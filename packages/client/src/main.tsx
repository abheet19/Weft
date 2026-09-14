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
import { App } from './ui/App.tsx';
import './ui/tokens.css';
import './ui/shell.css';

const WS_URL: string = import.meta.env.VITE_WEFT_WS ?? 'ws://127.0.0.1:4200';

const match = /^\/d\/([^/]+)$/.exec(location.pathname);
let docId = match?.[1];
// A /d/<id> deep-link opens straight into that document's editor; the bare home
// ("/") lands on the Documents library — the redesign artifact's entry screen.
// A fresh doc id is still minted so the Editor tab / "New document" have one ready.
const initialScreen: 'documents' | 'editor' = docId !== undefined && DOC_ID_RE.test(docId) ? 'editor' : 'documents';
if (docId === undefined || !DOC_ID_RE.test(docId)) {
  docId = newDocId();
}

const root = document.getElementById('weft-app');
if (root === null) throw new Error('index.html has no #weft-app root');
createRoot(root).render(
  <StrictMode>
    <App url={WS_URL} docId={docId} initialScreen={initialScreen} />
  </StrictMode>,
);
