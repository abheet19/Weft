// siblings.test.ts — the chunked sibling list under Children. It must read exactly like a sorted
// array (checked against one under random inserts, across chunk splits), answer "first" and
// "after" like that array, never mutate an older version, and rebuild from a sorted array.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareIds, type ItemId } from '../src/index.ts';
import { firstSibling, insertSibling, MAX_CHUNK, NO_SIBLINGS, siblingAfter, siblingArray, siblingsFrom, type SiblingList } from '../src/siblings.ts';
import { id, numRuns, REPLICAS } from './helpers.ts';

const arbId: fc.Arbitrary<ItemId> = fc.tuple(fc.constantFrom(...REPLICAS), fc.integer({ min: 1, max: 400 })).map(([r, s]) => id(r, s));

/** What the list must look like: the distinct ids inserted so far, sorted by compareIds. */
function model(ids: readonly ItemId[]): ItemId[] {
  const seen = new Map<string, ItemId>();
  for (const x of ids) seen.set(`${x.replica}:${x.seq}`, x);
  return [...seen.values()].sort(compareIds);
}

describe('SiblingList', () => {
  it('reads like a sorted array after any sequence of inserts, and first/after agree with that array at every step', () => {
    fc.assert(
      fc.property(fc.array(arbId, { maxLength: 300 }), (ids) => {
        let list: SiblingList = NO_SIBLINGS;
        const inserted: ItemId[] = [];
        for (const x of ids) {
          if (model(inserted).some((y) => compareIds(y, x) === 0)) continue; // apply never inserts a held id
          inserted.push(x);
          list = insertSibling(list, x);
          const expected = model(inserted);
          expect(siblingArray(list)).toEqual(expected);
          expect(list.length).toBe(expected.length);
          expect(firstSibling(list)).toEqual(expected[0]);
          expected.forEach((y, i) => expect(siblingAfter(list, y)).toEqual(expected[i + 1]));
          for (const chunk of list.chunks) expect(chunk.length).toBeGreaterThan(0);
        }
        expect(siblingAfter(list, id(REPLICAS[0] as ItemId['replica'], 401))).toBeUndefined();
      }),
      { numRuns: numRuns('light') },
    );
  });

  it('splits a chunk that grows past MAX_CHUNK, keeps every chunk non-empty and sorted, and leaves the older list untouched', () => {
    let list: SiblingList = NO_SIBLINGS;
    const before: SiblingList[] = [];
    const replica = REPLICAS[1] as ItemId['replica'];
    for (let i = 1; i <= 3 * MAX_CHUNK; i++) {
      before.push(list);
      list = insertSibling(list, id(replica, i));
    }
    expect(list.chunks.length).toBeGreaterThan(1);
    for (const chunk of list.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK);
    }
    expect(siblingArray(list).map((x) => x.seq)).toEqual(Array.from({ length: 3 * MAX_CHUNK }, (_, i) => i + 1));
    before.forEach((old, i) => expect(old.length).toBe(i));
    expect(firstSibling(NO_SIBLINGS)).toBeUndefined();
    expect(siblingAfter(NO_SIBLINGS, id(replica, 1))).toBeUndefined();
  });

  it('inserting in the middle of a full chunk and at the very front and back lands in order', () => {
    const replica = REPLICAS[2] as ItemId['replica'];
    let list = siblingsFrom(Array.from({ length: MAX_CHUNK }, (_, i) => id(replica, 2 * (i + 1))));
    list = insertSibling(list, id(replica, 1)); // front
    list = insertSibling(list, id(replica, MAX_CHUNK + 1)); // middle of the (now split) range
    list = insertSibling(list, id(replica, 2 * MAX_CHUNK + 1)); // back
    const seqs = siblingArray(list).map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.length).toBe(MAX_CHUNK + 3);
  });

  it('siblingsFrom rebuilds a sorted array into half-full chunks, and from an empty array gives the shared empty list', () => {
    const replica = REPLICAS[3] as ItemId['replica'];
    const sorted = Array.from({ length: 100 }, (_, i) => id(replica, i + 1));
    const list = siblingsFrom(sorted);
    expect(siblingArray(list)).toEqual(sorted);
    expect(list.chunks.length).toBe(Math.ceil(100 / (MAX_CHUNK / 2)));
    expect(siblingsFrom([])).toBe(NO_SIBLINGS);
  });
});
