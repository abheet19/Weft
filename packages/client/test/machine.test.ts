// machine.test.ts — the session reducer, LLD §4. Examples pin every transition the diagram draws
// (and the timers: hello timeout, backoff, retry) and the denied/interrupted paths: a fatal error
// keeps editing allowed, a socket lost mid-syncing degrades and comes back as connecting. The
// model-based property then throws every event at every state: `offline` never leaves on a
// socket event, `unacked` is never negative, and every state that waits has scheduled its wake-up.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ReplicaId, StateVector } from '@weft/protocol';
import { HELLO_TIMEOUT_MS } from '../src/session/constants.ts';
import { backoffMs, initialSession, reduce, type Effect, type SessionEvent, type SessionState } from '../src/session/machine.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const sv = (o: Record<string, number>): StateVector => o as StateVector;
const NOW = 1_000_000;
const numRuns = process.env['CI'] ? 10_000 : 1_000;

/** Fold events from the initial state at a fixed clock; returns the final step. */
function after(events: SessionEvent[], now = NOW): { state: SessionState; effects: readonly Effect[] } {
  let state = initialSession;
  let effects: readonly Effect[] = [];
  for (const ev of events) ({ state, effects } = reduce(state, ev, now));
  return { state, effects };
}

const toLive: SessionEvent[] = [{ e: 'START' }, { e: 'SOCKET_OPEN' }, { e: 'WELCOME', theirSv: sv({}), mySv: sv({}) }, { e: 'CATCHUP_DONE' }];

describe('backoff', () => {
  it('is min(250·2^attempt, 8000) plus the supplied jitter', () => {
    expect(backoffMs(0, 0)).toBe(250);
    expect(backoffMs(1, 0)).toBe(500);
    expect(backoffMs(2, 7)).toBe(1007);
    expect(backoffMs(5, 0)).toBe(8000);
    expect(backoffMs(6, 249)).toBe(8249);
    expect(backoffMs(60, 0)).toBe(8000);
  });
});

describe('the happy path', () => {
  it('START opens a socket and arms the hello timeout', () => {
    const { state, effects } = after([{ e: 'START' }]);
    expect(state).toEqual({ s: 'connecting', attempt: 0, unacked: 0 });
    expect(effects).toEqual([{ f: 'OPEN_SOCKET' }, { f: 'SCHEDULE', at: NOW + HELLO_TIMEOUT_MS }]);
  });

  it('SOCKET_OPEN sends hello and stays connecting until the welcome', () => {
    const { state, effects } = after([{ e: 'START' }, { e: 'SOCKET_OPEN' }]);
    expect(state.s).toBe('connecting');
    expect(effects).toEqual([{ f: 'SEND_HELLO' }]);
  });

  it('WELCOME computes what is in and out from the two state vectors and asks for my missing ops to be sent', () => {
    const theirs = sv({ [A]: 2, [B]: 9 });
    const mine = sv({ [A]: 5, [B]: 4 });
    const { state, effects } = after([{ e: 'START' }, { e: 'SOCKET_OPEN' }, { e: 'WELCOME', theirSv: theirs, mySv: mine }]);
    expect(state).toEqual({ s: 'syncing', inbound: 5, outbound: 3, unacked: 0 });
    expect(effects).toEqual([{ f: 'SEND_OPS_SINCE', sv: theirs }]);
  });

  it('CATCHUP_DONE goes live with no ack seen yet; ACK stamps the time and derives unacked', () => {
    expect(after(toLive).state).toEqual({ s: 'live', unacked: 0, lastAckAt: null });
    const { state } = after([...toLive, { e: 'LOCAL_OPS_PERSISTED', count: 3 }, { e: 'ACK', upToSeq: 5, mySeq: 7 }]);
    expect(state).toEqual({ s: 'live', unacked: 2, lastAckAt: NOW });
  });

  it('unacked is never below zero even when the server acknowledges more than the persisted seq', () => {
    expect(after([...toLive, { e: 'ACK', upToSeq: 9, mySeq: 7 }]).state.unacked).toBe(0);
  });
});

