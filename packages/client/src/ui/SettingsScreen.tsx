// SettingsScreen.tsx — the redesign's full-page Settings (a fourth nav-rail destination), gathering
// controls that used to live only behind ⌘K or the sidebar's Sync tab into one place a reader can
// browse rather than search: Appearance (theme, reduce transparency, the new accent choice),
// Collaboration (your display name), Shortcuts (a static reference — nothing here is a control),
// and — only once a document session is open — Debug (the same chaos controls the Sync tab's
// Diagnostics exposes: drop N ops, delay outbound frames, force the divergence tripwire). It invents
// no new behaviour: every control here calls exactly the function the top bar, the palette or the
// sidebar already calls: this is a second, more discoverable front door, same as the palette is.

import { useState } from 'react';
import type { ReplicaId } from '@weft/crdt';
import type { Session } from '../session/open.ts';
import type { RunnerSnapshot } from '../session/runner.ts';
import type { Accent, ThemeChoice } from './uiPrefs.ts';
import { Icon } from './Icons.tsx';

/** A fixed, valid replica id for the demo's stubbed divergent peer (mirrors Sidebar.tsx) — never authored under, so it can never be a real replica. */
const PHANTOM = 'zzzzzzzzzzzzz' as ReplicaId;

type Section = 'appearance' | 'collab' | 'shortcuts' | 'debug';

interface SettingsScreenProps {
  theme: ThemeChoice;
  onTheme: (theme: ThemeChoice) => void;
  flat: boolean;
  onFlat: (flat: boolean) => void;
  accent: Accent;
  onAccent: (accent: Accent) => void;
  /** null until a document session is loaded — Collaboration/Debug need a live session, so they show a plain notice instead of a control until then. */
  doc: { readonly displayName: string; readonly onRename: (name: string) => void; readonly userOffline: boolean; readonly onSetUserOffline: (offline: boolean) => void; readonly session: Session; readonly snapshot: RunnerSnapshot } | null;
}

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Command palette', '⌘K'],
  ['Bold', '⌘B'],
  ['Italic', '⌘I'],
  ['Underline', '⌘U'],
  ['Strikethrough', '⌘⇧S'],
  ['Inline code', '⌘E'],
  ['Highlight', '⌘⇧H'],
  ['Link', '⌘K (with a selection)'],
  ['Undo / Redo', '⌘Z / ⌘Y'],
];

