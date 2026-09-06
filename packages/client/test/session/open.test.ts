// open.test.ts — a browser tab becoming a session (`openSession`), with every browser global
// injected and the real @weft/server on the other end: two tabs on one device (each with its own sessionStorage,
// sharing one fake IndexedDB and one lock manager) get two replica ids, see no SEQ_GAP and
// converge; a tab killed while offline is reopened, reclaims its id and count, and its edits reach
// the server (F4 in Node); `Start fresh` carries the text into a new document once; IndexedDB
// missing falls back to memory, visibly; a corrupt store rejects and releases its claim; the
// browser's connectivity starts the session offline and flips it, and the user's toggle outranks
// it. Against a bare `ws` listener: the pill never reads `Saved` before the ack lands (I11), a
// store that stops writing ends the session as `failed · STORE_FAILED` (E18), and 10 000
// unacknowledged ops are re-sent after a reload in ≤ 512-op messages, in order.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@weft/server';
import { localInsert, type Op, type ReplicaId } from '@weft/crdt';
import { decodeClient, type ClientMessage } from '@weft/protocol';
import { newReplicaId } from '../../src/identity.ts';
import type { Connectivity } from '../../src/session/connectivity.ts';
import { openSession, plainText, type BrowserDeps, type Session } from '../../src/session/open.ts';
import type { Runner } from '../../src/session/runner.ts';
import { openIdbStore, StoreCorruptError } from '../../src/store/idb.ts';
import { pillCopy } from '../../src/ui/pillCopy.ts';
import { until } from '../headlessHelpers.ts';
import { fakeLocks, fakeStorage } from '../store/fakes.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const DOC = 'doc-open-00001';

/** One "device": a shared IndexedDB, a shared lock manager and a shared localStorage. Each `tab()` has its own sessionStorage. */
function device(): { tab(overrides?: Partial<BrowserDeps>): BrowserDeps; indexedDB: IDBFactory; locks: ReturnType<typeof fakeLocks> } {
  const indexedDB = new IDBFactory();
  const locks = fakeLocks();
  const localStorage = fakeStorage();
  return {
    indexedDB,
    locks,
    tab: (overrides = {}) => ({ indexedDB, locks, localStorage, sessionStorage: fakeStorage(), storageManager: null, connectivity: null, mint: newReplicaId, ...overrides }),
  };
}

const type = (r: Runner, index: number, text: string): Promise<void> =>
  r.local((doc, me, next) => {
    const ops: Op[] = [];
    let cur = doc;
    let at = index;
    for (const ch of text) {
      const step = localInsert(cur, me, next + ops.length, at++, { kind: 'char', text: ch });
      ops.push(...step.ops);
      cur = step.doc;
    }
    return { ops, doc: cur };
  });

const state = (s: Session) => s.runner.snapshot().session;
const saved = (s: Session): boolean => state(s).s === 'live' && state(s).unacked === 0;
const sameSv = (a: Session, b: Session): boolean => JSON.stringify(Object.entries(a.runner.snapshot().sv).sort()) === JSON.stringify(Object.entries(b.runner.snapshot().sv).sort());

/** A network the test flips. */
function fakeConnectivity(online: boolean): Connectivity & { set(online: boolean): void } {
  const listeners = new Set<(online: boolean) => void>();
  const c = {
    online,
    subscribe: (l: (online: boolean) => void) => (listeners.add(l), () => void listeners.delete(l)),
    set: (v: boolean) => {
      c.online = v;
      for (const l of listeners) l(v);
    },
  };
  return c;
}

