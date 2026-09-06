// constants.ts — every number the session's life cycle is tuned by, in one place (LLD §9), so a
// test can quote a timing by name and the reducer, the runner and the tests read the same value.
// It must never hold behaviour.

/** Connect + hello must complete within this, or the attempt is abandoned and retried with backoff (LLD §4). */
export const HELLO_TIMEOUT_MS = 5_000;
/** Backoff: min(BACKOFF_BASE_MS · 2^attempt, BACKOFF_MAX_MS) plus a jitter in [0, JITTER_MS) (LLD §4). */
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 8_000;
export const JITTER_MS = 250;
/** Application-level keep-alive (LLD §4): ping every 15 s, and a pong that does not come within 10 s means the socket is dead. */
export const PING_INTERVAL_MS = 15_000;
export const PONG_TIMEOUT_MS = 10_000;
/** More re-hellos than this within one window on one socket is a loop, not a repair (E36): the session ends as `failed` instead of hammering the server. */
export const REHELLO_MAX = 5;
export const REHELLO_WINDOW_MS = 30_000;
/** IndexedDB compaction cadence (LLD §7 S7, D4): after this many operations are applied, the runner writes a snapshot and prunes the covered foreign ops in one transaction. A constant, not a knob — 500 keeps the op log short without snapshotting on every keystroke. */
export const COMPACT_EVERY_OPS = 500;
