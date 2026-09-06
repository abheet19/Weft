// history.test.ts — the runner's side of S7: local-only undo/redo emit real ops through the same
// persist-then-send path as any edit; the time-travel op log replays to the live document; and
// IndexedDB compaction fires at COMPACT_EVERY_OPS operations in ONE transaction (D4) without losing
// an op that arrives while it is in flight (LLD §8 S7). The runner runs offline (no socket) so the
// subject is the local machinery, not the wire — the store is a memory store wrapped to observe and
// gate `compact`.
import { describe, expect, it } from 'vitest';
import { localDelete, localInsert, visibleItems, type Doc, type Op, type ReplicaId } from '@weft/crdt';
import { COMPACT_EVERY_OPS } from '../../src/session/constants.ts';
import { replayTo } from '../../src/history/timeTravel.ts';
import { startRunner, type Runner } from '../../src/session/runner.ts';
import { memoryStore, type Store } from '../../src/store/memoryStore.ts';

const ME = 'bcdefghijklmn' as ReplicaId;

const text = (doc: Doc): string =>
  visibleItems(doc)
    .map((it) => (it.content.kind === 'char' ? it.content.text : '▮'))
    .join('');

/** A memory store that counts `compact` calls and, when `block` is set, holds the first one open until `gate()` — so the trigger can be observed and raced with an edit. */
function observableStore(me: ReplicaId, block = false): Store & { compacts: number; gate: () => void } {
  const inner = memoryStore(me);
  let release: (() => void) | null = null;
  let blocking = block;
  const wrapper: Store & { compacts: number; gate: () => void } = {
    putOps: (ops) => inner.putOps(ops),
    markAcked: (sv) => inner.markAcked(sv),
    unacked: () => inner.unacked(),
    load: () => inner.load(),
    opLog: () => inner.opLog(),
    persisted: () => inner.persisted(),
    persist: () => inner.persist(),
    close: () => inner.close(),
    compacts: 0,
    gate: () => {
      release?.();
      release = null;
    },
    compact: async (doc) => {
      wrapper.compacts++;
      if (blocking) {
        blocking = false;
        await new Promise<void>((r) => (release = r));
      }
      await inner.compact(doc);
    },
  };
  return wrapper;
}

async function offlineRunner(store: Store): Promise<Runner> {
  return startRunner({ url: 'ws://127.0.0.1:1', doc: 'doc-hist', me: ME, store, presence: { name: 'me', color: 0 }, offline: true });
}

const type = (r: Runner, at: number, s: string): Promise<void> => r.local((doc, me, seq) => localInsert(doc, me, seq, at, { kind: 'char', text: s }));

describe('undo/redo through the runner', () => {
  it('emit real ops that persist and reload, and drive canUndo/canRedo', async () => {
    const store = memoryStore(ME);
    const r = await offlineRunner(store);
    await type(r, 0, 'h');
    await type(r, 1, 'i');
    expect(text(r.doc)).toBe('hi');
    expect(r.snapshot().canUndo).toBe(true);
    expect(r.snapshot().canRedo).toBe(false);

    await r.undo();
    expect(text(r.doc)).toBe('h');
    expect(r.snapshot().canRedo).toBe(true);

    await r.redo();
    expect(text(r.doc)).toBe('hi');

    // The undo/redo ops were persisted: a fresh runner on the same store reloads "hi".
    await r.close();
    const again = await offlineRunner(store);
    expect(text(again.doc)).toBe('hi');
    await again.close();
  });

  it('an empty undo stack is a no-op', async () => {
    const r = await offlineRunner(memoryStore(ME));
    await r.undo(); // nothing to undo
    expect(text(r.doc)).toBe('');
    expect(r.snapshot().canUndo).toBe(false);
    await r.close();
  });
});

describe('time-travel op log', () => {
  it('history().base + ops replays to the live document, and position 0 is empty', async () => {
    const r = await offlineRunner(memoryStore(ME));
    await type(r, 0, 'a');
    await type(r, 1, 'b');
    await r.local((doc, me, seq) => localDelete(doc, me, seq, 0, 1)); // delete "a"
    const { base, ops } = r.history();
    expect(ops.length).toBe(3); // ins a, ins b, del a
    expect(text(replayTo(base, ops, 0))).toBe('');
    expect(text(replayTo(base, ops, 2))).toBe('ab');
    expect(text(replayTo(base, ops, ops.length))).toBe(text(r.doc));
    expect(text(r.doc)).toBe('b');
    await r.close();
  });
});

describe('IndexedDB compaction (D4, LLD §8 S7)', () => {
  it('fires once at COMPACT_EVERY_OPS operations', async () => {
    const store = observableStore(ME); // not blocking: compact resolves at once
    const r = await offlineRunner(store);
    // One edit emitting exactly COMPACT_EVERY_OPS insert ops.
    await r.local((doc, me, seq) => {
      let cur = doc;
      const ops: Op[] = [];
      for (let i = 0; i < COMPACT_EVERY_OPS; i++) {
        const step = localInsert(cur, me, seq + ops.length, i, { kind: 'char', text: 'a' });
        ops.push(...step.ops);
        cur = step.doc;
      }
      return { ops, doc: cur };
    });
    await Promise.resolve();
    expect(store.compacts).toBe(1);
    await r.close();
  });

  it('an op that arrives while a compaction is in flight is not lost', async () => {
    const store = observableStore(ME, true); // block the first compact until gate()
    const r = await offlineRunner(store);
    // Trigger the (gated) compaction with COMPACT_EVERY_OPS ops.
    await r.local((doc, me, seq) => {
      let cur = doc;
      const ops: Op[] = [];
      for (let i = 0; i < COMPACT_EVERY_OPS; i++) {
        const step = localInsert(cur, me, seq + ops.length, i, { kind: 'char', text: 'a' });
        ops.push(...step.ops);
        cur = step.doc;
      }
      return { ops, doc: cur };
    });
    expect(store.compacts).toBe(1); // compact called, now blocked on the gate
    // A further edit lands while compaction is still running (persisted on its own transaction).
    await type(r, COMPACT_EVERY_OPS, 'Z');
    store.gate(); // let the snapshot finish
    await new Promise((res) => setTimeout(res, 0));
    await r.close();
    // Reload from the store: the snapshot plus the op that raced it — nothing lost.
    const again = await offlineRunner(store);
    expect(visibleItems(again.doc).length).toBe(COMPACT_EVERY_OPS + 1);
    expect(text(again.doc).endsWith('Z')).toBe(true);
    await again.close();
  });
});
