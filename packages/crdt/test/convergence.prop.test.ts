// convergence.prop.test.ts — THE test (LLD §3, "the one test that fails if the CRDT is subtly
// wrong"). Three or four replicas edit under a random partition schedule; deliveries are partial,
// duplicated, and occasionally skip an op (a real gap, which must be refused and repaired by
// catch-up); the network then heals. It asserts I1 (convergence), I2 (any interleaving of the
// logs replays to the same doc), I3 (re-applying everything is a no-op), I5 (no lost insert),
// I12 (snapshot round trip) together. A second property replays HOSTILE but well-formed logs —
// equal lamports from one replica on overlapping targets, lamports at the bound, dependencies
// that never exist, parents that are later ops — in several orders, so I1 is tested under hostile
// timing and not only under honest editing; the review's P3 counterexample is its first example.
// Each property runs with the fixed seed and with a fresh one (LLD §3); fast-check prints the seed
// and shrunk case on failure.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyAll,
  canonicalString,
  decodeSnapshot,
  emptyDoc,
  encodeSnapshot,
  idKey,
  MAX_LAMPORT,
  pendingCount,
  ROOT,
  svEqual,
  svGet,
  visibleItems,
  type Doc,
  type ItemId,
  type Op,
} from '../src/index.ts';
import { arbSchedule, arbScript, perform } from './generators.ts';
import { char, del, fmt, FIXED_SEED, healAll, id, ins, interleave, mulberry32, numRuns, pairs, pull, R, REPLICAS, Replica, shuffle, block, blk } from './helpers.ts';

/** One delivery step from `from` to `to` with chaos: a deliberate gap (must be rejected, doc untouched), a duplicate (must be a no-op), then a partial pull. */
function chaoticDelivery(from: Replica, to: Replica, rng: () => number): void {
  const held = svGet(to.doc.sv, from.me);
  const missing = from.log.length - held;
  const roll = rng();
  if (roll < 0.15 && missing >= 2) {
    const before = to.doc;
    const r = to.receive(from.log[held + 1] as Op);
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('SEQ_GAP');
    expect(to.doc).toBe(before);
  } else if (roll < 0.3 && held > 0) {
    const before = to.doc;
    const r = to.receive(from.log[Math.floor(rng() * held)] as Op);
    expect(r.kind).toBe('duplicate');
    expect(to.doc).toBe(before);
  }
  const results = pull(from, to, Math.floor(rng() * (missing + 1)));
  for (const r of results) expect(['applied', 'pending']).toContain(r.kind);
}

