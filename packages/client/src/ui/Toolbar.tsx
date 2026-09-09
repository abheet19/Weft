// Toolbar.tsx — the persistent formatting toolbar of the redesign (S6, 03-UI §4.4), ported from the
// prototype's `.toolbar`. It replaces the floating format bar as the primary surface: it is always on
// screen, reflects the current selection's marks / block type / colours (the pure `activeFormat`),
// and every control runs the SAME `prosemirror-commands` the keyboard shortcuts do (binding/
// shortcuts.ts, ui/format.ts), so a click and a keystroke are one edit. Its only floating children are
// the block-type menu and the two colour palettes, which close on an outside press; the link POPOVER
// (the one persistent floating element) lives in Editor.tsx. It holds no document state.

import { useEffect, useRef, useState } from 'react';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { isSafeHref } from '@weft/protocol';
import { schema } from '../binding/schema.ts';
import { linkAcrossSelection } from '../binding/shortcuts.ts';
import { activeFormat, BLOCK_CHOICES, setBlock, setColor, toggleMarkByName, TOGGLE_MARKS, type ActiveFormat } from './format.ts';
import { Icon } from './Icons.tsx';

/** The palette the prototype ships: eight text colours, six highlight tints — all safe `#rrggbb` hexes `safeColor` accepts. */
const TEXT_COLORS = ['#17242c', '#0e8ea0', '#7c5cf0', '#c77d16', '#d3524a', '#1f9d6b', '#2b6fd6', '#b23c8e'];
const HIGHLIGHT_COLORS = ['#ffe8a3', '#c7f0d8', '#d6eef1', '#e9d8ff', '#ffd6d0', '#e7edf1'];

/** The label shown on the block-type button for the selection's current block. */
const BLOCK_LABEL: Record<string, string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bullet_item: 'Bullet list',
  ordered_item: 'Numbered list',
  check_item: 'Checklist',
  quote: 'Quote',
  code_block: 'Code block',
  divider: 'Divider',
};

/** The glyph shown for each toggle mark; a letter for the type ones, an icon for code and highlight. */
const MARK_GLYPH: Record<string, React.ReactNode> = {
  bold: <b>B</b>,
  italic: <i>I</i>,
  underline: <span className="u">U</span>,
  strikethrough: <span className="s">S</span>,
  code: <Icon name="code" />,
  highlight: <Icon name="mark" />,
};

const MARK_LABEL: Record<string, string> = {
  bold: 'Bold (Ctrl+B)',
  italic: 'Italic (Ctrl+I)',
  underline: 'Underline (Ctrl+U)',
  strikethrough: 'Strikethrough (Ctrl+Shift+S)',
  code: 'Inline code (Ctrl+E)',
  highlight: 'Highlight (Ctrl+Shift+H)',
};

interface ToolbarProps {
  view: EditorView;
  state: EditorState;
  /** The link input's open state, controlled by the shell so Ctrl+K (the plugin's `onLink`) opens the same input the Link button does. */
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  undo?: (() => void) | undefined;
  redo?: (() => void) | undefined;
}

/** Which floating menu, if any, is open. */
type Menu = 'block' | 'text' | 'highlight' | null;

