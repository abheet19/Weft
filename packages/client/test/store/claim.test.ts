// claim.test.ts — which replica id a tab writes as (E41): a fresh tab mints and remembers; a
// reload of the same tab reuses what it remembered; a tab opening after a kill reclaims the most
// recently used free id (its lock died with the tab); a second live tab, finding every id held,
// mints; a duplicated tab (same sessionStorage, id held) does NOT collide; without the Web Locks
// API only the tab's own remembered id is reused; a remembered value that is not a replica id, or
// is the root sentinel, is ignored. The preferences are the other small facts: the offline toggle
// per document and replica, and the Start-fresh seed taken exactly once.
import { describe, expect, it } from 'vitest';
import { ROOT_REPLICA, type ReplicaId } from '@weft/crdt';
import { claimReplica } from '../../src/store/claim.ts';
import { readUserOffline, stashSeed, takeSeed, writeUserOffline } from '../../src/store/prefs.ts';
import { fakeLocks, fakeStorage } from './fakes.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const C = 'defghijklmnop' as ReplicaId;
const DOC = 'doc-claim-0001';
const minter = (...ids: ReplicaId[]) => () => ids.shift() ?? (`z${Math.random().toString(36).slice(2, 14)}`.slice(0, 13) as ReplicaId); // test-only fallback, never reached by these tests

describe('claimReplica', () => {
  it('a fresh tab on a fresh device mints, holds the lock and remembers the id in sessionStorage', async () => {
    const locks = fakeLocks();
    const session = fakeStorage();
    const claim = await claimReplica(DOC, [], { sessionStorage: session, locks, mint: minter(A) });
    expect(claim.me).toBe(A);
    expect(locks.held()).toEqual([`weft:${DOC}:replica:${A}`]);
    expect(session.getItem(`weft:${DOC}:me`)).toBe(A);
    claim.release();
    await Promise.resolve();
    expect(locks.held()).toEqual([]);
  });

  it('a reload of the same tab reuses the remembered id, before any other used id', async () => {
    const locks = fakeLocks();
    const session = fakeStorage();
    session.setItem(`weft:${DOC}:me`, B);
    const claim = await claimReplica(DOC, [A, B, C], { sessionStorage: session, locks, mint: minter() });
    expect(claim.me).toBe(B);
  });

  it('F4: after a tab kill the lock is gone, and the reopened tab (empty sessionStorage) reclaims the most recently used id', async () => {
    const locks = fakeLocks();
    const claim = await claimReplica(DOC, [A, B], { sessionStorage: fakeStorage(), locks, mint: minter(C) });
    expect(claim.me).toBe(B);
    expect(locks.held()).toEqual([`weft:${DOC}:replica:${B}`]);
  });

  it('two live tabs never share an id: the second finds B held and takes A; a third finds both held and mints', async () => {
    const locks = fakeLocks();
    const first = await claimReplica(DOC, [A, B], { sessionStorage: fakeStorage(), locks, mint: minter() });
    const second = await claimReplica(DOC, [A, B], { sessionStorage: fakeStorage(), locks, mint: minter() });
    const third = await claimReplica(DOC, [A, B], { sessionStorage: fakeStorage(), locks, mint: minter(C) });
    expect([first.me, second.me, third.me]).toEqual([B, A, C]);
    expect(new Set(locks.held()).size).toBe(3);
  });

  it('attack: a duplicated tab carries the same sessionStorage id, finds it held, and mints instead of colliding seqs', async () => {
    const locks = fakeLocks();
    const session = fakeStorage();
    const original = await claimReplica(DOC, [], { sessionStorage: session, locks, mint: minter(A) });
    const duplicate = await claimReplica(DOC, [A], { sessionStorage: fakeStorage(), locks, mint: minter(B) });
    duplicate.release();
    const copyOfSession = fakeStorage();
    copyOfSession.setItem(`weft:${DOC}:me`, A);
    const dup = await claimReplica(DOC, [A], { sessionStorage: copyOfSession, locks, mint: minter(C) });
    expect(original.me).toBe(A);
    expect(dup.me).toBe(C);
    expect(copyOfSession.getItem(`weft:${DOC}:me`)).toBe(C);
  });

  it('a fresh id that is somehow already held is minted again, not shared', async () => {
    const locks = fakeLocks();
    await claimReplica(DOC, [], { sessionStorage: fakeStorage(), locks, mint: minter(A) });
    const next = await claimReplica(DOC, [], { sessionStorage: fakeStorage(), locks, mint: minter(A, B) });
    expect(next.me).toBe(B);
  });

  it('without Web Locks a used id cannot be known free: the tab reuses only its own remembered id, else mints; release is a no-op', async () => {
    const remembered = fakeStorage();
    remembered.setItem(`weft:${DOC}:me`, B);
    expect((await claimReplica(DOC, [A, B], { sessionStorage: remembered, locks: null, mint: minter(C) })).me).toBe(B);
    const fresh = await claimReplica(DOC, [A, B], { sessionStorage: fakeStorage(), locks: null, mint: minter(C) });
    expect(fresh.me).toBe(C);
    fresh.release();
    expect((await claimReplica(DOC, [A], { sessionStorage: null, locks: null, mint: minter(B) })).me).toBe(B);
  });

  it('a remembered value that is not a replica id, or is the root sentinel, is ignored', async () => {
    for (const bad of ['', 'not-an-id', ROOT_REPLICA, 'ABCDEFGHIJKLM']) {
      const session = fakeStorage();
      session.setItem(`weft:${DOC}:me`, bad);
      expect((await claimReplica(DOC, [], { sessionStorage: session, locks: fakeLocks(), mint: minter(A) })).me).toBe(A);
    }
  });

  it('a lock request the browser refuses outright (the document is unloading) counts as not taken', async () => {
    const refusing = { request: async () => Promise.reject(new DOMException('unloading', 'AbortError')) } as unknown as LockManager;
    const claim = await claimReplica(DOC, [A], { sessionStorage: fakeStorage(), locks: refusing, mint: minter(B) });
    expect(claim.me).toBe(B); // A could not be verified free, B could not be verified either — the loop stops at the first fresh id
  });
});

describe('prefs', () => {
  it('the offline toggle is per document and replica, absent by default, and removable', () => {
    const local = fakeStorage();
    expect(readUserOffline(local, DOC, A)).toBe(false);
    writeUserOffline(local, DOC, A, true);
    expect(readUserOffline(local, DOC, A)).toBe(true);
    expect(readUserOffline(local, DOC, B)).toBe(false);
    expect(readUserOffline(local, 'other-doc-001', A)).toBe(false);
    writeUserOffline(local, DOC, A, false);
    expect(readUserOffline(local, DOC, A)).toBe(false);
    expect(local.length).toBe(0);
    writeUserOffline(null, DOC, A, true);
    expect(readUserOffline(null, DOC, A)).toBe(false);
  });

  it('the Start-fresh seed is stashed for the new document and taken exactly once; a malformed stash is an error, not a document', () => {
    const session = fakeStorage();
    expect(takeSeed(session, 'new-doc-00001')).toBeNull();
    stashSeed(session, 'new-doc-00001', { text: 'kept\ntext', from: DOC });
    expect(takeSeed(session, 'new-doc-00001')).toEqual({ text: 'kept\ntext', from: DOC });
    expect(takeSeed(session, 'new-doc-00001')).toBeNull();
    session.setItem('weft:new-doc-00001:seed', '{"text":1}');
    expect(() => takeSeed(session, 'new-doc-00001')).toThrow(/not \{ text, from \}/);
    expect(takeSeed(null, 'x')).toBeNull();
  });
});
