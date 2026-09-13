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
// The redesign (App.tsx, NavRail.tsx) adds a `screen` prop: 'editor' is this file's original layout,
// unchanged; 'history' and 'settings' swap the `<main>` body for HistoryScreen/SettingsScreen while
// keeping the SAME live session, top bar and status pill — switching screens costs nothing on the
// wire. It also derives a live title from the document's own content (`docTitle.ts`, no schema
// change) and persists the theme/accent/reduce-transparency choice and this document's entry in the
// local Documents registry (`uiPrefs.ts`, `recents.ts`) — both disposable presentation state behind
// `browserStorage.ts`'s guarded `localStorage`, never the durable per-document store.

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
import type { Screen } from './App.tsx';
import { safeLocalStorage } from './browserStorage.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { paletteCommands } from './commands.ts';
import { Editor } from './Editor.tsx';
import { errorCard, NOTICE, type Failure } from './copy.ts';
import { History } from './History.tsx';
import { HistoryDoc } from './HistoryDoc.tsx';
import { HistoryScreen } from './HistoryScreen.tsx';
import { Icon } from './Icons.tsx';
import { Notice, type NoticeModel } from './Notice.tsx';
import { Page, type PageMode } from './Page.tsx';
import { Presence } from './Presence.tsx';
import { touchRecent } from './recents.ts';
import { Sidebar, type OutlineItem } from './Sidebar.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { StatusPill } from './StatusPill.tsx';
import type { Accent, ThemeChoice } from './uiPrefs.ts';
import { useSession } from './useSession.ts';

