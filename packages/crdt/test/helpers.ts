// helpers.ts — the test harness shared by every crdt test: four fixed replica ids, op builders,
// a Replica object that turns intents into ops through local.ts and receives ops through apply,
// a seeded PRNG (tests may not call Math.random either — a failing run must be reproducible from
// the printed fast-check seed), and the "pull" primitive that models catch-up delivery.
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  apply,
  applyAll,
  emptyDoc,
  localDelete,
  localFormat,
  localInsert,
  localSetBlock,
  svGet,
  visibleItems,
  type ApplyResult,
  type BlockAttrs,
  type Content,
  type Doc,
  type ItemId,
  type MarkName,
  type Op,
  type ReplicaId,
} from '../src/index.ts';

/** Four lexicographically distinct ids (LLD §6.1). None is the all-'a' ROOT replica. */
export const R = {
  a: 'abcdefghijklm' as ReplicaId,
  b: 'bcdefghijklmn' as ReplicaId,
  c: 'cdefghijklmno' as ReplicaId,
  d: 'defghijklmnop' as ReplicaId,
};
export const REPLICAS: readonly ReplicaId[] = [R.a, R.b, R.c, R.d];

export const id = (replica: ReplicaId, seq: number): ItemId => ({ replica, seq });
export const char = (text: string): Content => ({ kind: 'char', text });
export const block = (attrs: BlockAttrs, replica: ReplicaId = R.a, lamport = 0): Content => ({ kind: 'block', attrs, lamport, replica });
/** A soft break (E52): inline, immutable, no register. */
export const brk = (): Content => ({ kind: 'break' });
type OpOf<T extends Op['t']> = Extract<Op, { t: T }>;
export const ins = (me: ItemId, parent: ItemId, side: 'L' | 'R', content: Content = char('x')): OpOf<'ins'> => ({ t: 'ins', id: me, parent, side, content });
export const del = (me: ItemId, target: ItemId): OpOf<'del'> => ({ t: 'del', id: me, target });
/** `value` rides a link as its `href` and a colour mark as its `value`; every other mark ignores it. */
export const fmt = (me: ItemId, targets: readonly ItemId[], mark: MarkName, active: boolean, lamport: number, value?: string): OpOf<'fmt'> => {
  if (value === undefined) return { t: 'fmt', id: me, targets, mark, active, lamport };
  if (mark === 'link') return { t: 'fmt', id: me, targets, mark, active, lamport, href: value };
  if (mark === 'textColor' || mark === 'highlightColor') return { t: 'fmt', id: me, targets, mark, active, lamport, value };
  return { t: 'fmt', id: me, targets, mark, active, lamport };
};
export const blk = (me: ItemId, target: ItemId, attrs: BlockAttrs, lamport: number): OpOf<'blk'> => ({ t: 'blk', id: me, target, attrs, lamport });

/** The visible sequence as text; block boundaries print as ▮ so structure is visible in failures. */
export function text(doc: Doc): string {
  return visibleItems(doc)
    .map((item) => (item.content.kind === 'char' ? item.content.text : item.content.kind === 'break' ? '⏎' : '▮'))
    .join('');
}

/** Apply and insist it was applied; the doc after. For tests whose subject is not the result kind. */
export function applied(doc: Doc, op: Op): Doc {
  const r = apply(doc, op);
  expect(r.kind, `expected applied, got ${r.kind}${r.kind === 'rejected' ? ` (${r.reason})` : ''}`).toBe('applied');
  return r.doc;
}

/** Fold `apply` over a long log keeping only the final doc — `applyAll` keeps every intermediate result (for time travel), which for 100 000 ops is hundreds of MB a test does not need. */
export function replay(doc: Doc, ops: readonly Op[]): Doc {
  let cur = doc;
  for (const op of ops) {
    const r = apply(cur, op);
    expect(r.kind).toBe('applied');
    cur = r.doc;
  }
  return cur;
}

export function appliedAll(doc: Doc, ops: readonly Op[]): Doc {
  const { doc: next, results } = applyAll(doc, ops);
  for (const r of results) expect(r.kind).toBe('applied');
  return next;
}

/** One replica under test: its doc, its own contiguous seq, and the log of ops it generated. */
export class Replica {
  doc: Doc = emptyDoc();
  seq = 0;
  readonly log: Op[] = [];

  constructor(readonly me: ReplicaId) {}

  private emit(result: { ops: readonly Op[]; doc: Doc }): readonly Op[] {
    this.doc = result.doc;
    this.seq += result.ops.length;
    this.log.push(...result.ops);
    return result.ops;
  }

  length(): number {
    return visibleItems(this.doc).length;
  }

  insert(visibleIndex: number, content: Content): readonly Op[] {
    return this.emit(localInsert(this.doc, this.me, this.seq + 1, visibleIndex, content));
  }

