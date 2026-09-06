// persistentMap.test.ts — the HAMT under Doc. It must behave exactly like a Map for get/has/size/
// iteration (checked against a real Map under random operations), never mutate an older version,
// and survive hash collisions — forced here by injecting a constant hash.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashString, PersistentMap } from '../src/persistentMap.ts';
import { numRuns } from './helpers.ts';

const arbKey = fc.oneof(fc.string({ maxLength: 6 }), fc.integer({ min: 0, max: 40 }).map((n) => `abcdefghijklm:${n}`));

describe('PersistentMap', () => {
  it('matches a Map on get, has, size and iteration after any sequence of sets', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbKey, fc.nat()), { maxLength: 200 }), (pairs) => {
        let pm = PersistentMap.empty<number>();
        const model = new Map<string, number>();
        for (const [k, v] of pairs) {
          pm = pm.set(k, v);
          model.set(k, v);
          expect(pm.size).toBe(model.size);
          expect(pm.get(k)).toBe(v);
        }
        for (const [k, v] of model) {
          expect(pm.has(k)).toBe(true);
          expect(pm.get(k)).toBe(v);
        }
        expect(new Map(pm.entries())).toEqual(model);
        expect(new Set(pm.keys())).toEqual(new Set(model.keys()));
        expect([...pm.values()].sort()).toEqual([...model.values()].sort());
        expect(new Map(pm)).toEqual(model);
        const seen = new Map<string, number>();
        pm.forEach((v, k, m) => {
          expect(m).toBe(pm);
          seen.set(k, v);
        });
        expect(seen).toEqual(model);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('never changes an older version: every set returns a new map and the previous one still reads the old value', () => {
    const m0 = PersistentMap.empty<string>();
    const m1 = m0.set('k', 'one');
    const m2 = m1.set('k', 'two');
    const m3 = m2.set('other', 'x');
    expect(m0.get('k')).toBeUndefined();
    expect(m1.get('k')).toBe('one');
    expect(m2.get('k')).toBe('two');
    expect(m3.get('k')).toBe('two');
    expect([m0.size, m1.size, m2.size, m3.size]).toEqual([0, 1, 1, 2]);
    expect(m3.has('missing')).toBe(false);
  });

  it('handles keys whose hashes collide completely, and keys that share a hash prefix', () => {
    // Constant hash: every key collides at every level.
    let all = PersistentMap.empty<number>(() => 7);
    for (let i = 0; i < 20; i++) all = all.set(`k${i}`, i);
    expect(all.size).toBe(20);
    for (let i = 0; i < 20; i++) expect(all.get(`k${i}`)).toBe(i);
    all = all.set('k3', 33);
    expect(all.get('k3')).toBe(33);
    expect(all.size).toBe(20);
    expect(all.get('absent')).toBeUndefined();

    // Two hash classes: keys ending in an even digit share hash 1, the rest share hash 2 — a
    // collision node must be split by a branch when a different hash arrives at its slot.
    let split = PersistentMap.empty<number>((k) => (Number(k.at(-1)) % 2 === 0 ? 1 : 1 + (1 << 5)));
    for (let i = 0; i < 10; i++) split = split.set(`x${i}`, i);
    expect(split.size).toBe(10);
    for (let i = 0; i < 10; i++) expect(split.get(`x${i}`)).toBe(i);
    expect([...split.keys()].length).toBe(10);
    expect(split.get('x11')).toBeUndefined();

    // Hashes that differ only in the top two bits (shift 30) separate at the last level.
    let deep = PersistentMap.empty<number>((k) => (k === 'p' ? 0 : k === 'q' ? 1 << 30 : 1 << 31));
    deep = deep.set('p', 1).set('q', 2).set('r', 3);
    expect([deep.get('p'), deep.get('q'), deep.get('r')]).toEqual([1, 2, 3]);
    expect(deep.get('s')).toBeUndefined();
  });

  it('files slot 31 after slot 3 when two leaves split below the root (1 << 31 is negative; the order must be unsigned)', () => {
    // Both keys share the low five bits (slot 7 at level 0), then split at level 1 into slots 3 and 31.
    let m = PersistentMap.empty<number>((k) => (k === 'hi' ? (31 << 5) | 7 : (3 << 5) | 7));
    m = m.set('hi', 1).set('lo', 2);
    expect([m.get('hi'), m.get('lo')]).toEqual([1, 2]);
    m = m.set('lo', 3).set('hi', 4);
    expect([m.get('hi'), m.get('lo'), m.size]).toEqual([4, 3, 2]);
  });

  it('keeps every one of 100 000 sequential id keys (the regression that once lost 3 584 of them)', () => {
    let m = PersistentMap.empty<number>();
    for (let i = 1; i <= 100_000; i++) m = m.set(`abcdefghijklm:${i}`, i);
    expect(m.size).toBe(100_000);
    let lost = 0;
    for (let i = 1; i <= 100_000; i++) if (m.get(`abcdefghijklm:${i}`) !== i) lost++;
    expect(lost).toBe(0);
  });

  it('from() takes the same collision and split paths as set(): a constant hash, two hash classes, and a collision node met by a different hash (review P9)', () => {
    const entries: [string, number][] = [];
    for (let i = 0; i < 20; i++) entries.push([`k${i}`, i]);
    entries.push(['k3', 33]); // an overwrite inside the bulk build must not count as growth
    const all = PersistentMap.from(entries, () => 7);
    expect(all.size).toBe(20);
    expect(all.get('k3')).toBe(33);
    for (let i = 0; i < 20; i++) if (i !== 3) expect(all.get(`k${i}`)).toBe(i);
    expect([...all.keys()].length).toBe(20);

    const split = PersistentMap.from(
      Array.from({ length: 10 }, (_, i) => [`x${i}`, i] as const),
      (k) => (Number(k.at(-1)) % 2 === 0 ? 1 : 1 + (1 << 5)),
    );
    expect(split.size).toBe(10);
    for (let i = 0; i < 10; i++) expect(split.get(`x${i}`)).toBe(i);

    // 'a' and 'b' collide, then 'c' arrives at the collision node with a hash that differs deeper down.
    const wrapped = PersistentMap.from<number>([['a', 1], ['b', 2], ['c', 3]], (k) => (k === 'c' ? 7 + (1 << 5) : 7));
    expect([wrapped.get('a'), wrapped.get('b'), wrapped.get('c'), wrapped.size]).toEqual([1, 2, 3, 3]);
    // And a map built by from() keeps behaving persistently under set().
    const more = wrapped.set('d', 4).set('a', 11);
    expect([more.get('a'), more.get('d'), more.size, wrapped.get('a'), wrapped.size]).toEqual([11, 4, 4, 1, 3]);
  });

  it('delete matches a Map after any interleaving of sets and deletes, and never changes the older version', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbKey, fc.option(fc.nat(), { nil: undefined })), { maxLength: 200 }), (steps) => {
        let pm = PersistentMap.empty<number>();
        const model = new Map<string, number>();
        for (const [k, v] of steps) {
          const before = pm;
          const had = pm.get(k);
          if (v === undefined) {
            pm = pm.delete(k);
            model.delete(k);
            if (had === undefined) expect(pm).toBe(before);
          } else {
            pm = pm.set(k, v);
            model.set(k, v);
          }
          expect(pm.size).toBe(model.size);
          expect(pm.get(k)).toBe(model.get(k));
          expect(before.get(k)).toBe(had);
        }
        expect(new Map(pm)).toEqual(model);
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('delete empties branches and shrinks collision nodes: constant-hash and deep-split maps come back empty and then accept sets again', () => {
    let all = PersistentMap.empty<number>(() => 7);
    for (let i = 0; i < 5; i++) all = all.set(`k${i}`, i);
    for (let i = 0; i < 5; i++) all = all.delete(`k${i}`);
    expect(all.size).toBe(0);
    expect([...all.keys()]).toEqual([]);
    expect(all.set('k9', 9).get('k9')).toBe(9);

    let deep = PersistentMap.empty<number>((k) => (k === 'hi' ? (31 << 5) | 7 : (3 << 5) | 7));
    deep = deep.set('hi', 1).set('lo', 2).delete('hi');
    expect([deep.get('hi'), deep.get('lo'), deep.size]).toEqual([undefined, 2, 1]);
    expect(deep.delete('lo').size).toBe(0);
    expect(deep.delete('absent')).toBe(deep);
  });

  it('builds from entries and reports its tag', () => {
    const m = PersistentMap.from([
      ['a', 1],
      ['b', 2],
    ]);
    expect(m.size).toBe(2);
    expect(Object.prototype.toString.call(m)).toBe('[object PersistentMap]');
  });

  it('hashString is deterministic, 32-bit unsigned, and spreads sequential id keys', () => {
    expect(hashString('abcdefghijklm:1')).toBe(hashString('abcdefghijklm:1'));
    const hashes = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const h = hashString(`abcdefghijklm:${i}`);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
      hashes.add(h);
    }
    expect(hashes.size).toBe(1000);
  });
});
