// undo.ts — local-only undo/redo as an inverse-op stack (design §0 A3, LLD §7 S7). This file exists
// to answer one question honestly: what is the inverse of an operation I made, in a document a peer
// may have changed underneath me? The answer, and the whole scope, is LOCAL — only the user's own
// operations are ever inverted, and the inverse is always a NEW operation that emits real ops the
// editor mirror stays consistent with (I7), never a rewind of the log. The four inverses:
//   • an `ins` I made  → a `del` of that item — unless a peer already deleted it, then a NO-OP (the
//     character is gone; the tombstone is NEVER resurrected — I6);
//   • a `del` I made    → a fresh `ins` re-inserting the content at the tombstone's slot with a NEW
//     id (again: no resurrection, and the id is mine, so undo never touches a peer's item);
//   • a `fmt` I made    → a `fmt` restoring each target's previous mark register;
//   • a `blk` I made    → a `blk` restoring the boundary's previous attributes.
// Cross-replica undo is out (design §0 A3): the stack holds only this replica's own actions, so
// every `del` this module emits targets an item this replica authored and every re-insert mints a
// new id — undo can neither delete nor revive a peer's item. It must never read a clock or draw
// randomness (it is on the PURE list), never mutate a Doc, and never emit an op `apply` refuses.

import { apply, buildIndex, getItem, idKey, localInsert, MAX_LAMPORT, traversalOrder, type BlockAttrs, type Content, type Doc, type ItemContent, type ItemId, type MarkState, type Op, type ReplicaId } from '@weft/crdt';

/** How many user actions the undo stack keeps. A bound, not a feature: an unbounded stack is memory an adversary grows one keystroke at a time. */
const UNDO_STACK_LIMIT = 1000;

/** One operation of a user action, plus the state captured BEFORE it applied that its inverse needs. */
interface UndoStep {
  readonly op: Op;
  /** For a `del`: the content of the tombstoned item, so the inverse can re-insert it as a new item. */
  readonly deletedContent?: ItemContent;
  /** For a `fmt`: the previous register of `op.mark` on each target, in `op.targets` order (undefined = the mark was absent). */
  readonly prevMarks?: readonly (MarkState | undefined)[];
  /** For a `blk`: the previous attrs of the target boundary. */
  readonly prevAttrs?: BlockAttrs;
}

/** One undoable user action: the ops it emitted, in order, with the state each inverse needs. */
interface UndoEntry {
  readonly steps: readonly UndoStep[];
}

/** The two stacks. A value, so the runner holds one field and the property test drives it directly. */
export interface UndoHistory {
  readonly undo: readonly UndoEntry[];
  readonly redo: readonly UndoEntry[];
}

export const emptyHistory: UndoHistory = { undo: [], redo: [] };

/** Read, before `op` applied, whatever inverting it will need — the deleted content, the marks it overwrote, the attrs it replaced. */
function captureStep(before: Doc, op: Op): UndoStep {
  switch (op.t) {
    case 'del': {
      const item = getItem(before, op.target);
      return item === undefined ? { op } : { op, deletedContent: item.content };
    }
    case 'fmt':
      return { op, prevMarks: op.targets.map((t) => getItem(before, t)?.marks[op.mark]) };
    case 'blk': {
      const item = getItem(before, op.target);
      return item !== undefined && item.content.kind === 'block' ? { op, prevAttrs: item.content.attrs } : { op };
    }
    default:
      return { op };
  }
}

/** The entry for a user action: `ops` emitted against `before`. */
function captureEntry(before: Doc, ops: readonly Op[]): UndoEntry {
  return { steps: ops.map((op) => captureStep(before, op)) };
}

/** The content of a re-inserted item: a fresh copy, authored by `me` (a block seed must name its writer), with a new lamport when it is a boundary. Marks are not restored in v1 — a re-inserted character comes back plain. */
function reinsertContent(content: ItemContent, me: ReplicaId, lamport: () => number): Content {
  if (content.kind === 'char') return { kind: 'char', text: content.text };
  if (content.kind === 'break') return { kind: 'break' };
  const attrs: BlockAttrs = content.attrs.level === undefined ? { type: content.attrs.type } : { type: content.attrs.type, level: content.attrs.level };
  return { kind: 'block', attrs, lamport: lamport(), replica: me };
}

/** Restore each target's previous state of `op.mark`, grouping targets that shared a previous state into one `fmt` op so a wide format inverts in a handful of ops, not one per character. */
function invertFmt(op: Extract<Op, { t: 'fmt' }>, prev: readonly (MarkState | undefined)[], mint: () => ItemId, lamport: () => number, push: (op: Op) => void): void {
  const groups = new Map<string, { active: boolean; href: string | undefined; targets: ItemId[] }>();
  op.targets.forEach((target, i) => {
    const before = prev[i];
    const active = before?.active ?? false; // an absent mark is restored to inactive, which renders identically
    const href = before?.href;
    const key = `${String(active)}|${href ?? ''}`;
    const group = groups.get(key) ?? { active, href, targets: [] };
    group.targets.push(target);
    groups.set(key, group);
  });
  for (const group of groups.values()) {
    const base = { t: 'fmt' as const, id: mint(), targets: group.targets, mark: op.mark, active: group.active, lamport: lamport() };
    push(op.mark === 'link' && group.active && group.href !== undefined ? { ...base, href: group.href } : base);
  }
}

