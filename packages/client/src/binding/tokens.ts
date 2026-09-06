// tokens.ts — the one flat alphabet both sides of the binding speak. A ProseMirror document and a
// CRDT visible sequence are both read as a list of tokens: one code point per character, one token
// per SOFT BREAK (hard_break, E52), and one boundary per block that is CLOSED by an explicit item
// (the last block is closed by the root sentinel, so it has no token — design §2.2). This file
// exists so that "what changed" is a diff of two token lists, computed the same way for a local
// transaction (tokens → ops) and for a remote change (tokens → transaction), and so the invariant
// I7 is one comparison. One level up, a block is its attrs and its inline tokens WITH their marks
// (E53) — which is what a remote change is diffed by first, so a formatting change becomes
// addMark/removeMark rather than a rewrite. It must never look at PM positions (positions.ts owns
// that formula) and never emit a token `apply` would refuse: a lone surrogate or U+0000 in editor
// text becomes U+FFFD here, not a thrown error.

import { MARK_NAMES, ROOT_ATTRS, type BlockAttrs, type Item, type MarkName, type MarkSet } from '@weft/crdt';
import type { Node as PMNode } from 'prosemirror-model';

/** A structural token: a code point, a soft break, or a block boundary. Marks are carried one level up (see `InlineTok`), because a boundary carries none and the structural diff is mark-blind. */
export type Token = { readonly kind: 'char'; readonly text: string } | { readonly kind: 'break' } | { readonly kind: 'block'; readonly attrs: BlockAttrs };

/** Editor text is DOM text: a paste can carry a lone surrogate or a NUL, neither of which is a code point the CRDT stores (E10). U+FFFD is what every decoder substitutes. */
const REPLACEMENT = '�';

function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/** The code point sanitised to what the CRDT can store (E10). */
export function safeChar(ch: string): string {
  const cp = ch.codePointAt(0) as number;
  return cp === 0 || isLoneSurrogate(cp) ? REPLACEMENT : ch;
}

/** Code points in `text`, which is what the CRDT counts; `text.length` would count UTF-16 units. */
export function codePoints(text: string): number {
  let n = 0;
  // The string iterator yields code points; counting its steps avoids allocating `[...text]` per block.
  for (const it = text[Symbol.iterator](); !it.next().done; ) n++;
  return n;
}

/**
 * One entry per visible inline token of a PM block, in order: its token, its PM unit offset within
 * the block's content (an astral char is two units, a break is one), and its unit width. This is
 * the one walk that knows a hard_break is an inline node with no `textContent`, so every coordinate
 * map below counts it as one token / one unit rather than skipping it.
 */
export interface InlineEntry {
  readonly token: Token;
  readonly unit: number;
  readonly width: number;
}

export function inlineEntries(block: PMNode): InlineEntry[] {
  const out: InlineEntry[] = [];
  let unit = 0;
  block.forEach((node) => {
    if (node.isText) {
      for (const ch of node.text as string) {
        out.push({ token: { kind: 'char', text: safeChar(ch) }, unit, width: ch.length });
        unit += ch.length;
      }
    } else {
      // A hard_break (the only non-text inline in the schema): one token, one unit.
      out.push({ token: { kind: 'break' }, unit, width: node.nodeSize });
      unit += node.nodeSize;
    }
  });
  return out;
}

/** Visible token count of a block, without allocating the entries: code points of its text plus one per inline leaf (a break). */
export function blockVisibleLength(block: PMNode): number {
  let n = 0;
  block.forEach((node) => (n += node.isText ? codePoints(node.text as string) : 1));
  return n;
}

/** `level` means something only on a heading, and a heading always has one: the one shape both sides agree on (design §5.3 "schema mismatch"). */
export function normalizeAttrs(attrs: BlockAttrs): BlockAttrs {
  if (attrs.type === 'heading') return { type: 'heading', level: attrs.level ?? 1 };
  return { type: attrs.type };
}

export function sameAttrs(a: BlockAttrs, b: BlockAttrs): boolean {
  return a.type === b.type && a.level === b.level;
}

/** The CRDT block attrs of a schema block node. The node names are the schema's; the attrs are the CRDT's — this is the only place the two vocabularies meet. */
export function attrsOfBlock(block: PMNode): BlockAttrs {
  switch (block.type.name) {
    case 'heading':
      return normalizeAttrs({ type: 'heading', level: block.attrs.level as 1 | 2 | 3 });
    case 'bullet_item':
      return { type: 'bullet' };
    case 'quote':
      return { type: 'quote' };
    default:
      return { type: 'paragraph' };
  }
}