describe('timers and backoff', () => {
  it(`hello timeout after ${HELLO_TIMEOUT_MS} ms → degraded with the attempt kept, the socket closed and a retry scheduled with jitter from the clock`, () => {
    // The reducer's own `now` is the clock every deadline is measured from; the event's `now` only says when the timer fired.
    const { state, effects } = after([{ e: 'START' }, { e: 'SOCKET_OPEN' }, { e: 'TIMER', now: NOW + HELLO_TIMEOUT_MS }]);
    const retryAt = NOW + backoffMs(0, NOW % 250);
    expect(state).toEqual({ s: 'degraded', attempt: 0, retryAt, lastError: 'hello timeout', unacked: 0 });
    expect(effects).toEqual([{ f: 'CLOSE_SOCKET', code: 1000 }, { f: 'SCHEDULE', at: retryAt }]);
  });

  it('the retry timer reconnects with attempt + 1, and each failure doubles the wait up to 8 s', () => {
    let step = after([{ e: 'START' }]);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      step = reduce(step.state, { e: 'SOCKET_ERROR', reason: 'refused' }, NOW);
      expect(step.state.s).toBe('degraded');
      if (step.state.s === 'degraded') waits.push(step.state.retryAt - NOW - (NOW % 250));
      step = reduce(step.state, { e: 'TIMER', now: (step.state as { retryAt: number }).retryAt }, NOW);
      expect(step.state).toMatchObject({ s: 'connecting', attempt: i + 1 });
      expect(step.effects[0]).toEqual({ f: 'OPEN_SOCKET' });
    }
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('a timer that fires early in degraded re-arms itself for retryAt', () => {
    const degraded = after([{ e: 'START' }, { e: 'SOCKET_CLOSED', code: 1006, reason: '' }]).state as { retryAt: number };
    const { state, effects } = reduce(degraded as SessionState, { e: 'TIMER', now: degraded.retryAt - 1 }, NOW);
    expect(state).toBe(degraded);
    expect(effects).toEqual([{ f: 'SCHEDULE', at: degraded.retryAt }]);
  });

  it('a stale hello timer in syncing or live does nothing', () => {
    for (const events of [toLive.slice(0, 3), toLive]) {
      const before = after(events).state;
      expect(reduce(before, { e: 'TIMER', now: NOW + 99_999 }, NOW)).toEqual({ state: before, effects: [] });
    }
  });

  it('pong timeout arrives as SOCKET_ERROR in live → degraded from attempt 0 (live resets the count)', () => {
    const { state, effects } = after([...toLive, { e: 'SOCKET_ERROR', reason: 'pong timeout' }]);
    expect(state).toMatchObject({ s: 'degraded', attempt: 0, lastError: 'pong timeout' });
    expect(effects[0]).toEqual({ f: 'CLOSE_SOCKET', code: 1000 });
  });
});

describe('interrupted path: the socket is lost mid-syncing', () => {
  it('degrades, then reconnects with a fresh hello; unacked survives the round trip', () => {
    const syncing = after([{ e: 'START' }, { e: 'SOCKET_OPEN' }, { e: 'LOCAL_OPS_PERSISTED', count: 4 }, { e: 'WELCOME', theirSv: sv({ [B]: 3 }), mySv: sv({ [A]: 4 }) }]);
    expect(syncing.state).toEqual({ s: 'syncing', inbound: 3, outbound: 4, unacked: 4 });
    const dropped = reduce(syncing.state, { e: 'SOCKET_CLOSED', code: 1006, reason: 'abnormal' }, NOW);
    expect(dropped.state).toMatchObject({ s: 'degraded', attempt: 0, unacked: 4, lastError: 'socket closed (1006: abnormal)' });
    expect(dropped.effects).toEqual([{ f: 'SCHEDULE', at: (dropped.state as { retryAt: number }).retryAt }]);
    const retried = reduce(dropped.state, { e: 'TIMER', now: (dropped.state as { retryAt: number }).retryAt }, NOW);
    expect(retried.state).toEqual({ s: 'connecting', attempt: 1, unacked: 4 });
    expect(retried.effects).toEqual([{ f: 'OPEN_SOCKET' }, { f: 'SCHEDULE', at: NOW + HELLO_TIMEOUT_MS }]);
    const hello = reduce(retried.state, { e: 'SOCKET_OPEN' }, NOW);
    expect(hello.effects).toEqual([{ f: 'SEND_HELLO' }]);
  });
});

describe('server errors', () => {
  it('SEQ_GAP in live or syncing → syncing with a REHELLO; elsewhere ignored', () => {
    const fromLive = after([...toLive, { e: 'SERVER_ERROR', code: 'SEQ_GAP', fatal: false, reason: 'gap' }]);
    expect(fromLive.state).toEqual({ s: 'syncing', inbound: 0, outbound: 0, unacked: 0 });
    expect(fromLive.effects).toEqual([{ f: 'REHELLO' }]);
    const fromSyncing = after([...toLive.slice(0, 3), { e: 'SERVER_ERROR', code: 'SEQ_GAP', fatal: false, reason: 'gap' }]);
    expect(fromSyncing.effects).toEqual([{ f: 'REHELLO' }]);
    const connecting = after([{ e: 'START' }]).state;
    expect(reduce(connecting, { e: 'SERVER_ERROR', code: 'SEQ_GAP', fatal: false, reason: 'gap' }, NOW)).toEqual({ state: connecting, effects: [] });
  });

  it('non-fatal BAD_SHAPE, TOO_LARGE and a rate warning change nothing', () => {
    const live = after(toLive).state;
    for (const code of ['BAD_SHAPE', 'TOO_LARGE', 'RATE_LIMITED'] as const) {
      expect(reduce(live, { e: 'SERVER_ERROR', code, fatal: false, reason: 'x' }, NOW)).toEqual({ state: live, effects: [] });
    }
  });

  it('denied path: a fatal UNSUPPORTED_VERSION → failed with the socket closed; editing continues; USER_ONLINE retries', () => {
    const failed = after([...toLive, { e: 'SERVER_ERROR', code: 'UNSUPPORTED_VERSION', fatal: true, reason: 'v2 only' }]);
    expect(failed.state).toEqual({ s: 'failed', code: 'UNSUPPORTED_VERSION', reason: 'v2 only', unacked: 0 });
    expect(failed.effects).toEqual([{ f: 'CLOSE_SOCKET', code: 1000 }]);
    const edited = reduce(failed.state, { e: 'LOCAL_OPS_PERSISTED', count: 2 }, NOW);
    expect(edited.state).toMatchObject({ s: 'failed', unacked: 2 });
    for (const ev of [{ e: 'SOCKET_CLOSED', code: 1002, reason: '' }, { e: 'TIMER', now: NOW + 1 }, { e: 'BROWSER_ONLINE' }, { e: 'START' }] as SessionEvent[]) {
      expect(reduce(edited.state, ev, NOW).state).toBe(edited.state);
    }
    const retried = reduce(edited.state, { e: 'USER_ONLINE' }, NOW);
    expect(retried.state).toEqual({ s: 'connecting', attempt: 0, unacked: 2 });
    expect(reduce(edited.state, { e: 'USER_OFFLINE' }, NOW).state).toEqual({ s: 'offline', reason: 'user', unacked: 2 });
  });

  it('fatal FOREIGN_REPLICA and PENDING_OVERFLOW are terminal; fatal RATE_LIMITED and INTERNAL degrade and retry', () => {
    for (const code of ['FOREIGN_REPLICA', 'PENDING_OVERFLOW'] as const) {
      expect(after([...toLive, { e: 'SERVER_ERROR', code, fatal: true, reason: 'r' }]).state).toMatchObject({ s: 'failed', code });
    }
    for (const code of ['RATE_LIMITED', 'INTERNAL'] as const) {
      const { state, effects } = after([...toLive, { e: 'SERVER_ERROR', code, fatal: true, reason: 'r' }]);
      expect(state).toMatchObject({ s: 'degraded', attempt: 0, lastError: `${code}: r` });
      expect(effects[0]).toEqual({ f: 'CLOSE_SOCKET', code: 1000 });
    }
    const connecting = after([{ e: 'START' }, { e: 'SOCKET_ERROR', reason: 'x' }, { e: 'TIMER', now: NOW + 9000 }]).state;
    expect(reduce(connecting, { e: 'SERVER_ERROR', code: 'INTERNAL', fatal: true, reason: 'r' }, NOW).state).toMatchObject({ s: 'degraded', attempt: 1 });
  });
});

describe('the load finds a reason to stay offline (S4, LLD §4 "[*] → offline")', () => {
  it('START with the user toggle persisted → offline · user with no socket opened; USER_ONLINE then connects', () => {
    const { state, effects } = after([{ e: 'START', offline: 'user' }]);
    expect(state).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    expect(effects).toEqual([]);
    expect(reduce(state, { e: 'USER_ONLINE' }, NOW).state).toEqual({ s: 'connecting', attempt: 0, unacked: 0 });
  });

  it('START with the browser offline → offline · browser (the initial state’s "user" is a placeholder the load replaces); BROWSER_ONLINE then connects', () => {
    const { state, effects } = after([{ e: 'START', offline: 'browser' }]);
    expect(state).toEqual({ s: 'offline', reason: 'browser', unacked: 0 });
    expect(effects).toEqual([]);
    expect(reduce(state, { e: 'BROWSER_ONLINE' }, NOW).state).toEqual({ s: 'connecting', attempt: 0, unacked: 0 });
  });

  it('the honest count dispatched before START survives it', () => {
    expect(after([{ e: 'ACK', upToSeq: 2, mySeq: 9 }, { e: 'START', offline: 'user' }]).state).toEqual({ s: 'offline', reason: 'user', unacked: 7 });
  });
});

describe('the store fails (E18 reconciled: STORE_FAILED ends in failed, not degraded)', () => {
  it('from live: failed with code STORE_FAILED and the reason, the socket closed so nothing unpersisted is ever sent', () => {
    const { state, effects } = after([...toLive, { e: 'LOCAL_OPS_PERSISTED', count: 2 }, { e: 'STORE_FAILED', reason: 'store failed: QuotaExceededError' }]);
    expect(state).toEqual({ s: 'failed', code: 'STORE_FAILED', reason: 'store failed: QuotaExceededError', unacked: 2 });
    expect(effects).toEqual([{ f: 'CLOSE_SOCKET', code: 1000 }]);
  });

  it('from offline or degraded there is no socket to close; a second failure changes nothing; USER_ONLINE retries', () => {
    const offline = after([{ e: 'START', offline: 'user' }, { e: 'STORE_FAILED', reason: 'r' }]);
    expect(offline.state).toMatchObject({ s: 'failed', code: 'STORE_FAILED' });
    expect(offline.effects).toEqual([]);
    const degraded = after([{ e: 'START' }, { e: 'SOCKET_ERROR', reason: 'x' }, { e: 'STORE_FAILED', reason: 'r' }]);
    expect(degraded.state).toMatchObject({ s: 'failed' });
    expect(degraded.effects).toEqual([]);
    const again = reduce(offline.state, { e: 'STORE_FAILED', reason: 'later' }, NOW);
    expect(again.state).toBe(offline.state);
    expect(reduce(offline.state, { e: 'USER_ONLINE' }, NOW).state).toEqual({ s: 'connecting', attempt: 0, unacked: 0 });
  });
});

describe('offline, by the user and by the browser', () => {
  it('USER_OFFLINE from live closes the socket; BROWSER_ONLINE does not override the user; USER_ONLINE reconnects', () => {
    const off = after([...toLive, { e: 'USER_OFFLINE' }]);
    expect(off.state).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    expect(off.effects).toEqual([{ f: 'CLOSE_SOCKET', code: 1000 }]);
    expect(reduce(off.state, { e: 'BROWSER_ONLINE' }, NOW).state).toBe(off.state);
    expect(reduce(off.state, { e: 'USER_ONLINE' }, NOW).state).toEqual({ s: 'connecting', attempt: 0, unacked: 0 });
  });

  it('BROWSER_OFFLINE from degraded needs no socket close; BROWSER_ONLINE then reconnects; the user can still take over the reason', () => {
    const degraded = after([{ e: 'START' }, { e: 'SOCKET_CLOSED', code: 1006, reason: '' }]).state;
    const off = reduce(degraded, { e: 'BROWSER_OFFLINE' }, NOW);
    expect(off).toEqual({ state: { s: 'offline', reason: 'browser', unacked: 0 }, effects: [] });
    expect(reduce(off.state, { e: 'BROWSER_ONLINE' }, NOW).state).toMatchObject({ s: 'connecting' });
    expect(reduce(off.state, { e: 'USER_OFFLINE' }, NOW).state).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    expect(reduce(off.state, { e: 'BROWSER_OFFLINE' }, NOW).state).toBe(off.state);
    const userOff = reduce(off.state, { e: 'USER_OFFLINE' }, NOW).state;
    expect(reduce(userOff, { e: 'BROWSER_OFFLINE' }, NOW).state).toBe(userOff);
  });

  it('"Retry now" (USER_ONLINE in degraded) reconnects at once with the attempt count kept', () => {
    const degraded = after([{ e: 'START' }, { e: 'SOCKET_ERROR', reason: 'x' }, { e: 'TIMER', now: NOW + 9000 }, { e: 'SOCKET_ERROR', reason: 'x' }]).state;
    expect(degraded).toMatchObject({ s: 'degraded', attempt: 1 });
    expect(reduce(degraded, { e: 'USER_ONLINE' }, NOW).state).toEqual({ s: 'connecting', attempt: 2, unacked: 0 });
    expect(reduce(degraded, { e: 'START' }, NOW).state).toBe(degraded);
  });

  it('stale events in live and degraded change nothing', () => {
    const live = after(toLive).state;
    for (const ev of [{ e: 'SOCKET_OPEN' }, { e: 'WELCOME', theirSv: sv({}), mySv: sv({}) }, { e: 'CATCHUP_DONE' }, { e: 'START' }, { e: 'BROWSER_ONLINE' }] as SessionEvent[]) {
      expect(reduce(live, ev, NOW).state).toBe(live);
    }
    const degraded = after([{ e: 'START' }, { e: 'SOCKET_ERROR', reason: 'x' }]).state;
    for (const ev of [{ e: 'SOCKET_CLOSED', code: 1006, reason: '' }, { e: 'SERVER_ERROR', code: 'INTERNAL', fatal: true, reason: '' }, { e: 'SOCKET_OPEN' }] as SessionEvent[]) {
      expect(reduce(degraded, ev, NOW).state).toBe(degraded);
    }
  });
});

// ---- model-based: every event against every reachable state --------------------------------

const SOCKET_EVENTS = new Set<SessionEvent['e']>(['SOCKET_OPEN', 'SOCKET_CLOSED', 'SOCKET_ERROR', 'WELCOME', 'CATCHUP_DONE', 'SERVER_ERROR', 'TIMER']);

const arbEvent: fc.Arbitrary<SessionEvent> = fc.oneof(
  fc.constantFrom<SessionEvent>({ e: 'START' }, { e: 'START', offline: 'user' }, { e: 'START', offline: 'browser' }, { e: 'USER_OFFLINE' }, { e: 'USER_ONLINE' }, { e: 'BROWSER_OFFLINE' }, { e: 'BROWSER_ONLINE' }, { e: 'SOCKET_OPEN' }, { e: 'CATCHUP_DONE' }, { e: 'STORE_FAILED', reason: 'r' }),
  fc.record({ e: fc.constant('SOCKET_CLOSED' as const), code: fc.constantFrom(1000, 1001, 1002, 1006, 1008, 1011), reason: fc.constantFrom('', 'bye') }),
  fc.record({ e: fc.constant('SOCKET_ERROR' as const), reason: fc.constantFrom('refused', 'pong timeout') }),
  fc.record({ e: fc.constant('WELCOME' as const), theirSv: fc.constant(sv({ [B]: 3 })), mySv: fc.constant(sv({ [A]: 2 })) }),
  fc.record({ e: fc.constant('LOCAL_OPS_PERSISTED' as const), count: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ e: fc.constant('ACK' as const), upToSeq: fc.nat({ max: 20 }), mySeq: fc.nat({ max: 20 }) }),
  fc.record({
    e: fc.constant('SERVER_ERROR' as const),
    code: fc.constantFrom('BAD_SHAPE', 'UNSUPPORTED_VERSION', 'SEQ_GAP', 'FOREIGN_REPLICA', 'TOO_LARGE', 'RATE_LIMITED', 'PENDING_OVERFLOW', 'INTERNAL' as const),
    fatal: fc.boolean(),
    reason: fc.constant('r'),
  }),
  fc.record({ e: fc.constant('TIMER' as const), now: fc.integer({ min: 0, max: 20_000 }) }).map((t) => ({ ...t, now: NOW + t.now })),
);

type Model = { now: number };
type Real = { state: SessionState };

class Step implements fc.Command<Model, Real> {
  /** `atRetry` turns a TIMER into one firing exactly at the current retryAt, so the reconnect branch is reachable without a random clock. */
  constructor(
    readonly ev: SessionEvent,
    readonly atRetry = false,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: Model, r: Real): void {
    const before = r.state;
    const now = m.now;
    const ev: SessionEvent = this.ev.e === 'TIMER' && this.atRetry && before.s === 'degraded' ? { e: 'TIMER', now: before.retryAt } : this.ev;
    const { state, effects } = reduce(before, ev, now);
    r.state = state;
    m.now = now + 1;

    expect(state.unacked).toBeGreaterThanOrEqual(0);
    if (before.s === 'offline' && SOCKET_EVENTS.has(ev.e)) {
      expect(state).toBe(before);
      expect(effects).toEqual([]);
    }
    if (before.s === 'failed' && !['USER_ONLINE', 'USER_OFFLINE', 'BROWSER_OFFLINE', 'LOCAL_OPS_PERSISTED', 'ACK', 'START'].includes(ev.e)) expect(state).toBe(before);
    if (ev.e === 'STORE_FAILED') expect(state).toMatchObject({ s: 'failed', code: before.s === 'failed' ? before.code : 'STORE_FAILED' });
    if (ev.e === 'START' && ev.offline !== undefined) {
      expect(state).toEqual({ s: 'offline', reason: ev.offline, unacked: before.unacked });
      expect(effects.every((f) => f.f === 'CLOSE_SOCKET')).toBe(true);
    }
    if (effects.some((f) => f.f === 'OPEN_SOCKET')) {
      expect(state.s).toBe('connecting');
      expect(effects).toContainEqual({ f: 'SCHEDULE', at: now + HELLO_TIMEOUT_MS });
    }
    if (state.s === 'connecting' && before.s !== 'connecting') expect(effects).toContainEqual({ f: 'OPEN_SOCKET' });
    if (state.s === 'degraded') {
      expect(state.retryAt - now).toBeGreaterThanOrEqual(0);
      if (before.s !== 'degraded') {
        expect(state.retryAt - now).toBeLessThanOrEqual(8000 + 249);
        expect(effects).toContainEqual({ f: 'SCHEDULE', at: state.retryAt });
      }
    }
    if (effects.some((f) => f.f === 'CLOSE_SOCKET')) expect(['connecting', 'syncing', 'live']).toContain(before.s);
    if (effects.some((f) => f.f === 'SEND_HELLO')) expect(before.s).toBe('connecting');
    if (effects.some((f) => f.f === 'REHELLO')) expect(state.s).toBe('syncing');
    if (ev.e === 'LOCAL_OPS_PERSISTED') expect(state.unacked).toBe(before.unacked + ev.count);
    if (ev.e === 'ACK') expect(state.unacked).toBe(Math.max(0, ev.mySeq - ev.upToSeq));
    if (ev.e !== 'LOCAL_OPS_PERSISTED' && ev.e !== 'ACK') expect(state.unacked).toBe(before.unacked);
  }
  toString(): string {
    return JSON.stringify(this.ev);
  }
}

describe('model-based: invariants hold along every event sequence', () => {
  it('offline never leaves on a socket event; unacked never negative; every waiting state has scheduled its wake-up; effects match transitions', () => {
    fc.assert(
      fc.property(fc.commands([arbEvent.map((ev) => new Step(ev)), fc.constant(new Step({ e: 'TIMER', now: NOW }, true))], { size: '+1' }), (cmds) => {
        fc.modelRun(() => ({ model: { now: NOW }, real: { state: initialSession } }), cmds);
      }),
      { numRuns },
    );
  });
});
