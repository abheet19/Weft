// toTransaction.ts — from a CRDT that moved on to the ProseMirror transaction that shows it. This
// file exists so a remote change reaches the editor as the smallest edit that explains it: the
// two documents are compared BLOCK BY BLOCK (common leading and trailing blocks are untouched),
// a block whose text changed gets one inline replace the editor maps the cursor through, a block
// whose type changed gets one `setNodeMarkup`, and only when the block count differs is the range
// of differing blocks replaced with their normal form — so two edits far apart arrive as two small
// steps, a `blk` on block 0 replaces nothing but block 0's markup, and a peer deleting the very
// paragraph the cursor sits in leaves the cursor beside the text that remains (selection carried
// as item anchors, design §5.3). The transaction is tagged `weft-remote` and carries the new
// mirror, so plugin.ts neither loops it back into ops nor rebuilds an index it already has. The
// same block diff is what the plugin's correction uses. It must never read a Doc other than
// through its index, and never produce a doc the schema rejects: every block it builds comes from
// normalize's `blockNode`.

import { buildIndex, MARK_NAMES, type Doc, type MarkName, type PositionIndex } from '@weft/crdt';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { blockNode, blockOf, inlineNodesOf } from './normalize.ts';
import { anchorFromVisible, pmPosToVisible, unitsOfCodePoints, visibleFromAnchor, visibleToPmPos } from './positions.ts';
import { inlineEntries, isPlainText, sameAttrs, sameBlock, sameInlineShape, blocksOfItems, blocksOfPm, diffText, type ActiveMark, type Block, type InlineTok } from './tokens.ts';
import { schema } from './schema.ts';

/** The CRDT state the editor currently mirrors: the doc and its position index, which are always built together. */
export interface Mirror {
  readonly doc: Doc;
  readonly index: PositionIndex;
}

/** Transaction meta key: a transaction that carries a Mirror under it came from the CRDT (or advanced the mirror after local ops) and must not be turned back into ops. */
export const REMOTE_META = 'weft-remote';

export function mirrorOf(doc: Doc): Mirror {
  return { doc, index: buildIndex(doc) };
}

/** Selection end points as item anchors in `before`, restored as positions in `doc` through `after`; a non-text selection (all, node) is left to ProseMirror's own mapping. */
function carrySelection(state: EditorState, before: PositionIndex, after: PositionIndex, tr: Transaction): void {
  if (!(state.selection instanceof TextSelection)) return;
  const carry = (pos: number): number => visibleToPmPos(tr.doc, visibleFromAnchor(after, anchorFromVisible(before, pmPosToVisible(state.doc, pos))));
  tr.setSelection(TextSelection.create(tr.doc, carry(state.selection.anchor), carry(state.selection.head)));
}

/**
 * Append to `tr` the steps that turn `tr.doc` — whose blocks are `before` — into a doc whose blocks
 * are `after`. Blocks equal at both ends are untouched; with an equal count in between, each
 * differing block is rewritten in place (inline replace of the changed code points, then its
 * markup), last block first so earlier positions stay valid; otherwise the differing range is
 * replaced as whole blocks.
 */
function replaceBlocks(tr: Transaction, before: readonly Block[], after: readonly Block[]): void {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && sameBlock(before[prefix] as Block, after[prefix] as Block)) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && sameBlock(before[before.length - 1 - suffix] as Block, after[after.length - 1 - suffix] as Block)) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  if (prefix === beforeEnd && prefix === afterEnd) return;
  const doc = tr.doc;
  // `starts[b]` is the first content position of block b; `boundary(b)` the position before block b (the document's end for b = childCount).
  const starts: number[] = [];
  let pos = 0;
  for (let b = 0; b < doc.childCount; b++) {
    starts.push(pos + 1);
    pos += doc.child(b).nodeSize;
  }
  const boundary = (b: number): number => (b < doc.childCount ? (starts[b] as number) - 1 : doc.content.size);
  if (beforeEnd - prefix !== afterEnd - prefix) {
    tr.replaceWith(boundary(prefix), boundary(beforeEnd), after.slice(prefix, afterEnd).map(blockOf));
    return;
  }
  for (let b = beforeEnd - 1; b >= prefix; b--) {
    const was = before[b] as Block;
    const is = after[b] as Block;
    const start = starts[b] as number;
    const contentEnd = start + doc.child(b).content.size;
    if (sameInlineShape(was.inlines, is.inlines)) {
      // Same char/break sequence, only marks differ: emit addMark/removeMark over the changed ranges (E53),
      // which keeps the cursor put and is exactly what a remote `fmt` means.
      markDiff(tr, start, doc.child(b), was.inlines, is.inlines);
    } else if (isPlainText(was) && isPlainText(is)) {
      // Neither side has marks or breaks: the S3 pure-text inline replace, which preserves the cursor (E50).
      const d = diffText(was.text, is.text);
      const from = start + unitsOfCodePoints(was.text, d.from);
      const to = start + unitsOfCodePoints(was.text, d.from + d.removed);
      tr.replaceWith(from, to, d.inserted === '' ? [] : schema.text(d.inserted));
    } else {
      // Marks or breaks moved: rebuild the whole block's inline content in its marked normal form.
      tr.replaceWith(start, contentEnd, inlineNodesOf(is.inlines));
    }
    if (!sameAttrs(was.attrs, is.attrs)) {
      const node = blockNode(is.attrs, '');
      tr.setNodeMarkup(start - 1, node.type, node.attrs);
    }
  }
}

