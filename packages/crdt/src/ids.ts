// ids.ts — identity for replicas and items. This file exists so that there is exactly one
// definition of "which id comes first": sibling order in the Fugue tree and last-writer-wins ties
// both call `compareIds`, and convergence depends on every replica agreeing with it. It must never
// compare strings with a locale-aware function, never generate an id (ids are supplied by the
// caller; this package is pure), and never invent a second key encoding beside `idKey`.

/** 13 lowercase base32 chars [a-z2-7]. Fixed length so lexicographic order == the order every replica uses for siblings. ⟨D1⟩ */
export type ReplicaId = string & { readonly __brand: 'ReplicaId' };

export const REPLICA_ID_RE: RegExp = /^[a-z2-7]{13}$/;

/**
 * The reserved replica id of the root sentinel: thirteen 'a's. `REPLICA_ID_RE` accepts it, so it
 * sorts like any other id, but `newReplicaId` (client, later slice) never generates it.
 */
export const ROOT_REPLICA: ReplicaId = 'aaaaaaaaaaaaa' as ReplicaId;

/** Per-replica contiguous counter. Contiguity is what makes a state vector a complete description of "what I hold". */
export interface ItemId {
  readonly replica: ReplicaId;
  readonly seq: number;
}

/** The one total order every replica must agree on. replica (string) first, then seq (number). Used for siblings and for LWW ties. */
export function compareIds(a: ItemId, b: ItemId): -1 | 0 | 1 {
  // `<` on strings compares UTF-16 code units, which for the [a-z2-7] alphabet is code-point order
  // and is identical on every platform. localeCompare would not be; it is never used here.
  if (a.replica < b.replica) return -1;
  if (a.replica > b.replica) return 1;
  if (a.seq < b.seq) return -1;
  if (a.seq > b.seq) return 1;
  return 0;
}

/** `${replica}:${seq}` — a Map key. Exists so nobody invents a second encoding. */
export function idKey(id: ItemId): string {
  return `${id.replica}:${id.seq}`;
}

export function parseIdKey(key: string): ItemId | null {
  const colon = key.indexOf(':');
  if (colon === -1) return null;
  const replica = key.slice(0, colon);
  const seqText = key.slice(colon + 1);
  if (!REPLICA_ID_RE.test(replica)) return null;
  // Only canonical decimal integers round-trip; "01", "1.0", "1e3" and "" are not ids.
  if (!/^(0|[1-9][0-9]*)$/.test(seqText)) return null;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return null;
  return { replica: replica as ReplicaId, seq };
}

/** True when `x` has the exact shape of an ItemId from a trusted or untrusted source: a well-formed replica and a non-negative safe integer seq. */
export function isWellFormedId(x: unknown): x is ItemId {
  if (typeof x !== 'object' || x === null) return false;
  const { replica, seq } = x as { replica?: unknown; seq?: unknown };
  return typeof replica === 'string' && REPLICA_ID_RE.test(replica) && Number.isSafeInteger(seq) && (seq as number) >= 0;
}
