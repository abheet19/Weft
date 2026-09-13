// uiPrefs.test.ts — the persisted theme/accent/reduce-transparency choice: round-trips, defaults
// with no storage or nothing saved yet, and every malformed-value path falling back field-by-field
// rather than discarding the whole record.

import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS, readUiPrefs, writeUiPrefs } from '../../src/ui/uiPrefs.ts';

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

describe('readUiPrefs', () => {
  it('is the defaults with no storage', () => {
    expect(readUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
  });
  it('is the defaults with nothing saved yet', () => {
    expect(readUiPrefs(fakeStorage())).toEqual(DEFAULT_UI_PREFS);
  });
  it('is the defaults for unparseable JSON', () => {
    expect(readUiPrefs(fakeStorage({ 'weft:ui-prefs': '{not json' }))).toEqual(DEFAULT_UI_PREFS);
  });
  it('is the defaults when the saved value is not an object', () => {
    expect(readUiPrefs(fakeStorage({ 'weft:ui-prefs': '"just a string"' }))).toEqual(DEFAULT_UI_PREFS);
  });

  it('round-trips a full saved value', () => {
    const storage = fakeStorage();
    writeUiPrefs(storage, { theme: 'dark', flat: true, accent: 'amber' });
    expect(readUiPrefs(storage)).toEqual({ theme: 'dark', flat: true, accent: 'amber' });
  });

  it('falls back per-field for an unrecognised value instead of discarding the whole record', () => {
    const storage = fakeStorage({ 'weft:ui-prefs': JSON.stringify({ theme: 'purple', flat: true, accent: 'amber' }) });
    expect(readUiPrefs(storage)).toEqual({ theme: null, flat: true, accent: 'amber' });
  });

  it('accepts a null theme (follow the system) and a false flat', () => {
    const storage = fakeStorage();
    writeUiPrefs(storage, { theme: null, flat: false, accent: 'cyan' });
    expect(readUiPrefs(storage)).toEqual({ theme: null, flat: false, accent: 'cyan' });
  });
});

describe('writeUiPrefs', () => {
  it('is a no-op with no storage', () => {
    expect(() => writeUiPrefs(null, { theme: 'dark', flat: false, accent: 'cyan' })).not.toThrow();
  });
});
