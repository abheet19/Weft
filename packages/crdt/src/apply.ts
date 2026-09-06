// apply.ts — THE function. This file exists because convergence (I1) is a property of `apply`
// alone: given the same set of ops in any order, every replica must compute the same tree. It
// holds the Fugue integrate step (attach the new item under its parent, siblings sorted by id),
// tombstoning, last-writer-wins for marks and block attributes under a TOTAL order (lamport,
// replica, seq — E8), the pending buffer for ops whose dependency has not arrived, and the
// per-replica seq rule. It is total over `unknown`: it never throws on data (an op of any shape,
// `null` included, comes back `rejected` with a reason), never reads a clock, never mutates the
// Doc it was given, and never stores a value the snapshot decoder would refuse — every id-shaped
// field and every content field is validated in `refuse` before anything is looked up, and an op
// that fails is `MALFORMED` (E10), never half-applied and never parked. @weft/protocol validates
// the same shapes at the wire; the checks here are what keeps this function total without it.

import { compareIds, idKey, isWellFormedId, ROOT_REPLICA, type ItemId } from './ids.ts';
import { childrenOf, type Children, type Doc } from './doc.ts';
import { isBlockAttrs, isContent, isLamport, isMarkName, NO_MARKS, ROOT_KEY, type BlockRegister, type Item, type ItemContent, type MarkSet, type MarkState } from './item.ts';
import { opDependencies, type Op } from './ops.ts';
import { PersistentMap } from './persistentMap.ts';
import { insertSibling } from './siblings.ts';
import { svGet, svSet } from './stateVector.ts';

export type ApplyResult =
  | { readonly kind: 'applied'; readonly doc: Doc; readonly drained: readonly Op[] } // drained = pending ops this one unblocked (already applied, listed for the Inspector)
  | { readonly kind: 'pending'; readonly doc: Doc; readonly missing: readonly ItemId[] }
  | { readonly kind: 'duplicate'; readonly doc: Doc } // idempotence: already held
  | { readonly kind: 'rejected'; readonly doc: Doc; readonly reason: RejectReason }; // seq gap for this replica, structural impossibility, or a shape no replica could apply
/** `SEQ_GAP` is strictly "not the replica's next seq"; anything that fails a shape rule is `MALFORMED` (E10). */
export type RejectReason = 'SEQ_GAP' | 'MALFORMED' | 'BAD_PARENT_SIDE' | 'TARGET_IS_ROOT' | 'SELF_PARENT';

/** THE function. Deterministic, total, idempotent. Convergence (I1) is a property of this function alone. */
export function apply(doc: Doc, op: Op): ApplyResult {
  const reason = refuse(op);
  if (reason !== null) return { kind: 'rejected', doc, reason };

  // Idempotence and contiguity, both read off the state vector. The vector counts every op
  // RECEIVED for a replica — applied or parked — so a parked op's successor is not a gap.
  const held = svGet(doc.sv, op.id.replica);
  if (op.id.seq <= held) return { kind: 'duplicate', doc };
  if (op.id.seq !== held + 1) return { kind: 'rejected', doc, reason: 'SEQ_GAP' };
  const counted: Doc = { ...doc, sv: svSet(doc.sv, op.id.replica, op.id.seq) };

  const missing = opDependencies(op).filter((dep) => !counted.items.has(idKey(dep)));
  const first = missing[0];
  if (first !== undefined) return { kind: 'pending', doc: park(counted, op, first), missing };

  const drained: Op[] = [];
  const next = drain(integrate(counted, op), op, drained);
  return { kind: 'applied', doc: next, drained };
}

/** apply in sequence; exists so tests and time-travel share one implementation. */
export function applyAll(doc: Doc, ops: readonly Op[]): { doc: Doc; results: readonly ApplyResult[] } {
  const results: ApplyResult[] = [];
  let cur = doc;
  for (const op of ops) {
    const r = apply(cur, op);
    results.push(r);
    cur = r.doc;
  }
  return { doc: cur, results };
}

/**
 * The checks that need no document: an op that fails one can never be applied by any replica, so
 * refusing it is itself deterministic. Takes `unknown` on purpose — this is the one place that
 * turns wire data into an `Op` — and looks at no field before proving its shape. Returns the
 * reason or null. Also used by the snapshot decoder on parked ops.
 */