/** The PM position of inline token `k` (its unit offset from the block's content start). `entries.length` is the token count; `k === length` is the block's content end. */
function tokenPos(start: number, entries: readonly { unit: number; width: number }[], k: number): number {
  const at = entries[k];
  if (at !== undefined) return start + at.unit;
  const last = entries[entries.length - 1];
  return last === undefined ? start : start + last.unit + last.width;
}

/** Append addMark/removeMark steps that turn `was`'s marks into `is`'s over a block whose char/break shape is unchanged. Per mark name, contiguous runs that gain the mark are added and runs that lose it (or whose link href changed) are removed then re-added. */
function markDiff(tr: Transaction, start: number, block: PMNode, was: readonly InlineTok[], is: readonly InlineTok[]): void {
  const entries = inlineEntries(block);
  const find = (marks: readonly ActiveMark[], name: MarkName): ActiveMark | undefined => marks.find((m) => m.name === name);
  for (const name of MARK_NAMES) {
    const removals: [number, number][] = [];
    const additions: [number, number, string | undefined][] = [];
    let k = 0;
    while (k < is.length) {
      const wasM = find((was[k] as InlineTok).marks, name);
      const isM = find((is[k] as InlineTok).marks, name);
      // A value-carrying mark whose value changed is a remove-then-add, so the DOM shows the new href/colour.
      const add = isM !== undefined && (wasM === undefined || wasM.value !== isM.value);
      const remove = wasM !== undefined && (isM === undefined || wasM.value !== isM.value);
      if (!add && !remove) {
        k++;
        continue;
      }
      // Extend a run of tokens with the same add/remove decision and (for additions) the same value.
      let j = k + 1;
      while (j < is.length) {
        const w2 = find((was[j] as InlineTok).marks, name);
        const i2 = find((is[j] as InlineTok).marks, name);
        const a2 = i2 !== undefined && (w2 === undefined || w2.value !== i2.value);
        const r2 = w2 !== undefined && (i2 === undefined || w2.value !== i2.value);
        if (a2 !== add || r2 !== remove || (add && i2?.value !== isM?.value)) break;
        j++;
      }
      const from = tokenPos(start, entries, k);
      const to = tokenPos(start, entries, j);
      if (remove) removals.push([from, to]);
      if (add) additions.push([from, to, isM?.value]);
      k = j;
    }
    const type = schema.marks[name];
    if (type === undefined) continue;
    for (const [from, to] of removals) tr.removeMark(from, to, type);
    for (const [from, to, value] of additions) {
      const mark = name === 'link' ? type.create({ href: value ?? '' }) : name === 'textColor' || name === 'highlightColor' ? type.create({ color: value ?? '' }) : type.create();
      tr.addMark(from, to, mark);
    }
  }
}

/** Given the editor's mirror before and the doc after remote ops, build the minimal PM transaction and tag it `weft-remote` so plugin.ts does not loop it back. One `buildIndex` — the O(n) the LLD puts on the remote path — and no separate traversal. */
export function opsToTransaction(before: PositionIndex, after: Doc, state: EditorState): Transaction {
  const afterIndex = buildIndex(after);
  const tr = state.tr.setMeta(REMOTE_META, { doc: after, index: afterIndex } satisfies Mirror);
  replaceBlocks(tr, blocksOfPm(state.doc), blocksOfItems(afterIndex.items()));
  if (tr.docChanged) carrySelection(state, before, afterIndex, tr);
  return tr;
}

/** The transaction that turns `state.doc` into the normal form of `mirror` while keeping the cursor at the same visible index (clamped: the fault case may have shortened the text), tagged with the mirror. */
export function correction(state: EditorState, mirror: Mirror): Transaction {
  const tr = state.tr.setMeta(REMOTE_META, mirror);
  replaceBlocks(tr, blocksOfPm(state.doc), blocksOfItems(mirror.index.items()));
  if (tr.docChanged && state.selection instanceof TextSelection) {
    const carry = (pos: number): number => visibleToPmPos(tr.doc, Math.min(mirror.index.length, pmPosToVisible(state.doc, pos)));
    tr.setSelection(TextSelection.create(tr.doc, carry(state.selection.anchor), carry(state.selection.head)));
  }
  return tr;
}
