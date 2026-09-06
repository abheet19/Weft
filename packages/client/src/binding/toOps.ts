// toOps.ts — from a local ProseMirror transaction to CRDT ops. This file exists so that whatever
// the editor did — a keystroke, Enter, Backspace across a block boundary, a paste of ten
// paragraphs, a block-type change, a drag the schema rewrote — becomes the same thing: the token
// diff of the PM range each step changed, turned into `del` ops for what left, a run of `ins` ops
// for what arrived, or a `blk` for a boundary that only changed its attrs (the LWW register is
// what makes a concurrent keystroke into that block survive), in document order. Reading the diff
// rather than interpreting step shapes is what keeps this total over every Step ProseMirror can
// produce; reading only the changed range (positions.ts `tokensInRange`) and carrying the
// PositionIndex forward incrementally (crdt E47) is what keeps a keystroke into a 50 000-character
// document from touching those 50 000 characters. It must never read a PM position as a visible
// index by itself (positions.ts owns that formula), never mint an id or a seq (both are supplied),
// and never emit an op `apply` refuses — a local op that does not apply is a programmer error and
// throws.

import { apply, blockRangeAt, buildIndex, idKey, isMarkName, localDeleteAt, localFormat, localInsertAt, localSetBlockAt, ROOT_ATTRS, ROOT_KEY, type BlockAttrs, type Content, type Doc, type ItemId, type MarkName, type Op, type PositionIndex, type ReplicaId } from '@weft/crdt';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, type Step } from 'prosemirror-transform';
import { pmPosToVisible, tokensInRange, visibleToPmPos } from './positions.ts';
import { attrsOfBlock, diffTokens, normalizeAttrs, sameAttrs, sameToken, type Token } from './tokens.ts';

/** What a local transaction became: its ops, the doc and index they produced, and whether the join rule closed the trailing block. */
export interface LocalBuild {
  readonly ops: readonly Op[];
  readonly doc: Doc;
  /** The index of `doc`, derived incrementally from the input index — the plugin's next mirror. */
  readonly index: PositionIndex;
  /**
   * Set when a join left a block of a type the root sentinel cannot carry (anything but a paragraph,
   * E5) as the trailing block. The CRDT keeps the type by closing that block with an explicit
   * boundary before ROOT instead of letting normalisation demote it, so its normal form ends with one
   * more empty paragraph than the editor shows — the plugin appends it quietly (E48). Until S6 owns
   * the trailing block, that empty paragraph cannot be removed: joining it back is a no-op.
   */
  readonly trailingKept: boolean;
}

/** The PM range a step changed: `lo..hi` in the doc before, `newLo..newHi` in the doc after; null for a step that moved nothing (a mark step). */
function stepRange(step: Step): { lo: number; hi: number; newLo: number; newHi: number } | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let newLo = Number.POSITIVE_INFINITY;
  let newHi = Number.NEGATIVE_INFINITY;
  step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
    lo = Math.min(lo, oldStart);
    hi = Math.max(hi, oldEnd);
    newLo = Math.min(newLo, newStart);
    newHi = Math.max(newHi, newEnd);
  });
  return lo === Number.POSITIVE_INFINITY ? null : { lo, hi, newLo, newHi };
}

function contentOf(token: Token, me: ReplicaId): Content {
  if (token.kind === 'char') return { kind: 'char', text: token.text };
  if (token.kind === 'break') return { kind: 'break' };
  // A fresh boundary starts its LWW register at lamport 0: any later `blk` carries formatLamport + 1 and wins.
  return { kind: 'block', attrs: token.attrs, lamport: 0, replica: me };
}

/** A mark step (AddMark/RemoveMark) becomes one `fmt` op over the step's visible range (E53); link carries its href. Its range moves no positions, so the index it is applied against is unchanged. An unknown mark name (none exist in the schema) or an empty range emits nothing. */
function markStepToOps(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, before: PMNode, step: AddMarkStep | RemoveMarkStep): Built {
  const mark: Mark = step.mark;
  const name = mark.type.name;
  if (!isMarkName(name)) return { ops: [], doc, index };
  const from = pmPosToVisible(before, step.from);
  const to = pmPosToVisible(before, step.to);
  if (from >= to) return { ops: [], doc, index };
  const active = step instanceof AddMarkStep;
  // A value-carrying mark takes its value from the attr the schema names — a link's href, a colour's
  // color; it rides only an active write, mirrored by `localFormat`.
  const value = !active ? undefined : name === 'link' ? (mark.attrs.href as string | undefined) : name === 'textColor' || name === 'highlightColor' ? (mark.attrs.color as string | undefined) : undefined;
  const r = localFormat(doc, me, nextSeq, from, to, name as MarkName, active, value);
  // Marks change no item's POSITION, but they replace the item objects; the index caches items, so
  // it is rebuilt from the new doc rather than reused stale. Formatting is not the per-keystroke path.
  return { ops: r.ops, doc: r.doc, index: buildIndex(r.doc) };
}

