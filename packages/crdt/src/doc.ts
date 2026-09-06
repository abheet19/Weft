// doc.ts — the replica's whole state and its read-only queries. This file exists so "the state
// after these ops" is one value: tree, indexes, state vector and the pending buffer travel
// together, and `apply` produces a new one. It must never mutate a Doc (every field is a
// persistent or frozen value) and never contain the integrate rule — that lives in apply.ts.

import type { ItemId } from './ids.ts';
import { ROOT_KEY, ROOT, type Item } from './item.ts';
import { opDependencies, type Op } from './ops.ts';
import { PersistentMap } from './persistentMap.ts';
import { NO_SIBLINGS, type SiblingList } from './siblings.ts';
import { svGet, type StateVector } from './stateVector.ts';
import { idKey } from './ids.ts';

/** The two sorted sibling lists of one item. `L` and `R` are each ordered by `compareIds` (see siblings.ts for why they are chunked). */
export interface Children {
  readonly L: SiblingList;
  readonly R: SiblingList;
}

/** Shared by every childless item so the children map does not allocate per insert. */
export const NO_CHILDREN: Children = Object.freeze({ L: NO_SIBLINGS, R: NO_SIBLINGS });

/** The replica's whole state. Immutable from the outside; `apply` returns a new Doc sharing structure. The pending buffer lives here so "the state after these ops" is a pure function of the ops. */
export interface Doc {
  readonly items: ReadonlyMap<string, Item>; // idKey → Item
  readonly children: ReadonlyMap<string, Children>; // sorted by compareIds
  readonly sv: StateVector;
  readonly pending: ReadonlyMap<string, readonly Op[]>; // missing idKey → ops waiting for it
  readonly formatLamport: number; // highest formatting lamport seen (for LWW)
}

/** An empty state vector, frozen so nobody can grow it in place. */
const EMPTY_SV: StateVector = Object.freeze({}) as StateVector;

export function emptyDoc(): Doc {
  return {
    items: PersistentMap.empty<Item>().set(ROOT_KEY, ROOT),
    children: PersistentMap.empty<Children>().set(ROOT_KEY, NO_CHILDREN),
    sv: EMPTY_SV,
    pending: PersistentMap.empty(),
    formatLamport: 0,
  };
}

export function getItem(doc: Doc, id: ItemId): Item | undefined {
  return doc.items.get(idKey(id));
}

/** Number of ops parked because a dependency has not arrived. Surfaced in the Inspector; bounded by protocol limits. */
export function pendingCount(doc: Doc): number {
  let n = 0;
  for (const ops of doc.pending.values()) n += ops.length;
  return n;
}

/** The sibling lists of `key`, or none. Exists so callers never special-case an item that has no entry. */
export function childrenOf(doc: Doc, key: string): Children {
  return doc.children.get(key) ?? NO_CHILDREN;
}

/**
 * Parked ops that can never drain (E1/E12). A dependency is dead when `knownSv` already counts the
 * op that carries its id — so it has been received, yet created no item — unless that op is itself
 * a parked `ins` that could still land. Iterated to a fixpoint, so an `ins` whose own dependency is
 * dead does not count as a future creator. Pass the doc's own sv after catch-up; the caller drops
 * the result with `dropPending` and, if it is the author, treats it as a bug in its own generator.
 */
export function unsatisfiablePending(doc: Doc, knownSv: StateVector): readonly Op[] {
  const parked: Op[] = [];
  for (const ops of doc.pending.values()) parked.push(...ops);
  // Items a parked insert would create, by key; shrinks as inserts are found to be dead.
  const wouldCreate = new Map<string, Op>();
  for (const op of parked) if (op.t === 'ins') wouldCreate.set(idKey(op.id), op);
  const dead = new Set<Op>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const op of parked) {
      if (dead.has(op)) continue;
      const doomed = opDependencies(op).some((dep) => {
        const key = idKey(dep);
        return !doc.items.has(key) && dep.seq <= svGet(knownSv, dep.replica) && !wouldCreate.has(key);
      });
      if (!doomed) continue;
      dead.add(op);
      if (op.t === 'ins') wouldCreate.delete(idKey(op.id));
      changed = true;
    }
  }
  return parked.filter((op) => dead.has(op));
}

/** The doc without these parked ops. The state vector still counts them — they were received; they are simply never going to apply. */
export function dropPending(doc: Doc, ops: readonly Op[]): Doc {
  if (ops.length === 0) return doc;
  const drop = new Set(ops);
  let pending = doc.pending instanceof PersistentMap ? doc.pending : PersistentMap.from(doc.pending);
  for (const [key, waiting] of doc.pending) {
    const kept = waiting.filter((op) => !drop.has(op));
    if (kept.length === waiting.length) continue;
    pending = kept.length === 0 ? pending.delete(key) : pending.set(key, kept);
  }
  return { ...doc, pending };
}
