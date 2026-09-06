// timeTravel.ts — read-only history scrubbing as a PURE fold (design §7, 03-UI §4.6). This file
// exists so the time-travel slider is exactly `fold(apply, base, ops[0..n])` and nothing more: the
// document at slider position `n` is the base state with the first `n` operations of this replica's
// op log replayed, computed the same way `applyAll` computes the live document, so the two can
// never disagree and the property test is a definition check. `base` is the document the session
// opened with (an empty doc for a fresh document, or the snapshot a previous compaction left); the
// ops are the operations applied since, in the order this replica applied them. It must never read
// a clock or draw randomness (it is on the PURE list), never mutate its inputs, and never depend on
// wall time — replaying the same log always yields the same document (design §3.6).

import { applyAll, type Doc, type Op } from '@weft/crdt';

/** A slider position clamped to a real prefix: an integer in 0..length. A fractional or out-of-range value is a UI slip, not data, and is rounded and clamped rather than throwing. */
export function clampPosition(position: number, length: number): number {
  if (!Number.isFinite(position)) return length;
  return Math.max(0, Math.min(Math.trunc(position), length));
}

/**
 * The document at slider position `n`: `base` with the first `n` ops of `log` replayed. Position 0
 * is `base` itself and position `log.length` is the live document. Deterministic and total — the
 * position is clamped first, and `applyAll` is total over any op (a malformed one is refused, never
 * thrown on), so no slider value can break replay.
 */
export function replayTo(base: Doc, log: readonly Op[], position: number): Doc {
  const n = clampPosition(position, log.length);
  return applyAll(base, log.slice(0, n)).doc;
}