/** Tokens of the blocks `from` (inclusive) to `to` (exclusive) of a PM doc. The doc's last block gets no boundary token. */
function tokensOfBlocks(doc: PMNode, from: number, to: number): Token[] {
  const out: Token[] = [];
  for (let i = from; i < to; i++) {
    const block = doc.child(i);
    for (const e of inlineEntries(block)) out.push(e.token);
    if (i < doc.childCount - 1) out.push({ kind: 'block', attrs: attrsOfBlock(block) });
  }
  return out;
}

export function tokensOfPm(doc: PMNode): Token[] {
  return tokensOfBlocks(doc, 0, doc.childCount);
}

export function tokenOf(item: Item): Token {
  if (item.content.kind === 'char') return { kind: 'char', text: item.content.text };
  if (item.content.kind === 'break') return { kind: 'break' };
  return { kind: 'block', attrs: normalizeAttrs(item.content.attrs) };
}

export function tokensOfItems(items: readonly Item[]): Token[] {
  return items.map(tokenOf);
}

export function sameToken(a: Token, b: Token): boolean {
  if (a.kind === 'char') return b.kind === 'char' && a.text === b.text;
  if (a.kind === 'break') return b.kind === 'break';
  return b.kind === 'block' && sameAttrs(a.attrs, b.attrs);
}

/** Two token lists have the same char/break/boundary SHAPE, ignoring block attrs — the I7 text check. A boundary's TYPE is an LWW register normalise resolves (quiet), so only a lost or gained character/break/boundary is a mirror fault. */
export function sameTextShape(a: readonly Token[], b: readonly Token[]): boolean {
  return a.length === b.length && a.every((t, i) => t.kind === (b[i] as Token).kind && (t.kind !== 'char' || t.text === (b[i] as Token & { kind: 'char' }).text));
}

/** The change from `before` to `after` as one replacement: tokens `[from, from + removed)` of `before` become `inserted`. Common prefix and suffix are excluded, so a single typed character is a one-token diff. */
export interface TokenDiff {
  readonly from: number;
  readonly removed: number;
  readonly inserted: readonly Token[];
}

/** Prefix/suffix diff of two sequences under `same`: `[from, from + removed)` of `before` becomes `after[from, after.length - suffix)`. */
function diffSequences<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean): { from: number; removed: number; to: number } {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && same(before[prefix] as T, after[prefix] as T)) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && same(before[before.length - 1 - suffix] as T, after[after.length - 1 - suffix] as T)) suffix++;
  return { from: prefix, removed: before.length - prefix - suffix, to: after.length - suffix };
}

export function diffTokens(before: readonly Token[], after: readonly Token[]): TokenDiff {
  const d = diffSequences(before, after, sameToken);
  return { from: d.from, removed: d.removed, inserted: after.slice(d.from, d.to) };
}

/** The change between two RAW texts, in code points — the editor's text as it is, so a lone surrogate the CRDT stores as U+FFFD is a difference the correction replaces, not one the alphabet hides. */
export function diffText(before: string, after: string): { readonly from: number; readonly removed: number; readonly inserted: string } {
  const b = [...before];
  const a = [...after];
  const d = diffSequences(b, a, (x, y) => x === y);
  return { from: d.from, removed: d.removed, inserted: a.slice(d.from, d.to).join('') };
}

/** Plain text of a token list — the `textOf` of invariant I7. A boundary is a newline, a break a line separator (distinct, so a fault report tells them apart). */
export function textOfTokens(tokens: readonly Token[]): string {
  return tokens.map((t) => (t.kind === 'char' ? t.text : t.kind === 'break' ? ' ' : '\n')).join('');
}

// ---------- marks and the block alphabet (E53) ----------

/** One active mark on an item or inline node: its name and, for a link, its href. Ordered by MARK_NAMES so two equal sets compare element-wise. */
export interface ActiveMark {
  readonly name: MarkName;
  readonly href?: string;
}

/** The active marks of a CRDT item, in MARK_NAMES order. A mark whose register is inactive is not present. */
function activeMarksOf(marks: MarkSet): ActiveMark[] {
  const out: ActiveMark[] = [];
  for (const name of MARK_NAMES) {
    const state = marks[name];
    if (state?.active !== true) continue;
    out.push(name === 'link' && state.href !== undefined ? { name, href: state.href } : { name });
  }
  return out;
}