interface Built {
  readonly ops: readonly Op[];
  readonly doc: Doc;
  readonly index: PositionIndex;
}

/**
 * Insert `tokens` so the first lands at visible index `at`. The first goes through `localInsertAt`
 * (the Fugue rule against the real neighbours, read off the index); each following token is the
 * right child of the one before it, which is exactly what `localInsert` at `at + k` would choose —
 * the new item has no right children yet — without its O(n) traversal per character, so a 50 000-
 * character paste costs O(k log n), not O(k · n). The index is derived once for the whole run.
 */
function insertRun(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, at: number, tokens: readonly Token[]): Built {
  const first = tokens[0];
  if (first === undefined) return { ops: [], doc, index };
  const head = localInsertAt(doc, index, me, nextSeq, at, contentOf(first, me));
  const ops: Op[] = [...head.ops];
  let cur = head.doc;
  let parent: ItemId = (head.ops[0] as Op).id;
  for (let k = 1; k < tokens.length; k++) {
    const op: Op = { t: 'ins', id: { replica: me, seq: nextSeq + k }, parent, side: 'R', content: contentOf(tokens[k] as Token, me) };
    const result = apply(cur, op);
    if (result.kind !== 'applied') throw new RangeError(`local insert was ${result.kind}: is nextSeq the replica's next seq?`);
    cur = result.doc;
    ops.push(op);
    parent = op.id;
  }
  return {
    ops,
    doc: cur,
    index: index.withInserted(
      cur,
      at,
      ops.map((op) => op.id),
    ),
  };
}

/** True when the diff rewrites boundaries in place: same length, chars equal pairwise, at least one boundary with different attrs, no char↔block swap. `setBlockType` over any number of blocks looks like this. */
function attrsOnly(removed: readonly Token[], inserted: readonly Token[]): boolean {
  if (removed.length === 0 || removed.length !== inserted.length) return false;
  let changed = false;
  for (let k = 0; k < removed.length; k++) {
    const a = removed[k] as Token;
    const b = inserted[k] as Token;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'char') {
      if (!sameToken(a, b)) return false;
    } else if (!sameToken(a, b)) changed = true;
  }
  return changed;
}

