// plugin.ts — the ProseMirror plugin that keeps one editor and one CRDT saying the same thing.
// This file exists to own the two directions and their one ordering rule. Local: `state.apply` is
// pure — it only records a document-changing transaction as not yet mirrored — and the plugin
// VIEW's `update` turns the recorded transactions into ops against the MIRROR (the CRDT state the
// editor was showing when the user typed), applies them to the host, and advances the mirror with
// one tagged transaction; so `state.apply(tr)` without a dispatch mints nothing, and a second
// transaction in the same tick is built against a fresh index. Remote: a change the host made
// (inbound ops, a reload) becomes a `weft-remote` transaction on the next animation frame (or
// zero timer without a DOM), coalescing a burst of messages into one redraw, never re-entrantly,
// not at all while the session is catching up (the whole catch-up lands as ONE transaction when
// it ends), and never while an IME composition is open — it waits for `compositionend`, the next
// editor update, or a zero-timer poll, or the browser's half-typed syllable would be rewritten
// under the user. After every document change the editor is compared with the normal form of the
// mirror (I7): fully (normalize + eq, O(n)) when `assert` is on — the LLD's dev-mode assertion,
// default `import.meta.env.DEV` — and otherwise over the changed window only for a single in-block
// text edit (the per-keystroke fast path), falling back to that same full check for any transaction
// the window cannot prove — multi-step, boundary-crossing, or block-count-changing. A difference in
// block attrs or marks is the schema's normalisation and is corrected quietly; a text difference
// is a bug, reported through `onFault` with both texts, the steps and the cursor, then corrected
// too, because the CRDT is what is persisted and shared. It must never swallow a failure, never
// turn a remote or mirror-advancing transaction back into ops, and never accept a drop:
// drag-and-drop is disabled in v1 (design §5.3).

import { applyAll, type Doc, type Op, type ReplicaId } from '@weft/crdt';
import { keydownHandler } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorView } from 'prosemirror-view';
import { enterInListBlock } from './keymap.ts';
import { normalize } from './normalize.ts';
import { pmPosToVisible, tokensInRange } from './positions.ts';
import { formatShortcuts } from './shortcuts.ts';
import { attrsOfBlock, blockVisibleLength, sameTextShape, sameToken, textOfTokens, tokenOf, tokensOfItems, tokensOfPm, type Token } from './tokens.ts';
import { transactionToOps, type LocalBuild } from './toOps.ts';
import { correction, mirrorOf, opsToTransaction, REMOTE_META, type Mirror } from './toTransaction.ts';

/** What the plugin needs from the session runner: the CRDT it holds, the one way to change it locally, and a way to hear that it changed. */
export interface BindingHost {
  readonly doc: Doc;
  /** Run a local edit against the host's doc and next seq; the edit callback is invoked synchronously, the promise resolves once the ops are persisted. */
  local(edit: (doc: Doc, me: ReplicaId, nextSeq: number) => { ops: readonly Op[]; doc: Doc }): Promise<void>;
  /** Called after every change the host made to `doc` on its own (inbound ops); returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * True while the session is catching up on a fresh connection (`session.s === 'syncing'`). Remote
   * changes are then not shown until it ends — the runner notifies on `CATCHUP_DONE` and the whole
   * catch-up becomes one transaction (E49) instead of one per message. Optional: a host without a
   * session shows every change as it arrives.
   */
  catchingUp?(): boolean;
  /**
   * Undo / redo this replica's own most recent action (design §0 A3, S7). The host emits real inverse
   * ops, which reach the editor through `subscribe` like any other change, so the mirror stays
   * consistent (I7) — the binding only binds the keys. Optional: a host without an undo stack omits them.
   */
  undo?(): void;
  redo?(): void;
}