/** The active marks of a PM inline node, in MARK_NAMES order — the same order as `activeMarksOf`, so the two are comparable. A mark the schema does not know is ignored (there are none). */
function marksOfPm(node: PMNode): ActiveMark[] {
  const names = new Set(node.marks.map((m) => m.type.name));
  const out: ActiveMark[] = [];
  for (const name of MARK_NAMES) {
    if (!names.has(name)) continue;
    const mark = node.marks.find((m) => m.type.name === name);
    out.push(name === 'link' ? { name, href: (mark?.attrs.href as string | undefined) ?? '' } : { name });
  }
  return out;
}

function sameMarks(a: readonly ActiveMark[], b: readonly ActiveMark[]): boolean {
  return a.length === b.length && a.every((m, i) => m.name === (b[i] as ActiveMark).name && m.href === (b[i] as ActiveMark).href);
}

/** One inline token WITH its marks: a char or a break. This is what a mark-aware diff compares within a block. */
export type InlineTok = { readonly kind: 'char'; readonly text: string; readonly marks: readonly ActiveMark[] } | { readonly kind: 'break'; readonly marks: readonly ActiveMark[] };

function sameInlineTok(a: InlineTok, b: InlineTok): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'char' && b.kind === 'char' && a.text !== b.text) return false;
  return sameMarks(a.marks, b.marks);
}

/** True when two token lists carry the same char/break sequence, ignoring marks — the condition for a marks-only diff (addMark/removeMark) instead of a rewrite. */
export function sameInlineShape(a: readonly InlineTok[], b: readonly InlineTok[]): boolean {
  return a.length === b.length && a.every((t, i) => t.kind === (b[i] as InlineTok).kind && (t.kind !== 'char' || t.text === (b[i] as InlineTok & { kind: 'char' }).text));
}

/** The alphabet one level up: a block is its attrs and its inline tokens with marks. The trailing block's attrs are the root sentinel's (E5). */
export interface Block {
  readonly attrs: BlockAttrs;
  /** The char text only (breaks excluded) — kept for the pure-text inline replace path (E50) when neither side has marks or breaks. */
  readonly text: string;
  readonly inlines: readonly InlineTok[];
}

export function sameBlock(a: Block, b: Block): boolean {
  return sameAttrs(a.attrs, b.attrs) && a.inlines.length === b.inlines.length && a.inlines.every((t, i) => sameInlineTok(t, b.inlines[i] as InlineTok));
}

/** True when a block has no marks and no breaks — the shape the S3 pure-text inline replace still handles (E50). */
export function isPlainText(block: Block): boolean {
  return block.inlines.every((t) => t.kind === 'char' && t.marks.length === 0);
}

/** Blocks of a visible sequence: each boundary closes the inlines before it; ROOT closes the rest. No items is one empty paragraph. */
export function blocksOfItems(items: readonly Item[]): Block[] {
  const blocks: Block[] = [];
  let inlines: InlineTok[] = [];
  let text = '';
  const flush = (attrs: BlockAttrs): void => {
    blocks.push({ attrs, text, inlines });
    inlines = [];
    text = '';
  };
  for (const item of items) {
    if (item.content.kind === 'block') {
      flush(normalizeAttrs(item.content.attrs));
      continue;
    }
    const marks = activeMarksOf(item.marks);
    if (item.content.kind === 'break') inlines.push({ kind: 'break', marks });
    else {
      inlines.push({ kind: 'char', text: item.content.text, marks });
      text += item.content.text;
    }
  }
  flush(ROOT_ATTRS);
  return blocks;
}

/** Blocks of a PM doc, inline tokens read node by node so a hard_break is one token and each char carries its marks; the last block's attrs are the editor's (a trailing heading differs from the CRDT's paragraph and is corrected). */
export function blocksOfPm(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.forEach((block) => {
    const inlines: InlineTok[] = [];
    let text = '';
    block.forEach((node) => {
      const marks = marksOfPm(node);
      if (node.isText) {
        // Raw text, NOT sanitised: a lone surrogate or NUL the editor holds must differ from the CRDT's
        // U+FFFD so the correction replaces it (the sanitisation happens on the way IN, in tokens/toOps).
        for (const ch of node.text as string) {
          inlines.push({ kind: 'char', text: ch, marks });
          text += ch;
        }
      } else inlines.push({ kind: 'break', marks });
    });
    blocks.push({ attrs: attrsOfBlock(block), text, inlines });
  });
  return blocks;
}
