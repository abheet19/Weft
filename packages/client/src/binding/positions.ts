// positions.ts — the three coordinate systems of the binding and the maps between them. A CRDT
// visible index counts items (one per code point, one per block boundary); a ProseMirror position
// counts UTF-16 code units plus one token for each node boundary it crosses; an ItemAnchor names
// the item a cursor sits after, which is the only form that survives concurrent edits. This file
// exists so the offset formula is written once: an astral character is one item and two PM units,
// and every other module treats both as opaque — including `tokensInRange`, the tokens a PM range
// covers, which is how toOps.ts reads a step without tokenizing the blocks around it. It must
// never guess when the two disagree — a position outside the document or between two UTF-16 units
// is a programmer error and throws — and never touch a Doc or a transaction: it reads a PM node
// and a PositionIndex, nothing else.

import type { ItemId, PositionIndex } from '@weft/crdt';
import type { ItemAnchor } from '@weft/protocol';
import type { Node as PMNode } from 'prosemirror-model';
import { attrsOfBlock, blockVisibleLength, safeChar, type Token } from './tokens.ts';

/** UTF-16 length of the first `count` code points of `text` — used only on plain text (no breaks), where a code-point offset maps straight to a unit offset. */
export function unitsOfCodePoints(text: string, count: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen === count) break;
    units += ch.length;
    seen++;
  }
  return units;
}

/**
 * PM units to reach the `count`-th visible inline token of `block` — the inverse of the walk in
 * `pmPosToVisible`'s partial. A char is 1 or 2 units, a break is 1; counting tokens rather than
 * code units is what makes a hard_break one visible index. Walked without allocating, so the hot
 * path stays cheap on a 50 000-character block (finding 4).
 */
function unitsToVisible(block: PMNode, count: number): number {
  if (count <= 0) return 0;
  let unit = 0;
  let tokens = 0;
  for (let i = 0; i < block.childCount; i++) {
    const node = block.child(i);
    if (node.isText) {
      for (const ch of node.text as string) {
        if (tokens === count) return unit;
        unit += ch.length;
        tokens++;
      }
    } else {
      if (tokens === count) return unit;
      unit += node.nodeSize;
      tokens++;
    }
  }
  return unit; // count === the block's token count: the end of its content
}

/**
 * PM positions count node boundaries; visible indexes count items. This is the only place that
 * knows the offset formula. A fractional position is a programmer error (RangeError), as is one
 * outside the document (ProseMirror's own RangeError). A position between the two UTF-16 units of
 * a surrogate pair — which no browser selection produces — rounds UP to the index after the pair.
 */
export function pmPosToVisible(doc: PMNode, pos: number): number {
  if (!Number.isInteger(pos)) throw new RangeError(`PM position ${pos} is not an integer`);
  const $pos = doc.resolve(pos);
  const blockIndex = $pos.index(0);
  let visible = 0;
  for (let i = 0; i < blockIndex; i++) visible += blockVisibleLength(doc.child(i)) + 1;
  // At depth 0 the position sits between blocks: before block `blockIndex`, or at the very end. The
  // start of the next block is the nearest cursor position, and the end of the document is the
  // end of the last block, which is the last visible index.
  if ($pos.depth === 0) return blockIndex < doc.childCount ? visible : visible - 1;
  // Within the block: count the inline tokens whose unit offset is before parentOffset (no allocation).
  const parent = $pos.parent;
  const offset = $pos.parentOffset;
  let unit = 0;
  let tokens = 0;
  for (let i = 0; i < parent.childCount && unit < offset; i++) {
    const node = parent.child(i);
    if (node.isText) {
      for (const ch of node.text as string) {
        if (unit >= offset) break;
        unit += ch.length;
        tokens++;
      }
    } else {
      unit += node.nodeSize;
      tokens++;
    }
  }
  return visible + tokens;
}

export function visibleToPmPos(doc: PMNode, index: number): number {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`visible index ${index} is negative or not an integer`);
  let base = 0;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    const length = blockVisibleLength(block);
    // A block covers indexes base..base+length inclusive; the boundary that closes it is base+length+1,
    // which is where the next block begins — so every index belongs to exactly one block.
    if (index <= base + length) return pos + 1 + unitsToVisible(block, index - base);
    base += length + 1;
    pos += block.nodeSize;
  }
  throw new RangeError(`visible index ${index} is past the end of a document with ${base - 1} visible items`);
}

