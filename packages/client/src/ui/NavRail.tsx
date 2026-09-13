// NavRail.tsx — the redesign's left icon rail: the app shell's four destinations (Documents, Editor,
// History, Settings). It is the ONE new piece of navigation structure the redesign adds; every
// screen it switches to is otherwise unchanged. It renders once, as a sibling of whichever screen is
// active, so it survives navigating away from a live document without touching that document's own
// session lifecycle (App.tsx owns that by mounting/unmounting Shell, not this rail).
//
// The design artifact also puts three utilities at the rail's foot: a theme mini-toggle (wired to
// App's real per-device theme so it works on every screen, Documents included, where Shell is not
// mounted), a ⌘K "Commands" trigger (opens Shell's existing command palette via the same global
// Ctrl+K it already listens for), and the ecosystem link back to github.com/abheet19 (real, kept —
// the artifact's decorative presence dots are NOT reproduced here: Weft has no accounts and the live
// peer table lives inside the unmounted Shell, so a rail avatar stack could only be faked).

import type { Screen } from './App.tsx';
import { Icon } from './Icons.tsx';
import type { ThemeChoice } from './uiPrefs.ts';

interface NavRailProps {
  active: Screen;
  onSelect: (screen: Screen) => void;
  theme: ThemeChoice;
  onToggleTheme: () => void;
  onCommands: () => void;
}

const ITEMS: ReadonlyArray<readonly [Screen, string, string]> = [
  ['documents', 'grid', 'Documents'],
  ['editor', 'pen', 'Editor'],
  ['history', 'clock', 'History'],
  ['settings', 'gear', 'Settings'],
];

export function NavRail({ active, onSelect, theme, onToggleTheme, onCommands }: NavRailProps): React.JSX.Element {
  // Resolve the icon the toggle should show: an explicit choice wins; otherwise fall back to the
  // system preference so the glyph matches what is actually on screen.
  const systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true;
  const isDark = theme === 'dark' || (theme === null && systemDark);
  return (
    <nav className="navrail" aria-label="Weft">
      {/* aria-label is distinct from the top bar's own "Weft home" link (Shell.tsx) so a11y tooling
          and Playwright's getByRole never collide between the two brand marks on screen at once. */}
      <a className="navrail-brand" href="/" aria-label="Weft (nav rail)" title="Weft">
        <img src="/brand/mark.svg" alt="" />
      </a>
      <div className="navrail-items" role="tablist" aria-orientation="vertical">
        {ITEMS.map(([id, icon, label]) => (
          <button key={id} type="button" role="tab" aria-selected={active === id} className={`navrail-btn${active === id ? ' on' : ''}`} onClick={() => onSelect(id)}>
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <span className="grow" />
      <div className="navrail-foot">
        <button type="button" className="navrail-mini" onClick={onToggleTheme} title="Toggle theme" aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}>
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
        <button type="button" className="navrail-cmdk" onClick={onCommands} aria-label="Open command palette (Ctrl+K)">
          <kbd>⌘K</kbd>
          <span>Commands</span>
        </button>
        <a className="navrail-eco" href="https://github.com/abheet19" target="_blank" rel="noreferrer noopener" title="Part of Abheet’s Zeno ecosystem — github.com/abheet19" aria-label="Part of Abheet’s Zeno ecosystem — opens github.com/abheet19">
          <Icon name="ext" />
        </a>
      </div>
    </nav>
  );
}
