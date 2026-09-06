// pillCopy.test.ts — the pill says exactly the words of 03-UI §4.1 for every reducer state and
// every storage status (I11, the derived half): `Saved` is reachable from `live` with nothing
// unacknowledged only, the suffix appears exactly when the device's copy is weaker than it sounds,
// the popover names the last error and offers `Retry now` only while degraded, and the wall clock
// reaches labels only — two clocks a century apart change the countdown and "N s ago" and nothing
// else (LLD §8 "clock set to 1970 / 2099").
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SessionState } from '../src/session/machine.ts';
import { pillCopy, type StorageStatus } from '../src/ui/pillCopy.ts';

const NOW = 1_000_000;
const IDB: StorageStatus = { kind: 'idb' };

const STATES: readonly SessionState[] = [
  { s: 'live', unacked: 0, lastAckAt: NOW - 2_000 },
  { s: 'live', unacked: 0, lastAckAt: null },
  { s: 'live', unacked: 3, lastAckAt: null },
  { s: 'syncing', inbound: 12, outbound: 31, unacked: 31 },
  { s: 'connecting', attempt: 0, unacked: 0 },
  { s: 'degraded', attempt: 2, retryAt: NOW + 7_400, lastError: 'ECONNREFUSED', unacked: 4 },
  { s: 'offline', reason: 'user', unacked: 31 },
  { s: 'offline', reason: 'browser', unacked: 7 },
  { s: 'failed', code: 'UNSUPPORTED_VERSION', reason: 'v2 only', unacked: 2 },
  { s: 'failed', code: 'STORE_FAILED', reason: 'store failed: QuotaExceededError', unacked: 2 },
];

describe('pillCopy', () => {
  it('uses the exact copy of 03-UI §4.1 for each state — text, hue, icon, popover body and whether Retry now is offered', () => {
    const rows = STATES.map((state) => pillCopy(state, NOW, IDB));
    expect(rows).toEqual([
      { text: 'Saved', hue: 'ok', icon: 'check', suffix: null, body: 'Every change is on the server. Last ack 2 s ago.', retry: false },
      { text: 'Saved', hue: 'ok', icon: 'check', suffix: null, body: 'Every change is on the server.', retry: false },
      { text: 'Syncing · 3', hue: 'sync', icon: 'sync', suffix: null, body: '3 changes are on this device and in flight.', retry: false },
      { text: 'Catching up · 12 in, 31 out', hue: 'sync', icon: 'sync', suffix: null, body: '12 ops coming in, 31 going out, computed from the state-vector diff.', retry: false },
      { text: 'Connecting…', hue: 'warn', icon: 'clock', suffix: null, body: 'Attempt 1. The server has 5 s to answer before the next try.', retry: false },
      { text: 'Reconnecting in 8s · 4 on this device', hue: 'warn', icon: 'clock', suffix: null, body: 'Last error: ECONNREFUSED', retry: true },
      { text: 'Offline · 31 changes on this device', hue: 'warn', icon: 'wifioff', suffix: null, body: 'Saved on this device. Will sync when back online.', retry: false },
      { text: 'Offline · 7 changes on this device', hue: 'warn', icon: 'wifioff', suffix: null, body: 'Saved on this device. Will sync when back online.', retry: false },
      { text: 'Can’t connect · UNSUPPORTED_VERSION', hue: 'bad', icon: 'alert', suffix: null, body: 'v2 only. Nothing is sent; every change stays on this device.', retry: false },
      { text: 'Can’t save · STORE_FAILED', hue: 'bad', icon: 'alert', suffix: null, body: 'store failed: QuotaExceededError. Changes since then are in this tab’s memory only — copy anything important before reloading.', retry: false },
    ]);
  });

  it('the storage suffix is a function of the storage status alone: a working IndexedDB store carries none, the memory fallback carries the caveat — in every state, appended to the body', () => {
    for (const state of STATES) {
      const idb = pillCopy(state, NOW, IDB);
      const memory = pillCopy(state, NOW, { kind: 'memory' });
      expect(idb.suffix).toBeNull(); // persistence is requested silently; a working idb store is never a warning
      expect(memory).toEqual({ ...idb, suffix: 'not persisted on this device', body: `${idb.body} IndexedDB could not be opened, so changes live in this tab’s memory only and are gone when it closes.` });
    }
  });

  it('never counts down below one second, so a retry that is due still reads as imminent rather than "in 0s"', () => {
    expect(pillCopy({ s: 'degraded', attempt: 0, retryAt: NOW - 50, lastError: 'x', unacked: 0 }, NOW, IDB).text).toBe('Reconnecting in 1s · 0 on this device');
  });

  it('attack: a clock set to 1970 or 2099 changes the countdown and "N s ago" labels and nothing else', () => {
    for (const state of STATES) {
      const a = pillCopy(state, 0, IDB);
      const b = pillCopy(state, 4_102_444_800_000, IDB);
      const strip = (c: typeof a): unknown => ({ ...c, text: c.text.replace(/in \d+s/, 'in Ns'), body: c.body.replace(/Last ack \d+ s ago/, 'Last ack N s ago') });
      expect(strip(a)).toEqual(strip(b));
    }
  });

  it('says Saved for exactly one state: live with nothing unacknowledged (I11)', () => {
    const arbState: fc.Arbitrary<SessionState> = fc.oneof(
      fc.record({ s: fc.constant('offline' as const), reason: fc.constantFrom('user' as const, 'browser' as const), unacked: fc.nat() }),
      fc.record({ s: fc.constant('connecting' as const), attempt: fc.nat(), unacked: fc.nat() }),
      fc.record({ s: fc.constant('syncing' as const), inbound: fc.nat(), outbound: fc.nat(), unacked: fc.nat() }),
      fc.record({ s: fc.constant('live' as const), unacked: fc.nat(), lastAckAt: fc.option(fc.nat(), { nil: null }) }),
      fc.record({ s: fc.constant('degraded' as const), attempt: fc.nat(), retryAt: fc.nat(), lastError: fc.string(), unacked: fc.nat() }),
      fc.record({ s: fc.constant('failed' as const), code: fc.constantFrom('INTERNAL' as const, 'STORE_FAILED' as const, 'UNSUPPORTED_VERSION' as const), reason: fc.string(), unacked: fc.nat() }),
    );
    const arbStorage: fc.Arbitrary<StorageStatus> = fc.oneof(fc.constant({ kind: 'idb' as const }), fc.constant({ kind: 'memory' as const }));
    fc.assert(
      fc.property(arbState, fc.nat(), arbStorage, (state, now, storage) => {
        const copy = pillCopy(state, now, storage);
        expect(copy.text === 'Saved').toBe(state.s === 'live' && state.unacked === 0);
        expect(copy.hue === 'ok').toBe(copy.text === 'Saved');
        expect(copy.retry).toBe(state.s === 'degraded');
        expect(copy.suffix === null).toBe(storage.kind === 'idb');
        if (state.s !== 'live' && state.s !== 'connecting' && state.s !== 'failed' && state.s !== 'syncing') expect(copy.text).toContain(String(state.unacked));
      }),
      { numRuns: process.env['CI'] ? 10_000 : 1_000 },
    );
  });
});