// Exactly one kind — `mirror` — means the invariant broke (the editor and the CRDT disagree after a
// transaction, a bug). The other two are EXPECTED, surfaced degradation, not I7 violations: `local`
// is a host that refused an edit before it applied (the mirror never moved, the keystroke is undone)
// and `remote` is a change that could not be shown (the mirror is kept). All three are reported so
// the shell can raise an inline notice — none is ever only logged — but a test asserting I7 checks
// for `mirror` faults alone (see `expectMirror`), because a refusal the test set up is not a mirror
// divergence.
export type BindingFault =
  /** I7 violated: the editor's text and the CRDT's text differ after a transaction. The editor was reset to the CRDT. A bug. */
  | { kind: 'mirror'; editor: string; crdt: string; steps: readonly unknown[]; selection: { anchor: number; head: number } }
  /** A local edit could not be turned into ops or could not be persisted; the edit was refused before it applied, so the mirror is intact and the editor shows what the CRDT holds. Surfaced, not an I7 fault. */
  | { kind: 'local'; error: unknown }
  /** A change of the host's doc could not be shown. The editor keeps its previous mirror. Surfaced, not an I7 fault. */
  | { kind: 'remote'; error: unknown };

export interface BindingOptions {
  host: BindingHost;
  /** Every fault is reported here, structured; the shell logs it and shows an inline notice. Nothing is ever only logged. */
  onFault: (fault: BindingFault) => void;
  /**
   * Compare the whole editor with the normal form of the mirror after every document change (the
   * I7 dev-mode assertion, O(n) per transaction). Default: `import.meta.env.DEV`. Off, a local
   * change is checked over the window its steps touched and the total token count only.
   */
  assert?: boolean;
  /**
   * Called when Ctrl+K asks for a link and the selection is not already all linked (E54): the shell
   * opens the format bar's href input, which then dispatches the `addMark`. Optional; without it
   * Ctrl+K on an unlinked selection does nothing.
   */
  onLink?: () => void;
}

/** The plugin's state: the mirror, the transaction that set it (a remote change or a correction; null for the initial state), plus the document-changing transactions applied since it that the view has not yet turned into ops. */
export interface PluginState extends Mirror {
  readonly carried: Transaction | null;
  readonly unmirrored: readonly Transaction[];
}

export const weftKey = new PluginKey<PluginState>('weft');

/** Vite's `import.meta.env` is absent when the module runs outside Vite and vitest (a plain Node import); assume development then. */
function devMode(): boolean {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  return env?.DEV ?? true;
}

/** Apply ops that were built against the mirror to a host doc that may be ahead of it (an IME deferral); they apply there too, because the mirror is a prefix of the host's history. */
function applyToHost(hostDoc: Doc, ops: readonly Op[]): Doc {
  const { doc, results } = applyAll(hostDoc, ops);
  const bad = results.find((r) => r.kind !== 'applied');
  if (bad !== undefined) throw new Error(`a local op was ${bad.kind} by the host doc`);
  return doc;
}

/** Editor tokens counted without allocating them: visible inline tokens (chars + breaks) per block plus one boundary per block but the last. */
function tokenCount(doc: PMNode): number {
  let n = doc.childCount - 1;
  doc.forEach((block) => (n += blockVisibleLength(block)));
  return n;
}

/**
 * Whether a local transaction inserted any marked text — the only way, in a single in-block text
 * edit, that the editor can carry a mark the CRDT does not (a char typed with an inherited stored
 * mark; design §2.5's anomaly). Reading the inserted slice is O(change), so the fast path stays fast
 * even when the document has marks elsewhere. Such marks are stripped by the quiet correction.
 */
function insertsMarks(trs: readonly Transaction[]): boolean {
  for (const tr of trs) {
    for (const step of tr.steps) {
      if (!(step instanceof ReplaceStep)) continue;
      let found = false;
      step.slice.content.descendants((node) => {
        if (node.marks.length > 0) found = true;
        return !found;
      });
      if (found) return true;
    }
  }
  return false;
}

/**
 * The cheap I7 check for a local change: the editor's token count equals the mirror's, and the
 * tokens in the PM range each step changed — mapped through every later step and transaction —
 * are the mirror's items at that visible index. O(change), not O(document).
 */
