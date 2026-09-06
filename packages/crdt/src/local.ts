// local.ts — from intent to ops. This file exists because the editor thinks in visible indexes
// ("insert at 7", "delete 3..5") and the CRDT thinks in ids; here the Fugue insert rule turns the
// first into the second (design §2.3), and the result is applied through the same `apply` every
// remote op goes through, so a local edit is never a special case. It must never generate a
// replica id or a seq (they are supplied — purity), never bypass `apply`, never emit a `fmt`
// with more than MAX_FMT_TARGETS ids (D2), and never emit an op `apply` would refuse: at the
// lamport bound it throws a RangeError that names the bound instead.

import { idKey, type ItemId, type ReplicaId } from './ids.ts';
import { applyAll } from './apply.ts';
import { childrenOf, type Doc } from './doc.ts';
import { MAX_LAMPORT, ROOT_KEY, type BlockAttrs, type Content, type MarkName, type Side } from './item.ts';
import type { Op } from './ops.ts';
import { blockRangeAt, buildIndex, neighboursAt, visibleItems, type PositionIndex } from './traverse.ts';

/**
 * ⟨D2⟩ The most target ids one `fmt` op may carry. The canonical constant is LIMITS.MAX_FMT_TARGETS
 * in @weft/protocol (S2); crdt may not import protocol (LLD §1), so the number is repeated here
 * and the protocol test asserts the two agree. Larger formats are split into several ops.
 */
export const MAX_FMT_TARGETS = 4096;

/**
 * The Fugue insert rule, isolated so tests and the bench can call it by name: the new item is the
 * right child of `left` when that seat is free; otherwise the left child of `right`, the next
 * item in traversal order INCLUDING tombstones (design §2.3). Siblings sort by id in `apply`.
 */
export function fuguePlace(doc: Doc, left: ItemId, right: ItemId | null): { parent: ItemId; side: Side } {
  // `right` is null only at the very end of the traversal, and then `left` has no right children;
  // the disjunction keeps this total without asserting that.
  if (childrenOf(doc, idKey(left)).R.length === 0 || right === null) return { parent: left, side: 'R' };
  return { parent: right, side: 'L' };
}

/** A visible index the caller claims exists. A bad one is a programmer error, not data, so it throws. */
function checkIndex(visibleIndex: number, length: number, what: string): void {
  if (!Number.isInteger(visibleIndex) || visibleIndex < 0 || visibleIndex > length) {
    throw new RangeError(`${what} ${visibleIndex} is outside 0..${length}`);
  }
}

/**
 * The lamport a local formatting write must carry to beat everything seen so far. Exists because a
 * remote op may sit AT the bound (E9): emitting bound + 1 would be refused by our own `apply`, so
 * the caller learns the true reason instead of a puzzling rejection.
 */
function nextFormatLamport(doc: Doc): number {
  if (doc.formatLamport >= MAX_LAMPORT) throw new RangeError(`formatting lamport is at MAX_LAMPORT (${MAX_LAMPORT}); no further format op can win`);
  return doc.formatLamport + 1;
}

/** Local ops are built against this very doc, so anything but `applied` means the caller passed a stale seq or a bad id — again a programmer error. */
function mustApply(doc: Doc, ops: readonly Op[]): Doc {
  const { doc: next, results } = applyAll(doc, ops);
  for (const r of results) {
    if (r.kind !== 'applied') {
      throw new RangeError(`local op was ${r.kind}${r.kind === 'rejected' ? ` (${r.reason})` : ''}: is nextSeq the replica's next seq?`);
    }
  }
  return next;
}

/** The one `ins` the Fugue rule makes of a left/right neighbour pair, applied. */
function placeInsert(doc: Doc, me: ReplicaId, nextSeq: number, left: ItemId, right: ItemId | null, content: Content): { ops: readonly Op[]; doc: Doc } {
  const { parent, side } = fuguePlace(doc, left, right);
  const op: Op = { t: 'ins', id: { replica: me, seq: nextSeq }, parent, side, content };
  return { ops: [op], doc: mustApply(doc, [op]) };
}

/** Turns "insert text at visible index i" into ops using the Fugue rule. Needs the replica id and its next seq — supplied, never generated here (purity). One traversal; `localInsertAt` is the same op without it. */
export function localInsert(doc: Doc, me: ReplicaId, nextSeq: number, visibleIndex: number, content: Content): { ops: readonly Op[]; doc: Doc } {
  if (!Number.isInteger(visibleIndex) || visibleIndex < 0) throw new RangeError(`visible index ${visibleIndex} is negative or not an integer`);
  const { left, right } = neighboursAt(doc, visibleIndex); // throws RangeError past the end
  return placeInsert(doc, me, nextSeq, left, right, content);
}

/** `localInsert` given the index of `doc` (E47): the neighbours come from the index in O(1), so a keystroke costs no traversal. Same op, same result; `index` must describe `doc`. */
export function localInsertAt(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, visibleIndex: number, content: Content): { ops: readonly Op[]; doc: Doc } {
  const { left, right } = index.neighboursAt(visibleIndex); // throws RangeError outside 0..length
  return placeInsert(doc, me, nextSeq, left, right, content);
}

