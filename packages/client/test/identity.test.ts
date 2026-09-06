// identity.test.ts — the ids the shell mints are well-formed for the CRDT and the protocol, never
// the root sentinel's, and distinct across draws.
import { REPLICA_ID_RE, ROOT_REPLICA } from '@weft/crdt';
import { DOC_ID_RE } from '@weft/protocol';
import { describe, expect, it } from 'vitest';
import { newDocId, newReplicaId } from '../src/identity.ts';

describe('identity', () => {
  it('mints replica ids the CRDT accepts, never the root sentinel, and 1 000 draws are all distinct', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const id = newReplicaId();
      expect(id).toMatch(REPLICA_ID_RE);
      expect(id).not.toBe(ROOT_REPLICA);
      ids.add(id);
    }
    expect(ids.size).toBe(1_000);
  });

  it('mints document ids the protocol accepts as URL segments and server file names', () => {
    for (let i = 0; i < 200; i++) expect(newDocId()).toMatch(DOC_ID_RE);
  });
});
