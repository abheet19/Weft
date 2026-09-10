// machine.ts — the session as a pure reducer: (state, event, now) → (state, effects). This file
// exists so the connection life cycle (LLD §4) can be tested exhaustively without a socket or a
// clock — every timer is a SCHEDULE effect the runner executes and a TIMER event it feeds back
// with the time. Jitter is derived from `now`, not drawn, so the reducer stays a function. The
// runner keeps ONE pending timer: each SCHEDULE replaces the previous one, so a stale timer never
// fires into a fresh attempt. `failed` (E9) is the terminal error card: a fatal error must not
// render as "reconnecting" — and a store that can no longer write is such a failure (STORE_FAILED,
// E18 reconciled in S4): the pill must not keep saying where the work is when it is nowhere. START
// carries what the load found — the user's persisted Simulate-offline toggle, or a browser that
// reports no network — so the session begins offline without ever opening a socket (LLD §4). It
// must never perform IO, never read a clock, and never disable editing — no state does.

import { svGet } from '@weft/crdt';
import type { ErrorCode, StateVector } from '@weft/protocol';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, HELLO_TIMEOUT_MS, JITTER_MS } from './constants.ts';

export type SessionState =
  | { s: 'offline'; reason: 'user' | 'browser'; unacked: number }
  | { s: 'connecting'; attempt: number; unacked: number }
  | { s: 'syncing'; inbound: number; outbound: number; unacked: number }
  | { s: 'live'; unacked: number; lastAckAt: number | null }
  | { s: 'degraded'; attempt: number; retryAt: number; lastError: string; unacked: number }
  | { s: 'failed'; code: FailureCode; reason: string; unacked: number }; // E9: fatal error, no automatic retry; editing continues on this device

/** What ended the session: a fatal code from the server, or this device's store refusing to write (E18). */
type FailureCode = ErrorCode | 'STORE_FAILED';

export type SessionEvent =
  /** The load: `offline` when the user's toggle was persisted or the browser reports no network — no socket is opened then. */
  | { e: 'START'; offline?: 'user' | 'browser' }
  | { e: 'USER_OFFLINE' }
  | { e: 'USER_ONLINE' }
  | { e: 'BROWSER_OFFLINE' }
  | { e: 'BROWSER_ONLINE' }
  | { e: 'SOCKET_OPEN' }
  | { e: 'SOCKET_CLOSED'; code: number; reason: string }
  | { e: 'SOCKET_ERROR'; reason: string }
  | { e: 'WELCOME'; theirSv: StateVector; mySv: StateVector }
  | { e: 'CATCHUP_DONE' }
  | { e: 'LOCAL_OPS_PERSISTED'; count: number }
  | { e: 'ACK'; upToSeq: number; mySeq: number }
  | { e: 'SERVER_ERROR'; code: ErrorCode; fatal: boolean; reason: string }
  /** The store rejected a write. Terminal: what is in memory can no longer be made durable here (E18). */
  | { e: 'STORE_FAILED'; reason: string }
  | { e: 'TIMER'; now: number };

export type Effect = { f: 'OPEN_SOCKET' } | { f: 'CLOSE_SOCKET'; code: number } | { f: 'SEND_HELLO' } | { f: 'SEND_OPS_SINCE'; sv: StateVector } | { f: 'SCHEDULE'; at: number } | { f: 'REHELLO' };

/** Fatal codes the server sends for a transient condition; the client retries with backoff instead of giving up (LLD §5.4). */
const RETRYABLE_FATAL: readonly ErrorCode[] = ['RATE_LIMITED', 'INTERNAL'];

/** Backoff is a pure function of attempt so tests can assert it: min(250 * 2^attempt, 8000) ms, plus supplied jitter in [0, 250). */
export function backoffMs(attempt: number, jitter: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) + jitter;
}

export const initialSession: SessionState = { s: 'offline', reason: 'user', unacked: 0 };

type Step = { state: SessionState; effects: readonly Effect[] };

