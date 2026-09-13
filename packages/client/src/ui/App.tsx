// App.tsx — the redesign's app shell: the left NavRail plus whichever of the four screens is active.
// Documents needs no live document session, so selecting it fully UNMOUNTS Shell — the same
// `useSession` cleanup that runs on a normal page unload closes the socket and releases the
// IndexedDB handle, rather than leaving a session open behind a hidden panel. Editor/History/Settings
// all need the SAME live session, so they stay inside Shell as an internal `screen` prop instead:
// switching between them keeps one WebSocket connected instead of reconnecting on every tab click.
// This file owns exactly one thing besides that — which of the four is showing — and, since the
// NavRail (its theme mini-toggle) is mounted on EVERY screen including Documents where Shell is not,
// it also owns the per-device look prefs (theme/flat/accent) so a single source of truth drives both
// the rail's toggle and Shell's Settings/palette. It applies the `data-*` flags and persists the
// choice (`uiPrefs.ts`, guarded `localStorage`); Shell just reads them and calls the setters back.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Documents } from './Documents.tsx';
import { IconSprite } from './Icons.tsx';
import { NavRail } from './NavRail.tsx';
import { safeLocalStorage } from './browserStorage.ts';
import { Shell } from './Shell.tsx';
import { readUiPrefs, writeUiPrefs, type Accent, type ThemeChoice } from './uiPrefs.ts';

export type Screen = 'documents' | 'editor' | 'history' | 'settings';

interface AppProps {
  url: string;
  docId: string;
}

/** Opens the ⌘K palette (owned by Shell, mounted only off Documents) by dispatching the same global
    Ctrl+K the palette already listens for — so the rail trigger needs no wire down into the session. */
function openPalette(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
}

export function App({ url, docId }: AppProps): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('editor');
  const storage = useRef(safeLocalStorage());
  const [uiPrefs, setUiPrefs] = useState(() => readUiPrefs(storage.current));
  const { theme, flat, accent } = uiPrefs;
  useEffect(() => {
    if (theme !== null) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  useEffect(() => {
    if (flat) document.documentElement.dataset.flat = '1';
    else delete document.documentElement.dataset.flat;
  }, [flat]);
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);
  useEffect(() => writeUiPrefs(storage.current, uiPrefs), [uiPrefs]);
  const setTheme = useCallback((next: ThemeChoice) => setUiPrefs((p) => ({ ...p, theme: next })), []);
  const setFlat = useCallback((next: boolean) => setUiPrefs((p) => ({ ...p, flat: next })), []);
  const setAccent = useCallback((next: Accent) => setUiPrefs((p) => ({ ...p, accent: next })), []);

  return (
    <div className="appshell">
      <IconSprite />
      <NavRail active={screen} onSelect={setScreen} theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onCommands={openPalette} />
      <div className="appstage">
        {screen === 'documents' ? (
          <Documents />
        ) : (
          <Shell url={url} docId={docId} screen={screen} onNavigate={setScreen} theme={theme} flat={flat} accent={accent} onTheme={setTheme} onFlat={setFlat} onAccent={setAccent} />
        )}
      </div>
    </div>
  );
}
