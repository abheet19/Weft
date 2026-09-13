// browserStorage.test.ts — safeLocalStorage never throws: a real Storage passes through, a missing
// global, a getter that throws, and a Storage whose own methods throw (Safari private mode's classic
// shape) all read as null.

import { describe, expect, it } from 'vitest';
import { safeLocalStorage } from '../../src/ui/browserStorage.ts';

function fakeStorage(): Storage {
  const data = new Map<string, string>();
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

describe('safeLocalStorage', () => {
  it('returns the real storage when it is usable', () => {
    const win = { localStorage: fakeStorage() } as unknown as Window;
    expect(safeLocalStorage(win)).toBe(win.localStorage);
  });

  it('returns null when the property access itself throws', () => {
    const win = {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    } as unknown as Window;
    expect(safeLocalStorage(win)).toBeNull();
  });

  it('returns null when the storage exists but every method throws (private-mode Safari)', () => {
    const angry = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    const win = { localStorage: angry } as unknown as Window;
    expect(safeLocalStorage(win)).toBeNull();
  });

  it('leaves no probe key behind on success', () => {
    const storage = fakeStorage();
    const win = { localStorage: storage } as unknown as Window;
    safeLocalStorage(win);
    expect(storage.length).toBe(0);
  });
});