export function SettingsScreen({ theme, onTheme, flat, onFlat, accent, onAccent, doc }: SettingsScreenProps): React.JSX.Element {
  const [section, setSection] = useState<Section>('appearance');
  return (
    <div className="screenpage" aria-label="Settings">
      <h1 className="screenpage-h">Settings</h1>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {(
            [
              ['appearance', 'brush', 'Appearance'],
              ['collab', 'user', 'Collaboration'],
              ['shortcuts', 'cmd', 'Shortcuts'],
              ['debug', 'gear', 'Debug'],
            ] as const
          ).map(([id, icon, label]) => (
            <button key={id} type="button" className={section === id ? 'on' : ''} aria-current={section === id} onClick={() => setSection(id)}>
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === 'appearance' && (
            <section className="panel" aria-labelledby="set-appearance-h">
              <div className="panel-h">
                <h2 id="set-appearance-h">Appearance</h2>
              </div>
              <div className="set-row">
                <span>
                  Theme<span className="desc">Light, dark, or follow this device’s system setting</span>
                </span>
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {(['light', 'dark', null] as const).map((t) => (
                    <button key={String(t)} type="button" role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => onTheme(t)}>
                      {t === null ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <span>
                  Reduce transparency<span className="desc">Turns glass panels into solid surfaces</span>
                </span>
                <button type="button" className="switch" role="switch" aria-checked={flat} aria-label="Reduce transparency" onClick={() => onFlat(!flat)} />
              </div>
              <div className="set-row">
                <span>
                  Accent<span className="desc">Used for links, focus rings, and the active state</span>
                </span>
                <div className="accent-swatches" role="radiogroup" aria-label="Accent colour">
                  {(['cyan', 'amber'] as const).map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={accent === c} aria-label={c} className={`accent-swatch accent-${c}${accent === c ? ' on' : ''}`} onClick={() => onAccent(c)} />
                  ))}
                </div>
              </div>
            </section>
          )}
          {section === 'appearance' && (
            <aside className="settings-help">
              <h3>About appearance</h3>
              <p>These are personal, per-device preferences. Nothing here is a document edit and none of it syncs to your collaborators — Weft keeps your theme, transparency, and accent in this browser only.</p>
              <p><strong>Theme</strong> follows your system by default. <strong>Reduce transparency</strong> swaps the glass panels for solid surfaces — handy if the blur is heavy on your machine. <strong>Accent</strong> recolours links, focus rings, and the active state.</p>
            </aside>
          )}

          {section === 'collab' && (
            <section className="panel" aria-labelledby="set-collab-h">
              <div className="panel-h">
                <h2 id="set-collab-h">Collaboration</h2>
              </div>
              {doc === null ? (
                <p className="rail-empty">Open a document to set the name your collaborators see.</p>
              ) : (
                <div className="set-row">
                  <span>
                    Your name<span className="desc">Shown to collaborators on this document; never persisted, never a document op</span>
                  </span>
                  <input
                    type="text"
                    className="set-input"
                    defaultValue={doc.displayName}
                    aria-label="Your name"
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next !== '' && next !== doc.displayName) doc.onRename(next);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
              )}
            </section>
          )}
          {section === 'collab' && (
            <aside className="settings-help">
              <h3>About collaboration</h3>
              <p>Your display name rides along in <strong>presence</strong>, so collaborators can see who is editing and where each caret sits.</p>
              <p>It is never written into the document and never persisted — refresh and it is gone. History and the CRDT op log record edits, not names.</p>
            </aside>
          )}

          {section === 'shortcuts' && (
            <section className="panel" aria-labelledby="set-shortcuts-h">
              <div className="panel-h">
                <h2 id="set-shortcuts-h">Keyboard shortcuts</h2>
              </div>
              <div className="shortcut-table">
                {SHORTCUTS.map(([label, keys]) => (
                  <div className="shortcut-row" key={label}>
                    <span>{label}</span>
                    <kbd>{keys}</kbd>
                  </div>
                ))}
              </div>
            </section>
          )}
          {section === 'shortcuts' && (
            <aside className="settings-help">
              <h3>About shortcuts</h3>
              <p>Every command here also lives in the palette (⌘K), which searches by name when you cannot recall the key.</p>
              <p>These bindings are a fixed reference for now — nothing on this panel is a control.</p>
            </aside>
          )}

          {section === 'debug' && <DebugSection doc={doc} />}
        </div>
      </div>
    </div>
  );
}

function DebugSection({ doc }: Pick<SettingsScreenProps, 'doc'>): React.JSX.Element {
  const [dropN, setDropN] = useState(3);
  const [delayed, setDelayed] = useState(false);
  const [copyResult, setCopyResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (doc === null) {
    return (
      <>
        <section className="panel" aria-labelledby="set-debug-h">
          <div className="panel-h">
            <h2 id="set-debug-h">Debug</h2>
          </div>
          <p className="rail-empty">Open a document to reach its chaos controls — the same ones the Sync tab’s Diagnostics exposes.</p>
        </section>
        <DebugHelp />
      </>
    );
  }
  const { session, snapshot, userOffline, onSetUserOffline } = doc;
  const toggleDelay = (): void => {
    const next = !delayed;
    setDelayed(next);
    session.runner.setDelay(next ? 2_000 : 0);
  };
  const forceDivergence = (): void => {
    if (snapshot.hash === null) return;
    const bad = (snapshot.hash[0] === 'f' ? '0' : 'f') + snapshot.hash.slice(1);
    session.runner.receivePresence(PHANTOM, { name: 'phantom', color: 2, hash: bad, sv: snapshot.sv });
  };
  const copyStateVector = (): void => {
    if (navigator.clipboard === undefined) {
      setCopyResult('failed');
      return;
    }
    void navigator.clipboard.writeText(JSON.stringify(snapshot.sv)).then(
      () => setCopyResult('copied'),
      () => setCopyResult('failed'),
    );
  };
  return (
    <>
    <section className="panel" aria-labelledby="set-debug-h">
      <div className="panel-h">
        <h2 id="set-debug-h">Debug — this document</h2>
        <span className="sub">The chaos controls the tests share</span>
      </div>
      <div className="set-row">
        <span>
          Work offline<span className="desc">Closes the socket; edits stay saved on this device</span>
        </span>
        <button type="button" className="switch" role="switch" aria-checked={userOffline} aria-label="Simulate offline" onClick={() => onSetUserOffline(!userOffline)} />
      </div>
      <div className="set-row">
        <span>
          Drop next <output className="mono">{dropN}</output> op messages<span className="desc">Opens a seq gap the client repairs</span>
        </span>
        <span className="chaos-controls">
          <span className="stepper">
            <button type="button" aria-label="Fewer" onClick={() => setDropN((n) => Math.max(1, n - 1))}>
              −
            </button>
            <output aria-hidden="true">{dropN}</output>
            <button type="button" aria-label="More" onClick={() => setDropN((n) => Math.min(50, n + 1))}>
              +
            </button>
          </span>
          <button type="button" className="btn" onClick={() => session.runner.dropNext(dropN)}>
            Arm
          </button>
        </span>
      </div>
      <div className="set-row">
        <span>
          Delay 2 s<span className="desc">Every outbound message</span>
        </span>
        <button type="button" className="switch" role="switch" aria-checked={delayed} aria-label="Delay 2 s" onClick={toggleDelay} />
      </div>
      <div className="set-row">
        <span>
          Force divergence<span className="desc">Demo the tripwire: a peer with a bad hash</span>
        </span>
        <button type="button" className="btn" onClick={forceDivergence} disabled={snapshot.hash === null}>
          Trip
        </button>
      </div>
      <div className="set-row">
        <span>
          State vector<span className="desc">This replica’s op counts, for a bug report</span>
        </span>
        <button type="button" className="btn" onClick={copyStateVector}>
          {copyResult === 'copied' ? 'Copied state vector' : copyResult === 'failed' ? 'Copy failed' : 'Copy state vector'}
        </button>
      </div>
    </section>
    <DebugHelp />
    </>
  );
}

function DebugHelp(): React.JSX.Element {
  return (
    <aside className="settings-help">
      <h3>About debug</h3>
      <p>These chaos controls drive the same code paths the automated tests use, so you can watch Weft recover live: dropping ops opens a sequence gap the client repairs, and <strong>delay</strong> or <strong>work offline</strong> exercise reconnection.</p>
      <p><strong>Force divergence</strong> plants a peer with a bad hash to trip the safety tripwire. None of this corrupts your work — the CRDT op log and History stay intact.</p>
    </aside>
  );
}