describe('against the real server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let dataDir: string;
  const url = (): string => `ws://127.0.0.1:${server.port}`;
  const open: Session[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'weft-open-'));
    server = await startServer({ host: '127.0.0.1', port: 0, dataDir, limits: { QUIET_MS: 40 }, warn: () => undefined });
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function session(deps: BrowserDeps, docId = DOC): Promise<Session> {
    const s = await openSession({ ...deps, url: url(), docId });
    open.push(s);
    return s;
  }
  const lines = (docId = DOC): string[] => readFileSync(join(dataDir, `${docId}.jsonl`), 'utf8').split('\n').filter(Boolean);

  it('two tabs on one device get two replica ids, upload to one document without a SEQ_GAP, converge, and the device remembers both ids', async () => {
    const dev = device();
    const one = await session(dev.tab());
    const two = await session(dev.tab());
    expect(one.me).not.toBe(two.me);
    expect(one.storage).toEqual({ kind: 'idb' });
    expect(dev.locks.held()).toHaveLength(2);
    await until(() => state(one).s === 'live' && state(two).s === 'live', 'both live');
    await type(one.runner, 0, 'one ');
    await type(two.runner, 0, 'two ');
    await until(() => saved(one) && saved(two) && sameSv(one, two), () => `converged (${state(one).s}/${state(two).s})`);
    expect(plainText(one.runner.doc)).toBe(plainText(two.runner.doc));
    expect(plainText(one.runner.doc)).toMatch(/^(one two |two one )$/);
    expect(one.runner.snapshot().ignored + two.runner.snapshot().ignored).toBe(0);
    expect(lines()).toHaveLength(8);
    let used: readonly ReplicaId[] = [];
    const probe = await openIdbStore(DOC, { claim: async (ids) => ((used = ids), A), indexedDB: dev.indexedDB, storageManager: null });
    probe.store.close();
    expect([...used].sort()).toEqual([one.me, two.me].sort());
  });

  it('F4 in Node: a tab killed while offline is reopened — same replica id, the text and Offline · N count restored, the toggle still on; going online uploads exactly those edits', async () => {
    const dev = device();
    const first = await session(dev.tab());
    await until(() => state(first).s === 'live', 'live');
    await type(first.runner, 0, 'kept');
    await until(() => saved(first), 'saved');
    first.setUserOffline(true);
    expect(state(first)).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    await type(first.runner, 4, ' dark');
    expect(state(first)).toEqual({ s: 'offline', reason: 'user', unacked: 5 });
    const me = first.me;
    await first.close(); // the kill: the lock dies with the tab (the browser releases it a tick later, as the fake does)
    await new Promise((r) => setTimeout(r, 0));
    open.splice(open.indexOf(first), 1);
    expect(dev.locks.held()).toEqual([]);

    const again = await session(dev.tab()); // a new tab: empty sessionStorage, same device
    expect(again.me).toBe(me);
    expect(plainText(again.runner.doc)).toBe('kept dark');
    expect(state(again)).toEqual({ s: 'offline', reason: 'user', unacked: 5 });
    expect(pillCopy(state(again), 0, { kind: 'idb' }).text).toBe('Offline · 5 changes on this device');
    expect(lines()).toHaveLength(4);
    again.setUserOffline(false);
    await until(() => saved(again), () => `saved after reconnect (${JSON.stringify(state(again))})`);
    expect(lines()).toHaveLength(9);
    expect(again.runner.snapshot().pending).toBe(0);
  });

  it('Start fresh (keeps a copy): the text — paragraphs included — is planted into the new document once, the notice names the old one, and the old database is untouched', async () => {
    const dev = device();
    const tab = dev.tab();
    const old = await session(tab);
    await until(() => state(old).s === 'live', 'live');
    await old.runner.local((doc, me, next) => {
      const a = localInsert(doc, me, next, 0, { kind: 'char', text: 'a' });
      const b = localInsert(a.doc, me, next + 1, 1, { kind: 'block', attrs: { type: 'paragraph' }, lamport: 0, replica: me });
      const c = localInsert(b.doc, me, next + 2, 2, { kind: 'char', text: 'b' });
      return { ops: [...a.ops, ...b.ops, ...c.ops], doc: c.doc };
    });
    await until(() => saved(old), 'saved');
    expect(plainText(old.runner.doc)).toBe('a\nb');
    old.startFresh('doc-fresh-0001');
    const fresh = await session(tab, 'doc-fresh-0001'); // the same tab navigated: same sessionStorage
    expect(fresh.seeded).toEqual({ text: 'a\nb', from: DOC });
    expect(plainText(fresh.runner.doc)).toBe('a\nb');
    await until(() => saved(fresh), 'fresh saved');
    expect(lines('doc-fresh-0001')).toHaveLength(3);
    expect(lines(DOC)).toHaveLength(3);
    await fresh.close();
    open.splice(open.indexOf(fresh), 1);
    const reopened = await session(tab, 'doc-fresh-0001');
    expect(reopened.seeded).toBeNull();
    expect(plainText(reopened.runner.doc)).toBe('a\nb');
  });

  it('denied path: no IndexedDB → the session runs in memory and says so; a corrupt store → openSession rejects with the StoreCorruptError and releases the claim', async () => {
    const dev = device();
    const memory = await session(dev.tab({ indexedDB: null }));
    expect(memory.storage).toEqual({ kind: 'memory', reason: 'Error: this browser exposes no indexedDB' });
    await until(() => state(memory).s === 'live', 'live in memory');
    expect(await memory.store.persisted()).toBe(false);

    const corrupt = device();
    const good = await session(corrupt.tab());
    await good.close();
    open.splice(open.indexOf(good), 1);
    await new Promise<void>((resolve, reject) => {
      const req = corrupt.indexedDB.open(`weft:${DOC}`, 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('snapshot', 'readwrite');
        tx.objectStore('snapshot').put({ v: 1, sv: {}, formatLamport: 0, items: 'not an array', pending: [] }, 'latest');
        tx.oncomplete = () => (req.result.close(), resolve());
        tx.onabort = () => reject(tx.error);
      };
    });
    await expect(openSession({ ...corrupt.tab(), url: url(), docId: DOC })).rejects.toBeInstanceOf(StoreCorruptError);
    expect(corrupt.locks.held()).toEqual([]);
  });

  it('the browser’s connectivity: a tab that loads offline starts offline · browser without a socket, connects when the network returns, drops when it goes; the user’s toggle outranks the browser', async () => {
    const dev = device();
    const network = fakeConnectivity(false);
    const s = await session(dev.tab({ connectivity: network }));
    expect(state(s)).toEqual({ s: 'offline', reason: 'browser', unacked: 0 });
    network.set(true);
    await until(() => state(s).s === 'live', 'live once online');
    network.set(false);
    expect(state(s)).toEqual({ s: 'offline', reason: 'browser', unacked: 0 });
    s.setUserOffline(true);
    network.set(true);
    expect(state(s)).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    s.setUserOffline(false);
    await until(() => state(s).s === 'live', 'live again');
    await s.close();
    open.splice(open.indexOf(s), 1);
    network.set(false); // unsubscribed: a late event reaches nothing
    expect(state(s)).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
  });

});

