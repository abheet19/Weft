// copy.test.ts — the S4 shell's other words are exact: the error card for each way a session ends
// (03-UI §4.9, the prototype's F10 card verbatim for a version mismatch), the notices of §4.7 and
// F9/F10, and the reconnect count, which is the catch-up's outbound read at the moment the session
// goes live — and nothing for a first connect or a re-hello.
import { describe, expect, it } from 'vitest';
import type { SessionState } from '../src/session/machine.ts';
import { CARD, errorCard, mergedOnReconnect, NOTICE } from '../src/ui/copy.ts';

const failed = (code: Extract<SessionState, { s: 'failed' }>['code'], reason: string): Extract<SessionState, { s: 'failed' }> => ({ s: 'failed', code, reason, unacked: 3 });

describe('errorCard', () => {
  it('a version mismatch is the prototype’s F10 card, word for word, with the server’s supported list', () => {
    expect(errorCard({ kind: 'session', state: failed('UNSUPPORTED_VERSION', 'v2 only'), supported: [2] })).toEqual({
      heading: 'Can’t join this server',
      body: 'This server speaks protocol v2; this tab speaks v1. Your work is safe on this device.',
      detail: 'UNSUPPORTED_VERSION: v2 only',
    });
    expect(errorCard({ kind: 'session', state: failed('UNSUPPORTED_VERSION', 'x'), supported: [2, 3] }).body).toContain('protocol v2, v3;');
    expect(errorCard({ kind: 'session', state: failed('UNSUPPORTED_VERSION', 'x'), supported: null }).body).toContain('protocol another version;');
  });

  it('a corrupt identity, a store that cannot write, and any other fatal code each get their own heading, the code and reason verbatim, and no promise beyond §4.3', () => {
    expect(errorCard({ kind: 'session', state: failed('FOREIGN_REPLICA', 'reused'), supported: null })).toMatchObject({ heading: 'This tab’s identity is corrupt', detail: 'FOREIGN_REPLICA: reused' });
    const store = errorCard({ kind: 'session', state: failed('STORE_FAILED', 'store failed: QuotaExceededError'), supported: null });
    expect(store.heading).toBe('Couldn’t write to this document’s storage');
    expect(store.body).toContain('in this tab’s memory only');
    expect(store.body).not.toContain('safe on this device');
    expect(errorCard({ kind: 'session', state: failed('SEQ_GAP', 'REHELLO_LOOP: 6 re-hellos'), supported: null })).toEqual({ heading: 'Can’t sync this document', body: 'REHELLO_LOOP: 6 re-hellos. Your work is safe on this device.', detail: 'SEQ_GAP: REHELLO_LOOP: 6 re-hellos' });
  });

  it('a load that failed shows the storage card with the actual error, never a paraphrase', () => {
    const e = new TypeError('invalid snapshot: item has the wrong keys');
    expect(errorCard({ kind: 'load', docId: 'k7m2p9qa', error: e })).toEqual({
      heading: 'Couldn’t open this document’s storage',
      body: 'The copy of weft:k7m2p9qa on this device could not be read. Nothing on disk was changed.',
      detail: 'TypeError: invalid snapshot: item has the wrong keys',
    });
    expect(errorCard({ kind: 'load', docId: 'd', error: 'plain string' }).detail).toBe('plain string');
  });
});

describe('notices and card actions', () => {
  it('are the words of 03-UI §4.7, §4.9 and the F9/F10 flows', () => {
    expect(NOTICE.merged(12)).toBe('Back online — 12 offline edits merged.');
    expect(NOTICE.showInInspector).toBe('Open sidebar');
    expect(NOTICE.startedFresh('k7m2p9qa')).toBe('Started fresh. The previous document is kept on this device as weft:k7m2p9qa.');
    expect(CARD).toEqual({ retry: 'Retry', startFresh: 'Start fresh (keeps a copy)', empty: 'Start writing, or press ⌘K' });
  });
});

describe('mergedOnReconnect', () => {
  const live: SessionState = { s: 'live', unacked: 0, lastAckAt: null };
  it('is the catch-up’s outbound when the session goes live from syncing with something to upload', () => {
    expect(mergedOnReconnect({ s: 'syncing', inbound: 12, outbound: 31, unacked: 31 }, live)).toBe(31);
  });
  it('is null for a first connect (nothing outbound), a re-hello, and every other transition', () => {
    expect(mergedOnReconnect({ s: 'syncing', inbound: 12, outbound: 0, unacked: 0 }, live)).toBeNull();
    expect(mergedOnReconnect(live, { s: 'syncing', inbound: 0, outbound: 0, unacked: 0 })).toBeNull();
    expect(mergedOnReconnect({ s: 'connecting', attempt: 0, unacked: 5 }, live)).toBeNull();
    expect(mergedOnReconnect({ s: 'syncing', inbound: 0, outbound: 5, unacked: 5 }, { s: 'degraded', attempt: 0, retryAt: 1, lastError: 'x', unacked: 5 })).toBeNull();
  });
});
