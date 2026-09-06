// @vitest-environment jsdom
// tabKill.test.ts — the design's §4.3 claim, observed: "no edit that has reached IndexedDB is ever
// lost, and no acknowledged edit is ever lost; an edit can be lost only if the browser dies between
// the keystroke and the IndexedDB commit". A scripted tab kill, 1 000 times: keystrokes go through
// the runner exactly as the editor's do (apply, then `putOps`, one transaction each), the process
// is killed at a random point between the keystroke and the transaction's `complete` — every
// in-flight transaction aborted, the connection dropped — and the same database is reopened. After
// every kill: every op whose `putOps` had resolved is there, every acknowledged op is there, what is
// there is a contiguous prefix (a hole would be a SEQ_GAP forever), and what is lost is at most the
// ops still in flight. The observed worst case is printed, labelled measured, and asserted.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { localInsert, svGet, type ReplicaId, type StateVector } from '@weft/crdt';
import { openIdbStore } from '../../src/store/idb.ts';
import { startRunner } from '../../src/session/runner.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const DOC = 'doc-tabkill-001';
const ITERATIONS = 1_000;

/** A factory whose databases report every transaction they open, so a "kill" can abort the ones still in flight. */
function tracked(factory: IDBFactory): { factory: IDBFactory; kill(): number } {
  const live = new Set<IDBTransaction>();
  const wrapped = Object.create(factory) as IDBFactory;
  wrapped.open = (name: string, version?: number) => {
    const req = factory.open(name, version);
    req.addEventListener('success', () => {
      const db = req.result;
      const real = db.transaction.bind(db);
      db.transaction = (stores, mode, options) => {
        const tx = real(stores, mode, options);
        live.add(tx);
        const done = (): void => void live.delete(tx);
        tx.addEventListener('complete', done);
        tx.addEventListener('abort', done);
        return tx;
      };
    });
    return req;
  };
  return {
    factory: wrapped,
    kill: () => {
      let aborted = 0;
      for (const tx of live) {
        try {
          tx.abort();
          aborted++;
        } catch {
          // already committing: the browser would have finished it too
        }
      }
      live.clear();
      return aborted;
    },
  };
}

/** A seeded generator so a failing run can be reproduced from its printed seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('the tab is killed between the keystroke and the IndexedDB commit', () => {
  it(`${ITERATIONS} kills at random points: never a committed op lost, never an acknowledged op lost, never a hole; loss bounded by what was in flight (measured worst case printed)`, async () => {
    const seed = Number(process.env['WEFT_KILL_SEED'] ?? Date.now() % 1_000_000);
    const random = rng(seed);
    const { factory, kill } = tracked(new IDBFactory());
    let maxLoss = 0;
    let maxInFlight = 0;
    let totalLost = 0;
    let totalTyped = 0;
    let highestAcked = 0;
    let expectedPrefix = 0; // every seq up to here is known committed from an earlier life
    for (let i = 0; i < ITERATIONS; i++) {
      const opened = await openIdbStore(DOC, { claim: async () => A, indexedDB: factory, storageManager: null });
      const runner = await startRunner({ url: 'ws://127.0.0.1:1', doc: DOC, me: A, store: opened.store, presence: { name: 'a', color: 0 }, offline: true });
      const before = svGet(runner.doc.sv, A);
      // Reopen check: everything committed in earlier lives is back, as a contiguous prefix.
      expect(before).toBeGreaterThanOrEqual(expectedPrefix);
      expect(opened.store.opLog().get(A, 1, before)).toHaveLength(before);
      expectedPrefix = before;

      const keystrokes = 1 + Math.floor(random() * 3);
      const committed = new Set<number>();
      const pending: Promise<void>[] = [];
      for (let k = 0; k < keystrokes; k++) {
        const seq = before + k + 1;
        const p = runner
          .local((doc, me, nextSeq) => localInsert(doc, me, nextSeq, svGet(doc.sv, me) === 0 ? 0 : Math.min(k, 0) + visibleLength(doc), { kind: 'char', text: String.fromCharCode(97 + (seq % 26)) }))
          .then(() => void committed.add(seq));
        pending.push(p.catch(() => undefined)); // an aborted transaction rejects: that IS the kill
        if (random() < 0.3) await tick(); // sometimes the next keystroke waits a moment
      }
      // Sometimes the server acknowledged what had committed by the time of the kill.
      if (random() < 0.3) {
        await tick();
        const ackUpTo = Math.max(0, ...committed);
        if (ackUpTo > 0) {
          await opened.store.markAcked({ [A]: ackUpTo } as StateVector);
          highestAcked = Math.max(highestAcked, ackUpTo);
        }
      }
      // The kill: at a random point between "keystroke dispatched" and "every transaction complete".
      const wait = Math.floor(random() * 8);
      for (let t = 0; t < wait; t++) await tick();
      const inFlight = keystrokes - committed.size;
      kill();
      opened.store.close();
      await runner.close();
      await Promise.all(pending);

      // Reopen from the same database, as the next tab would.
      const again = await openIdbStore(DOC, { claim: async () => A, indexedDB: factory, storageManager: null });
      const loaded = await again.store.load();
      const held = again.store.opLog().get(A, 1, Number.MAX_SAFE_INTEGER).map((op) => op.id.seq);
      again.store.close();
      const top = loaded === null ? 0 : svGet(loaded.doc.sv, A);
      expect(held).toEqual(Array.from({ length: top }, (_, n) => n + 1)); // contiguous: no hole, ever
      for (const seq of committed) expect(top, `committed op ${seq} lost at iteration ${i} (seed ${seed})`).toBeGreaterThanOrEqual(seq);
      expect(top, `acknowledged op lost at iteration ${i} (seed ${seed})`).toBeGreaterThanOrEqual(highestAcked);
      const lost = before + keystrokes - top;
      expect(lost, `lost more than was in flight at iteration ${i} (seed ${seed})`).toBeLessThanOrEqual(inFlight);
      maxLoss = Math.max(maxLoss, lost);
      maxInFlight = Math.max(maxInFlight, inFlight);
      totalLost += lost;
      totalTyped += keystrokes;
    }
    console.log(`tab kill (measured, seed ${seed}): ${ITERATIONS} kills, ${totalTyped} keystrokes, ${totalLost} lost in total; worst case ${maxLoss} keystroke(s) in one kill (at most ${maxInFlight} were ever in flight at once); 0 committed and 0 acknowledged ops lost.`);
    expect(maxLoss).toBeLessThanOrEqual(maxInFlight);
  });
});

function visibleLength(doc: { sv: StateVector }): number {
  return svGet(doc.sv, A);
}