export function reduce(state: SessionState, ev: SessionEvent, now: number): Step {
  switch (ev.e) {
    case 'START':
      return ev.offline === undefined ? goOnline(state, ev.e, now) : startOffline(state, ev.offline);
    case 'USER_ONLINE':
    case 'BROWSER_ONLINE':
      return goOnline(state, ev.e, now);
    case 'USER_OFFLINE':
    case 'BROWSER_OFFLINE':
      return goOffline(state, ev.e === 'USER_OFFLINE' ? 'user' : 'browser');
    case 'LOCAL_OPS_PERSISTED':
      return stay({ ...state, unacked: state.unacked + ev.count });
    case 'ACK':
      return acked(state, ev, now);
    case 'SOCKET_OPEN':
      return state.s === 'connecting' ? { state, effects: [{ f: 'SEND_HELLO' }] } : stay(state);
    case 'SOCKET_CLOSED':
      return dropped(state, `socket closed (${ev.code}${ev.reason === '' ? '' : `: ${ev.reason}`})`, false, now);
    case 'SOCKET_ERROR':
      return dropped(state, ev.reason, true, now);
    case 'WELCOME':
      return welcomed(state, ev.theirSv, ev.mySv);
    case 'CATCHUP_DONE':
      return state.s === 'syncing' ? stay({ s: 'live', unacked: state.unacked, lastAckAt: null }) : stay(state);
    case 'SERVER_ERROR':
      return serverError(state, ev, now);
    case 'STORE_FAILED':
      return storeFailed(state, ev.reason);
    case 'TIMER':
      return timer(state, ev.now, now);
  }
}

function stay(state: SessionState): Step {
  return { state, effects: [] };
}

/** Spread across clients by their differing clocks; a function of `now` so the reducer needs no randomness. */
function jitter(now: number): number {
  return ((now % JITTER_MS) + JITTER_MS) % JITTER_MS;
}

function connect(unacked: number, attempt: number, now: number): Step {
  return { state: { s: 'connecting', attempt, unacked }, effects: [{ f: 'OPEN_SOCKET' }, { f: 'SCHEDULE', at: now + HELLO_TIMEOUT_MS }] };
}

function degrade(unacked: number, attempt: number, lastError: string, now: number, closeSocket: boolean): Step {
  const retryAt = now + backoffMs(attempt, jitter(now));
  const effects: Effect[] = closeSocket ? [{ f: 'CLOSE_SOCKET', code: 1000 }] : [];
  effects.push({ f: 'SCHEDULE', at: retryAt });
  return { state: { s: 'degraded', attempt, retryAt, lastError, unacked }, effects };
}

function goOnline(state: SessionState, why: 'START' | 'USER_ONLINE' | 'BROWSER_ONLINE', now: number): Step {
  switch (state.s) {
    case 'offline':
      // The browser coming back must not override a user who chose to be offline.
      if (why === 'BROWSER_ONLINE' && state.reason === 'user') return stay(state);
      return connect(state.unacked, 0, now);
    case 'failed':
      return why === 'USER_ONLINE' ? connect(state.unacked, 0, now) : stay(state);
    case 'degraded':
      // "Retry now": skip the wait; the attempt count is kept so the next wait is still longer.
      return why === 'USER_ONLINE' ? connect(state.unacked, state.attempt + 1, now) : stay(state);
    default:
      return stay(state);
  }
}

function goOffline(state: SessionState, reason: 'user' | 'browser'): Step {
  if (state.s === 'offline') return reason === 'user' && state.reason !== 'user' ? stay({ ...state, reason }) : stay(state);
  return { state: { s: 'offline', reason, unacked: state.unacked }, effects: closeIfOpen(state) };
}

/** The load found a reason to stay off the network. Unlike `goOffline`, the initial state's `user` reason is a placeholder the load's finding replaces. */
function startOffline(state: SessionState, reason: 'user' | 'browser'): Step {
  return { state: { s: 'offline', reason, unacked: state.unacked }, effects: closeIfOpen(state) };
}

