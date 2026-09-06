// identity.ts — the two random ids the browser shell mints: a replica id for this tab and a
// document id for `/`. This file exists because @weft/crdt and @weft/protocol are pure and may not
// draw randomness (LLD §9), so the client is where an id is born, and there must be one place that
// knows the alphabets: 13 base32 chars for a replica (never the root sentinel's all-'a'), 12
// lowercase alphanumerics for a document (a URL segment and a file name on the server). It must
// never use Math.random — a collision is a seq collision — and never persist anything (S4 does).

import { REPLICA_ID_RE, ROOT_REPLICA, type ReplicaId } from '@weft/crdt';
import { DOC_ID_RE } from '@weft/protocol';

const REPLICA_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const DOC_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `length` characters drawn uniformly from `alphabet`: bytes at or above the largest multiple of its size are rejected, so no letter is favoured. */
function draw(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const b of bytes) if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
  }
  return out;
}

export function newReplicaId(): ReplicaId {
  for (;;) {
    const id = draw(REPLICA_ALPHABET, 13);
    if (id !== ROOT_REPLICA && REPLICA_ID_RE.test(id)) return id as ReplicaId;
  }
}

export function newDocId(): string {
  const id = draw(DOC_ALPHABET, 12);
  if (!DOC_ID_RE.test(id)) throw new Error(`generated document id ${id} does not match the protocol's DOC_ID_RE`);
  return id;
}
