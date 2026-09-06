// helpers.ts — the harness every binding test shares: an in-memory BindingHost that plays the
// session runner without a socket or a store (its `local` runs the edit synchronously and settles
// on a microtask, exactly like the runner's), a jsdom editor mount with the Weft plugin and the
// base keymap, the two `textOf` readings that invariant I7 compares, and the microtask/timer tick
// that lets the plugin's deferred remote sync run. Faults are collected, never thrown, so a test
// can assert on them.
import { apply, canonicalBytes, svGet, visibleItems, type Doc, type Item, type Op, type ReplicaId, emptyDoc } from '@weft/crdt';
import { emptyHistory, recordUser, redo as redoHistory, undo as undoHistory, type UndoHistory } from '../../src/history/undo.ts';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { expect } from 'vitest';
import { normalize } from '../../src/binding/normalize.ts';
import { weftKey, weftPlugin, type BindingFault, type BindingHost, type BindingOptions } from '../../src/binding/plugin.ts';
import { schema } from '../../src/binding/schema.ts';

export const R = { a: 'bcdefghijklmn' as ReplicaId, b: 'cdefghijklmno' as ReplicaId };

export const numRuns = (heavy: boolean): number => (process.env['CI'] ? (heavy ? 1_000 : 10_000) : heavy ? 100 : 1_000);

/** A replica without IO: `local` applies at once and resolves on a microtask; `receive` is the inbound path and notifies subscribers like the runner's `inbound` does. */
export class MemoryHost implements BindingHost {
  doc: Doc = emptyDoc();
  /** Every op this replica generated, in order — what a peer pulls. */
  readonly log: Op[] = [];
  /** When set, `local` fails this way: `sync` throws from the edit, `persist` rejects after applying (the store said no). */
  failLocal: 'sync' | 'persist' | null = null;
  /** Plays the session's `syncing` state: while true the plugin shows nothing new; `receive([])` after clearing it is the CATCHUP_DONE notification. */
  syncing = false;

  catchingUp(): boolean {
    return this.syncing;
  }
  private readonly listeners = new Set<() => void>();
  private delivered = 0;
  /** Local-only undo/redo stacks, exactly as the runner keeps them (S7). */
  private history: UndoHistory = emptyHistory;
  readonly me: ReplicaId;

  constructor(me: ReplicaId) {
    this.me = me;
  }

  async local(edit: (doc: Doc, me: ReplicaId, nextSeq: number) => { ops: readonly Op[]; doc: Doc }): Promise<void> {
    if (this.failLocal === 'sync') throw new Error('store is read-only');
    const before = this.doc;
    const { ops, doc } = edit(this.doc, this.me, svGet(this.doc.sv, this.me) + 1);
    this.history = recordUser(this.history, before, ops);
    this.doc = doc;
    this.log.push(...ops);
    if (this.failLocal === 'persist') throw new Error('IndexedDB transaction aborted');
  }

  /** Undo/redo emit real inverse ops and notify like the runner, so the plugin shows them as a change (I7). */
  undo(): void {
    this.applyHistory(undoHistory(this.history, this.doc, this.me, svGet(this.doc.sv, this.me) + 1));
  }

  redo(): void {
    this.applyHistory(redoHistory(this.history, this.doc, this.me, svGet(this.doc.sv, this.me) + 1));
  }

