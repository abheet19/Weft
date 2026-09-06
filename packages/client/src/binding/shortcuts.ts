// shortcuts.ts — the keyboard commands of the floating format bar (03-UI §4.4, E54), built over
// prosemirror-commands so a shortcut and a bar button are the same edit. This file exists so the
// keys work whether or not the bar is on screen and so the plugin has one place to compose them
// into its `handleKeyDown` (before the base keymap). It must add no dependency and dispatch only
// transactions the binding can read: a mark toggle is an AddMark/RemoveMark step (→ `fmt`), a block
// change is a setNodeMarkup (→ `blk`), and a break is one hard_break insert (→ an `ins` of a
// `break` item, E52). Link needs an href the keyboard cannot supply, so Ctrl+K removes a link the
// selection already has and otherwise asks the shell (`onLink`) to open the bar's input.

import { setBlockType, toggleMark } from 'prosemirror-commands';
import type { MarkType } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { schema } from './schema.ts';

/** True when every inline position in the (non-empty) selection carries `type` — the condition for Ctrl+K to REMOVE the link rather than open the input. */
export function linkAcrossSelection(state: EditorState, type: MarkType): boolean {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  return state.doc.rangeHasMark(from, to, type);
}

/** Insert a soft break at the selection (Shift+Enter / Mod+Enter). The CRDT sees one `ins` of a break item (E52). */
const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView());
  return true;
};

/** Ctrl+K: on a selection already fully linked, remove the link; otherwise ask the shell to open the href input. Never toggles a link with an empty href. */
function linkCommand(onLink: (() => void) | undefined): Command {
  return (state, dispatch) => {
    const type = schema.marks.link!;
    if (state.selection.empty) return false;
    if (linkAcrossSelection(state, type)) {
      if (dispatch) dispatch(state.tr.removeMark(state.selection.from, state.selection.to, type));
      return true;
    }
    onLink?.();
    return true;
  };
}

/** The format bar's keymap. `Mod` is Ctrl on Windows/Linux and Cmd on macOS, which is what the design's "Ctrl+…" means on the target platform. */
export function formatShortcuts(onLink?: () => void): Record<string, Command> {
  const heading = (level: 1 | 2 | 3): Command => setBlockType(schema.nodes.heading!, { level });
  return {
    'Mod-b': toggleMark(schema.marks.bold!),
    'Mod-i': toggleMark(schema.marks.italic!),
    'Mod-e': toggleMark(schema.marks.code!),
    'Mod-k': linkCommand(onLink),
    'Mod-Alt-1': heading(1),
    'Mod-Alt-2': heading(2),
    'Mod-Alt-3': heading(3),
    'Mod-Shift-8': setBlockType(schema.nodes.bullet_item!),
    'Mod-Shift-.': setBlockType(schema.nodes.quote!),
    'Shift-Enter': insertHardBreak,
    'Mod-Enter': insertHardBreak,
  };
}