function stepToOps(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, before: PMNode, after: PMNode, step: Step): Built & { trailingKept: boolean } {
  // A mark step moves nothing (its map is empty), so it is read from the step itself, not the token diff.
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return { ...markStepToOps(doc, index, me, nextSeq, before, step), trailingKept: false };
  const range = stepRange(step);
  if (range === null) return { ops: [], doc, index, trailingKept: false };
  const beforeTokens = tokensInRange(before, range.lo, range.hi);
  const afterTokens = tokensInRange(after, range.newLo, range.newHi);
  const d = diffTokens(beforeTokens, afterTokens);
  if (d.removed === 0 && d.inserted.length === 0) return { ops: [], doc, index, trailingKept: false };
  const at = pmPosToVisible(before, range.lo) + d.from;
  const removed = beforeTokens.slice(d.from, d.from + d.removed);

  // A boundary that only changed its attrs is a `blk` on its register, not a delete and an insert:
  // a peer's concurrent keystroke into that block stays in that block (finding P17).
  if (attrsOnly(removed, d.inserted)) {
    const ops: Op[] = [];
    let cur = doc;
    let curIndex = index;
    d.inserted.forEach((token, k) => {
      if (token.kind !== 'block' || sameToken(removed[k] as Token, token)) return;
      const set = localSetBlockAt(cur, curIndex, me, nextSeq + ops.length, at + k, token.attrs);
      ops.push(...set.ops);
      cur = set.doc;
      curIndex = curIndex.withItem(cur, at + k);
    });
    return { ops, doc: cur, index: curIndex, trailingKept: false };
  }

  // A join: boundaries left and none arrived, so the block before the first deleted boundary and the
  // text after it are now one block. ProseMirror gives the merged block the FIRST block's type; the
  // CRDT gives it the type of the boundary that now closes it — the SECOND block's, or ROOT's
  // paragraph (E5). The join rule (E48) reconciles them below in favour of what the user saw.
  const joined = removed.some((t) => t.kind === 'block') && !d.inserted.some((t) => t.kind === 'block');
  // Joining the sentinel's empty paragraph back into the non-paragraph block before it would delete
  // that block's boundary and re-create it: nothing to do but restore the paragraph.
  if (joined && d.removed === 1 && d.inserted.length === 0 && at === index.length - 1) {
    const last: BlockAttrs = attrsOfBlock(after.lastChild as PMNode);
    if (!sameAttrs(last, ROOT_ATTRS) && sameToken(removed[0] as Token, { kind: 'block', attrs: last })) return { ops: [], doc, index, trailingKept: true };
  }

  let cur = doc;
  let curIndex = index;
  const ops: Op[] = [];
  if (d.removed > 0) {
    const del = localDeleteAt(cur, curIndex, me, nextSeq, at, at + d.removed);
    ops.push(...del.ops);
    cur = del.doc;
    curIndex = curIndex.withDeleted(cur, at, at + d.removed);
  }
  const ins = insertRun(cur, curIndex, me, nextSeq + ops.length, at, d.inserted);
  ops.push(...ins.ops);
  cur = ins.doc;
  curIndex = ins.index;
  let trailingKept = false;
  if (joined) {
    const closing = blockRangeAt(curIndex, at);
    const want = attrsOfBlock(after.child(after.resolve(visibleToPmPos(after, at)).index(0)));
    if (!sameAttrs(want, normalizeAttrs(closing.attrs))) {
      if (idKey(closing.boundary) === ROOT_KEY) {
        // Nothing closes the merged block but ROOT, whose paragraph cannot be retyped: close it with
        // an explicit boundary carrying its type, and ROOT's empty paragraph follows (the plugin
        // shows it). Until S6 owns the trailing block, that paragraph cannot be joined away.
        const close = insertRun(cur, curIndex, me, nextSeq + ops.length, curIndex.length, [{ kind: 'block', attrs: want }]);
        ops.push(...close.ops);
        cur = close.doc;
        curIndex = close.index;
        trailingKept = true;
      } else {
        const set = localSetBlockAt(cur, curIndex, me, nextSeq + ops.length, at, want);
        ops.push(...set.ops);
        cur = set.doc;
        curIndex = curIndex.withItem(cur, closing.to);
      }
    }
  }
  return { ops, doc: cur, index: curIndex, trailingKept };
}

/**
 * For each ReplaceStep / ReplaceAroundStep / AddMarkStep / RemoveMarkStep in a local transaction,
 * produce ops via local.ts. Pure given doc, index and the next seq; `index` must describe `doc`
 * (the mirror). Returns the doc AND its index after the ops — the caller's next mirror, derived
 * without a traversal.
 */
export function transactionToOps(doc: Doc, index: PositionIndex, me: ReplicaId, nextSeq: number, tr: Transaction): LocalBuild {
  const ops: Op[] = [];
  let cur = doc;
  let curIndex = index;
  let trailingKept = false;
  tr.steps.forEach((step, i) => {
    const before = tr.docs[i] as PMNode;
    const after = tr.docs[i + 1] ?? tr.doc;
    const result = stepToOps(cur, curIndex, me, nextSeq + ops.length, before, after, step);
    ops.push(...result.ops);
    cur = result.doc;
    curIndex = result.index;
    trailingKept ||= result.trailingKept;
  });
  // The trailing block has no boundary token, so a type change on it (setBlockType on the last block,
  // a paste ending in a heading) is invisible to the token diff. If the editor's last block is not
  // the CRDT's trailing type, close it with an explicit boundary before ROOT (E5/E54): the CRDT keeps
  // the type and normalize adds ROOT's empty paragraph, which the plugin appends quietly. A join that
  // already kept the trailing type (E48, `trailingKept`) inserted that boundary itself — do not add a
  // second one.
  const want = attrsOfBlock(tr.doc.lastChild as PMNode);
  const trailing = blockRangeAt(curIndex, curIndex.length);
  if (!trailingKept && idKey(trailing.boundary) === ROOT_KEY && !sameAttrs(want, ROOT_ATTRS)) {
    const close = insertRun(cur, curIndex, me, nextSeq + ops.length, curIndex.length, [{ kind: 'block', attrs: want }]);
    ops.push(...close.ops);
    cur = close.doc;
    curIndex = close.index;
    trailingKept = true;
  }
  return { ops, doc: cur, index: curIndex, trailingKept };
}
