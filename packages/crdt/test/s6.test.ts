// s6.test.ts — the CRDT facts S6 relies on: a soft break (E52) is an ordinary inline item that
// converges and round-trips, and the design §2.5 formatting anomaly is demonstrated deliberately,
// named after itself, so an interviewer sees it is known rather than hidden. The convergence,
// order-independence, traversal and snapshot properties themselves live in the property suites,
// which now carry breaks in their alphabet (generators.ts); this file pins the specific behaviours.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildIndex, canonicalString, decodeSnapshot, encodeSnapshot, MARK_NAMES, svEqual, visibleItems, type Item } from '../src/index.ts';
import { arbSchedule, arbScript, perform } from './generators.ts';
import { assertBothSeeds, brk, healAll, mulberry32, R, Replica, REPLICAS, text } from './helpers.ts';

const activeMarks = (item: Item): string[] => MARK_NAMES.filter((m) => item.marks[m]?.active === true);

describe('soft break (E52)', () => {
  it('inserts a break as one visible item that traverses and indexes like a char', () => {
    const a = new Replica(R.a);
    a.type(0, 'ab');
    a.insert(1, brk()); // a⏎b
    expect(text(a.doc)).toBe('a⏎b');
    const visible = visibleItems(a.doc);
    expect(visible).toHaveLength(3);
    expect(visible[1]?.content).toEqual({ kind: 'break' });
    // One code-point-equivalent position: the break is not a block boundary, so the block is unbroken.
    const index = buildIndex(a.doc);
    expect(index.length).toBe(3);
    expect(index.blockRanges()).toHaveLength(1);
  });

  it('encodes a break distinctly from a char and a boundary in the canonical bytes', () => {
    const a = new Replica(R.a);
    a.type(0, 'a');
    a.insert(1, brk());
    // The break is the tuple content ['break'], never the char "a" nor a ['block', …].
    expect(canonicalString(a.doc)).toBe('[["a",[]],[["break"],[]]]');
  });

  it('round-trips a document containing a break through a snapshot (I12)', () => {
    const a = new Replica(R.a);
    a.type(0, 'x');
    a.insert(1, brk());
    a.type(2, 'y');
    const back = decodeSnapshot(encodeSnapshot(a.doc));
    expect(canonicalString(back)).toBe(canonicalString(a.doc));
    expect(svEqual(back.sv, a.doc.sv)).toBe(true);
  });

  it('converges when two replicas insert breaks concurrently at the same index', () => {
    const a = new Replica(R.a);
    const b = new Replica(R.b);
    a.type(0, 'hi');
    b.receiveAll(a.log);
    a.insert(1, brk()); // h⏎i on A
    b.insert(1, brk()); // h⏎i on B, a different break item
    healAll([a, b]);
    expect(text(a.doc)).toBe(text(b.doc));
    expect(canonicalString(a.doc)).toBe(canonicalString(b.doc));
    expect(visibleItems(a.doc).filter((i) => i.content.kind === 'break')).toHaveLength(2);
  });
});

describe('design §2.5 formatting anomaly', () => {
  it('a character typed just after a bold word does not inherit the bold; the two replicas still converge', () => {
    // Sequential form: one replica bolds a word, then types after it. The new char carries no mark,
    // because a char insert has no marks and no fmt op named it — the CRDT has no "inherit".
    const a = new Replica(R.a);
    a.type(0, 'Hello');
    a.format(0, 5, 'bold', true);
    a.type(5, '!'); // the "!" is typed just after the bold "o"
    const visible = visibleItems(a.doc);
    expect(visible.slice(0, 5).every((i) => activeMarks(i).includes('bold'))).toBe(true);
    expect(activeMarks(visible[5] as Item)).toEqual([]); // not bold

    // Concurrent form (design §2.5 verbatim): A bolds "Hello" while B types "!" after "o". Merge.
    const a2 = new Replica(R.a);
    const b2 = new Replica(R.b);
    a2.type(0, 'Hello');
    b2.receiveAll(a2.log);
    a2.format(0, 5, 'bold', true); // A bolds Hello
    b2.type(5, '!'); // B, concurrently, types "!" after "o"
    healAll([a2, b2]);
    expect(text(a2.doc)).toBe('Hello!');
    expect(canonicalString(a2.doc)).toBe(canonicalString(b2.doc)); // convergence
    const merged = visibleItems(a2.doc);
    expect(activeMarks(merged[5] as Item)).toEqual([]); // the "!" is still not bold
  });
});

describe('I1/I12 hold with breaks in the alphabet', () => {
  it('partitioned replicas typing chars, boundaries and breaks reach one canonical string and survive a snapshot', () => {
    assertBothSeeds(
      fc.property(fc.array(arbScript, { minLength: 4, maxLength: 4 }), arbSchedule, (scripts, schedule) => {
        const reps = REPLICAS.map((me) => new Replica(me));
        for (let i = 0; i < reps.length; i++) for (const intent of scripts[i] ?? []) perform(reps[i] as Replica, intent);
        const rng = mulberry32(0xb6ea4);
        for (const segment of schedule) {
          const groups = new Map<number, Replica[]>();
          segment.groups.forEach((g, i) => groups.set(g, [...(groups.get(g) ?? []), reps[i] as Replica]));
          for (let round = 0; round < segment.rounds; round++) for (const group of groups.values()) healAll(group, rng);
        }
        healAll(reps, rng);
        const canonical = canonicalString((reps[0] as Replica).doc);
        for (const rep of reps) {
          expect(canonicalString(rep.doc)).toBe(canonical);
          expect(canonicalString(decodeSnapshot(encodeSnapshot(rep.doc)))).toBe(canonical);
        }
      }),
    );
  });
});