  /** Forward typing: each character after the previous one. */
  type(visibleIndex: number, s: string): readonly Op[] {
    const out: Op[] = [];
    let i = visibleIndex;
    for (const ch of s) out.push(...this.insert(i++, char(ch)));
    return out;
  }

  /** Backward typing: the cursor stays put, so the string is typed last character first. */
  prepend(visibleIndex: number, s: string): readonly Op[] {
    const out: Op[] = [];
    for (const ch of [...s].reverse()) out.push(...this.insert(visibleIndex, char(ch)));
    return out;
  }

  delete(from: number, to: number): readonly Op[] {
    return this.emit(localDelete(this.doc, this.me, this.seq + 1, from, to));
  }

  format(from: number, to: number, mark: MarkName, active: boolean, value?: string): readonly Op[] {
    return this.emit(localFormat(this.doc, this.me, this.seq + 1, from, to, mark, active, value));
  }

  setBlock(visibleIndexInBlock: number, attrs: BlockAttrs): readonly Op[] {
    return this.emit(localSetBlock(this.doc, this.me, this.seq + 1, visibleIndexInBlock, attrs));
  }

  receive(op: Op): ApplyResult {
    const r = apply(this.doc, op);
    this.doc = r.doc;
    return r;
  }

  receiveAll(ops: readonly Op[]): ApplyResult[] {
    return ops.map((op) => this.receive(op));
  }
}

/** Deliver up to `count` of `from`'s own ops that `to` has not yet received, in seq order — one catch-up step of design §3.4. */
export function pull(from: Replica, to: Replica, count = Number.POSITIVE_INFINITY): ApplyResult[] {
  const held = svGet(to.doc.sv, from.me);
  return to.receiveAll(from.log.slice(held, Math.min(from.log.length, held + count)));
}

/** Keep pulling in every direction until every replica holds every op. */
export function healAll(reps: readonly Replica[], rng: () => number = mulberry32(1)): void {
  for (let round = 0; round < reps.length * reps.length + 2; round++) {
    let moved = 0;
    for (const [i, j] of shuffle(pairs(reps.length), rng)) moved += pull(reps[i] as Replica, reps[j] as Replica).length;
    if (moved === 0) return;
  }
  throw new Error('healAll did not settle');
}

export function pairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) out.push([i, j]);
  return out;
}

/** A small, fast, seedable PRNG: uniform doubles in [0, 1). Deterministic per seed, so a failing property shrinks reproducibly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** A random interleaving of several per-replica logs that keeps each log's own order — every delivery order the real protocol can produce. */
export function interleave(logs: readonly (readonly Op[])[], rng: () => number): Op[] {
  const cursors = logs.map(() => 0);
  const out: Op[] = [];
  const total = logs.reduce((n, l) => n + l.length, 0);
  while (out.length < total) {
    const live = cursors.map((c, i) => (c < (logs[i] as readonly Op[]).length ? i : -1)).filter((i) => i >= 0);
    const pick = live[Math.floor(rng() * live.length)] as number;
    out.push((logs[pick] as readonly Op[])[cursors[pick] as number] as Op);
    cursors[pick] = (cursors[pick] as number) + 1;
  }
  return out;
}

/**
 * Heavy property cases: 1,000 locally, 3,000 in CI, and 300 in the CI coverage pass.
 * Light/fresh-seed cases take a fifth/tenth. CI coverage is followed by the full CI
 * pass; separating them avoids coverage/worker heartbeat overhead on slow runners.
 * Named tests, generated cases and repeated coverage runs are different counts.
 */
export function numRuns(kind: 'heavy' | 'light' | 'fresh' = 'heavy'): number {
  const heavy = process.env['CI'] ? (process.env['WEFT_COV'] ? 300 : 3_000) : 1_000;
  if (kind === 'heavy') return heavy;
  return Math.max(1, Math.floor(heavy / (kind === 'light' ? 5 : 10)));
}

/** The seed of the reproducible run. Any constant works; this one is written down so a failure in CI can be replayed byte for byte. */
export const FIXED_SEED = 0x5eed;

/**
 * LLD §3: the heavy properties run once with a FIXED seed (the same cases on every machine, so a
 * regression is reproducible) and once with a FRESH seed (new cases every run, so the fixed set is
 * not the only thing ever exercised). `examples` are replayed before either run.
 */
export function assertBothSeeds<Ts extends unknown[]>(property: fc.IProperty<Ts>, examples: readonly Ts[] = []): void {
  // No `verbose`: it accumulates every run in memory (heavy at 10 000 cases and a needless load on the
  // worker); fast-check still reports the shrunk counterexample on failure, which is what a debugger needs.
  fc.assert(property, { numRuns: numRuns('heavy'), seed: FIXED_SEED, examples: [...examples] });
  fc.assert(property, { numRuns: numRuns('fresh') });
}
