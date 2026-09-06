// keymap.ts — the binding's own keys, which exist because the schema's list item and quote are
// blocks of their own (no wrapper node), so ProseMirror's default Enter cannot know that the block
// after a bullet should be another bullet. One command: Enter at the end of a non-empty bullet item
// or quote continues the same block type; Enter in an EMPTY one ends the run by turning it into a
// paragraph; anywhere else it declines and the base keymap's splitBlock runs. It must never add a
// dependency, never dispatch a transaction the binding cannot read as a token diff (a split is a
// boundary insert, a type change is a `blk`), and never grow beyond keys the block model needs —
// marks and their shortcuts are S6.

import { setBlockType, splitBlockAs } from 'prosemirror-commands';
import type { NodeType } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import { schema } from './schema.ts';

function nodeType(name: string): NodeType {
  const type = schema.nodes[name];
  if (type === undefined) throw new Error(`schema has no node ${name}`);
  return type;
}

/** The block types whose Enter continues them. Headings deliberately not: Enter at the end of a heading starts a paragraph, as everywhere. */
const CONTINUING: ReadonlySet<NodeType> = new Set([nodeType('bullet_item'), nodeType('quote')]);

/** Enter inside a bullet item or quote: continue the type at the end of a non-empty one, end the run in an empty one, else decline. */
export const enterInListBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || !CONTINUING.has($from.parent.type)) return false;
  if ($from.parent.content.size === 0) return setBlockType(nodeType('paragraph'))(state, dispatch);
  return splitBlockAs((node, atEnd) => (atEnd && CONTINUING.has(node.type) ? { type: node.type, attrs: node.attrs } : null))(state, dispatch);
};