describe('I1 convergence under a partitioned network', () => {
  // Split fixed-seed and fresh-seed into separate `it()`s (rather than one `assertBothSeeds` call)
  // so vitest gets a task-report boundary between the two ~10 000-case fc.assert runs. Combined into
  // one it(), this property's ~45s of continuous synchronous work occasionally outlasted the CI
  // worker's task-update heartbeat on a slow/contended windows-latest runner ("Timeout calling
  // onTaskUpdate" — every assertion still passed; it was a reporting timeout, not a failure).
  // Splitting changes no coverage: same seeds, same case counts, same examples.
  const property = fc.property(fc.integer({ min: 3, max: 4 }), fc.array(arbScript, { minLength: 4, maxLength: 4 }), arbSchedule, fc.nat(), (n, scripts, schedule, seed) => {
        const rng = mulberry32(seed);
        const reps = REPLICAS.slice(0, n).map((r) => new Replica(r));
        const cursor = reps.map(() => 0);
        const step = (i: number): void => {
          const script = scripts[i] ?? [];
          const intent = script[cursor[i] as number];
          if (intent === undefined) return;
          cursor[i] = (cursor[i] as number) + 1;
          perform(reps[i] as Replica, intent);
        };

        for (const segment of schedule) {
          for (let round = 0; round < segment.rounds; round++) {
            for (let i = 0; i < n; i++) step(i);
            const talking = pairs(n).filter(([i, j]) => segment.groups[i] === segment.groups[j]);
            for (const [i, j] of shuffle(talking, rng)) chaoticDelivery(reps[i] as Replica, reps[j] as Replica, rng);
          }
        }
        // Whatever the schedule did not reach runs fully partitioned, then everything heals.
        for (let i = 0; i < n; i++) while ((cursor[i] as number) < (scripts[i] ?? []).length) step(i);
        healAll(reps, rng);

        // I1: equal state vectors, nothing parked, identical bytes.
        const first = reps[0] as Replica;
        for (const rep of reps) {
          expect(pendingCount(rep.doc)).toBe(0);
          expect(svEqual(rep.doc.sv, first.doc.sv)).toBe(true);
          expect(canonicalString(rep.doc)).toBe(canonicalString(first.doc));
        }

        // I5: every insert not deleted is visible exactly once; every deleted one never.
        const merged = reps.flatMap((r) => r.log);
        const inserted = new Set(merged.filter((op) => op.t === 'ins').map((op) => idKey(op.id)));
        const deleted = new Set(merged.filter((op) => op.t === 'del').map((op) => idKey((op as Extract<Op, { t: 'del' }>).target)));
        const visible = visibleItems(first.doc).map((item) => idKey(item.id));
        expect(new Set(visible).size).toBe(visible.length);
        expect(new Set(visible)).toEqual(new Set([...inserted].filter((k) => !deleted.has(k))));

        // I2: a fresh replay of any interleaving of the logs reaches the same doc, with no rejections.
        const replay = applyAll(emptyDoc(), interleave(reps.map((r) => r.log), rng));
        for (const r of replay.results) expect(['applied', 'pending']).toContain(r.kind);
        expect(pendingCount(replay.doc)).toBe(0);
        expect(svEqual(replay.doc.sv, first.doc.sv)).toBe(true);
        expect(canonicalString(replay.doc)).toBe(canonicalString(first.doc));

        // I3: re-applying every op to a converged replica is a duplicate and leaves the very same doc.
        const target = reps[Math.floor(rng() * n)] as Replica;
        const before = target.doc;
        for (const op of shuffle(merged, rng)) expect(target.receive(op).kind).toBe('duplicate');
        expect(target.doc).toBe(before);

        // I12: snapshot round trip on every replica.
        for (const rep of reps) {
          const snap = encodeSnapshot(rep.doc);
          const back = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
          expect(canonicalString(back)).toBe(canonicalString(rep.doc));
          expect(svEqual(back.sv, rep.doc.sv)).toBe(true);
          expect(encodeSnapshot(back)).toEqual(snap);
        }
      });

  it('three or four replicas editing through random partitions, partial, duplicated and gapped deliveries, then healing, hold I1, I2, I3, I5 and I12 together — with the fixed seed', () => {
    fc.assert(property, { numRuns: numRuns('heavy'), seed: FIXED_SEED });
  });

  it('… and with a fresh one', () => {
    fc.assert(property, { numRuns: numRuns('fresh') });
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile timing of well-formed ops.

/** Ids a hostile op may name: ROOT, three replicas' first four seqs (some of which will not be inserts, or never arrive), and one replica that never sends anything. */
const WORLD: readonly ItemId[] = [ROOT.id, ...[R.a, R.b, R.c].flatMap((r) => [1, 2, 3, 4].map((s) => id(r, s))), id(R.d, 1)];
/** Small so equal lamports from one replica are common, plus the bound itself. */
const LAMPORTS = [0, 1, 2, 7, MAX_LAMPORT];

type OpSketch =
  | { t: 'ins'; parent: number; side: 'L' | 'R'; block: boolean; lamport: number }
  | { t: 'del'; target: number }
  | { t: 'fmt'; targets: number[]; mark: 'bold' | 'italic' | 'code' | 'link'; active: boolean; lamport: number }
  | { t: 'blk'; target: number; level: 0 | 1 | 2 | 3; lamport: number };

const arbSketch: fc.Arbitrary<OpSketch> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('ins' as const), parent: fc.nat({ max: WORLD.length - 1 }), side: fc.constantFrom('L' as const, 'R' as const), block: fc.boolean(), lamport: fc.nat({ max: LAMPORTS.length - 1 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('del' as const), target: fc.nat({ max: WORLD.length - 1 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('fmt' as const), targets: fc.array(fc.nat({ max: WORLD.length - 1 }), { maxLength: 4 }), mark: fc.constantFrom('bold' as const, 'italic' as const, 'code' as const, 'link' as const), active: fc.boolean(), lamport: fc.nat({ max: LAMPORTS.length - 1 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('blk' as const), target: fc.nat({ max: WORLD.length - 1 }), level: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const), lamport: fc.nat({ max: LAMPORTS.length - 1 }) }) },
);

/** Turn sketches into a well-formed log for one replica: contiguous seqs, no self reference, no ROOT target, no left child of ROOT. Everything else — dead parents, equal lamports, the bound — is allowed. */
function realise(replica: ItemId['replica'], sketches: readonly OpSketch[]): Op[] {
  const out: Op[] = [];
  let seq = 0;
  const pick = (i: number, own: ItemId): ItemId | null => {
    const x = WORLD[i % WORLD.length] as ItemId;
    return idKey(x) === idKey(own) || idKey(x) === idKey(ROOT.id) ? null : x;
  };
  for (const s of sketches) {
    const own = id(replica, seq + 1);
    switch (s.t) {
      case 'ins': {
        const parent = WORLD[s.parent % WORLD.length] as ItemId;
        if (idKey(parent) === idKey(own)) continue;
        const side = idKey(parent) === idKey(ROOT.id) ? 'R' : s.side;
        const content = s.block ? block({ type: 'paragraph' }, replica, LAMPORTS[s.lamport] as number) : char('x');
        out.push(ins(own, parent, side, content));
        break;
      }
      case 'del': {
        const target = pick(s.target, own);
        if (target === null) continue;
        out.push(del(own, target));
        break;
      }
      case 'fmt': {
        const targets = s.targets.map((i) => pick(i, own)).filter((x): x is ItemId => x !== null);
        out.push(fmt(own, targets, s.mark, s.active, LAMPORTS[s.lamport] as number, s.mark === 'link' && s.active ? 'https://weft.test/' : undefined));
        break;
      }
      case 'blk': {
        const target = pick(s.target, own);
        if (target === null) continue;
        out.push(blk(own, target, s.level === 0 ? { type: 'quote' } : { type: 'heading', level: s.level }, LAMPORTS[s.lamport] as number));
        break;
      }
    }
    seq++;
  }
  return out;
}

/** Three hostile logs, one per replica. */
const arbHostileLogs: fc.Arbitrary<Op[][]> = fc.tuple(fc.array(arbSketch, { maxLength: 6 }), fc.array(arbSketch, { maxLength: 6 }), fc.array(arbSketch, { maxLength: 6 })).map(([a, b, c]) => [realise(R.a, a), realise(R.b, b), realise(R.c, c)]);

/** What every replica must agree on once it holds the same op set: sv, the parked set (by op id) and the bytes. */
function fingerprint(doc: Doc): { sv: Record<string, number>; parked: string[]; bytes: string } {
  const parked: string[] = [];
  for (const ops of doc.pending.values()) for (const op of ops) parked.push(idKey(op.id));
  return { sv: { ...doc.sv }, parked: parked.sort(), bytes: canonicalString(doc) };
}

/** a1, b1, c1, a2, b2, c2 … — every replica's ops arrive one at a time, so most of them park on something still on its way. */
function roundRobin(logs: readonly (readonly Op[])[]): Op[] {
  const out: Op[] = [];
  for (let i = 0; i < Math.max(...logs.map((l) => l.length)); i++) for (const log of logs) if (log[i] !== undefined) out.push(log[i] as Op);
  return out;
}

/** Review P3: two fmt ops from b with one lamport, overlapping targets; whether b:1 is parked (c:1 late) decided the outcome. */
const P3: Op[][] = [
  [ins(id(R.a, 1), ROOT.id, 'R', char('a'))],
  [fmt(id(R.b, 1), [id(R.a, 1), id(R.c, 1)], 'bold', true, 7), fmt(id(R.b, 2), [id(R.a, 1)], 'bold', false, 7)],
  [ins(id(R.c, 1), ROOT.id, 'R', char('c'))],
];

describe('I1 under hostile timing of well-formed ops', () => {
  // Same split as above, same reason: one continuous ~23s fc.assert-pair, no reporting boundary
  // between the fixed- and fresh-seed runs, occasionally outlasting CI's task-update heartbeat on a
  // slow windows-latest runner. `examples` (the review's P3 counterexample) stays on the fixed-seed
  // run only, exactly as `assertBothSeeds` applied it.
  const property = fc.property(arbHostileLogs, fc.nat(), (logs, seed) => {
    const rng = mulberry32(seed);
    const orders: Op[][] = [logs.flat(), [...logs].reverse().flat(), roundRobin(logs), interleave(logs, rng)];
    const docs = orders.map((order) => {
      const { doc, results } = applyAll(emptyDoc(), order);
      for (const r of results) expect(['applied', 'pending'], JSON.stringify(r)).toContain(r.kind);
      return doc;
    });
    const reference = fingerprint(docs[0] as Doc);
    for (const doc of docs) expect(fingerprint(doc)).toEqual(reference);
    // I12 still holds with parked ops in the picture (E11).
    for (const doc of docs) {
      const back = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(doc))));
      expect(fingerprint(back)).toEqual(reference);
      expect(back.formatLamport).toBe(doc.formatLamport);
    }
  });

  it('hostile logs (equal lamports on overlapping targets, lamports at the bound, dependencies that never exist) replayed in replica order, reverse order, round robin and a random interleaving reach one sv, one parked set and one canonical string, with no rejection — with the fixed seed, and the review’s P3 as the first example', () => {
    fc.assert(property, { numRuns: numRuns('heavy'), seed: FIXED_SEED, examples: [[P3, 0]] });
  });

  it('… and with a fresh seed', () => {
    fc.assert(property, { numRuns: numRuns('fresh') });
  });
});
