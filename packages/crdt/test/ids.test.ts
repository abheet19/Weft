// ids.test.ts — identity: the total order is by code point (never locale), keys round-trip, and
// the reserved ROOT replica is accepted by the regex.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareIds, idKey, isWellFormedId, parseIdKey, REPLICA_ID_RE, ROOT, ROOT_REPLICA, type ItemId, type ReplicaId } from '../src/index.ts';
import { id, numRuns, R } from './helpers.ts';

const arbReplica = fc.stringMatching(/^[a-z2-7]{13}$/) as fc.Arbitrary<ReplicaId>;
const arbId: fc.Arbitrary<ItemId> = fc.record({ replica: arbReplica, seq: fc.nat() });

describe('compareIds', () => {
  it('is a total order: antisymmetric, transitive, and zero only for the same id', () => {
    fc.assert(
      fc.property(arbId, arbId, arbId, (a, b, c) => {
        expect(compareIds(a, b)).toBe(-compareIds(b, a));
        if (compareIds(a, b) <= 0 && compareIds(b, c) <= 0) expect(compareIds(a, c)).toBeLessThanOrEqual(0);
        expect(compareIds(a, b) === 0).toBe(idKey(a) === idKey(b));
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('orders replicas by code point, so digits 2..7 sort before letters and no locale rule applies', () => {
    expect(compareIds(id('2bcdefghijklm' as ReplicaId, 9), id('abcdefghijklm' as ReplicaId, 1))).toBe(-1);
    expect(['b', 'a', '7', '2'].sort((x, y) => compareIds(id((x + 'aaaaaaaaaaaa') as ReplicaId, 1), id((y + 'aaaaaaaaaaaa') as ReplicaId, 1)))).toEqual(['2', '7', 'a', 'b']);
  });

  it('orders by seq numerically, not as text, within one replica', () => {
    expect(compareIds(id(R.a, 9), id(R.a, 10))).toBe(-1);
    expect(compareIds(id(R.a, 10), id(R.a, 9))).toBe(1);
    expect(compareIds(id(R.a, 10), id(R.a, 10))).toBe(0);
  });

  it('two replicas differing only in the last character are ordered by that character', () => {
    const x = 'abcdefghijkla' as ReplicaId;
    const y = 'abcdefghijklb' as ReplicaId;
    expect(compareIds(id(x, 100), id(y, 1))).toBe(-1);
    expect(compareIds(id(y, 1), id(x, 100))).toBe(1);
  });
});

describe('idKey and parseIdKey', () => {
  it('round-trip every well-formed id', () => {
    fc.assert(
      fc.property(arbId, (x) => {
        expect(parseIdKey(idKey(x))).toEqual(x);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('return null for keys that are not `${replica}:${seq}` with a canonical decimal seq', () => {
    for (const bad of ['', 'abc', `${R.a}`, `${R.a}:`, `${R.a}:01`, `${R.a}:1.0`, `${R.a}:-1`, `${R.a}:1e3`, `short:1`, `${R.a}:${2 ** 53}`, `ABCDEFGHIJKLM:1`]) {
      expect(parseIdKey(bad)).toBeNull();
    }
  });
});

describe('ReplicaId and ROOT', () => {
  it('accepts exactly 13 chars of [a-z2-7], including the reserved all-a ROOT replica', () => {
    expect(REPLICA_ID_RE.test(ROOT_REPLICA)).toBe(true);
    expect(ROOT.id).toEqual({ replica: ROOT_REPLICA, seq: 0 });
    expect(REPLICA_ID_RE.test('abcdefghijkl')).toBe(false);
    expect(REPLICA_ID_RE.test('abcdefghijklmn')).toBe(false);
    expect(REPLICA_ID_RE.test('abcdefghijkl1')).toBe(false);
    expect(REPLICA_ID_RE.test('ABCDEFGHIJKLM')).toBe(false);
  });

  it('isWellFormedId accepts a valid id and rejects wrong types, bad replicas, negative, fractional or unsafe seqs', () => {
    expect(isWellFormedId(id(R.a, 0))).toBe(true);
    expect(isWellFormedId(null)).toBe(false);
    expect(isWellFormedId('abc')).toBe(false);
    expect(isWellFormedId({ replica: 'x', seq: 1 })).toBe(false);
    expect(isWellFormedId({ replica: R.a, seq: -1 })).toBe(false);
    expect(isWellFormedId({ replica: R.a, seq: 1.5 })).toBe(false);
    expect(isWellFormedId({ replica: R.a, seq: 2 ** 53 })).toBe(false);
    expect(isWellFormedId({ replica: R.a, seq: '1' })).toBe(false);
  });
});
