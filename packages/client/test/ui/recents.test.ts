// recents.test.ts — the Documents screen's local registry: read/write round-trips, newest-first
// order, upsert-by-id, forgetting an entry, the cap on how many are kept, and every "this is not
// usable" path (no storage, a foreign shape, unparseable JSON) degrading to an empty list rather
// than throwing — this data is a convenience, never a source of truth about any document.

import { describe, expect, it } from 'vitest';
import { forgetRecent, readRecents, touchRecent } from '../../src/ui/recents.ts';

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe('readRecents', () => {
  it('is empty with no storage', () => {
    expect(readRecents(null)).toEqual([]);
  });
  it('is empty with nothing saved yet', () => {
    expect(readRecents(fakeStorage())).toEqual([]);
  });
  it('is empty for unparseable JSON', () => {
    expect(readRecents(fakeStorage({ 'weft:recents': '{not json' }))).toEqual([]);
  });
  it('is empty when the saved value is not an array', () => {
    expect(readRecents(fakeStorage({ 'weft:recents': '{"id":"a"}' }))).toEqual([]);
  });
  it('drops entries that are not shaped like a RecentDoc, keeping the valid ones', () => {
    const raw = JSON.stringify([{ id: 'ok', title: 'Ok', words: 1, updatedAt: 5 }, { id: 'bad' }, 'nope', null]);
    expect(readRecents(fakeStorage({ 'weft:recents': raw }))).toEqual([{ id: 'ok', title: 'Ok', words: 1, updatedAt: 5 }]);
  });
});

describe('touchRecent', () => {
  it('adds a new entry with the given timestamp', () => {
    const storage = fakeStorage();
    touchRecent(storage, { id: 'a1', title: 'A', words: 10 }, 100);
    expect(readRecents(storage)).toEqual([{ id: 'a1', title: 'A', words: 10, updatedAt: 100 }]);
  });

  it('is a no-op with no storage', () => {
    expect(() => touchRecent(null, { id: 'a1', title: 'A', words: 10 }, 100)).not.toThrow();
  });

  it('moves an existing id to the front and updates its fields', () => {
    const storage = fakeStorage();
    touchRecent(storage, { id: 'a', title: 'A', words: 1 }, 1);
    touchRecent(storage, { id: 'b', title: 'B', words: 2 }, 2);
    touchRecent(storage, { id: 'a', title: 'A renamed', words: 9 }, 3);
    expect(readRecents(storage)).toEqual([
      { id: 'a', title: 'A renamed', words: 9, updatedAt: 3 },
      { id: 'b', title: 'B', words: 2, updatedAt: 2 },
    ]);
  });

  it('sorts newest-first regardless of insertion order', () => {
    const storage = fakeStorage();
    touchRecent(storage, { id: 'old', title: 'Old', words: 0 }, 1);
    touchRecent(storage, { id: 'new', title: 'New', words: 0 }, 99);
    expect(readRecents(storage).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('caps the list at 40 entries, dropping the oldest', () => {
    const storage = fakeStorage();
    for (let i = 0; i < 45; i++) touchRecent(storage, { id: `d${i}`, title: `D${i}`, words: 0 }, i);
    const all = readRecents(storage);
    expect(all).toHaveLength(40);
    expect(all[0]!.id).toBe('d44'); // newest
    expect(all.some((r) => r.id === 'd0')).toBe(false); // oldest, evicted
  });
});

describe('forgetRecent', () => {
  it('removes exactly the named entry, leaving the rest', () => {
    const storage = fakeStorage();
    touchRecent(storage, { id: 'a', title: 'A', words: 0 }, 1);
    touchRecent(storage, { id: 'b', title: 'B', words: 0 }, 2);
    forgetRecent(storage, 'a');
    expect(readRecents(storage).map((r) => r.id)).toEqual(['b']);
  });

  it('is a no-op with no storage or an unknown id', () => {
    const storage = fakeStorage();
    touchRecent(storage, { id: 'a', title: 'A', words: 0 }, 1);
    expect(() => forgetRecent(null, 'a')).not.toThrow();
    forgetRecent(storage, 'does-not-exist');
    expect(readRecents(storage)).toHaveLength(1);
  });
});
