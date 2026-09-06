// commands.test.ts — the ⌘K palette's contents (03-UI §4.8) as pure data: every row is wired to the
// action the shell supplies, in the right group, and running it calls exactly that action; the value
// column reflects the current state; and the typing filter is a case-insensitive substring on title
// or group. This is the coverage-gated proof that "each wired command dispatches the right existing
// action" — the component test (CommandPalette.test.tsx) then proves the dialog behaviour around it.

import { describe, expect, it, vi } from 'vitest';
import { filterCommands, paletteCommands, type PaletteActions } from '../../src/ui/commands.ts';

/** A PaletteActions whose every function is a spy and whose values are fixed, so a test can assert which action a row runs. */
function spies(over: Partial<PaletteActions> = {}): PaletteActions {
  return {
    renameViaHeading: vi.fn(),
    newDocument: vi.fn(),
    themeLabel: 'Dark',
    toggleTheme: vi.fn(),
    transparencyOn: false,
    toggleTransparency: vi.fn(),
    myName: 'abcdef',
    setMyName: vi.fn(),
    followPeer: vi.fn(),
    timeTravel: vi.fn(),
    authorsOn: false,
    toggleAuthors: vi.fn(),
    offlineOn: false,
    simulateOffline: vi.fn(),
    dropN: 3,
    dropMessages: vi.fn(),
    toggleInspector: vi.fn(),
    copyStateVector: vi.fn(),
    ...over,
  };
}

const find = (a: PaletteActions, title: string) => paletteCommands(a).find((c) => c.title === title)!;

describe('paletteCommands groups and order', () => {
  it('lists the four groups of 03-UI §4.8 in order, contiguously', () => {
    expect(paletteCommands(spies()).map((c) => c.group)).toEqual([
      'Document', 'Document', 'Document', 'Document',
      'Collaboration', 'Collaboration',
      'History', 'History',
      'Debug', 'Debug', 'Debug', 'Debug',
    ]);
  });

  it('titles every row with the labels from the design', () => {
    expect(paletteCommands(spies()).map((c) => c.title)).toEqual([
      'Rename via heading', 'New document', 'Theme', 'Reduce transparency',
      'Set my name', 'Follow…',
      'Time-travel', 'Show authors',
      'Simulate offline', 'Drop next N', 'Toggle Inspector', 'Copy state vector',
    ]);
  });
});

describe('each row runs exactly its wired action', () => {
  const cases: ReadonlyArray<readonly [string, keyof PaletteActions]> = [
    ['Rename via heading', 'renameViaHeading'],
    ['New document', 'newDocument'],
    ['Theme', 'toggleTheme'],
    ['Reduce transparency', 'toggleTransparency'],
    ['Set my name', 'setMyName'],
    ['Follow…', 'followPeer'],
    ['Time-travel', 'timeTravel'],
    ['Show authors', 'toggleAuthors'],
    ['Simulate offline', 'simulateOffline'],
    ['Drop next N', 'dropMessages'],
    ['Toggle Inspector', 'toggleInspector'],
    ['Copy state vector', 'copyStateVector'],
  ];
  for (const [title, action] of cases) {
    it(`${title} calls ${action}`, () => {
      const a = spies();
      find(a, title).run();
      expect(a[action]).toHaveBeenCalledTimes(1);
      // No other action fired.
      for (const [, other] of cases) if (other !== action) expect(a[other]).not.toHaveBeenCalled();
    });
  }
});

describe('the value column reflects the current state', () => {
  it('shows the theme label', () => {
    expect(find(spies({ themeLabel: 'Light' }), 'Theme').value).toBe('Light');
  });
  it('shows On/Off for reduce transparency, show authors and simulate offline', () => {
    expect(find(spies({ transparencyOn: true }), 'Reduce transparency').value).toBe('On');
    expect(find(spies({ authorsOn: true }), 'Show authors').value).toBe('On');
    expect(find(spies({ offlineOn: false }), 'Simulate offline').value).toBe('Off');
  });
  it('shows the current name and the drop count', () => {
    expect(find(spies({ myName: 'Mara' }), 'Set my name').value).toBe('Mara');
    expect(find(spies({ dropN: 5 }), 'Drop next N').value).toBe('N = 5');
  });
  it('leaves plain actions without a value', () => {
    expect(find(spies(), 'New document').value).toBeUndefined();
  });
});

describe('filterCommands', () => {
  const all = paletteCommands(spies());
  it('keeps everything for an empty or whitespace query', () => {
    expect(filterCommands(all, '')).toHaveLength(all.length);
    expect(filterCommands(all, '   ')).toHaveLength(all.length);
  });
  it('matches a title substring, case-insensitively', () => {
    const hit = filterCommands(all, 'OFFLINE');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.title).toBe('Simulate offline');
  });
  it('matches a group name too', () => {
    expect(filterCommands(all, 'debug').map((c) => c.title)).toEqual(['Simulate offline', 'Drop next N', 'Toggle Inspector', 'Copy state vector']);
  });
  it('returns nothing when there is no match', () => {
    expect(filterCommands(all, 'zzzz')).toHaveLength(0);
  });
});
