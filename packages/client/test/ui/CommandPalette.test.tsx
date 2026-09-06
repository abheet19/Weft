// @vitest-environment jsdom
// CommandPalette.test.tsx — the ⌘K dialog's behaviour (03-UI §4.8): Ctrl+K opens it and focuses the
// search box; typing filters the list (and shows the empty state); ArrowDown + Enter runs the
// highlighted command; a click runs a row; Esc and a click outside dismiss it and RETURN focus to
// whatever opened it; running a command closes it but does NOT steal focus back. Rendered with
// react-dom into jsdom. jsdom implements the dialog's `open` reflection but not showModal/close/Esc,
// so the component falls back to the `open` attribute and drives Esc from state — the assertions read
// that attribute and `document.activeElement`. The real focus trap and ::backdrop are covered by the
// F-palette Playwright flow in a real browser.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../../src/ui/CommandPalette.tsx';
import type { Command } from '../../src/ui/commands.ts';

// Tell React this is an act() environment, so state updates dispatched inside act() are flushed without the warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const rename = vi.fn();
const newDoc = vi.fn();
const theme = vi.fn();
const offline = vi.fn();

const commands: readonly Command[] = [
  { group: 'Document', title: 'Rename via heading', icon: 'h1', run: rename },
  { group: 'Document', title: 'New document', icon: 'plus', run: newDoc },
  { group: 'Document', title: 'Theme', icon: 'sun', value: 'Dark', run: theme },
  { group: 'Debug', title: 'Simulate offline', icon: 'wifioff', value: 'Off', run: offline },
];

function render(): HTMLElement {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<CommandPalette commands={commands} />));
  return host;
}

const dialog = (el: HTMLElement): HTMLDialogElement => el.querySelector('dialog')!;
const input = (el: HTMLElement): HTMLInputElement => el.querySelector('.k-search input')!;
const rows = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('.k-it')];
const trigger = (el: HTMLElement): HTMLButtonElement => el.querySelector<HTMLButtonElement>('button[aria-label="Open command palette (Ctrl+K)"]')!;

function ctrlK(): void {
  act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })));
}
function type(el: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(el), value);
    input(el).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function key(target: Element, k: string): void {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
}

beforeEach(() => {
  rename.mockClear();
  newDoc.mockClear();
  theme.mockClear();
  offline.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete document.documentElement.dataset.theme;
});

describe('opening', () => {
  it('opens on Ctrl+K and focuses the search input', () => {
    const el = render();
    expect(dialog(el).open).toBe(false);
    ctrlK();
    expect(dialog(el).open).toBe(true);
    expect(document.activeElement).toBe(input(el));
  });

  it('opens from the top-bar trigger button', () => {
    const el = render();
    act(() => trigger(el).click());
    expect(dialog(el).open).toBe(true);
  });

  it('Ctrl+K again closes it', () => {
    const el = render();
    ctrlK();
    ctrlK();
    expect(dialog(el).open).toBe(false);
  });

  it('ignores a Ctrl+K the editor already handled (defaultPrevented)', () => {
    const el = render();
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      ev.preventDefault(); // the editor's link command consumed it
      window.dispatchEvent(ev);
    });
    expect(dialog(el).open).toBe(false);
  });
});

describe('filtering', () => {
  it('narrows the list to a title match and runs it on Enter', () => {
    const el = render();
    ctrlK();
    type(el, 'offline');
    expect(rows(el).map((r) => r.textContent)).toEqual(['Simulate offlineOff']);
    key(input(el), 'Enter');
    expect(offline).toHaveBeenCalledTimes(1);
    expect(dialog(el).open).toBe(false);
  });

  it('shows the empty state when nothing matches', () => {
    const el = render();
    ctrlK();
    type(el, 'zzzz');
    expect(rows(el)).toHaveLength(0);
    expect(el.querySelector('.k-empty')?.textContent).toContain('zzzz');
  });
});

describe('keyboard selection', () => {
  it('ArrowDown moves the selection and Enter runs the highlighted command', () => {
    const el = render();
    ctrlK();
    expect(rows(el)[0]!.getAttribute('aria-selected')).toBe('true'); // first row selected on open
    key(input(el), 'ArrowDown');
    expect(rows(el)[1]!.getAttribute('aria-selected')).toBe('true');
    key(input(el), 'Enter');
    expect(newDoc).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
  });

  it('ArrowUp does not move above the first row', () => {
    const el = render();
    ctrlK();
    key(input(el), 'ArrowUp');
    expect(rows(el)[0]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('running from a click', () => {
  it('runs the clicked row and closes', () => {
    const el = render();
    ctrlK();
    act(() => rows(el).find((r) => r.textContent?.startsWith('Theme'))!.click());
    expect(theme).toHaveBeenCalledTimes(1);
    expect(dialog(el).open).toBe(false);
  });
});

describe('dismissing returns focus', () => {
  it('Esc closes and returns focus to the opener', () => {
    const el = render();
    const button = trigger(el);
    act(() => {
      button.focus();
      button.click();
    });
    expect(dialog(el).open).toBe(true);
    key(dialog(el), 'Escape');
    expect(dialog(el).open).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('a pointer press outside the dialog box dismisses it', () => {
    const el = render();
    ctrlK();
    // jsdom has no PointerEvent constructor; a MouseEvent of type 'pointerdown' carries clientX/Y and reaches React's onPointerDown.
    act(() => void dialog(el).dispatchEvent(new MouseEvent('pointerdown', { clientX: 9999, clientY: 9999, bubbles: true })));
    expect(dialog(el).open).toBe(false);
    expect(offline).not.toHaveBeenCalled();
  });

  it('running a command does NOT force focus back to the opener (the command owns focus)', () => {
    const el = render();
    const button = trigger(el);
    act(() => {
      button.focus();
      button.click();
    });
    type(el, 'offline');
    key(input(el), 'Enter');
    expect(offline).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(button); // the palette did not yank focus back
  });
});