/**
 * The tokens the PM range `from..to` covers, in order: the code points and breaks inside it, plus
 * the boundary token of every non-trailing block whose closing position (`after(block) - 1`, the
 * end of its content) lies within the range — so `setNodeMarkup` over `[before, after]` covers that
 * block's token, a split's new boundary covers the new one, and a character typed mid-block covers
 * none. An inline token is covered when its own start unit lies in the range, which keeps a break
 * (one unit) and a char (one code point) each atomic. The first token is the one
 * `pmPosToVisible(doc, from)` names, which is what lets a step be read as a diff of two short lists.
 */
export function tokensInRange(doc: PMNode, from: number, to: number): Token[] {
  if (from > to) throw new RangeError(`PM range ${from}..${to} is reversed`);
  const out: Token[] = [];
  const first = doc.resolve(from).index(0);
  let pos = 0;
  for (let b = 0; b < first; b++) pos += doc.child(b).nodeSize;
  for (let b = first; b < doc.childCount; b++) {
    const block = doc.child(b);
    const start = pos + 1;
    const end = pos + block.nodeSize - 1;
    if (start > to) break;
    // Walk the block's inline children, emitting only the tokens whose start unit lies in the range
    // (so a break and a char stay atomic); allocate one token per hit, none per skipped code point,
    // and stop the walk once past the range so a small edit in a huge block stays O(range).
    let unit = 0;
    walk: for (let i = 0; i < block.childCount; i++) {
      const node = block.child(i);
      if (node.isText) {
        for (const ch of node.text as string) {
          const at = start + unit;
          if (at >= to) break walk;
          if (at >= from) out.push({ kind: 'char', text: safeChar(ch) });
          unit += ch.length;
        }
      } else {
        const at = start + unit;
        if (at >= to) break walk;
        if (at >= from) out.push({ kind: 'break' });
        unit += node.nodeSize;
      }
    }
    if (b < doc.childCount - 1 && from <= end && to >= end) out.push({ kind: 'block', attrs: attrsOfBlock(block) });
    pos += block.nodeSize;
  }
  return out;
}

/**
 * The item the cursor at `visible` sits after; at 0 it sits after ROOT (`id: null`), so a remote
 * insert at the cursor's own index lands AFTER the cursor at 0 exactly as it does anywhere else
 * (`{ id: x, side: 'after' }` resolves to the index right after `x`, whatever arrives behind it).
 */
export function anchorFromVisible(index: PositionIndex, visible: number): ItemAnchor {
  if (!Number.isInteger(visible) || visible < 0 || visible > index.length) throw new RangeError(`visible index ${visible} is outside 0..${index.length}`);
  return visible === 0 ? { id: null, side: 'after' } : { id: index.idAt(visible - 1) as ItemId, side: 'after' };
}

/** Clamps to a live neighbour if the anchor item is deleted. `id: null` is ROOT — index 0 on either side. An id this replica has not received yet resolves to 0; presence (S5) checks `visibleBefore` first and hides such carets, and the local selection never names an item its own doc lacks. */
export function visibleFromAnchor(index: PositionIndex, a: ItemAnchor): number {
  if (a.id === null) return 0;
  const before = index.visibleBefore(a.id);
  if (before < 0) return 0;
  // A tombstone has no offset of its own; the live items ahead of it are where it was.
  const live = index.indexOf(a.id) >= 0;
  return live && a.side === 'after' ? before + 1 : before;
}

/**
 * A remote caret's visible offset, or null when the anchor names an item this replica has not
 * received (`visibleBefore < 0`). A peer's cursor can honestly reference an id we lack — it typed
 * ahead of what has reached us, or a hostile peer anchored to a non-existent id (LLD §8 S5). Either
 * way the caret is HIDDEN, not clamped to 0, so it never jumps to the document start and mislead;
 * the runner still counted the presence frame. A deleted (tombstoned) item still resolves — its
 * caret clamps to where it was, which is the concurrent-edit survival the demo points at.
 */
export function anchorVisibleOrHidden(index: PositionIndex, a: ItemAnchor): number | null {
  if (a.id === null) return 0;
  const before = index.visibleBefore(a.id);
  if (before < 0) return null;
  const live = index.indexOf(a.id) >= 0;
  return live && a.side === 'after' ? before + 1 : before;
}
