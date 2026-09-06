// CommandPalette.tsx — the ⌘K command palette of 03-UI §4.8, ported from the prototype's `.cmdk`
// dialog (markup and section 12 of its JS). It renders its own trigger button (for the top bar) and
// a REAL <dialog>: in the browser `showModal()` traps focus and paints the ::backdrop, Esc and a
// click outside dismiss it, and focus returns to whatever opened it. Ctrl/Cmd+K toggles it; typing
// filters the list; ArrowUp/Down move the selection and Enter (or a click) runs. The palette holds
// no application state — it maps a `Command[]` (built by `paletteCommands`) to markup and calls the
// selected command's `run`. It is coverage-excluded as the other `.tsx` files are; its behaviour is
// proven in CommandPalette.test.tsx (open/filter/run/close/focus) and its wiring in commands.test.ts.
//
// Two portability notes. (1) Ctrl+K also means "insert link" in the editor (E54); the editor's
// keymap preventDefaults that key ONLY when it acts (a non-empty selection), so this global handler
// ignores an already-handled event (`defaultPrevented`) and opens the palette otherwise — no
// conflict, F7 unchanged. (2) jsdom implements the dialog's `open` reflection but neither
// `showModal()` nor `close()` nor native Esc, so both are called behind a capability guard and Esc
// is driven from React state; the behaviour is then identical under jsdom and a real browser.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands, type Command } from './commands.ts';
import { Icon } from './Icons.tsx';

export function CommandPalette({ commands }: { commands: readonly Command[] }): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** What had focus when the palette opened; focus returns here on a DISMISS (Esc / click-away), not when a command runs — a command owns where focus lands. */
  const opener = useRef<HTMLElement | null>(null);
  const ran = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Ctrl/Cmd+K toggles the palette. An event the editor already handled (Ctrl+K = link on a
  // selection) is left alone; otherwise the palette opens — the one global shortcut of 03-UI §4.8.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setOpen((was) => !was);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drive the real <dialog> from React state. showModal/close are guarded so jsdom (which has
  // neither) falls back to the `open` attribute the tests read; the browser gets the modal + backdrop.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      ran.current = false;
      setQuery('');
      setSel(0);
      if (typeof dlg.showModal === 'function') {
        if (!dlg.open) dlg.showModal();
      } else {
        dlg.setAttribute('open', '');
      }
      inputRef.current?.focus();
    } else if (dlg.open) {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
      if (!ran.current) opener.current?.focus();
    }
  }, [open]);

  const run = (i: number): void => {
    const command = filtered[i];
    if (command === undefined) return;
    ran.current = true; // a run closes the palette but lets the command decide focus (e.g. Rename focuses the editor)
    setOpen(false);
    command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault(); // drive the close from state so jsdom and the browser behave the same
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(sel);
    }
  };

  // A pointer press outside the dialog's box is a dismiss (the backdrop). A press on a row is inside, so it runs instead.
  const onPointerDown = (e: React.PointerEvent): void => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setOpen(false);
  };

  const activeId = filtered[sel] !== undefined ? `k-${sel}` : undefined;

  return (
    <>
      <button type="button" className="gbtn" aria-label="Open command palette (Ctrl+K)" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="cmd" />
        <span className="kbd">K</span>
      </button>
      <dialog ref={dialogRef} className="cmdk glass" aria-label="Command palette" onKeyDown={onKeyDown} onPointerDown={onPointerDown} onClose={() => setOpen(false)}>
        <div className="k-search">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command…"
            role="combobox"
            aria-expanded="true"
            aria-controls="k-list"
            aria-autocomplete="list"
            autoComplete="off"
            {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
          />
        </div>
        <div className="k-list" id="k-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="k-empty">No commands match “{query.trim()}”</div>
          ) : (
            filtered.map((command, i) => (
              <Fragment key={`${command.group}/${command.title}`}>
                {(i === 0 || filtered[i - 1]!.group !== command.group) && <div className="k-g">{command.group}</div>}
                <div className="k-it" role="option" id={`k-${i}`} data-i={i} aria-selected={i === sel} onClick={() => run(i)} onMouseMove={() => setSel(i)}>
                  <Icon name={command.icon} />
                  <span>{command.title}</span>
                  {command.value !== undefined && <span className="val">{command.value}</span>}
                </div>
              </Fragment>
            ))
          )}
        </div>
        <div className="k-foot">
          <span>
            <kbd>↑↓</kbd>navigate
          </span>
          <span>
            <kbd>↵</kbd>run
          </span>
          <span>
            <kbd>esc</kbd>close
          </span>
        </div>
      </dialog>
    </>
  );
}