/**
 * The inverse ops for one entry against the CURRENT doc, applied; returns the ops (each authored by
 * `me` from `nextSeq` up) and the doc after. Two passes so a batch that replaced a selection inverts
 * correctly: first undo the inserts, formats and block changes (in reverse), which removes the typed
 * text; then re-insert the deleted content (in forward order) at each tombstone's now-correct visible
 * slot. Every emitted op is applied here, so the runner persists a doc it never has to recompute.
 */
function invertEntry(doc: Doc, entry: UndoEntry, me: ReplicaId, nextSeq: number): { ops: readonly Op[]; doc: Doc } {
  const ops: Op[] = [];
  let cur = doc;
  const mint = (): ItemId => ({ replica: me, seq: nextSeq + ops.length });
  const lamport = (): number => {
    if (cur.formatLamport >= MAX_LAMPORT) throw new RangeError(`formatting lamport is at MAX_LAMPORT (${MAX_LAMPORT}); no further format op can win`);
    return cur.formatLamport + 1;
  };
  const push = (op: Op): void => {
    const r = apply(cur, op);
    if (r.kind !== 'applied') throw new Error(`undo op was ${r.kind}${r.kind === 'rejected' ? ` (${r.reason})` : ''}`);
    ops.push(op);
    cur = r.doc;
  };

  // Pass 1 (reverse): delete my inserts, revert my formats and my block changes.
  for (let i = entry.steps.length - 1; i >= 0; i--) {
    const step = entry.steps[i] as UndoStep;
    const op = step.op;
    if (op.t === 'ins') {
      const item = getItem(cur, op.id);
      // Only my own live insert is deleted; a peer (or an earlier undo) may already have tombstoned
      // it, and then undo is a no-op — the character is gone and the id is never resurrected (I6).
      if (item !== undefined && !item.deleted) push({ t: 'del', id: mint(), target: op.id });
    } else if (op.t === 'fmt') {
      invertFmt(op, step.prevMarks ?? [], mint, lamport, push);
    } else if (op.t === 'blk' && step.prevAttrs !== undefined && getItem(cur, op.target)?.content.kind === 'block') {
      push({ t: 'blk', id: mint(), target: op.target, attrs: step.prevAttrs, lamport: lamport() });
    }
  }

  // Pass 2: re-insert the content each `del` tombstoned. The re-inserts must go in FORWARD document
  // order (not the entry's order, which for a redo of an undone insert is reversed), or a "hello"
  // would come back "olleh"; ordering by each tombstone's traversal position and re-inserting at its
  // current visible slot reproduces the original sequence regardless of the entry's order.
  const dels = entry.steps.filter((step): step is UndoStep & { op: Extract<Op, { t: 'del' }> } => step.op.t === 'del' && step.deletedContent !== undefined);
  if (dels.length > 0) {
    const rank = new Map<string, number>();
    traversalOrder(cur).forEach((item, i) => rank.set(idKey(item.id), i));
    dels.sort((x, y) => (rank.get(idKey(x.op.target)) ?? 0) - (rank.get(idKey(y.op.target)) ?? 0));
    for (const step of dels) {
      const target = step.op.target;
      if (getItem(cur, target) === undefined) continue; // the tombstone is gone (impossible after apply); nothing to anchor to
      const at = buildIndex(cur).visibleBefore(target);
      if (at < 0) continue;
      const built = localInsert(cur, me, nextSeq + ops.length, at, reinsertContent(step.deletedContent as ItemContent, me, lamport));
      for (const op of built.ops) ops.push(op);
      cur = built.doc;
    }
  }

  return { ops, doc: cur };
}

/** After a user edit that emitted `ops` (built against `before`): remember how to invert it, and forget the redo stack (a new edit branches history). An edit that emitted nothing changes nothing. */
export function recordUser(history: UndoHistory, before: Doc, ops: readonly Op[], limit: number = UNDO_STACK_LIMIT): UndoHistory {
  if (ops.length === 0) return history;
  const undo = [...history.undo, captureEntry(before, ops)];
  return { undo: undo.length > limit ? undo.slice(undo.length - limit) : undo, redo: [] };
}

/** The result of an undo or redo: the ops it emitted (already applied to `doc`), the doc after, and the history with that action moved to the other stack. */
export interface UndoResult {
  readonly ops: readonly Op[];
  readonly doc: Doc;
  readonly history: UndoHistory;
}

/** Invert the most recent user action against `doc`, moving it to the redo stack. `null` when there is nothing to undo (an empty stack is a no-op). */
export function undo(history: UndoHistory, doc: Doc, me: ReplicaId, nextSeq: number): UndoResult | null {
  const entry = history.undo[history.undo.length - 1];
  if (entry === undefined) return null;
  const { ops, doc: next } = invertEntry(doc, entry, me, nextSeq);
  // The redo of this undo re-inverts what the undo emitted, captured against the pre-undo doc.
  const redoEntry = captureEntry(doc, ops);
  return { ops, doc: next, history: { undo: history.undo.slice(0, -1), redo: [...history.redo, redoEntry] } };
}

/** Mirror of `undo` for the redo stack. */
export function redo(history: UndoHistory, doc: Doc, me: ReplicaId, nextSeq: number): UndoResult | null {
  const entry = history.redo[history.redo.length - 1];
  if (entry === undefined) return null;
  const { ops, doc: next } = invertEntry(doc, entry, me, nextSeq);
  const undoEntry = captureEntry(doc, ops);
  return { ops, doc: next, history: { undo: [...history.undo, undoEntry], redo: history.redo.slice(0, -1) } };
}
