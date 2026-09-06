// commands.ts — the contents of the ⌘K command palette (03-UI §4.8), as pure data. This file is the
// single source of truth for the palette's groups, order, icons and labels; every `run` is a
// behaviour the shell supplies through `PaletteActions`, so nothing here reaches for the DOM, the
// runner or the router. It exists so the palette's wiring is testable without rendering the shell:
// a test passes spies and asserts that running "Simulate offline" calls `simulateOffline`, and so on.
// Every item is wired to a session or UI action that already exists — the palette invents no new
// behaviour, it is only a second front door to the controls the top bar, the rail and the keyboard
// already expose (03-UI §4.8). `filterCommands` is the typing filter: a case-insensitive substring
// match on an item's title or its group.

/** One palette row: a group heading it sorts under, an icon, its label, an optional current value shown at the right, an optional shortcut hint, and what running it does. */
export interface Command {
  readonly group: string;
  readonly title: string;
  readonly icon: string;
  /** The control's current value shown right-aligned (e.g. the theme, or On/Off) — omitted for a plain action. */
  readonly value?: string;
  run(): void;
}

/** The behaviours and current values the shell wires each command to. All of them already exist elsewhere in the shell; the palette only re-exposes them. */
export interface PaletteActions {
  /** Document */
  renameViaHeading(): void;
  newDocument(): void;
  themeLabel: string;
  toggleTheme(): void;
  transparencyOn: boolean;
  toggleTransparency(): void;
  /** Collaboration */
  myName: string;
  setMyName(): void;
  followPeer(): void;
  /** History */
  timeTravel(): void;
  authorsOn: boolean;
  toggleAuthors(): void;
  /** Debug */
  offlineOn: boolean;
  simulateOffline(): void;
  dropN: number;
  dropMessages(): void;
  toggleInspector(): void;
  copyStateVector(): void;
}

const onOff = (on: boolean): string => (on ? 'On' : 'Off');

/** The palette's rows, in the groups and order of 03-UI §4.8. Built fresh on each render so the values (theme, On/Off, name, N) reflect the current state. */
export function paletteCommands(a: PaletteActions): readonly Command[] {
  return [
    { group: 'Document', title: 'Rename via heading', icon: 'h1', run: a.renameViaHeading },
    { group: 'Document', title: 'New document', icon: 'plus', run: a.newDocument },
    { group: 'Document', title: 'Theme', icon: 'sun', value: a.themeLabel, run: a.toggleTheme },
    { group: 'Document', title: 'Reduce transparency', icon: 'layers', value: onOff(a.transparencyOn), run: a.toggleTransparency },
    { group: 'Collaboration', title: 'Set my name', icon: 'user', value: a.myName, run: a.setMyName },
    { group: 'Collaboration', title: 'Follow…', icon: 'eye', run: a.followPeer },
    { group: 'History', title: 'Time-travel', icon: 'clock', run: a.timeTravel },
    { group: 'History', title: 'Show authors', icon: 'brush', value: onOff(a.authorsOn), run: a.toggleAuthors },
    { group: 'Debug', title: 'Simulate offline', icon: 'wifioff', value: onOff(a.offlineOn), run: a.simulateOffline },
    { group: 'Debug', title: 'Drop next N', icon: 'drop', value: `N = ${a.dropN}`, run: a.dropMessages },
    { group: 'Debug', title: 'Toggle Inspector', icon: 'panel', run: a.toggleInspector },
    { group: 'Debug', title: 'Copy state vector', icon: 'copy', run: a.copyStateVector },
  ];
}

/** The typing filter: case-insensitive substring on the title or the group; an empty query keeps everything. */
export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const q = query.trim().toLowerCase();
  if (q === '') return commands;
  return commands.filter((c) => c.title.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
}
