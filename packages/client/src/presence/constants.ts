// constants.ts — the numbers presence and the Inspector are tuned by, in one place (LLD §9) so a
// test can quote a timing by name and the runner, the awareness table and the UI read the same
// value. Presence is EPHEMERAL and rate-limited separately from ops (LLD §8 S5): a burst of cursor
// movements must not cost a frame each, and a peer that has gone dark without a clean goodbye must
// disappear on its own. It must never hold behaviour.

/**
 * A cursor moves far more often than it is worth broadcasting: at most one presence frame per this
 * interval, with a trailing send so the final resting position is never lost. Separate from the
 * op-rate limit, because presence is throw-away and ops are not (LLD §8 S5 "presence rate limited
 * separately from ops").
 */
export const PRESENCE_THROTTLE_MS = 90;
/**
 * While present but still, a replica re-publishes on this beat so peers do not expire it. Strictly
 * below PRESENCE_TTL_MS and below CARET_IDLE_MS, so a live-but-idle peer is kept alive AND its caret
 * can honestly fade at CARET_IDLE_MS (its `movedAt` stops advancing while heartbeats keep `seenAt`
 * fresh) — the two would otherwise coincide at the TTL and the fade would never be seen.
 */
export const PRESENCE_HEARTBEAT_MS = 12_000;
/** How often the runner sweeps the peer table for expiry and fires a heartbeat if one is due. */
export const PRESENCE_SWEEP_MS = 4_000;
/** A caret's name flag is shown for this long after the peer's cursor moves, and on hover (03-UI §4.3). */
export const PRESENCE_FLAG_MS = 1_500;
/** A caret whose cursor has not moved for this long fades to 40% (03-UI §4.3); still present until the TTL removes it. */
export const CARET_IDLE_MS = 30_000;
/** An avatar whose peer's cursor has not moved for this long is faded (03-UI §4.2). Longer than the caret fade: the avatar is the last, calmest signal that someone is still here. */
export const AVATAR_IDLE_MS = 60_000;
