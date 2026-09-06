// hash.ts — the content hash the divergence tripwire compares (LLD §1.3, D3). This is the ONE place
// the client turns a document into the 64-hex SHA-256 of its canonical bytes, so the runner, the
// Inspector and the tests all name the same digest. It is IO (Web Crypto's `crypto.subtle` is async
// and platform-provided) and therefore not PURE, but it is a pure function of the document's bytes:
// two replicas that converged (I1) share `canonicalBytes`, so they share this hash, and a genuine
// divergence shows up as different hashes at equal state vectors (I13). It must never salt or
// truncate — the whole point is that the hash is reproducible by any replica and by an auditor.

import { canonicalBytes, type Doc } from '@weft/crdt';

/** SHA-256 of arbitrary bytes as lowercase hex, matching the protocol's `HASH_RE` (`/^[0-9a-f]{64}$/`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The document's content hash: the digest of its canonical bytes. Published in presence after `quiet` (D3, E27). */
export function hashDoc(doc: Doc): Promise<string> {
  return sha256Hex(canonicalBytes(doc));
}
