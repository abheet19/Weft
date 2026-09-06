// ops.ts — the four operations and their dependencies. This file exists so causality is a data
// fact: `opDependencies` is the one place that says which items an op cannot live without, and
// `apply` parks an op precisely when one of them is missing. It must never carry positions
// (a `del` names an id, never an index — that is what lets it commute with every insert) and
// never depend on wall time.

import type { ItemId } from './ids.ts';
import type { BlockAttrs, Content, MarkName, Side } from './item.ts';

export type Op =
  | { readonly t: 'ins'; readonly id: ItemId; readonly parent: ItemId; readonly side: Side; readonly content: Content }
  | { readonly t: 'del'; readonly id: ItemId; readonly target: ItemId }
  | { readonly t: 'fmt'; readonly id: ItemId; readonly targets: readonly ItemId[]; readonly mark: MarkName; readonly active: boolean; readonly lamport: number; readonly href?: string } // ⟨D2⟩ ≤ 4096 targets
  | { readonly t: 'blk'; readonly id: ItemId; readonly target: ItemId; readonly attrs: BlockAttrs; readonly lamport: number };

/** The ids this op cannot be applied without. Explicit so causality is a data fact, not a code path. */
export function opDependencies(op: Op): readonly ItemId[] {
  switch (op.t) {
    case 'ins':
      return [op.parent];
    case 'del':
    case 'blk':
      return [op.target];
    case 'fmt':
      return op.targets;
    default:
      // Unknown op types reach here only from untrusted data; they depend on nothing and `apply` refuses them.
      return [];
  }
}