function windowMismatch(trs: readonly Transaction[], final: PMNode, mirror: Mirror): boolean {
  if (tokenCount(final) !== mirror.index.length) return true;
  for (let t = 0; t < trs.length; t++) {
    const tr = trs[t] as Transaction;
    for (let i = 0; i < tr.steps.length; i++) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      (tr.steps[i] as Transaction['steps'][number]).getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        lo = Math.min(lo, newStart);
        hi = Math.max(hi, newEnd);
      });
      if (lo === Number.POSITIVE_INFINITY) continue;
      const later = tr.mapping.slice(i + 1);
      let from = later.map(lo, -1);
      let to = later.map(hi, 1);
      for (let u = t + 1; u < trs.length; u++) {
        from = (trs[u] as Transaction).mapping.map(from, -1);
        to = (trs[u] as Transaction).mapping.map(to, 1);
      }
      const tokens = tokensInRange(final, from, to);
      const v = pmPosToVisible(final, from);
      for (let k = 0; k < tokens.length; k++) {
        const item = mirror.index.itemAt(v + k);
        if (item === null || !sameToken(tokens[k] as Token, tokenOf(item))) return true;
      }
    }
  }
  return false;
}

/**
 * Whether `trs` is one ReplaceStep confined to a single block's text — the per-keystroke case the
 * window check is provably equivalent to the full `normalize`+`eq` reconcile for, and the only case
 * it may be used in production (E47). The window check reads only the PM range each step changed; a
 * transaction that is MULTI-STEP, CROSSES A BLOCK BOUNDARY, or CHANGES THE BLOCK COUNT can move or
 * re-key a boundary the window does not cover — two edits in different blocks, a split, a join, a
 * block-type change, a multi-paragraph paste — so those fall back to the full check instead, which
 * is O(document) but exact. Restricting the fast path this way keeps typing into a 50 000-character
 * document cheap (a keystroke is one in-block step) while never letting the cheap check pass a
 * transaction it cannot actually verify.
 */
function isSimpleTextEdit(trs: readonly Transaction[]): boolean {
  let seen = false;
  for (const tr of trs) {
    for (let i = 0; i < tr.steps.length; i++) {
      if (seen) return false; // more than one document-changing step
      seen = true;
      const before = tr.docs[i] as PMNode;
      const after = (tr.docs[i + 1] ?? tr.doc) as PMNode;
      if (before.childCount !== after.childCount) return false; // a block arrived or left
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      let newLo = Number.POSITIVE_INFINITY;
      let newHi = Number.NEGATIVE_INFINITY;
      (tr.steps[i] as Transaction['steps'][number]).getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        lo = Math.min(lo, oldStart);
        hi = Math.max(hi, oldEnd);
        newLo = Math.min(newLo, newStart);
        newHi = Math.max(newHi, newEnd);
      });
      if (lo === Number.POSITIVE_INFINITY) return false; // a step that maps nothing (a mark step): not a plain text edit
      // A boundary token inside the changed range on either side means the step touched block structure.
      if (tokensInRange(before, lo, hi).some((t) => t.kind === 'block')) return false;
      if (tokensInRange(after, newLo, newHi).some((t) => t.kind === 'block')) return false;
    }
  }
  return seen;
}

/**
 * The undo/redo keys (S7), bound only when the host provides the actions: Mod-z undoes, and both
 * Mod-Shift-z and Mod-y redo (the Windows and the mac conventions). Each returns true so the
 * browser's native undo never fires; the host emits the inverse ops and the editor sees them as a
 * remote change, so the mirror stays consistent (I7) without the keymap touching the document.
 */
function historyKeys(host: BindingHost): Record<string, Command> {
  const keys: Record<string, Command> = {};
  // Call through `host` so the method keeps its receiver (a destructured `host.undo` would lose `this`).
  if (host.undo !== undefined)
    keys['Mod-z'] = () => {
      host.undo?.();
      return true;
    };
  if (host.redo !== undefined) {
    const run: Command = () => {
      host.redo?.();
      return true;
    };
    keys['Mod-y'] = run;
    keys['Mod-Shift-z'] = run;
  }
  return keys;
}

