// format.ts — the pure read the persistent toolbar (S6) draws its pressed state from, and the one
// list of formatting commands it and the keyboard share. This file exists so the toolbar's active
// state is testable without React: `activeFormat` reads which marks, which block type, and which
// colours the current selection carries, and every button in Toolbar.tsx runs a `prosemirror-commands`
// command over the SAME schema the shortcuts use (binding/shortcuts.ts), so a click and a keystroke
// are one edit. It must hold no DOM and no editor state — only read a state and describe a command.

import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { Mark, MarkType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { schema } from '../binding/schema.ts';

/** The boolean inline marks the toolbar toggles, in toolbar order. */
export const TOGGLE_MARKS = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'highlight'] as const;
export type ToggleMark = (typeof TOGGLE_MARKS)[number];

/** The active marks, colours and block type of the current selection — a pure read, so the toolbar's pressed state is asserted without rendering. */
export interface ActiveFormat {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly code: boolean;
  readonly highlight: boolean;
  readonly link: boolean;
  /** The block the selection starts in and, for a checklist item, its tick. */
  readonly block: { readonly type: string; readonly level: number | null; readonly checked: boolean | null };
  /** The link href over the selection, if it carries one — pre-fills the popover when editing a link. */
  readonly href: string | null;
  /** The text / highlight colour over the selection, if uniform; used to tint the swatch buttons. */
  readonly textColor: string | null;
  readonly highlightColor: string | null;
}

/** Whether `type` is active at the selection: over a range, present across all of it; empty, in the stored or cursor marks. */
function hasMark(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) return (state.storedMarks ?? $from.marks()).some((m) => m.type === type);
  return state.doc.rangeHasMark(from, to, type);
}

/** The value of a value-carrying mark (`link` → href, a colour → color) over the selection, or null: the first such value found, so an edit pre-fills with what is there. */
function markValueAt(state: EditorState, type: MarkType, attr: 'href' | 'color'): string | null {
  const { from, to, empty, $from } = state.selection;
  const read = (marks: readonly Mark[]): string | null => (marks.find((m) => m.type === type)?.attrs[attr] as string | undefined) ?? null;
  if (empty) return read($from.marks());
  let found: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found === null) found = read(node.marks);
  });
  return found;
}

export function activeFormat(state: EditorState): ActiveFormat {
  const { $from } = state.selection;
  const block = $from.parent;
  return {
    bold: hasMark(state, schema.marks.bold!),
    italic: hasMark(state, schema.marks.italic!),
    underline: hasMark(state, schema.marks.underline!),
    strikethrough: hasMark(state, schema.marks.strikethrough!),
    code: hasMark(state, schema.marks.code!),
    highlight: hasMark(state, schema.marks.highlight!),
    link: hasMark(state, schema.marks.link!),
    block: { type: block.type.name, level: (block.attrs.level as number | undefined) ?? null, checked: block.type.name === 'check_item' ? block.attrs.checked === true : null },
    href: markValueAt(state, schema.marks.link!, 'href'),
    textColor: markValueAt(state, schema.marks.textColor!, 'color'),
    highlightColor: markValueAt(state, schema.marks.highlightColor!, 'color'),
  };
}

/** Toggle a boolean mark by name — the command the matching keyboard shortcut runs. */
export function toggleMarkByName(name: ToggleMark): Command {
  return toggleMark(schema.marks[name]!);
}

/** Set (or, on a colour value, replace) a value-carrying mark over the current selection; a null value clears it. Not a `toggleMark`, because a colour change is "become this colour", never a toggle. */
export function setColor(mark: 'textColor' | 'highlightColor', color: string | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    const type = schema.marks[mark]!;
    if (dispatch) {
      const tr = state.tr.removeMark(from, to, type);
      if (color !== null) tr.addMark(from, to, type.create({ color }));
      dispatch(tr);
    }
    return true;
  };
}

/** The eight block types the toolbar's block menu and its list buttons set, with a schema node each. A checklist item is set unchecked. */
export const BLOCK_CHOICES = [
  { type: 'paragraph', node: 'paragraph', label: 'Paragraph' },
  { type: 'heading1', node: 'heading', attrs: { level: 1 }, label: 'Heading 1' },
  { type: 'heading2', node: 'heading', attrs: { level: 2 }, label: 'Heading 2' },
  { type: 'heading3', node: 'heading', attrs: { level: 3 }, label: 'Heading 3' },
  { type: 'quote', node: 'quote', label: 'Quote' },
  { type: 'code', node: 'code_block', label: 'Code block' },
] as const;

/** Set the block type of the selection (a `setBlockType` over the schema node), the command the block menu and the list/quote/code buttons run. */
export function setBlock(node: string, attrs: Record<string, unknown> | null = null): Command {
  return setBlockType(schema.nodes[node]!, attrs ?? undefined);
}