export function Toolbar({ view, state, linkOpen, setLinkOpen, undo, redo }: ToolbarProps): React.JSX.Element {
  const af = activeFormat(state);
  const [menu, setMenu] = useState<Menu>(null);
  const [href, setHref] = useState('');
  const [hrefError, setHrefError] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (menu === null) return undefined;
    const close = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || e.target.closest('.tb-menu, .tb-swatch, #blockBtn') === null) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  const hrefRef = useRef(af.href);
  hrefRef.current = af.href;
  useEffect(() => {
    if (linkOpen) {
      setHref(hrefRef.current ?? '');
      setHrefError(false);
      input.current?.focus();
    }
  }, [linkOpen]);

  const run = (cmd: Command): void => {
    cmd(view.state, view.dispatch);
    view.focus();
  };
  const stop = (e: React.MouseEvent): void => e.preventDefault();

  const linkButton = (): void => {
    const type = schema.marks.link!;
    if (linkAcrossSelection(view.state, type)) {
      view.dispatch(view.state.tr.removeMark(view.state.selection.from, view.state.selection.to, type));
      view.focus();
    } else if (!view.state.selection.empty) setLinkOpen(!linkOpen);
  };
  const applyLink = (): void => {
    const type = schema.marks.link!;
    const { from, to } = view.state.selection;
    if (href !== '' && !isSafeHref(href)) {
      setHrefError(true);
      input.current?.focus();
      return;
    }
    if (href !== '' && from !== to) view.dispatch(view.state.tr.addMark(from, to, type.create({ href })));
    setLinkOpen(false);
    view.focus();
  };
  const insertDivider = (): void => {
    view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.divider!.create()).scrollIntoView());
    view.focus();
  };
  const pickColor = (mark: 'textColor' | 'highlightColor', color: string | null): void => {
    run(setColor(mark, color));
    setMenu(null);
  };

  const blockActive = (choice: (typeof BLOCK_CHOICES)[number], a: ActiveFormat): boolean =>
    choice.node === 'heading' ? a.block.type === 'heading' && a.block.level === choice.attrs.level : a.block.type === schema.nodes[choice.node]!.name;

  return (
    <div className="toolbar glass" role="toolbar" aria-label="Formatting" ref={barRef}>
      <div className="tgrp">
        <button type="button" className="tb" aria-label="Undo (Ctrl+Z)" onMouseDown={stop} onClick={() => undo?.()} disabled={undo === undefined}>
          <Icon name="undo" />
        </button>
        <button type="button" className="tb" aria-label="Redo (Ctrl+Y)" onMouseDown={stop} onClick={() => redo?.()} disabled={redo === undefined}>
          <Icon name="redo" />
        </button>
      </div>
      <span className="tb-sep" />
      <div className="tgrp">
        <button type="button" className="tb wide" id="blockBtn" aria-haspopup="menu" aria-expanded={menu === 'block'} onMouseDown={stop} onClick={() => setMenu((m) => (m === 'block' ? null : 'block'))}>
          <span>{BLOCK_LABEL[af.block.type] ?? 'Paragraph'}</span>
          <Icon name="chevd" />
        </button>
        {menu === 'block' && (
          <div className="tb-menu" role="menu">
            {BLOCK_CHOICES.map((choice) => (
              <button
                type="button"
                key={choice.type}
                className="tb-mi"
                role="menuitemradio"
                aria-checked={blockActive(choice, af)}
                onMouseDown={stop}
                onClick={() => {
                  run(setBlock(choice.node, 'attrs' in choice ? choice.attrs : null));
                  setMenu(null);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="tb-sep" />
      <div className="tgrp">
        {TOGGLE_MARKS.map((name) => (
          <button type="button" key={name} className={`tb${af[name] ? ' on' : ''}`} aria-pressed={af[name]} aria-label={MARK_LABEL[name]} onMouseDown={stop} onClick={() => run(toggleMarkByName(name))}>
            {MARK_GLYPH[name]}
          </button>
        ))}
      </div>
      <span className="tb-sep" />
      <div className="tgrp">
        <div className="tb-swatch">
          <button type="button" className="tb swatch" aria-label="Text colour" aria-haspopup="menu" aria-expanded={menu === 'text'} onMouseDown={stop} onClick={() => setMenu((m) => (m === 'text' ? null : 'text'))}>
            <span style={{ fontWeight: 800 }}>A</span>
            <span className="bar" style={{ background: af.textColor ?? 'var(--accent)' }} />
          </button>
          {menu === 'text' && <Palette colors={TEXT_COLORS} noneLabel="Default" onPick={(c) => pickColor('textColor', c)} />}
        </div>
        <div className="tb-swatch">
          <button type="button" className="tb swatch" aria-label="Highlight colour" aria-haspopup="menu" aria-expanded={menu === 'highlight'} onMouseDown={stop} onClick={() => setMenu((m) => (m === 'highlight' ? null : 'highlight'))}>
            <Icon name="pen" />
            <span className="bar" style={{ background: af.highlightColor ?? 'var(--amber)' }} />
          </button>
          {menu === 'highlight' && <Palette colors={HIGHLIGHT_COLORS} noneLabel="None" onPick={(c) => pickColor('highlightColor', c)} />}
        </div>
        <div className="tb-swatch">
          <button type="button" className={`tb${af.link ? ' on' : ''}`} aria-pressed={af.link} aria-label="Link (Ctrl+K)" onMouseDown={stop} onClick={linkButton}>
            <Icon name="link" />
          </button>
          {linkOpen && (
            <input
              ref={input}
              className="tb-linkinput"
              type="url"
              placeholder="https://…"
              aria-label="Link URL"
              aria-invalid={hrefError}
              aria-describedby={hrefError ? 'toolbar-link-error' : undefined}
              value={href}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                setHref(e.target.value);
                setHrefError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkOpen(false);
                  view.focus();
                }
              }}
            />
          )}
          {linkOpen && hrefError && (
            <span className="tb-linkerror" id="toolbar-link-error" role="alert">
              Use an http, https, or mailto URL.
            </span>
          )}
        </div>
      </div>
      <span className="tb-sep" />
      <div className="tgrp">
        <button type="button" className={`tb${af.block.type === 'bullet_item' ? ' on' : ''}`} aria-pressed={af.block.type === 'bullet_item'} aria-label="Bullet list" onMouseDown={stop} onClick={() => run(setBlock('bullet_item'))}>
          <Icon name="list" />
        </button>
        <button type="button" className={`tb${af.block.type === 'ordered_item' ? ' on' : ''}`} aria-pressed={af.block.type === 'ordered_item'} aria-label="Numbered list" onMouseDown={stop} onClick={() => run(setBlock('ordered_item'))}>
          <Icon name="ol" />
        </button>
        <button type="button" className={`tb${af.block.type === 'check_item' ? ' on' : ''}`} aria-pressed={af.block.type === 'check_item'} aria-label="Checklist" onMouseDown={stop} onClick={() => run(setBlock('check_item'))}>
          <Icon name="checksq" />
        </button>
        <button type="button" className={`tb${af.block.type === 'quote' ? ' on' : ''}`} aria-pressed={af.block.type === 'quote'} aria-label="Quote" onMouseDown={stop} onClick={() => run(setBlock('quote'))}>
          <Icon name="quote" />
        </button>
        <button type="button" className={`tb${af.block.type === 'code_block' ? ' on' : ''}`} aria-pressed={af.block.type === 'code_block'} aria-label="Code block" onMouseDown={stop} onClick={() => run(setBlock('code_block'))}>
          <Icon name="braces" />
        </button>
        <button type="button" className="tb" aria-label="Divider" onMouseDown={stop} onClick={insertDivider}>
          <Icon name="minus" />
        </button>
      </div>
    </div>
  );
}

function Palette({ colors, noneLabel, onPick }: { colors: readonly string[]; noneLabel: string; onPick: (color: string | null) => void }): React.JSX.Element {
  const stop = (e: React.MouseEvent): void => e.preventDefault();
  return (
    <div className="tb-menu tb-palette" role="menu">
      <div className="tb-chips">
        {colors.map((c) => (
          <button type="button" key={c} className="tb-chip" role="menuitem" aria-label={c} style={{ background: c }} onMouseDown={stop} onClick={() => onPick(c)} />
        ))}
      </div>
      <button type="button" className="tb-none" role="menuitem" onMouseDown={stop} onClick={() => onPick(null)}>
        <Icon name="minus" />
        {noneLabel}
      </button>
    </div>
  );
}
