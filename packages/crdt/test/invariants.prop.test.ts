// invariants.prop.test.ts — one property per numbered invariant that the partitioned test does
// not already isolate: I2 permutation, I3 idempotence, I4 causality, I5 no lost insert, I6 no
// resurrection, I8 forward (and backward) non-interleaving, I12 snapshot round trip, plus the
// interrupted path as a property. Each generates random scripts against evolving docs (§6.1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  apply,
  applyAll,
  canonicalString,
  decodeSnapshot,
  emptyDoc,
  encodeSnapshot,
  idKey,
  opDependencies,
  pendingCount,
  svEqual,
  visibleItems,
  type Doc,
  type Op,
} from '../src/index.ts';
import { arbScript, perform, type Intent } from './generators.ts';
import { healAll, interleave, mulberry32, numRuns, R, REPLICAS, Replica, shuffle, text } from './helpers.ts';

/** Three replicas run their scripts fully connected (every op delivered at once), so the logs are causally rich. Returns the replicas and the merged log in one valid order. */
function connectedRun(scripts: readonly (readonly Intent[])[]): { reps: Replica[]; log: Op[] } {
  const reps = REPLICAS.slice(0, scripts.length).map((r) => new Replica(r));
  const log: Op[] = [];
  const longest = Math.max(0, ...scripts.map((s) => s.length));
  for (let step = 0; step < longest; step++) {
    reps.forEach((rep, i) => {
      const intent = scripts[i]?.[step];
      if (intent === undefined) return;
      const before = rep.log.length;
      perform(rep, intent);
      const fresh = rep.log.slice(before);
      log.push(...fresh);
      for (const other of reps) if (other !== rep) other.receiveAll(fresh);
    });
  }
  return { reps, log };
}

const threeScripts = fc.array(arbScript, { minLength: 3, maxLength: 3 });

