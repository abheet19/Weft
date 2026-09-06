// stateVector.test.ts — state vectors describe "what I hold"; their difference is the catch-up
// payload. svDiff/svEqual/svMerge are checked against a model, and opsSince against an in-memory
// OpLog: it must return exactly the ops the other side lacks, in per-replica seq order.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { opsSince, svDiff, svEqual, svGet, svMerge, svSet, type Op, type OpLog, type ReplicaId, type StateVector } from '../src/index.ts';
import { numRuns, R, REPLICAS, Replica } from './helpers.ts';

const arbSv: fc.Arbitrary<StateVector> = fc
  .array(fc.tuple(fc.constantFrom(...REPLICAS), fc.nat({ max: 20 })), { maxLength: 4 })
  .map((pairs) => Object.fromEntries(pairs.filter(([, n]) => n > 0)) as StateVector);

describe('svGet and svSet', () => {
  it('read own properties only: an inherited "constructor" reads as 0', () => {
    const sv = {} as StateVector;
    expect(svGet(sv, 'constructor')).toBe(0);
    expect(svGet(sv, '__proto__')).toBe(0);
    expect(svGet(sv, R.a)).toBe(0);
    const next = svSet(sv, R.a, 3);
    expect(svGet(next, R.a)).toBe(3);
    expect(svGet(sv, R.a)).toBe(0);
    expect(Object.isFrozen(next)).toBe(true);
  });
});

describe('svDiff, svEqual and svMerge', () => {
  it('svDiff lists, per replica, only the side that is ahead, and the two sides never overlap', () => {
    fc.assert(
      fc.property(arbSv, arbSv, (mine, theirs) => {
        const { iHave, theyHave } = svDiff(mine, theirs);
        for (const r of REPLICAS) {
          const m = svGet(mine, r);
          const t = svGet(theirs, r);
          expect(svGet(iHave, r)).toBe(m > t ? m : 0);
          expect(svGet(theyHave, r)).toBe(t > m ? t : 0);
        }
        expect(Object.keys(iHave).filter((k) => k in theyHave)).toEqual([]);
        expect(svEqual(mine, theirs)).toBe(Object.keys(iHave).length === 0 && Object.keys(theyHave).length === 0);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('svEqual treats a missing replica and a replica at 0 alike', () => {
    expect(svEqual({} as StateVector, { [R.a]: 0 } as StateVector)).toBe(true);
    expect(svEqual({ [R.a]: 1 } as StateVector, { [R.a]: 1, [R.b]: 0 } as StateVector)).toBe(true);
    expect(svEqual({ [R.a]: 1 } as StateVector, { [R.a]: 2 } as StateVector)).toBe(false);
  });

  it('svMerge is the pointwise maximum and drops zero entries', () => {
    fc.assert(
      fc.property(arbSv, arbSv, (a, b) => {
        const m = svMerge(a, b);
        for (const r of REPLICAS) expect(svGet(m, r)).toBe(Math.max(svGet(a, r), svGet(b, r)));
        expect(Object.values(m).every((n) => n > 0)).toBe(true);
        expect(svEqual(svMerge(a, b), svMerge(b, a))).toBe(true);
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('opsSince', () => {
  /** An OpLog over the merged logs of several replicas, as the store will supply it. */
  function logOf(reps: readonly Replica[]): OpLog {
    const byReplica = new Map<ReplicaId, readonly Op[]>(reps.map((r) => [r.me, r.log]));
    return {
      get(replica, fromSeq, toSeq) {
        return (byReplica.get(replica) ?? []).filter((op) => op.id.seq >= fromSeq && op.id.seq <= toSeq);
      },
    };
  }

  it('returns exactly the ops the other side lacks, grouped by replica in sorted order and by seq within a replica', () => {
    const a = new Replica(R.a);
    a.type(0, 'abc');
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    b.type(3, 'de');
    a.receiveAll(b.log);
    // `theirs` holds a:1 and nothing of b.
    const theirs = { [R.a]: 1 } as StateVector;
    const ops = opsSince(a.doc, theirs, logOf([a, b]));
    expect(ops.map((op) => `${op.id.replica === R.a ? 'a' : 'b'}:${op.id.seq}`)).toEqual(['a:2', 'a:3', 'b:1', 'b:2']);
  });

  it('returns nothing when the other side is level or ahead', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab');
    expect(opsSince(a.doc, a.doc.sv, logOf([a]))).toEqual([]);
    expect(opsSince(a.doc, { [R.a]: 5, [R.b]: 3 } as StateVector, logOf([a]))).toEqual([]);
  });

  it('applying the catch-up payload makes the lagging replica converge (the design §3.4 round trip)', () => {
    const a = new Replica(R.a);
    a.type(0, 'hello');
    const b = new Replica(R.b);
    b.receiveAll(a.log.slice(0, 2));
    b.type(2, '!');
    const lagging = new Replica(R.c);
    lagging.receiveAll(a.log.slice(0, 1));
    a.receiveAll(b.log);
    for (const op of opsSince(a.doc, lagging.doc.sv, logOf([a, b]))) expect(['applied', 'pending']).toContain(lagging.receive(op).kind);
    expect(svEqual(lagging.doc.sv, a.doc.sv)).toBe(true);
  });
});
