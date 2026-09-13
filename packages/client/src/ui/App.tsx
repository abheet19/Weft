// App.tsx — the redesign's app shell: the left NavRail plus whichever of the four screens is active.
// Documents needs no live document session, so selecting it fully UNMOUNTS Shell — the same
// `useSession` cleanup that runs on a normal page unload closes the socket and releases the
// IndexedDB handle, rather than leaving a session open behind a hidden panel. Editor/History/Settings
// all need the SAME live session, so they stay inside Shell as an internal `screen` prop instead:
// switching between them keeps one WebSocket connected instead of reconnecting on every tab click.
// This file owns exactly one thing — which of the four is showing — and asks Shell to hand it back
// each time a ⌘K "Navigate" command or an in-editor control needs to change it.

import { useState } from 'react';
import { Documents } from './Documents.tsx';
import { IconSprite } from './Icons.tsx';
import { NavRail } from './NavRail.tsx';
import { Shell } from './Shell.tsx';

export type Screen = 'documents' | 'editor' | 'history' | 'settings';

interface AppProps {
  url: string;
  docId: string;
}

export function App({ url, docId }: AppProps): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('editor');
  return (
    <div className="appshell">
      <IconSprite />
      <NavRail active={screen} onSelect={setScreen} />
      <div className="appstage">{screen === 'documents' ? <Documents /> : <Shell url={url} docId={docId} screen={screen} onNavigate={setScreen} />}</div>
    </div>
  );
}