export function weftPlugin(o: BindingOptions): Plugin<PluginState> {
  const { host, onFault } = o;
  const assert = o.assert ?? devMode();
  /** Cancels the scheduled remote sync, if one is pending. */
  let cancelScheduled: (() => void) | null = null;
  let deferred = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set around the dispatch that advances the mirror: the nested update it causes has been verified already. */
  let verified = false;

  function reportMirror(state: EditorState, mirror: Mirror, trs: readonly Transaction[]): void {
    onFault({
      kind: 'mirror',
      editor: textOfTokens(tokensOfPm(state.doc)),
      crdt: textOfTokens(tokensOfItems(mirror.index.items())),
      steps: trs.flatMap((tr) => tr.steps.map((s) => s.toJSON() as unknown)),
      selection: { anchor: state.selection.anchor, head: state.selection.head },
    });
  }

  /** Whether the editor is the normal form of `mirror` after local transactions: as is, up to a documented normalisation (quiet), or not (a fault). */
  function verifyLocal(state: EditorState, mirror: Mirror, build: LocalBuild, trs: readonly Transaction[]): 'ok' | 'quiet' | 'fault' {
    if (build.trailingKept) {
      // The editor lacks exactly the empty paragraph ROOT closes behind the kept boundary (E48).
      if (!assert) return 'quiet';
      const editor = [...tokensOfPm(state.doc), { kind: 'block', attrs: attrsOfBlock(state.doc.lastChild as PMNode) } as Token];
      return sameTextShape(editor, tokensOfItems(mirror.index.items())) ? 'quiet' : 'fault';
    }
    // The window check is only sound for a single in-block text edit (the keystroke fast path); any
    // other transaction — and every transaction in dev mode — takes the full O(document) reconcile,
    // which is the same comparison the LLD's dev-mode assertion makes.
    if (assert || !isSimpleTextEdit(trs)) {
      const items = mirror.index.items();
      if (state.doc.eq(normalize(items))) return 'ok';
      // Text preserved but block attrs or marks differ (a paste's block type, the §2.5 mark anomaly,
      // a trailing type) is the schema's normalisation, corrected quietly; a lost or gained
      // character/break/boundary is the mirror fault.
      return sameTextShape(tokensOfPm(state.doc), tokensOfItems(items)) ? 'quiet' : 'fault';
    }
    if (windowMismatch(trs, state.doc, mirror)) return 'fault';
    // A char typed with an inherited mark (design §2.5) and a non-paragraph trailing block (E5) are shown, then corrected away.
    return insertsMarks(trs) || attrsOfBlock(state.doc.lastChild as PMNode).type !== 'paragraph' ? 'quiet' : 'ok';
  }

  function buildAll(mirror: Mirror, me: ReplicaId, nextSeq: number, trs: readonly Transaction[]): LocalBuild {
    const ops: Op[] = [];
    let cur: LocalBuild = { ops, doc: mirror.doc, index: mirror.index, trailingKept: false };
    for (const tr of trs) {
      const r = transactionToOps(cur.doc, cur.index, me, nextSeq + ops.length, tr);
      ops.push(...r.ops);
      cur = { ops, doc: r.doc, index: r.index, trailingKept: cur.trailingKept || r.trailingKept };
    }
    return cur;
  }

  /** Turn the recorded local transactions into ops, hand them to the host, and advance the mirror — correcting the editor when it is not the CRDT's normal form. */
  function advance(view: EditorView, ps: PluginState): void {
    const trs = ps.unmirrored;
    let built: LocalBuild | null = null;
    try {
      host
        .local((hostDoc, me, nextSeq) => {
          const b = buildAll(ps, me, nextSeq, trs);
          // Only once the host has taken the ops is the mirror allowed to move; a host that throws here keeps the old one.
          const doc = hostDoc === ps.doc ? b.doc : applyToHost(hostDoc, b.ops);
          built = b;
          return { ops: b.ops, doc };
        })
        .catch((error: unknown) => onFault({ kind: 'local', error }));
    } catch (error) {
      built = null;
      onFault({ kind: 'local', error });
    }
    // `local` runs the edit before its first await, so `built` is set here — unless the host refused
    // first; then the unchanged mirror undoes the keystroke, and the promise reported the refusal.
    const b = built as LocalBuild | null;
    const mirror: Mirror = b === null ? { doc: ps.doc, index: ps.index } : { doc: b.doc, index: b.index };
    const verdict = b === null ? 'quiet' : verifyLocal(view.state, mirror, b, trs);
    if (verdict === 'fault') reportMirror(view.state, mirror, trs);
    const tr = verdict === 'ok' ? view.state.tr.setMeta(REMOTE_META, mirror) : correction(view.state, mirror);
    verified = true;
    try {
      view.dispatch(tr);
    } finally {
      verified = false;
    }
  }

  /** A remote (or mirror-carrying) transaction changed the document: in dev mode, prove it is the normal form. */
  function verifyRemote(view: EditorView, ps: PluginState): void {
    if (view.state.doc.eq(normalize(ps.index.items()))) return;
    reportMirror(view.state, ps, ps.carried === null ? [] : [ps.carried]);
    verified = true;
    try {
      view.dispatch(correction(view.state, ps));
    } finally {
      verified = false;
    }
  }

  function afterUpdate(view: EditorView, prev: EditorState): void {
    const ps = weftKey.getState(view.state) as PluginState;
    if (ps.unmirrored.length > 0) {
      advance(view, ps);
      return;
    }
    if (assert && !verified && view.state.doc !== prev.doc) verifyRemote(view, ps);
    // A composition that ended without `compositionend` (finding P10): the next editor update flushes what was deferred.
    if (deferred && !view.composing) flushDeferred(view);
  }

  function sync(view: EditorView): void {
    if (view.isDestroyed) return;
    // Every message of a catch-up would be one full-document diff; the runner notifies again on CATCHUP_DONE (E49).
    if (host.catchingUp?.() === true) return;
    if (view.composing) {
      deferred = true;
      armPoll(view);
      return;
    }
    deferred = false;
    const ps = weftKey.getState(view.state) as PluginState;
    if (host.doc === ps.doc) return;
    try {
      view.dispatch(opsToTransaction(ps.index, host.doc, view.state));
    } catch (error) {
      onFault({ kind: 'remote', error });
    }
  }

  /** Coalesce notifications into one redraw per animation frame and leave the current call stack first: a host may notify from inside a dispatch. Without a DOM (Node), a zero timer. */
  function scheduleSync(view: EditorView): void {
    if (cancelScheduled !== null) return;
    const run = (): void => {
      cancelScheduled = null;
      sync(view);
    };
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(run);
      cancelScheduled = () => cancelAnimationFrame(handle);
    } else {
      const handle = setTimeout(run, 0);
      cancelScheduled = () => clearTimeout(handle);
    }
  }

  /** The deferred remote change goes after ProseMirror has read the composed text into a transaction (its own microtask) — a zero timer, never re-entrantly from `update`. */
  function flushDeferred(view: EditorView): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      sync(view);
    }, 0);
  }

  /** While a composition holds a remote change back, poll on a zero timer so a composition the browser ends without an event still lets it through. */
  function armPoll(view: EditorView): void {
    if (pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (view.isDestroyed || !deferred) return;
      if (view.composing) armPoll(view);
      else sync(view);
    }, 0);
  }

  return new Plugin<PluginState>({
    key: weftKey,
    state: {
      init: () => ({ ...mirrorOf(host.doc), carried: null, unmirrored: [] }),
      // Pure: a mirror-carrying transaction is the new mirror; a document change is recorded for the view to turn into ops; anything else changes nothing.
      apply(tr, prev) {
        const mirror = tr.getMeta(REMOTE_META) as Mirror | undefined;
        if (mirror !== undefined) return { doc: mirror.doc, index: mirror.index, carried: tr, unmirrored: [] };
        return tr.docChanged ? { doc: prev.doc, index: prev.index, carried: prev.carried, unmirrored: [...prev.unmirrored, tr] } : prev;
      },
    },
    props: {
      // The binding's own keys run before the base keymap: Enter continuation (E51) and the S6
      // format shortcuts and Shift-Enter break (E54), so they work whether or not the format bar is shown.
      handleKeyDown: keydownHandler({ Enter: enterInListBlock, ...formatShortcuts(o.onLink), ...historyKeys(host) }),
      handleDOMEvents: {
        // A DOM-level handler, not `handleDrop`: ProseMirror asks `handleDrop` only after it has
        // already resolved the drop position, whereas a DOM handler that returns true stops it cold.
        drop: (_view, event) => {
          event.preventDefault();
          return true;
        },
        compositionend: (view) => {
          if (deferred) flushDeferred(view);
          return false;
        },
      },
    },
    view: (view) => {
      const unsubscribe = host.subscribe(() => scheduleSync(view));
      return {
        update: afterUpdate,
        destroy: () => {
          unsubscribe();
          cancelScheduled?.();
          cancelScheduled = null;
          if (flushTimer !== null) clearTimeout(flushTimer);
          if (pollTimer !== null) clearTimeout(pollTimer);
          flushTimer = null;
          pollTimer = null;
        },
      };
    },
  });
}
