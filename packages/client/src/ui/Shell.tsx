// Shell.tsx — the one screen of 03-UI §3, ported from the prototype's markup: L0 ground, L2 top bar
// (brand, title, document id, the presence avatar stack, a rail toggle), the L1 editor column with
// the inline notices above the page, the L1 side rail (Sync Inspector + Chaos), and the L2 status
// pill. S5 moves the Simulate-offline switch off the top bar into the Inspector's Chaos panel (where
// the design puts it), adds presence and follow mode, and raises the divergence tripwire: when a peer
// disagrees at an equal state vector (I13), a red alert appears above the editor that carries only an
// explicit "Copy report & dismiss" action — no casual dismiss cross — so it cannot be waved away. It
// decides nothing about the document.
// S8 adds the ⌘K command palette (03-UI §4.8): the shell owns the leaf actions each palette command
// runs — theme and reduce-transparency (a `data-*` flag on the document element, per 03-UI §2.2),
// New document (the router), Rename via heading (focus the editor at the title), Set my name / Follow
// / the History and Debug controls — and hands them to `paletteCommands`. Every one is a control the
// top bar, the rail or the keyboard already exposes; the palette invents nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { ReplicaId } from '@weft/crdt';
import type { PresenceState } from '@weft/protocol';
import { newDocId } from '../identity.ts';
import { isDiverged } from '../inspector/divergence.ts';
import { colorOf } from '../presence/colors.ts';
import { initialSession } from '../session/machine.ts';
import type { BindingFault } from '../binding/plugin.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { paletteCommands } from './commands.ts';
import { Editor } from './Editor.tsx';
import { errorCard, NOTICE, type Failure } from './copy.ts';
import { History } from './History.tsx';
import { HistoryDoc } from './HistoryDoc.tsx';
import { Icon, IconSprite } from './Icons.tsx';
import { Notice, type NoticeModel } from './Notice.tsx';
import { Page, type PageMode } from './Page.tsx';
import { Presence } from './Presence.tsx';
import { Sidebar, type OutlineItem } from './Sidebar.tsx';
import { StatusPill } from './StatusPill.tsx';
import { useSession } from './useSession.ts';

interface ShellProps {
  url: string;
  docId: string;
}

/** A fault in one sentence for the notice; the full structure goes to the console. */
function describeFault(fault: BindingFault): string {
  switch (fault.kind) {
    case 'mirror':
      return 'The editor and the document disagreed (I7). The editor was reset to the saved document; the report is in the console.';
    case 'local':
      return `Your last edit could not be recorded: ${fault.error instanceof Error ? fault.error.message : String(fault.error)}`;
    case 'remote':
      return `A change from a peer could not be shown: ${fault.error instanceof Error ? fault.error.message : String(fault.error)}`;
  }
}

/** The plain-text divergence report the alert copies (03-UI §4.7). Names each peer and both hashes — a bug record an auditor can act on. */
function divergenceReport(docId: string, diverged: ReadonlyMap<ReplicaId, { peerHash: string; mine: string }>): string {
  const lines = [...diverged].map(([replica, { peerHash, mine }]) => `peer ${replica}: ${peerHash}\n  mine: ${mine}`);
  return `Weft divergence report\ndoc ${docId}\n${lines.join('\n')}`;
}