function deleteTargets(doc: Doc, me: ReplicaId, nextSeq: number, targets: readonly ItemId[]): { ops: readonly Op[]; doc: Doc } {
  const ops: Op[] = targets.map((target, i) => ({ t: 'del', id: { replica: me, seq: nextSeq + i }, target }));
  return { ops, doc: mustApply(doc, ops) };
}

function checkRange(visibleFrom: number, visibleTo: number, length: number): void {
  checkIndex(visibleFrom, length, 'visibleFrom');
  checkIndex(visibleTo, length, 'visibleTo');
  if (visibleFrom > visibleTo) throw new RangeError(`visibleFrom ${visibleFrom} is after visibleTo ${visibleTo}`);
}

export function localDelete(doc: Doc, me: ReplicaId, nextSeq: number, visibleFrom: number, visibleTo: number): { ops: readonly Op[]; doc: Doc } {
  const visible = visibleItems(doc);
  checkRange(visibleFrom, visibleTo, visible.length);
  return deleteTargets(doc, me, nextSeq, visible.slice(visibleFrom, visibleTo).map((item) => item.id));
}

/** `localDelete` given the index of `doc` (E47): the targets are read off the index, O(k) for k items and no traversal. `index` must describe `doc`. */
export function localDeleteAt(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, visibleFrom: number, visibleTo: number): { ops: readonly Op[]; doc: Doc } {
  checkRange(visibleFrom, visibleTo, index.length);
  const targets: ItemId[] = [];
  for (let v = visibleFrom; v < visibleTo; v++) targets.push(index.idAt(v) as ItemId);
  return deleteTargets(doc, me, nextSeq, targets);
}

/**
 * Format visible `[from, to)` with `mark`. A value-carrying mark takes its value where the op needs
 * it: `link` an `href`, a colour a `value` (design S6). The value rides only an ACTIVE write — turning
 * a mark off carries none. Both are validated at the wire; here they are passed through unread.
 */
export function localFormat(doc: Doc, me: ReplicaId, nextSeq: number, visibleFrom: number, visibleTo: number, mark: MarkName, active: boolean, value?: string): { ops: readonly Op[]; doc: Doc } {
  const visible = visibleItems(doc);
  checkIndex(visibleFrom, visible.length, 'visibleFrom');
  checkIndex(visibleTo, visible.length, 'visibleTo');
  if (visibleFrom > visibleTo) throw new RangeError(`visibleFrom ${visibleFrom} is after visibleTo ${visibleTo}`);
  const targets = visible.slice(visibleFrom, visibleTo).map((item) => item.id);
  // One lamport for the whole logical format, so the chunks of a split range agree with each other.
  const lamport = nextFormatLamport(doc);
  // A link stores its value under `href`, a colour under `value`; every other mark carries neither.
  const carry: { href?: string } | { value?: string } | Record<string, never> =
    !active || value === undefined ? {} : mark === 'link' ? { href: value } : mark === 'textColor' || mark === 'highlightColor' ? { value } : {};
  const ops: Op[] = [];
  for (let i = 0; i < targets.length; i += MAX_FMT_TARGETS) {
    const id = { replica: me, seq: nextSeq + ops.length };
    const chunk = targets.slice(i, i + MAX_FMT_TARGETS);
    ops.push({ t: 'fmt', id, targets: chunk, mark, active, lamport, ...carry });
  }
  return { ops, doc: mustApply(doc, ops) };
}

/** Sets the type of the block that holds visible index `visibleIndexInBlock` — one `blk` on its closing boundary. One traversal to find it; `localSetBlockAt` is the same op given the index. */
export function localSetBlock(doc: Doc, me: ReplicaId, nextSeq: number, visibleIndexInBlock: number, attrs: BlockAttrs): { ops: readonly Op[]; doc: Doc } {
  return localSetBlockAt(doc, buildIndex(doc), me, nextSeq, visibleIndexInBlock, attrs);
}

/** `localSetBlock` given the index of `doc` (E47). `index` must describe `doc`. */
export function localSetBlockAt(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, visibleIndexInBlock: number, attrs: BlockAttrs): { ops: readonly Op[]; doc: Doc } {
  checkIndex(visibleIndexInBlock, index.length, 'visibleIndexInBlock');
  // Ranges tile 0..length; position i belongs to the first block whose closing boundary is at or after it.
  const block = blockRangeAt(index, visibleIndexInBlock);
  if (idKey(block.boundary) === ROOT_KEY) {
    // The trailing block is closed by the root sentinel, which is never a target. The binding
    // inserts an explicit boundary before it asks for the type (S3/S6 normalize).
    throw new RangeError('the trailing block is closed by the root sentinel; insert a boundary item first');
  }
  const op: Op = { t: 'blk', id: { replica: me, seq: nextSeq }, target: block.boundary, attrs, lamport: nextFormatLamport(doc) };
  return { ops: [op], doc: mustApply(doc, [op]) };
}
