// main.tsx — the browser entry point. Routes `/d/<docId>` to the Shell and `/` to a new document
// (03-UI §3: no other routes) and renders. The replica id is no longer minted here: since S4 a tab
// claims one against the device's store (E41), inside the session it opens. The WebSocket URL is a
// build-time setting (VITE_WEFT_WS, default the dev server on 4200) so the e2e run can point a
// preview build at an ephemeral server without a runtime knob a link could abuse. Nothing here is
// tested directly; everything it calls is.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DOC_ID_RE } from '@weft/protocol';
import { newDocId } from './identity.ts';
import { Shell } from './ui/Shell.tsx';
import './ui/tokens.css';
import './ui/shell.css';

const WS_URL: string = import.meta.env.VITE_WEFT_WS ?? 'ws://127.0.0.1:4200';

const match = /^\/d\/([^/]+)$/.exec(location.pathname);
const docId = match?.[1];
if (docId === undefined || !DOC_ID_RE.test(docId)) {
  location.replace(`/d/${newDocId()}`);
} else {
  const root = document.getElementById('weft-app');
  if (root === null) throw new Error('index.html has no #weft-app root');
  createRoot(root).render(
    <StrictMode>
      <Shell url={WS_URL} docId={docId} />
    </StrictMode>,
  );
}