export function Shell({ url, docId }: ShellProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [notices, setNotices] = useState<readonly NoticeModel[]>([]);
  const [railOpen, setRailOpen] = useState(true);
  const [follow, setFollow] = useState<ReplicaId | null>(null);
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  /** The time-travel slider position; null when live (not scrubbing). While scrubbing the page is read-only (03-UI §4.6). */
  const [historyPos, setHistoryPos] = useState<number | null>(null);
  const [showAuthors, setShowAuthors] = useState(false);
  /** ⌘K controls (03-UI §4.8/§2.2): an explicit theme and reduce-transparency choice, since neither `prefers-*` is Baseline; a display-name override; and the live editor view so "Rename via heading" can focus the title. */
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const [flat, setFlat] = useState(false);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (theme !== null) document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (flat) document.documentElement.dataset.flat = '1';
    else delete document.documentElement.dataset.flat;
  }, [flat]);
  /** One notice per id: a newer answer replaces the older question. */
  const show = useCallback((notice: NoticeModel) => setNotices((was) => [...was.filter((n) => n.id !== notice.id), notice]), []);
  const dismiss = useCallback((id: string) => setNotices((was) => was.filter((n) => n.id !== id)), []);

  const state = useSession(url, docId, attempt, {
    onMerged: (n) => show({ id: 'merged', hue: 'ok', icon: 'check', text: NOTICE.merged(n), role: 'status', action: { label: NOTICE.showInInspector, run: () => setRailOpen(true) } }),
  });
  const ready = state.phase === 'ready' ? state : null;

  const onFault = useCallback(
    (fault: BindingFault): void => {
      console.error('weft binding fault', fault);
      show({ id: `fault-${Date.now()}`, hue: 'bad', icon: 'alert', text: describeFault(fault), role: 'status' });
    },
    [show],
  );

  const seeded = ready?.session.seeded ?? null;
  useEffect(() => {
    if (seeded !== null) show({ id: 'fresh', hue: 'ok', icon: 'db', text: NOTICE.startedFresh(seeded.from), role: 'status' });
  }, [seeded, show]);

  const runner = ready?.session.runner ?? null;
  const reportCursor = useCallback((cursor: PresenceState['cursor']) => runner?.setCursor(cursor), [runner]);
  const onFollow = useCallback((replica: ReplicaId) => setFollow((was) => (was === replica ? null : replica)), []);
  /** Outline jump: move the caret to the heading's start and scroll it into view. */
  const onJump = useCallback((pos: number) => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)))).scrollIntoView());
    view.focus();
  }, []);

  const session = ready === null ? initialSession : ready.snapshot.session;
  const failure: Failure | null = state.phase === 'error' ? { kind: 'load', docId, error: state.error } : ready !== null && session.s === 'failed' ? { kind: 'session', state: session, supported: ready.snapshot.supported } : null;
  const mode: PageMode = state.phase === 'loading' ? 'loading' : failure !== null ? 'error' : ready !== null && ready.empty ? 'empty' : 'doc';
  const userOffline = session.s === 'offline' && session.reason === 'user';
  const connected = session.s === 'live' || session.s === 'syncing';
  const me = ready?.session.me ?? null;
  const displayName = nameOverride ?? (me === null ? '' : me.slice(0, 6));
  const self = me === null ? null : { replica: me, name: displayName, color: colorOf(me) };
  const diverged = ready !== null && isDiverged(ready.snapshot.diverged);
  /** Time travel: the op count is the slider's max; scrubbing (position off the end) swaps the live editor for a read-only replay. */
  const historyLength = ready?.snapshot.historyLength ?? 0;
  const scrubbing = ready !== null && historyPos !== null && historyPos < historyLength;
  const historyPanel = ready !== null ? <History length={historyLength} position={historyPos ?? historyLength} onPosition={(p) => setHistoryPos(p >= historyLength ? null : p)} showAuthors={showAuthors} onShowAuthors={setShowAuthors} /> : null;

  /** `Start fresh (keeps a copy)`: a new document id; the text travels in sessionStorage, the old database stays. */
  const startFresh = (): void => {
    const fresh = newDocId();
    ready?.session.startFresh(fresh);
    location.assign(`/d/${fresh}`);
  };
  /** `Retry`: a failed load is opened again; a failed session is asked to reconnect (USER_ONLINE). */
  const retry = (): void => {
    if (state.phase === 'error') setAttempt((n) => n + 1);
    else ready?.session.runner.dispatch({ e: 'USER_ONLINE' });
  };
  const dismissDivergence = (): void => {
    if (ready === null) return;
    void navigator.clipboard?.writeText(divergenceReport(docId, ready.snapshot.diverged)).catch(() => undefined);
    ready.session.runner.dismissDivergence();
  };

  // The ⌘K palette's rows (03-UI §4.8), built once the session is ready so every value (theme, name,
  // On/Off, the state vector to copy) is current. Every leaf is a control that already exists here.
  const commands =
    ready === null
      ? null
      : paletteCommands({
          renameViaHeading: () => {
            const view = viewRef.current;
            if (view === null) return;
            view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).scrollIntoView());
            view.focus();
          },
          newDocument: () => location.assign(`/d/${newDocId()}`),
          themeLabel: theme === 'light' ? 'Light' : 'Dark',
          toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
          transparencyOn: flat,
          toggleTransparency: () => setFlat((f) => !f),
          myName: displayName,
          setMyName: () => {
            const next = window.prompt('Your name', displayName)?.trim();
            if (next !== undefined && next !== '') {
              setNameOverride(next);
              ready.session.runner.setName(next);
            }
          },
          followPeer: () => {
            const first = [...ready.snapshot.peers.keys()][0];
            if (first !== undefined) onFollow(first);
          },
          timeTravel: () => setRailOpen(true),
          authorsOn: showAuthors,
          toggleAuthors: () => setShowAuthors((s) => !s),
          offlineOn: userOffline,
          simulateOffline: () => ready.session.setUserOffline(!userOffline),
          dropN: 3,
          dropMessages: () => {
            setRailOpen(true);
            ready.session.runner.dropNext(3);
          },
          toggleInspector: () => setRailOpen((o) => !o),
          copyStateVector: () => void navigator.clipboard?.writeText(JSON.stringify(ready.snapshot.sv)).catch(() => undefined),
        });

  return (
    <>
      <IconSprite />
      <div className="ground" aria-hidden="true">
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
      </div>
      <header className="topbar glass">
        <a className="brand inner" href="/" aria-label="Weft home">
          <Icon name="weft" />
          <span>Weft</span>
        </a>
        <div className="title inner">
          <span id="title">Weft</span>
          <span className="docid mono" title="document id">
            {docId}
          </span>
        </div>
        <span className="grow" />
        {self !== null && ready !== null && <Presence self={self} peers={ready.snapshot.peers} connected={connected} follow={follow} onFollow={onFollow} />}
        {commands !== null && <CommandPalette commands={commands} />}
        <button type="button" className="gbtn icon" aria-label="Toggle sidebar" aria-expanded={railOpen} onClick={() => setRailOpen((was) => !was)}>
          <Icon name="panel" />
        </button>
      </header>
      <main className={`shell${railOpen ? '' : ' rail-closed'}`}>
        <div className="col">
          {diverged && ready !== null && (
            <div className="notice in" role="alert" aria-live="assertive" style={{ ['--hue' as string]: 'var(--bad)' }} data-testid="diverged">
              <Icon name="alert" />
              <span className="grow">Replicas disagree (hash mismatch). Nothing was lost; this is a bug and has been logged locally.</span>
              <button type="button" className="btn" onClick={dismissDivergence}>
                Copy report &amp; dismiss
              </button>
            </div>
          )}
          {notices.map((notice) => (
            <Notice key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />
          ))}
          <Page mode={mode} card={failure === null ? null : errorCard(failure)} onRetry={retry} onStartFresh={startFresh}>
            {ready !== null && scrubbing ? (
              <HistoryDoc base={ready.session.runner.history().base} ops={ready.session.runner.history().ops} position={historyPos ?? historyLength} showAuthors={showAuthors} />
            ) : (
              ready !== null && (
                <Editor host={ready.host} onFault={onFault} peers={ready.snapshot.peers} reportCursor={reportCursor} follow={follow} onExitFollow={() => setFollow(null)} onView={(view) => (viewRef.current = view)} onOutline={setOutline} />
              )
            )}
          </Page>
        </div>
        {railOpen && ready !== null && self !== null && (
          <Sidebar self={self} snapshot={ready.snapshot} session={ready.session} userOffline={userOffline} connected={connected} outline={outline} onJump={onJump} follow={follow} onFollow={onFollow} historyPanel={historyPanel} />
        )}
      </main>
      <StatusPill session={session} storage={ready === null ? { kind: 'idb' } : ready.storage} onRetry={retry} />
    </>
  );
}
