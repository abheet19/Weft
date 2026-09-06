// hash.test.ts — the content hash is a pure function of the document's canonical bytes: two replicas
// that converged (same ops, any order) produce the SAME 64-hex digest, and two genuinely different
// documents produce different ones — which is exactly what lets the tripwire tell an in-flight lag
// (equal hashes coming) from a real fault (I1, I13). SHA-256 is 64 lowercase hex, the shape the
// protocol's HASH_RE accepts.

import { describe, expect, it } from 'vitest';
import { applyAll, emptyDoc, localInsert, type Op, type ReplicaId } from '@weft/crdt';
import { hashDoc, sha256Hex } from '../../src/inspector/hash.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;

/** Ops that type `text` for replica `me` into a fresh document, one op per code point. */
function typed(me: ReplicaId, text: string): readonly Op[] {
  let doc = emptyDoc();
  const ops: Op[] = [];
  let at = 0;
  for (const ch of text) {
    const step = localInsert(doc, me, ops.length + 1, at++, { kind: 'char', text: ch });
    ops.push(...step.ops);
    doc = step.doc;
  }
  return ops;
}

describe('hashDoc', () => {
  it('is a 64-character lowercase hex string', async () => {
    expect(await hashDoc(emptyDoc())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is equal for two replicas that applied the same ops in different orders (converged → same hash)', async () => {
    const a = typed(A, 'Hi');
    const b = typed(B, 'yo');
    const one = applyAll(applyAll(emptyDoc(), a).doc, b).doc;
    const two = applyAll(applyAll(emptyDoc(), b).doc, a).doc; // reverse order
    expect(await hashDoc(one)).toBe(await hashDoc(two));
  });

  it('differs for two genuinely different documents (a constructed divergence)', async () => {
    const one = applyAll(emptyDoc(), typed(A, 'Hi')).doc;
    const two = applyAll(emptyDoc(), typed(A, 'Ho')).doc;
    expect(await hashDoc(one)).not.toBe(await hashDoc(two));
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 of the empty input', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