export function refuse(op: unknown): RejectReason | null {
  if (typeof op !== 'object' || op === null) return 'MALFORMED';
  const x = op as Record<string, unknown>;
  // Seq 0 is ROOT's alone and ROOT never writes; nothing authored under its replica id is honest.
  if (!isWellFormedId(x.id) || x.id.seq < 1 || x.id.replica === ROOT_REPLICA) return 'MALFORMED';
  const own = idKey(x.id);
  switch (x.t) {
    case 'ins': {
      if (!isWellFormedId(x.parent) || !isContent(x.content)) return 'MALFORMED';
      // The block register's writer is this op; a seed claiming another replica could collide with
      // that replica's own write under the total order.
      if (x.content.kind === 'block' && x.content.replica !== x.id.replica) return 'MALFORMED';
      if (x.side !== 'L' && x.side !== 'R') return 'BAD_PARENT_SIDE';
      const parentKey = idKey(x.parent);
      if (parentKey === own) return 'SELF_PARENT';
      // The rule never produces a left child of ROOT (index 0 hangs under the first item), so one
      // arriving from outside is a forgery or a bug, not a position.
      if (parentKey === ROOT_KEY && x.side === 'L') return 'BAD_PARENT_SIDE';
      return null;
    }
    case 'del':
      return targetReason(x.target, own);
    case 'blk': {
      if (!isBlockAttrs(x.attrs) || !isLamport(x.lamport)) return 'MALFORMED';
      return targetReason(x.target, own);
    }
    case 'fmt': {
      if (!Array.isArray(x.targets) || !isMarkName(x.mark) || typeof x.active !== 'boolean' || !isLamport(x.lamport)) return 'MALFORMED';
      if (x.href !== undefined && typeof x.href !== 'string') return 'MALFORMED';
      for (const t of x.targets) {
        const r = targetReason(t, own);
        if (r !== null) return r;
      }
      return null;
    }
    default:
      return 'MALFORMED';
  }
}

/** ROOT is never a target (it is never emitted, so nothing about it can be edited); an op that depends on its own id can never be satisfied — the same impossibility as a self-parent. */
function targetReason(target: unknown, own: string): RejectReason | null {
  if (!isWellFormedId(target)) return 'MALFORMED';
  const targetKey = idKey(target);
  if (targetKey === ROOT_KEY) return 'TARGET_IS_ROOT';
  if (targetKey === own) return 'SELF_PARENT';
  return null;
}

/** Park `op` under the key of one missing dependency. When that id lands, `drain` re-checks all of them. */
function park(doc: Doc, op: Op, missing: ItemId): Doc {
  const key = idKey(missing);
  const pending = persistent(doc.pending);
  return { ...doc, pending: pending.set(key, [...(pending.get(key) ?? []), op]) };
}

/**
 * Apply an op whose dependencies are all present. Never called for rejected or duplicate ops, so
 * every lookup below finds its item. Returns the new Doc; the given one is untouched.
 */
function integrate(doc: Doc, op: Op): Doc {
  switch (op.t) {
    case 'ins':
      return integrateInsert(doc, op);
    case 'del':
      return integrateDelete(doc, op.target);
    case 'fmt':
      return integrateFormat(doc, op);
    case 'blk':
      return integrateBlock(doc, op);
  }
}

function integrateInsert(doc: Doc, op: Extract<Op, { t: 'ins' }>): Doc {
  const parentKey = idKey(op.parent);
  const parent = doc.items.get(parentKey) as Item;
  // Fresh objects, never the op's own: the caller may go on mutating what it handed us.
  const content: ItemContent =
    op.content.kind === 'char'
      ? { kind: 'char', text: op.content.text }
      : op.content.kind === 'break'
        ? { kind: 'break' }
        : { kind: 'block', attrs: copyAttrs(op.content.attrs), lamport: op.content.lamport, replica: op.id.replica, seq: op.id.seq };
  const item: Item = {
    id: { replica: op.id.replica, seq: op.id.seq },
    parent: parent.id, // the tree's own id object, so every stored id has passed isWellFormedId
    side: op.side,
    content,
    deleted: false,
    marks: NO_MARKS,
  };
  const siblings = childrenOf(doc, parentKey);
  const updated: Children =
    op.side === 'L' ? { L: insertSibling(siblings.L, item.id), R: siblings.R } : { L: siblings.L, R: insertSibling(siblings.R, item.id) };
  return {
    ...doc,
    items: persistent(doc.items).set(idKey(op.id), item),
    children: persistent(doc.children).set(parentKey, updated),
    formatLamport: content.kind === 'block' ? Math.max(doc.formatLamport, content.lamport) : doc.formatLamport,
  };
}

