// limits.test.ts — the rate window is the only arithmetic behind "3 warnings then close", so it
// gets its own examples: the cap is inclusive, the window resets on its boundary, and a burst
// that straddles a boundary counts in the new window only from the boundary on.
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@weft/protocol';
import { RateWindow, SERVER_LIMITS, Warnings } from '../src/limits.ts';

describe('RateWindow', () => {
  it('allows exactly the cap within one window and flags the first count past it', () => {
    const w = new RateWindow(3, 1000);
    expect(w.add(1, 0)).toBe(false);
    expect(w.add(2, 10)).toBe(false);
    expect(w.add(1, 20)).toBe(true);
    expect(w.add(1, 30)).toBe(true);
  });

  it('starts a fresh window when the window length has elapsed, so a limited connection recovers', () => {
    const w = new RateWindow(1, 1000);
    expect(w.add(2, 0)).toBe(true);
    expect(w.add(1, 999)).toBe(true);
    expect(w.add(1, 1000)).toBe(false);
    expect(w.add(1, 1001)).toBe(true);
  });

  it('counts a batch by its size, which is how ops per second are metered', () => {
    const w = new RateWindow(LIMITS.RATE_OPS_PER_SEC, 1000);
    expect(w.add(LIMITS.RATE_OPS_PER_SEC, 5)).toBe(false);
    expect(w.add(1, 6)).toBe(true);
  });

  it('the server limits derive from the protocol limits rather than restating them', () => {
    expect(SERVER_LIMITS.MAX_FRAME_BYTES).toBe(4 * LIMITS.MAX_MESSAGE_BYTES);
    expect(SERVER_LIMITS.CATCHUP_BATCH).toBe(LIMITS.MAX_OPS_PER_MESSAGE);
    expect(SERVER_LIMITS.MAX_QUEUED_FRAMES).toBeGreaterThanOrEqual(LIMITS.RATE_MESSAGES_PER_SEC);
  });
});

describe('Warnings (E32)', () => {
  it('the warning past the cap is fatal, and a clean interval forgives the earlier ones', () => {
    const w = new Warnings(3, 60_000);
    expect([w.add(0), w.add(10), w.add(20)]).toEqual([false, false, false]);
    expect(w.current).toBe(3);
    expect(w.add(30)).toBe(true);
    const forgiven = new Warnings(3, 60_000);
    expect([forgiven.add(0), forgiven.add(1), forgiven.add(2)]).toEqual([false, false, false]);
    expect(forgiven.add(59_999 + 2)).toBe(true); // not yet a clean minute since the last warning
    const clean = new Warnings(3, 60_000);
    expect([clean.add(0), clean.add(1), clean.add(2)]).toEqual([false, false, false]);
    expect(clean.add(60_002)).toBe(false); // a full minute after the last warning: back to one
    expect(clean.current).toBe(1);
  });
});