interface ShellProps {
  url: string;
  docId: string;
  /** Which of the app shell's four destinations is showing (App.tsx owns this); defaults to the
      original single-screen behaviour so every existing test keeps working unchanged. */
  screen?: Screen;
  /** Lets a control inside Shell (the ⌘K "Navigate" group) ask App to switch screens. A no-op default so Shell keeps working when mounted standalone, as the test suite does. */
  onNavigate?: (screen: Screen) => void;
  /** The per-device look choices, now OWNED BY APP (App.tsx) so the nav rail's theme toggle — mounted
      on every screen, including Documents where Shell is not — shares one source of truth with Shell's
      Settings and ⌘K. App applies the `data-*` flags and persists them; Shell only reads and sets. */
  theme: ThemeChoice;
  flat: boolean;
  accent: Accent;
  onTheme: (theme: ThemeChoice) => void;
  onFlat: (flat: boolean) => void;
  onAccent: (accent: Accent) => void;
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

export function Shell({ url, docId, screen = 'editor', onNavigate, theme, flat, accent, onTheme, onFlat, onAccent }: ShellProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [notices, setNotices] = useState<readonly NoticeModel[]>([]);
  const [railOpen, setRailOpen] = useState(true);
  const [follow, setFollow] = useState<ReplicaId | null>(null);
  const [outline, setOutline] = useState<readonly OutlineItem[]>([]);
  /** The time-travel slider position; null when live (not scrubbing). While scrubbing the page is read-only (03-UI §4.6). */
  const [historyPos, setHistoryPos] = useState<number | null>(null);
  const [showAuthors, setShowAuthors] = useState(false);
  /** The recents registry lives here (`recents.ts`); the look prefs (theme/flat/accent) are owned by App now. */
  const storage = useRef(safeLocalStorage());
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  /** The document's own derived title (`docTitle.ts`) — never stored, re-read from the live editor on every change. */
  const [title, setTitle] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Where the persistent toolbar portals to (S6): a sibling of `.page`, not nested inside its padded
      paper, so the toolbar is a bar ABOVE the document rather than content floating inside it. Editor
      still owns the live `view`/`state` the toolbar needs; only its DOM position moves. */
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  // App (App.tsx) owns applying the data-* flags and persisting these; Shell just forwards the setters
  // to Settings and the ⌘K palette under the names those call sites already use.
  const setTheme = onTheme;
  const setFlat = onFlat;
  const setAccent = onAccent;
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
  const goto = useCallback((next: Screen) => onNavigate?.(next), [onNavigate]);
  /** Editing the title is renaming the document's first heading — Weft has no separate title op (the
      artifact's editable title, given honest semantics). Clicking the title field focuses it. */
  const focusTitle = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).scrollIntoView());
    view.focus();
  }, []);

  // The ⌘K palette's rows (03-UI §4.8), built once the session is ready so every value (theme, name,
  // On/Off, the state vector to copy) is current. Every leaf is a control that already exists here.
  const commands =
    ready === null
      ? null
      : paletteCommands({
          goDocuments: () => goto('documents'),
          goEditor: () => goto('editor'),
          goHistory: () => goto('history'),
          goSettings: () => goto('settings'),
          renameViaHeading: () => {
            const view = viewRef.current;
            if (view === null) return;
            view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).scrollIntoView());
            view.focus();
          },
          newDocument: () => location.assign(`/d/${newDocId()}`),
          themeLabel: theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System',
          toggleTheme: () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? null : 'light'),
          transparencyOn: flat,
          toggleTransparency: () => setFlat(!flat),
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

  const topbar = (
    <header className="topbar glass">
      {onNavigate !== undefined ? (
        <button type="button" className="gbtn back" onClick={() => goto('documents')} aria-label="Back to Documents">
          <Icon name="chevl" />
          <span>Documents</span>
        </button>
      ) : (
        <a className="brand inner" href="/" aria-label="Weft home">
          <img className="brand-mark" src="/brand/mark.svg" alt="" />
          <span>Weft</span>
        </a>
      )}
      {screen === 'editor' && ready !== null ? (
        <button type="button" className="title titlefield" onClick={focusTitle} title="Edit the document title (its first heading)">
          <span id="title">{title !== null && title.trim() !== '' ? title : 'Untitled'}</span>
          <span className="docid mono">{docId}</span>
        </button>
      ) : (
        <div className="title inner">
          <span id="title">{title !== null && title.trim() !== '' ? title : 'Weft'}</span>
          <span className="docid mono" title="document id">
            {docId}
          </span>
        </div>
      )}
      <span className="grow" />
      {self !== null && ready !== null && <Presence self={self} peers={ready.snapshot.peers} connected={connected} follow={follow} onFollow={onFollow} />}
      {commands !== null && <CommandPalette commands={commands} />}
      {screen === 'editor' && (
        <button type="button" className="gbtn icon" aria-label="Toggle sidebar" aria-expanded={railOpen} onClick={() => setRailOpen((was) => !was)}>
          <Icon name="panel" />
        </button>
      )}
    </header>
  );

  if (screen === 'settings') {
    return (
      <>
        <div className="ground" aria-hidden="true">
          <div className="blob b1" />
          <div className="blob b2" />
          <div className="blob b3" />
        </div>
        {topbar}
        <main className="shell shell--screen">
          <SettingsScreen
            theme={theme}
            onTheme={setTheme}
            flat={flat}
            onFlat={setFlat}
            accent={accent}
            onAccent={setAccent}
            doc={
              ready === null
                ? null
                : {
                    displayName,
                    onRename: (name) => {
                      setNameOverride(name);
                      ready.session.runner.setName(name);
                    },
                    userOffline,
                    onSetUserOffline: (offline) => ready.session.setUserOffline(offline),
                    session: ready.session,
                    snapshot: ready.snapshot,
                  }
            }
          />
        </main>
        <StatusPill session={session} storage={ready === null ? { kind: 'idb' } : ready.storage} onRetry={retry} />
      </>
    );
  }

  if (screen === 'history') {
    return (
      <>
        <div className="ground" aria-hidden="true">
          <div className="blob b1" />
          <div className="blob b2" />
          <div className="blob b3" />
        </div>
        {topbar}
        <main className="shell shell--screen">
          {ready === null ? (
            <div className="screenpage" aria-label="History">
              <h1 className="screenpage-h">History</h1>
              <p className="screenpage-sub">Opening this document…</p>
            </div>
          ) : (
            <HistoryScreen base={ready.session.runner.history().base} ops={ready.session.runner.history().ops} length={historyLength} position={historyPos ?? historyLength} onPosition={(p) => setHistoryPos(p >= historyLength ? null : p)} showAuthors={showAuthors} onShowAuthors={setShowAuthors} />
          )}
        </main>
        <StatusPill session={session} storage={ready === null ? { kind: 'idb' } : ready.storage} onRetry={retry} />
      </>
    );
  }

  return (
    <>
      <div className="ground" aria-hidden="true">
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
      </div>
      {topbar}
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
          {/* This sticky slot reserves the toolbar's measured footprint while IndexedDB opens. The
              portaled controls replace that reserved surface without moving the document below it. */}
          <div className={`toolbar-host${ready === null ? ' toolbar-loading glass' : ''}`} ref={setToolbarSlot} />
          <Page mode={mode} card={failure === null ? null : errorCard(failure)} onRetry={retry} onStartFresh={startFresh}>
            {ready !== null && scrubbing ? (
              <HistoryDoc base={ready.session.runner.history().base} ops={ready.session.runner.history().ops} position={historyPos ?? historyLength} showAuthors={showAuthors} />
            ) : (
              ready !== null && (
                <Editor
                  host={ready.host}
                  onFault={onFault}
                  peers={ready.snapshot.peers}
                  reportCursor={reportCursor}
                  follow={follow}
                  onExitFollow={() => setFollow(null)}
                  onView={(view) => (viewRef.current = view)}
                  onOutline={setOutline}
                  onTitle={(next, words) => {
                    setTitle(next);
                    touchRecent(storage.current, { id: docId, title: next, words }, Date.now());
                  }}
                  toolbarSlot={toolbarSlot}
                />
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

