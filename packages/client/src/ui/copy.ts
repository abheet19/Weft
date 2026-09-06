// copy.ts — every other sentence the S4 shell shows, as data and pure functions: the error card's
// heading, body and detail for each way a session can end (03-UI §4.9, the prototype's F10 and
// storage cards), the inline notices of 03-UI §4.7 (the reconnect merge and the fresh start; the
// storage-eviction notice was removed — persistence is requested silently), and the one derived
// observation the reconnect notice needs — how many offline edits a catch-up merged. This file
// exists so the words are exact, in one place and tested, and so the React components hold no
// copy of their own. It must never phrase a failure as a wait, and never promise more than the
// design's §4.3 statement: work is "safe on this device" only where the device's store took it.

import { LIMITS } from '@weft/protocol';
import type { SessionState } from '../session/machine.ts';

export interface CardCopy {
  readonly heading: string;
  readonly body: string;
  /** The actual error, verbatim, in the card's <pre>: never a paraphrase in place of the fact. */
  readonly detail: string;
}

/** Why the shell shows the error card: the store could not be read at load, or the session ended in `failed`. */
export type Failure =
  | { readonly kind: 'load'; readonly docId: string; readonly error: unknown }
  | { readonly kind: 'session'; readonly state: Extract<SessionState, { s: 'failed' }>; readonly supported: readonly number[] | null };

const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function errorCard(failure: Failure): CardCopy {
  if (failure.kind === 'load') {
    return { heading: 'Couldn’t open this document’s storage', body: `The copy of weft:${failure.docId} on this device could not be read. Nothing on disk was changed.`, detail: describe(failure.error) };
  }
  const { code, reason } = failure.state;
  const detail = `${code}: ${reason}`;
  switch (code) {
    case 'UNSUPPORTED_VERSION': {
      const theirs = failure.supported === null || failure.supported.length === 0 ? 'another version' : failure.supported.map((v) => `v${v}`).join(', ');
      return { heading: 'Can’t join this server', body: `This server speaks protocol ${theirs}; this tab speaks v${Math.max(...LIMITS.PROTO_VERSIONS)}. Your work is safe on this device.`, detail };
    }
    case 'FOREIGN_REPLICA':
      return { heading: 'This tab’s identity is corrupt', body: 'The server holds changes under this replica id that this device does not have; continuing would collide with them. Your work is safe on this device.', detail };
    case 'STORE_FAILED':
      return { heading: 'Couldn’t write to this document’s storage', body: 'Changes since the failure are in this tab’s memory only. Copy anything important before you reload; what was saved before is still on this device.', detail };
    default:
      return { heading: 'Can’t sync this document', body: `${reason}. Your work is safe on this device.`, detail };
  }
}

export const NOTICE = {
  merged: (n: number): string => `Back online — ${n} offline edits merged.`,
  showInInspector: 'Show in Inspector',
  startedFresh: (from: string): string => `Started fresh. The previous document is kept on this device as weft:${from}.`,
} as const;

export const CARD = { retry: 'Retry', startFresh: 'Start fresh (keeps a copy)', empty: 'Start writing, or press ⌘K' } as const;

/**
 * The offline edits a reconnect merged: the catch-up's `outbound` — what the server lacked of ours
 * at the welcome — read the moment the session goes live from syncing. Zero (a first connect, a
 * re-hello) is no reconnect worth a notice.
 */
export function mergedOnReconnect(prev: SessionState, next: SessionState): number | null {
  return prev.s === 'syncing' && next.s === 'live' && prev.outbound > 0 ? prev.outbound : null;
}