function copyAttrs(attrs: BlockRegister['attrs']): BlockRegister['attrs'] {
  return attrs.level === undefined ? { type: attrs.type } : { type: attrs.type, level: attrs.level };
}

function integrateDelete(doc: Doc, target: ItemId): Doc {
  const key = idKey(target);
  const item = doc.items.get(key) as Item;
  if (item.deleted) return doc; // deleting a tombstone changes nothing; the op still consumed its seq
  return { ...doc, items: persistent(doc.items).set(key, { ...item, deleted: true }) };
}

/**
 * Last writer wins under a TOTAL order: higher lamport, then higher replica id (code-point order),
 * then higher seq of the writing op (E8). Two writes from one replica with one lamport are told
 * apart by seq, so the outcome cannot depend on which of them was parked. Equal on all three is
 * the same write.
 */
function wins(lamport: number, writer: ItemId, current: { readonly lamport: number; readonly replica: string; readonly seq: number } | undefined): boolean {
  if (current === undefined) return true;
  if (lamport !== current.lamport) return lamport > current.lamport;
  return compareIds(writer, { replica: current.replica as ItemId['replica'], seq: current.seq }) > 0;
}

function integrateFormat(doc: Doc, op: Extract<Op, { t: 'fmt' }>): Doc {
  let items = persistent(doc.items);
  const state: MarkState =
    op.mark === 'link' && op.href !== undefined
      ? { active: op.active, lamport: op.lamport, replica: op.id.replica, seq: op.id.seq, href: op.href }
      : { active: op.active, lamport: op.lamport, replica: op.id.replica, seq: op.id.seq };
  for (const target of op.targets) {
    const key = idKey(target);
    const item = items.get(key) as Item;
    if (!wins(op.lamport, op.id, item.marks[op.mark])) continue;
    const marks: MarkSet = { ...item.marks, [op.mark]: state };
    items = items.set(key, { ...item, marks });
  }
  return { ...doc, items, formatLamport: Math.max(doc.formatLamport, op.lamport) };
}

function integrateBlock(doc: Doc, op: Extract<Op, { t: 'blk' }>): Doc {
  const key = idKey(op.target);
  const item = doc.items.get(key) as Item;
  const formatLamport = Math.max(doc.formatLamport, op.lamport);
  // Block attributes live on boundary items only; a `blk` aimed at a character has nothing to set.
  if (item.content.kind !== 'block' || !wins(op.lamport, op.id, item.content)) return { ...doc, formatLamport };
  const content: BlockRegister = { kind: 'block', attrs: copyAttrs(op.attrs), lamport: op.lamport, replica: op.id.replica, seq: op.id.seq };
  return { ...doc, items: persistent(doc.items).set(key, { ...item, content }), formatLamport };
}

/**
 * After `landed` was integrated, apply every parked op it unblocked, transitively: an insert may
 * be the parent another insert was waiting for, and so on. Ops still missing something are parked
 * again under the next missing id. Appends what it applied to `drained`.
 */
function drain(doc: Doc, landed: Op, drained: Op[]): Doc {
  // Only an insert creates an id that others can be waiting for.
  const queue: string[] = landed.t === 'ins' ? [idKey(landed.id)] : [];
  let cur = doc;
  while (queue.length > 0) {
    const key = queue.pop() as string;
    const waiting = cur.pending.get(key);
    if (waiting === undefined) continue;
    cur = { ...cur, pending: persistent(cur.pending).delete(key) };
    for (const op of waiting) {
      const missing = opDependencies(op).find((dep) => !cur.items.has(idKey(dep)));
      if (missing !== undefined) {
        cur = park(cur, op, missing);
        continue;
      }
      cur = integrate(cur, op);
      drained.push(op);
      if (op.t === 'ins') queue.push(idKey(op.id));
    }
  }
  return cur;
}

/**
 * `Doc` exposes `ReadonlyMap` so callers cannot mutate it. `emptyDoc` and `decodeSnapshot` build
 * PersistentMaps underneath, which is what makes `set` cheap and non-destructive; a hand-built Doc
 * with plain Maps is converted once here rather than mutated in place.
 */
function persistent<V>(map: ReadonlyMap<string, V>): PersistentMap<V> {
  return map instanceof PersistentMap ? map : PersistentMap.from(map);
}