  private applyHistory(r: { ops: readonly Op[]; doc: Doc; history: UndoHistory } | null): void {
    if (r === null) return;
    this.history = r.history;
    this.doc = r.doc;
    this.log.push(...r.ops);
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Inbound ops: applied, then one notification for the whole batch (one message, one transaction). */
  receive(ops: readonly Op[]): void {
    for (const op of ops) {
      const r = apply(this.doc, op);
      this.doc = r.doc;
      expect(r.kind, `remote op ${op.t} ${op.id.replica}:${op.id.seq} was ${r.kind}`).toBe('applied');
    }
    for (const l of this.listeners) l();
  }

  /** Own ops not yet handed to a peer through `pull`. */
  pull(): readonly Op[] {
    const ops = this.log.slice(this.delivered);
    this.delivered = this.log.length;
    return ops;
  }

  text(): string {
    return textOfItems(visibleItems(this.doc));
  }
}

/** Deliver everything each host generated since the last exchange to the other, then let both editors sync. */
export async function exchange(a: MemoryHost, b: MemoryHost): Promise<void> {
  const fromA = a.pull();
  const fromB = b.pull();
  if (fromA.length > 0) b.receive(fromA);
  if (fromB.length > 0) a.receive(fromB);
  await tick();
}

export interface Mounted {
  view: EditorView;
  host: MemoryHost;
  faults: BindingFault[];
  /** Transactions dispatched through the view, remote ones included. */
  dispatched: Transaction[];
}

/** Mounts an editor on `host` with the Weft plugin first and the base keymap behind it, as the shell does. `options` overrides plugin options (`assert: false` is the production path). */
export function mount(host: MemoryHost, options: Partial<Omit<BindingOptions, 'host' | 'onFault'>> = {}): Mounted {
  const faults: BindingFault[] = [];
  const dispatched: Transaction[] = [];
  const state = EditorState.create({ schema, doc: normalize(visibleItems(host.doc)), plugins: [weftPlugin({ host, onFault: (f) => faults.push(f), ...options }), keymap(baseKeymap)] });
  const view = new EditorView(document.body.appendChild(document.createElement('div')), {
    state,
    dispatchTransaction(tr) {
      dispatched.push(tr);
      view.updateState(view.state.apply(tr));
    },
  });
  return { view, host, faults, dispatched };
}

export function unmount(m: Mounted): void {
  const parent = m.view.dom.parentNode;
  m.view.destroy();
  parent?.parentNode?.removeChild(parent);
}

/** jsdom has no ClipboardEvent; ProseMirror only hands the event on to `handlePaste`, so a bare paste Event stands in. */
const pasteEvent = (): ClipboardEvent => new Event('paste') as ClipboardEvent;
export const pasteText = (m: Mounted, text: string): boolean => m.view.pasteText(text, pasteEvent());
export const pasteHTML = (m: Mounted, html: string): boolean => m.view.pasteHTML(html, pasteEvent());

/** One animation frame and then a macrotask: the plugin syncs remote changes on the next frame (jsdom runs one at 60 Hz) and, after `compositionend` or a composition that ended silently, on a zero timer behind it. */
export const tick = (): Promise<void> =>
  new Promise((r) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(r, 0));
    else setTimeout(r, 0);
  });

/** Transactions that changed the document — a local edit, a remote change or a correction; the mirror-advancing transaction the plugin dispatches after every local edit changes nothing and is not one. */
export const docChanges = (m: Mounted): Transaction[] => m.dispatched.filter((tr) => tr.docChanged);

/** The editor's text with one newline per block boundary and a line separator per soft break — one side of I7. */
export function textOfPm(doc: PMNode): string {
  const blocks: string[] = [];
  doc.forEach((block) => {
    let s = '';
    block.forEach((node) => (s += node.isText ? (node.text as string) : ' '));
    blocks.push(s);
  });
  return blocks.join('\n');
}

/** The CRDT's text with one newline per boundary item and a line separator per break — the other side of I7. */
export function textOfItems(items: readonly Item[]): string {
  return items.map((item) => (item.content.kind === 'char' ? item.content.text : item.content.kind === 'break' ? ' ' : '\n')).join('');
}

/**
 * I7 against the editor's own mirror: the text is identical and the block structure is the normal
 * form, and no `mirror`-kind fault was raised. Only a `mirror` fault means the invariant broke; a
 * `local` (a refused edit) or `remote` (a change that could not be shown) fault is surfaced,
 * expected degradation the editor recovered from, so a test that deliberately provokes one (a
 * read-only host, say) still holds I7 — its mirror is intact.
 */
export function expectMirror(m: Mounted): void {
  const mirror = weftKey.getState(m.view.state);
  expect(mirror).toBeDefined();
  const items = visibleItems((mirror as { doc: Doc }).doc);
  expect(textOfPm(m.view.state.doc)).toBe(textOfItems(items));
  expect(m.view.state.doc.eq(normalize(items))).toBe(true);
  expect(m.faults.filter((f) => f.kind === 'mirror')).toEqual([]);
}

/** I7 plus "nothing deferred": the mirror IS the host's doc. */
export function expectSynced(m: Mounted): void {
  expectMirror(m);
  expect(weftKey.getState(m.view.state)?.doc).toBe(m.host.doc);
}

export function hashOf(doc: Doc): string {
  return Buffer.from(canonicalBytes(doc)).toString('hex');
}

/** Every position a text cursor can occupy, in order: inside each block from its start to its end, stepping by code point — a browser never puts the caret between the two units of a surrogate pair. */
export function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  let pos = 0;
  doc.forEach((block) => {
    let p = pos + 1;
    out.push(p);
    // Step by each inline node's size: a code point is 1 or 2 units, a hard_break is 1.
    block.forEach((node) => {
      if (node.isText) for (const ch of node.text as string) out.push((p += ch.length));
      else out.push((p += node.nodeSize));
    });
    pos += block.nodeSize;
  });
  return out;
}
