// pillCopy.ts — the status pill's words, colour, icon, storage suffix and popover text as a pure
// function of the session state and the storage status (03-UI §4.1). This file exists so the one
// honest object on the screen is testable without React: `Saved` appears only for `live` with
// nothing unacknowledged (I11), every other state names where the work is and how much of it, and
// the suffix says when "on this device" is weaker than it sounds. There is now exactly one such
// case: `not persisted on this device`, when IndexedDB could not be opened and the store is this
// tab's memory — a real data-loss risk. The old idb `storage may be evicted` surface was removed:
// durable storage is requested silently on load (`navigator.storage.persist()`), because on Chrome
// it never prompts and returns false on localhost, so a warning drawn from it was alarmist and a
// dead end. A working IndexedDB store therefore never carries a suffix. `now` is supplied so the
// countdown and "last ack N s ago" are functions, not clock reads; the wall clock reaches labels
// only, never a decision. It must never invent a state the reducer does not have and never soften a
// failure into a waiting message: `failed` is red and says it cannot connect — or, for a store
// failure, cannot save.

import { HELLO_TIMEOUT_MS } from '../session/constants.ts';
import type { SessionState } from '../session/machine.ts';

type Hue = 'ok' | 'sync' | 'warn' | 'bad';
type PillIcon = 'check' | 'sync' | 'clock' | 'wifioff' | 'alert';

/** Where this document's changes live on the device: a working IndexedDB store, or this tab's memory when IndexedDB could not be opened. */
export type StorageStatus = { readonly kind: 'idb' } | { readonly kind: 'memory' };

export interface PillCopy {
  readonly text: string;
  readonly hue: Hue;
  readonly icon: PillIcon;
  /** Shown after the text as `· suffix`; null when the device's copy is as safe as it sounds. */
  readonly suffix: string | null;
  /** The popover: what the pill means, in a sentence, plus the storage caveat when there is one. */
  readonly body: string;
  /** The popover offers `Retry now` (USER_ONLINE). */
  readonly retry: boolean;
}

export function pillCopy(state: SessionState, now: number, storage: StorageStatus): PillCopy {
  const main = mainCopy(state, now);
  return { ...main, suffix: suffixOf(storage), body: main.body + storageCaveat(storage) };
}

function mainCopy(state: SessionState, now: number): Omit<PillCopy, 'suffix'> {
  switch (state.s) {
    case 'live':
      if (state.unacked === 0) return { text: 'Saved', hue: 'ok', icon: 'check', body: `Every change is on the server.${state.lastAckAt === null ? '' : ` Last ack ${ago(now - state.lastAckAt)}.`}`, retry: false };
      return { text: `Syncing · ${state.unacked}`, hue: 'sync', icon: 'sync', body: `${state.unacked} changes are on this device and in flight.`, retry: false };
    case 'syncing':
      return { text: `Catching up · ${state.inbound} in, ${state.outbound} out`, hue: 'sync', icon: 'sync', body: `${state.inbound} ops coming in, ${state.outbound} going out, computed from the state-vector diff.`, retry: false };
    case 'connecting':
      return { text: 'Connecting…', hue: 'warn', icon: 'clock', body: `Attempt ${state.attempt + 1}. The server has ${HELLO_TIMEOUT_MS / 1000} s to answer before the next try.`, retry: false };
    case 'degraded':
      return { text: `Reconnecting in ${Math.max(1, Math.ceil((state.retryAt - now) / 1000))}s · ${state.unacked} on this device`, hue: 'warn', icon: 'clock', body: `Last error: ${state.lastError}`, retry: true };
    case 'offline':
      return { text: `Offline · ${state.unacked} changes on this device`, hue: 'warn', icon: 'wifioff', body: 'Saved on this device. Will sync when back online.', retry: false };
    case 'failed':
      if (state.code === 'STORE_FAILED') return { text: 'Can’t save · STORE_FAILED', hue: 'bad', icon: 'alert', body: `${state.reason}. Changes since then are in this tab’s memory only — copy anything important before reloading.`, retry: false };
      return { text: `Can’t connect · ${state.code}`, hue: 'bad', icon: 'alert', body: `${state.reason}. Nothing is sent; every change stays on this device.`, retry: false };
  }
}

function ago(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} s ago`;
}

function suffixOf(storage: StorageStatus): string | null {
  return storage.kind === 'memory' ? 'not persisted on this device' : null;
}

function storageCaveat(storage: StorageStatus): string {
  return storage.kind === 'memory' ? ' IndexedDB could not be opened, so changes live in this tab’s memory only and are gone when it closes.' : '';
}