describe('against a server that misbehaves (bare ws listener)', () => {
  let fake: WebSocketServer;
  let script: (send: (m: object) => void, msg: ClientMessage) => void = () => undefined;
  const open: Session[] = [];

  beforeEach(async () => {
    fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    fake.on('connection', (ws) => {
      ws.on('message', (data) => {
        const m = decodeClient(data as Buffer);
        if (m.ok) script((o) => ws.send(JSON.stringify(o)), m.value);
      });
    });
    await new Promise((r) => fake.once('listening', r));
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
    for (const c of fake.clients) c.terminate();
    await new Promise<void>((r) => fake.close(() => r()));
  });
  const fakeUrl = (): string => `ws://127.0.0.1:${(fake.address() as { port: number }).port}`;

  it('I11: the pill never reads Saved before the ack arrives — it reads Syncing · 1 from the keystroke until the (delayed) ack lands', async () => {
    let ackSent = false;
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (msg.t === 'ops') {
        const last = msg.ops[msg.ops.length - 1] as Op;
        setTimeout(() => {
          ackSent = true;
          send({ v: 1, t: 'ack', replica: last.id.replica, seq: last.id.seq });
        }, 150);
      }
    };
    const readings: { text: string; ackSent: boolean }[] = [];
    const dev = device();
    const s = await openSession({ ...dev.tab(), url: fakeUrl(), docId: DOC, onChange: (snap) => readings.push({ text: pillCopy(snap.session, 0, { kind: 'idb' }).text, ackSent }) });
    open.push(s);
    await until(() => saved(s), 'live and saved before typing');
    readings.length = 0;
    await type(s.runner, 0, 'x');
    expect(readings.at(-1)?.text).toBe('Syncing · 1');
    await until(() => saved(s), 'saved after the ack');
    expect(readings.some((r) => r.text === 'Syncing · 1')).toBe(true);
    for (const r of readings) if (r.text === 'Saved') expect(r.ackSent).toBe(true);
    expect(readings.at(-1)).toEqual({ text: 'Saved', ackSent: true });
  });

  it('E18: a store that stops writing ends the session as failed · STORE_FAILED with the reason — from a local edit and from an inbound batch alike — and USER_ONLINE retries', async () => {
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
    };
    const dev = device();
    const s = await openSession({ ...dev.tab(), url: fakeUrl(), docId: DOC });
    open.push(s);
    await until(() => state(s).s === 'live', 'live');
    const store = s.store;
    const realPut = store.putOps.bind(store);
    store.putOps = async () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    await expect(type(s.runner, 0, 'a')).rejects.toThrow(/quota/);
    expect(state(s)).toEqual({ s: 'failed', code: 'STORE_FAILED', reason: 'store failed: The quota has been exceeded.', unacked: 0 });
    expect(pillCopy(state(s), 0, { kind: 'idb' }).text).toBe('Can’t save · STORE_FAILED');
    store.putOps = realPut;
    s.runner.dispatch({ e: 'USER_ONLINE' });
    await until(() => state(s).s === 'live', 'live again after retry');
    // Inbound: the peer's ops arrive, the store refuses them.
    store.putOps = async () => {
      throw new Error('disk gone');
    };
    for (const c of fake.clients) c.send(JSON.stringify({ v: 1, t: 'ops', ops: [{ t: 'ins', id: { replica: 'cdefghijklmno', seq: 1 }, parent: { replica: 'aaaaaaaaaaaaa', seq: 0 }, side: 'R', content: { kind: 'char', text: 'p' } }] }));
    await until(() => state(s).s === 'failed', 'failed on the inbound write');
    expect(state(s)).toMatchObject({ s: 'failed', code: 'STORE_FAILED', reason: 'store failed: disk gone' });
    store.putOps = realPut;
  });

  it('attack: 10 000 unacknowledged ops in the store are re-sent after a reload in ≤ 512-op messages, in seq order, and nothing else', async () => {
    const dev = device();
    const seeded = await openIdbStore(DOC, { claim: async () => A, indexedDB: dev.indexedDB, storageManager: null });
    // A chain of 10 000 characters, each the right child of the one before — what typing them produces — written as one previous tab would have.
    const all: Op[] = Array.from({ length: 10_000 }, (_, i) => ({ t: 'ins', id: { replica: A, seq: i + 1 }, parent: i === 0 ? { replica: 'aaaaaaaaaaaaa' as ReplicaId, seq: 0 } : { replica: A, seq: i }, side: 'R', content: { kind: 'char', text: 'x' } }));
    for (let i = 0; i < all.length; i += 1_000) await seeded.store.putOps(all.slice(i, i + 1_000));
    seeded.store.close();

    const batches: number[][] = [];
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (msg.t === 'ops') batches.push(msg.ops.map((op) => op.id.seq));
    };
    const s = await openSession({ ...dev.tab(), url: fakeUrl(), docId: DOC });
    open.push(s);
    expect(s.me).toBe(A); // reclaimed: the id the device used, free again
    expect(state(s).unacked).toBe(10_000);
    await until(() => batches.reduce((n, b) => n + b.length, 0) === 10_000, () => `all re-sent (${batches.length} batches so far)`, 20_000);
    expect(batches.map((b) => b.length)).toEqual([...Array.from({ length: 19 }, () => 512), 272]);
    expect(batches.flat()).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(10_000); // nothing sent twice
  });
});
