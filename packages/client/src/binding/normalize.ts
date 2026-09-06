// normalize.ts — from a CRDT sequence to the ONE schema-valid ProseMirror document it means.
// This file exists because the CRDT can express what the schema forbids (design §5.3): an empty
// sequence, a heading level on a bullet, a heading with no level, two boundaries in a row. Every
// such sequence must map to exactly one valid doc on every replica, deterministically and without
// emitting an op — the CRDT stays the truth and the editor shows its normal form. Marks are now
// part of that normal form (E53): consecutive inline tokens with the same active-mark set become
// one marked text node, and a soft break (E52) becomes a hard_break carrying those marks — so the
// editor's marks and breaks are exactly the CRDT's. It must never throw on a sequence `apply`
// accepted.

import { type BlockAttrs, type Item } from '@weft/crdt';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema } from './schema.ts';
import { blocksOfItems, type ActiveMark, type Block, type InlineTok } from './tokens.ts';

/** ProseMirror marks for a set of active CRDT marks. A link's href is its attr; the others are attr-less. */
function pmMarks(marks: readonly ActiveMark[]): readonly Mark[] {
  return marks.map((m) => (m.name === 'link' ? schema.marks.link!.create({ href: m.href ?? '' }) : schema.marks[m.name]!.create()));
}

/** Inline nodes for a block's tokens: runs of chars with equal marks coalesce into one text node; a break is a hard_break carrying the same marks so `state.doc.eq(normalize(...))` holds. */
export function inlineNodesOf(inlines: readonly InlineTok[]): PMNode[] {
  const out: PMNode[] = [];
  let run = '';
  let runMarks: readonly ActiveMark[] = [];
  const flush = (): void => {
    if (run !== '') out.push(schema.text(run, pmMarks(runMarks) as Mark[]));
    run = '';
  };
  for (const tok of inlines) {
    if (tok.kind === 'char') {
      if (run !== '' && !sameActive(tok.marks, runMarks)) flush();
      run += tok.text;
      runMarks = tok.marks;
    } else {
      flush();
      out.push(schema.node('hard_break', null, undefined, pmMarks(tok.marks) as Mark[]));
    }
  }
  flush();
  return out;
}

function sameActive(a: readonly ActiveMark[], b: readonly ActiveMark[]): boolean {
  return a.length === b.length && a.every((m, i) => m.name === (b[i] as ActiveMark).name && m.href === (b[i] as ActiveMark).href);
}

/** The schema node for one block from its attrs and inline nodes. A heading without a level is an h1; a level on anything else is dropped. */
function blockNodeOf(attrs: BlockAttrs, content: readonly PMNode[]): PMNode {
  switch (attrs.type) {
    case 'heading':
      return schema.node('heading', { level: attrs.level ?? 1 }, content);
    case 'bullet':
      return schema.node('bullet_item', null, content);
    case 'quote':
      return schema.node('quote', null, content);
    default:
      return schema.node('paragraph', null, content);
  }
}

/** A block from attrs and plain text — the marks-free, breaks-free path (E50's pure-text inline replace and its rebuilds). */
export function blockNode(attrs: BlockAttrs, text: string): PMNode {
  return blockNodeOf(attrs, text === '' ? [] : [schema.text(text)]);
}

/** A block from the mark-carrying alphabet — used to rebuild a whole block whose marks or breaks changed. */
export function blockOf(block: Block): PMNode {
  return blockNodeOf(block.attrs, inlineNodesOf(block.inlines));
}

/** The CRDT can express what the PM schema forbids (empty doc, heading level on a bullet). Map every such sequence to one schema-valid doc, deterministically, without emitting ops. The trailing block is closed by the root sentinel, a paragraph (crdt E5, `ROOT_ATTRS`). */
export function normalize(items: readonly Item[]): PMNode {
  return schema.node('doc', null, blocksOfItems(items).map(blockOf));
}
