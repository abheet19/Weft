// NavRail.tsx — the redesign's left icon rail: the app shell's four destinations (Documents, Editor,
// History, Settings). It is the ONE new piece of navigation structure the redesign adds; every
// screen it switches to is otherwise unchanged. It renders once, as a sibling of whichever screen is
// active, so it survives navigating away from a live document without touching that document's own
// session lifecycle (App.tsx owns that by mounting/unmounting Shell, not this rail).

import type { Screen } from './App.tsx';
import { Icon } from './Icons.tsx';

interface NavRailProps {
  active: Screen;
  onSelect: (screen: Screen) => void;
}

const ITEMS: ReadonlyArray<readonly [Screen, string, string]> = [
  ['documents', 'grid', 'Documents'],
  ['editor', 'pen', 'Editor'],
  ['history', 'clock', 'History'],
  ['settings', 'gear', 'Settings'],
];

export function NavRail({ active, onSelect }: NavRailProps): React.JSX.Element {
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
      <a className="navrail-eco" href="https://github.com/abheet19" target="_blank" rel="noreferrer noopener" title="Part of Abheet’s Zeno ecosystem — github.com/abheet19" aria-label="Part of Abheet’s Zeno ecosystem — opens github.com/abheet19">
        <Icon name="ext" />
      </a>
    </nav>
  );
}