function closeIfOpen(state: SessionState): Effect[] {
  const hasSocket = state.s === 'connecting' || state.s === 'syncing' || state.s === 'live';
  return hasSocket ? [{ f: 'CLOSE_SOCKET', code: 1000 }] : [];
}

/** The device can no longer make edits durable. Terminal like a fatal server error, but from this side: the socket is closed so nothing unpersisted is ever sent (I10). */
function storeFailed(state: SessionState, reason: string): Step {
  if (state.s === 'failed') return stay(state);
  return { state: { s: 'failed', code: 'STORE_FAILED', reason, unacked: state.unacked }, effects: closeIfOpen(state) };
}

function acked(state: SessionState, ev: { upToSeq: number; mySeq: number }, now: number): Step {
  // unacked is DERIVED from the two counters (I11), never decremented by a UI event. The runner
  // supplies `upToSeq` from an acknowledged vector that is monotonic within the current welcome
  // epoch (E37), so a late, lower ack cannot make the count go back up.
  const unacked = Math.max(0, ev.mySeq - ev.upToSeq);
  return state.s === 'live' ? stay({ s: 'live', unacked, lastAckAt: now }) : stay({ ...state, unacked });
}

/** The socket went away under us: retry with backoff, remembering how many attempts this connection cost. */
function dropped(state: SessionState, lastError: string, closeSocket: boolean, now: number): Step {
  switch (state.s) {
    case 'connecting':
      return degrade(state.unacked, state.attempt, lastError, now, closeSocket);
    case 'syncing':
    case 'live':
      return degrade(state.unacked, 0, lastError, now, closeSocket);
    default:
      return stay(state); // offline, degraded and failed have no live socket; a late event is stale
  }
}

function welcomed(state: SessionState, theirs: StateVector, mine: StateVector): Step {
  if (state.s !== 'connecting' && state.s !== 'syncing') return stay(state);
  let inbound = 0;
  let outbound = 0;
  for (const replica of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const t = svGet(theirs, replica);
    const m = svGet(mine, replica);
    if (t > m) inbound += t - m;
    else outbound += m - t; // normally only my own ops; after a server log loss it also counts what only the authors can re-upload
  }
  return { state: { s: 'syncing', inbound, outbound, unacked: state.unacked }, effects: [{ f: 'SEND_OPS_SINCE', sv: theirs }] };
}

function serverError(state: SessionState, ev: { code: ErrorCode; fatal: boolean; reason: string }, now: number): Step {
  if (state.s === 'offline' || state.s === 'failed' || state.s === 'degraded') return stay(state);
  if (ev.fatal) {
    if (RETRYABLE_FATAL.includes(ev.code)) return degrade(state.unacked, state.s === 'connecting' ? state.attempt : 0, `${ev.code}: ${ev.reason}`, now, true);
    return { state: { s: 'failed', code: ev.code, reason: ev.reason, unacked: state.unacked }, effects: [{ f: 'CLOSE_SOCKET', code: 1000 }] };
  }
  if (ev.code === 'SEQ_GAP' && (state.s === 'live' || state.s === 'syncing')) {
    // The state vectors disagree about my own ops; a fresh hello exchanges them and repairs it.
    return { state: { s: 'syncing', inbound: 0, outbound: 0, unacked: state.unacked }, effects: [{ f: 'REHELLO' }] };
  }
  return stay(state); // BAD_SHAPE, TOO_LARGE and rate warnings are counted by the runner, not states
}

/** `firedAt` is the timer's own reading (did it reach retryAt?); `now` is the clock every new deadline is measured from. */
function timer(state: SessionState, firedAt: number, now: number): Step {
  switch (state.s) {
    case 'connecting':
      return degrade(state.unacked, state.attempt, 'hello timeout', now, true);
    case 'degraded':
      return firedAt >= state.retryAt ? connect(state.unacked, state.attempt + 1, now) : { state, effects: [{ f: 'SCHEDULE', at: state.retryAt }] };
    default:
      return stay(state); // a hello timer that outlived its attempt
  }
}
