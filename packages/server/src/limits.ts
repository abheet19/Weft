// limits.ts — the server's own tunables and the two pieces of accounting they need. This file
// exists so a resource bound (frame size, send queue, queued frames, warnings before a close,
// minutes of bad frames) is named once and quoted by tests, and so rate limiting is a pure class
// a test can drive with a supplied clock. It must never restate a number from @weft/protocol's
// LIMITS — it derives from them — and nothing here may read the clock itself.

import { LIMITS } from '@weft/protocol';

export const SERVER_LIMITS = {
  /** `ws` refuses frames above this before buffering them (close 1009). Between LIMITS.MAX_MESSAGE_BYTES and this, the server answers TOO_LARGE so the sender learns the real bound. */
  MAX_FRAME_BYTES: 4 * LIMITS.MAX_MESSAGE_BYTES,
  /** Bytes queued for one connection by LIVE fan-out before it is dropped as a slow consumer, so one stalled socket cannot hold every other member's fan-out in memory. Catch-up is paced instead (below). */
  SEND_QUEUE_BYTES: 4 * 1024 * 1024,
  /** During catch-up the next frame is sent only once the socket's buffer has drained below this (E22): a fresh replica joining a large document must never look like a slow consumer. */
  CATCHUP_LOW_WATER_BYTES: 256 * 1024,
  /** Decoded frames a connection may have waiting behind a slow handler (an fsync, a catch-up). Above the message rate so an honest client never reaches it; a flood while the disk stalls does (E33). */
  MAX_QUEUED_FRAMES: 64,
  /** Rate warnings before the close (LLD §5.4: "yes after 3 warnings"). */
  RATE_WARNINGS: 3,
  /** A connection that has stayed within its limits for this long has its warnings forgiven (E32). */
  WARNINGS_DECAY_MS: 60_000,
  /** Shape errors tolerated per minute before the connection is treated as hostile (LLD §5.2). */
  BAD_SHAPE_PER_MINUTE: 10,
  /** A connection that has not said hello by then is holding a socket for nothing. */
  HELLO_TIMEOUT_MS: 10_000,
  /** A connection silent for this long is dead: honest clients ping every 15 s. */
  IDLE_TIMEOUT_MS: 60_000,
  CATCHUP_BATCH: LIMITS.MAX_OPS_PER_MESSAGE,
  /** The file that marks a data directory as owned by one running server (E25). */
  LOCK_FILE: '.weft-server.lock',
} as const;

/**
 * A fixed-window counter. `add` returns true when this window's total exceeds the cap. Fixed
 * windows are coarse (a burst straddling a boundary counts twice), which errs toward the honest
 * client: it is never limited for less than a full window of excess.
 */
export class RateWindow {
  private windowStart = Number.NEGATIVE_INFINITY;
  private total = 0;
  private readonly cap: number;
  private readonly windowMs: number;

  // Explicit fields rather than parameter properties: Node 22 runs these sources with type
  // stripping only, which does not support the parameter-property shorthand.
  constructor(cap: number, windowMs: number) {
    this.cap = cap;
    this.windowMs = windowMs;
  }

  add(count: number, now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.total = 0;
    }
    this.total += count;
    return this.total > this.cap;
  }
}

/**
 * Strikes before a close, forgiven after a clean interval. Without the decay a connection that
 * was limited twice in its first minute stays one strike from a close for its whole life, which
 * punishes a long-lived honest tab for a burst an hour ago.
 */
export class Warnings {
  private count = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly cap: number;
  private readonly decayMs: number;

  constructor(cap: number, decayMs: number) {
    this.cap = cap;
    this.decayMs = decayMs;
  }

  /** Records a warning at `now`; true when it is one too many. */
  add(now: number): boolean {
    if (now - this.lastAt >= this.decayMs) this.count = 0;
    this.lastAt = now;
    this.count++;
    return this.count > this.cap;
  }

  /** Warnings on record, for the message that tells the client which one this is. */
  get current(): number {
    return this.count;
  }
}
