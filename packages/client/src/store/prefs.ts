// prefs.ts — the few per-device facts that live outside IndexedDB, in Web Storage. This file
// exists so they have one home and one set of keys: the Simulate-offline toggle, remembered per
// document and replica id so a tab that reopens after a kill starts offline with its count, as
// LLD §4 draws it (`[*] → offline: user toggle persisted`); and the text `Start fresh (keeps a
// copy)` carries into the new document, stashed in the tab's sessionStorage across the navigation
// and taken exactly once. Storage objects are parameters (`null` when the browser refuses access)
// so the functions are testable and never touch a global. It must never store an op — ops belong
// to the Store — and never invent a key elsewhere.

import type { ReplicaId } from '@weft/crdt';

const offlineKey = (docId: string, me: ReplicaId): string => `weft:${docId}:${me}:offline`;
const seedKey = (docId: string): string => `weft:${docId}:seed`;

export function readUserOffline(storage: Storage | null, docId: string, me: ReplicaId): boolean {
  return storage?.getItem(offlineKey(docId, me)) === '1';
}

export function writeUserOffline(storage: Storage | null, docId: string, me: ReplicaId, offline: boolean): void {
  if (storage === null) return;
  if (offline) storage.setItem(offlineKey(docId, me), '1');
  else storage.removeItem(offlineKey(docId, me));
}

/** What `Start fresh` carries over: the visible text (block boundaries as newlines) and the document it came from, named in the notice. */
export interface Seed {
  readonly text: string;
  readonly from: string;
}

export function stashSeed(storage: Storage | null, docId: string, seed: Seed): void {
  storage?.setItem(seedKey(docId), JSON.stringify(seed));
}

/** The seed for `docId`, removed as it is read so a reload does not plant it twice. */
export function takeSeed(storage: Storage | null, docId: string): Seed | null {
  const raw = storage?.getItem(seedKey(docId)) ?? null;
  if (raw === null) return null;
  storage?.removeItem(seedKey(docId));
  const parsed: unknown = JSON.parse(raw);
  const seed = parsed as { text?: unknown; from?: unknown } | null;
  if (typeof seed?.text !== 'string' || typeof seed.from !== 'string') throw new Error(`the seed stashed for ${docId} is not { text, from }`);
  return { text: seed.text, from: seed.from };
}