describe('I2 order-independence', () => {
  it('any interleaving of the replicas’ logs replays to the same canonical bytes and state vector', () => {
    fc.assert(
      fc.property(threeScripts, fc.nat(), (scripts, seed) => {
        const rng = mulberry32(seed);
        const { reps, log } = connectedRun(scripts);
        const reference = applyAll(emptyDoc(), log).doc;
        const permuted = applyAll(emptyDoc(), interleave(reps.map((r) => r.log), rng)).doc;
        expect(pendingCount(permuted)).toBe(0);
        expect(canonicalString(permuted)).toBe(canonicalString(reference));
        expect(svEqual(permuted.sv, reference.sv)).toBe(true);
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('I3 idempotence', () => {
  it('re-applying any already-held op returns duplicate and the identical doc object', () => {
    fc.assert(
      fc.property(threeScripts, fc.nat(), (scripts, seed) => {
        const rng = mulberry32(seed);
        const { log } = connectedRun(scripts);
        let doc = emptyDoc();
        for (const op of log) {
          doc = apply(doc, op).doc;
          const again = apply(doc, op);
          expect(again.kind).toBe('duplicate');
          expect(again.doc).toBe(doc);
        }
        for (const op of shuffle(log, rng)) expect(apply(doc, op).kind).toBe('duplicate');
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('I4 causality', () => {
  it('an op is applied only when every dependency is present, is parked otherwise, and every parked op is eventually drained — nothing is dropped', () => {
    fc.assert(
      fc.property(threeScripts, fc.nat(), (scripts, seed) => {
        const rng = mulberry32(seed);
        const { reps } = connectedRun(scripts);
        const order = interleave(reps.map((r) => r.log), rng);
        let doc = emptyDoc();
        const drainedKeys = new Set<string>();
        let appliedDirectly = 0;
        for (const op of order) {
          const depsPresent = opDependencies(op).every((d) => doc.items.has(idKey(d)));
          const r = apply(doc, op);
          if (depsPresent) {
            expect(r.kind).toBe('applied');
            appliedDirectly++;
          } else {
            expect(r.kind).toBe('pending');
            if (r.kind === 'pending') for (const m of r.missing) expect(doc.items.has(idKey(m))).toBe(false);
          }
          if (r.kind === 'applied') for (const d of r.drained) drainedKeys.add(idKey(d.id));
          doc = r.doc;
        }
        expect(pendingCount(doc)).toBe(0);
        expect(appliedDirectly + drainedKeys.size).toBe(order.length);
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('I5 no lost insert and I6 no resurrection', () => {
  it('after every op, the visible items are exactly the inserted-and-not-deleted ids, each once, and a deleted id never reappears', () => {
    fc.assert(
      fc.property(threeScripts, fc.nat(), (scripts, seed) => {
        const rng = mulberry32(seed);
        const { reps } = connectedRun(scripts);
        const order = interleave(reps.map((r) => r.log), rng);
        let doc = emptyDoc();
        const everDeleted = new Set<string>();
        for (const op of order) {
          doc = apply(doc, op).doc;
          // Deleted-on-this-replica means the del was applied (its target present), which is when I6 starts.
          if (op.t === 'del' && doc.items.get(idKey(op.target))?.deleted) everDeleted.add(idKey(op.target));
          const visible = visibleItems(doc).map((item) => idKey(item.id));
          expect(new Set(visible).size).toBe(visible.length); // I5: at most once
          for (const k of visible) expect(everDeleted.has(k)).toBe(false); // I6
        }
        const inserted = new Set(order.filter((op) => op.t === 'ins').map((op) => idKey(op.id)));
        const deleted = new Set(order.filter((op): op is Extract<Op, { t: 'del' }> => op.t === 'del').map((op) => idKey(op.target)));
        const visible = new Set(visibleItems(doc).map((item) => idKey(item.id)));
        expect(visible).toEqual(new Set([...inserted].filter((k) => !deleted.has(k)))); // I5: exactly the survivors
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('I8 non-interleaving', () => {
  const word = fc.stringMatching(/^[a-z]{1,8}$/);
  const setup = (prefix: string): [Replica, Replica] => {
    const a = new Replica(R.a);
    a.type(0, prefix);
    const b = new Replica(R.b);
    b.receiveAll(a.log);
    return [a, b];
  };
  const merged = (a: Replica, b: Replica, offset: number): string => {
    b.receiveAll(a.log.slice(offset));
    a.receiveAll(b.log);
    expect(text(a.doc)).toBe(text(b.doc));
    return text(a.doc);
  };

  it('two runs typed forwards at the same index stay contiguous after merge', () => {
    fc.assert(
      fc.property(word, word, word, fc.nat({ max: 8 }), (prefix, r1, r2, at) => {
        const [a, b] = setup(prefix);
        const i = at % (prefix.length + 1);
        const n = a.log.length;
        a.type(i, r1);
        b.type(i, r2);
        const out = merged(a, b, n);
        expect(out).toContain(r1);
        expect(out).toContain(r2);
        expect(out.length).toBe(prefix.length + r1.length + r2.length);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('two runs typed backwards (prepending) at the same index stay contiguous after merge', () => {
    fc.assert(
      fc.property(word, word, word, fc.nat({ max: 8 }), (prefix, r1, r2, at) => {
        const [a, b] = setup(prefix);
        const i = at % (prefix.length + 1);
        const n = a.log.length;
        a.prepend(i, r1);
        b.prepend(i, r2);
        const out = merged(a, b, n);
        expect(out).toContain(r1);
        expect(out).toContain(r2);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('one run typed forwards and one typed backwards at the same index stay contiguous after merge', () => {
    fc.assert(
      fc.property(word, word, word, fc.nat({ max: 8 }), (prefix, r1, r2, at) => {
        const [a, b] = setup(prefix);
        const i = at % (prefix.length + 1);
        const n = a.log.length;
        a.type(i, r1);
        b.prepend(i, r2);
        const out = merged(a, b, n);
        expect(out).toContain(r1);
        expect(out).toContain(r2);
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('I12 snapshot equivalence', () => {
  it('decodeSnapshot(encodeSnapshot(D)) has the same canonical bytes and state vector as D, for any fully-applied D', () => {
    fc.assert(
      fc.property(threeScripts, (scripts) => {
        const { reps } = connectedRun(scripts);
        healAll(reps);
        for (const rep of reps) {
          const snap = encodeSnapshot(rep.doc);
          const back: Doc = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
          expect(canonicalString(back)).toBe(canonicalString(rep.doc));
          expect(svEqual(back.sv, rep.doc.sv)).toBe(true);
          expect(back.formatLamport).toBe(rep.doc.formatLamport);
          // And a decoded doc keeps editing correctly: the same next op lands the same way on both.
          const continued = new Replica(rep.me);
          continued.doc = back;
          continued.seq = rep.seq;
          const original = new Replica(rep.me);
          original.doc = rep.doc;
          original.seq = rep.seq;
          continued.insert(0, { kind: 'char', text: 'z' });
          original.insert(0, { kind: 'char', text: 'z' });
          expect(canonicalString(continued.doc)).toBe(canonicalString(original.doc));
        }
      }),
      { numRuns: numRuns('light') },
    );
  });
});

describe('interrupted path as a property', () => {
  it('for any cut point, applyAll of the prefix then the rest equals applyAll of everything', () => {
    fc.assert(
      fc.property(threeScripts, fc.nat(), fc.nat(), (scripts, seed, cutSeed) => {
        const { reps } = connectedRun(scripts);
        const order = interleave(reps.map((r) => r.log), mulberry32(seed));
        const whole = applyAll(emptyDoc(), order).doc;
        const cut = order.length === 0 ? 0 : cutSeed % (order.length + 1);
        const resumed = applyAll(applyAll(emptyDoc(), order.slice(0, cut)).doc, order.slice(cut)).doc;
        expect(canonicalString(resumed)).toBe(canonicalString(whole));
        expect(svEqual(resumed.sv, whole.sv)).toBe(true);
        expect(pendingCount(resumed)).toBe(pendingCount(whole));
      }),
      { numRuns: numRuns('light') },
    );
  });
});
