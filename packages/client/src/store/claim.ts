// claim.ts — which replica id this TAB writes as. This file exists because a store is per device
// and a replica id must be per tab: two tabs on one document that both wrote as the same id would
// mint the same seqs (LLD §8 S4 "two tabs same doc same origin"). The claim is a Web Lock named
// after the document and the id, held for the life of the tab and released by the browser the
// instant the tab dies — so a tab that reopens after a kill takes its old id back and re-uploads
// what that id never got acknowledged (F4), while a second live tab, finding the id held, takes the
// next free one or mints a fresh id (E41). `sessionStorage` remembers the tab's own id across a
// reload so it is tried first. Without the Web Locks API a used id cannot be known to be free, so
// only the tab's own remembered id is reused and otherwise a fresh id is minted: correct, at the
// cost of leaving an old id's unacknowledged ops on the device until a tab with locks claims it.
// It must never reuse an id whose lock another tab holds, and never mint with Math.random.

import { REPLICA_ID_RE, ROOT_REPLICA, type ReplicaId } from '@weft/crdt';

export interface ClaimDeps {
  /** This tab's storage, or `null` when the browser refuses access. */
  sessionStorage: Storage | null;
  /** `navigator.locks`, or `null` when absent. */
  locks: LockManager | null;
  /** A fresh replica id (the client's `identity.ts`); injected so the store layer draws no randomness itself. */
  mint(): ReplicaId;
}

export interface Claim {
  readonly me: ReplicaId;
  /** Let the id go before the tab does (the shell's unmount); the browser does it on tab death. */
  release(): void;
}

const lockName = (docId: string, me: ReplicaId): string => `weft:${docId}:replica:${me}`;
const sessionKey = (docId: string): string => `weft:${docId}:me`;

export async function claimReplica(docId: string, used: readonly ReplicaId[], deps: ClaimDeps): Promise<Claim> {
  const remembered = readRemembered(deps.sessionStorage, docId);
  if (deps.locks === null) {
    const me = remembered ?? deps.mint();
    remember(deps.sessionStorage, docId, me);
    return { me, release: () => undefined };
  }
  // The tab's own id first, then the device's ids newest first: the most recently killed tab is
  // the one most likely to have unacknowledged ops waiting.
  const candidates = remembered === null ? [...used].reverse() : [remembered, ...[...used].reverse().filter((id) => id !== remembered)];
  for (const me of candidates) {
    const held = await tryHold(deps.locks, lockName(docId, me));
    if (held === 'held' || held === 'refused') continue;
    remember(deps.sessionStorage, docId, me);
    return { me, release: held.release };
  }
  for (;;) {
    const me = deps.mint();
    const held = await tryHold(deps.locks, lockName(docId, me));
    // A fresh 64-bit id reported HELD is an astronomically unlikely collision — mint again. But a
    // REFUSED request (the API unavailable, the document unloading) is not a collision and must not
    // loop forever: a freshly minted id is ours, held with a no-op release. (Without this a lock
    // manager that refuses every request spins here without end.)
    if (held === 'held') continue;
    remember(deps.sessionStorage, docId, me);
    return { me, release: held === 'refused' ? () => undefined : held.release };
  }
}

type Hold = { readonly release: () => void } | 'held' | 'refused';

/** Take the lock only if nobody holds it: `{ release }` keeps it until called, `'held'` when another tab holds it, `'refused'` when the request itself was rejected (the document is unloading, or the API is unavailable). The two failures are distinct because a refusal is not evidence an id is taken. */
function tryHold(locks: LockManager, name: string): Promise<Hold> {
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve('held');
          return undefined;
        }
        return new Promise<void>((release) => resolve({ release }));
      })
      .catch(() => resolve('refused'));
  });
}

function readRemembered(storage: Storage | null, docId: string): ReplicaId | null {
  const id = storage?.getItem(sessionKey(docId)) ?? null;
  return id !== null && id !== ROOT_REPLICA && REPLICA_ID_RE.test(id) ? (id as ReplicaId) : null;
}

function remember(storage: Storage | null, docId: string, me: ReplicaId): void {
  storage?.setItem(sessionKey(docId), me);
}
