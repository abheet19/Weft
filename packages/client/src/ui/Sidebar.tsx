// Sidebar.tsx — the right rail of the redesign (S6, 03-UI §4.5), replacing the standalone Sync
// Inspector. One glass panel, three tabs: OUTLINE (the document's headings, click to jump), PEOPLE
// (presence — who is here, their colour, follow), and SYNC (one calm status — Saved / Syncing /
// Offline with the unsent count and last-ack — with the engineer-only readouts, the per-replica state
// vectors and converged hash, folded into a collapsed Diagnostics `<details>`). The Chaos controls the
// tests and the demo share live in Diagnostics too, so nothing the old Inspector proved is lost. It
// reads pure models (`inspectorModel`, `presenceView`) and the session snapshot; it decides nothing
// about the document and, apart from ageing the idle flag, reads no clock.

import { useEffect, useState } from 'react';
import type { ReplicaId } from '@weft/crdt';
import type { Session } from '../session/open.ts';
import type { RunnerSnapshot } from '../session/runner.ts';
import { inspectorModel, type Lane } from '../inspector/model.ts';
import { initials, presenceView } from '../presence/awareness.ts';
import { hueVar } from '../presence/colors.ts';
import { Icon } from './Icons.tsx';

/** One heading in the outline: its level (1–3), text, and the PM position to jump to. */
export interface OutlineItem {
  readonly level: number;
  readonly text: string;
  readonly pos: number;
}

interface SidebarProps {
  self: { replica: ReplicaId; name: string; color: number };
  snapshot: RunnerSnapshot;
  session: Session;
  userOffline: boolean;
  connected: boolean;
  outline: readonly OutlineItem[];
  onJump: (pos: number) => void;
  follow: ReplicaId | null;
  onFollow: (replica: ReplicaId) => void;
  historyPanel?: React.ReactNode;
}

type Tab = 'outline' | 'people' | 'sync';

/** A fixed, valid replica id for the demo's stubbed divergent peer — never authored under, so it can never be a real replica. */
const PHANTOM = 'zzzzzzzzzzzzz' as ReplicaId;

/** A short, readable form of a 64-hex hash; the full value is the element's title. */
function shortHash(hash: string | null): string {
  return hash === null ? '⋯' : `#${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

/** The one calm sync line: what the pill says, said once more in the rail with the honest counts. */
function syncStatus(session: RunnerSnapshot['session'], unacked: number): { title: string; sub: string; kind: 'ok' | 'sync' | 'bad' } {
  switch (session.s) {
    case 'live':
      return unacked > 0 ? { title: 'Saving…', sub: `${unacked} change${unacked === 1 ? '' : 's'} not yet acknowledged`, kind: 'sync' } : { title: 'Saved', sub: 'All changes synced to everyone', kind: 'ok' };
    case 'syncing':
      return { title: 'Catching up', sub: 'Receiving the document from the server', kind: 'sync' };
    case 'offline':
      return { title: 'Offline', sub: `${unacked} change${unacked === 1 ? '' : 's'} saved on this device`, kind: 'bad' };
    case 'connecting':
    case 'degraded':
      return { title: 'Connecting…', sub: 'Reaching the server', kind: 'sync' };
    default:
      return { title: 'Can’t connect', sub: 'Editing still works and is saved locally', kind: 'bad' };
  }
}

export function Sidebar({ self, snapshot, session, userOffline, connected, outline, onJump, follow, onFollow, historyPanel }: SidebarProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('outline');
  const [now, setNow] = useState(() => Date.now());
  const [dropN, setDropN] = useState(3);
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const model = inspectorModel({ replica: self.replica, name: self.name, color: self.color, sv: snapshot.sv, hash: snapshot.hash }, snapshot.peers, snapshot.diverged, now);
  const footIcon = model.footer.kind === 'ok' ? 'check' : model.footer.kind === 'sync' ? 'sync' : 'alert';
  const unacked = snapshot.session.s === 'live' || snapshot.session.s === 'offline' ? (snapshot.session as { unacked?: number }).unacked ?? 0 : 0;
  const status = syncStatus(snapshot.session, unacked);
  const view = presenceView(snapshot.peers, connected, now);

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

  return (
    <aside className="rail glass" aria-label="Document sidebar">
      <div className="railtabs" role="tablist">
        <button type="button" role="tab" className={`railtab${tab === 'outline' ? ' on' : ''}`} aria-selected={tab === 'outline'} onClick={() => setTab('outline')}>
          <Icon name="outline" />
          Outline
        </button>
        <button type="button" role="tab" className={`railtab${tab === 'people' ? ' on' : ''}`} aria-selected={tab === 'people'} onClick={() => setTab('people')}>
          <Icon name="users" />
          People
        </button>
        <button type="button" role="tab" className={`railtab${tab === 'sync' ? ' on' : ''}`} aria-selected={tab === 'sync'} onClick={() => setTab('sync')}>
          <Icon name="pulse" />
          Sync
        </button>
      </div>

      {tab === 'outline' && (
        <div className="railbody" role="tabpanel" aria-label="Outline">
          <p className="railhead">On this page</p>
          {outline.length === 0 ? (
            <p className="rail-empty">No headings yet</p>
          ) : (
            <nav className="ol">
              {outline.map((h, i) => (
                <button type="button" key={`${h.pos}-${i}`} className={`ol-a lvl${h.level}`} onClick={() => onJump(h.pos)}>
                  {h.text === '' ? 'Untitled' : h.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}

      {tab === 'people' && (
        <div className="railbody" role="tabpanel" aria-label="People">
          <p className="railhead">{view.kind === 'peers' ? `${view.peers.length + 1} here now` : view.kind === 'alone' ? 'Only you' : 'Peers unknown'}</p>
          <div className="plist">
            <div className="prow">
              <span className="pdot live" style={{ ['--hue' as string]: hueVar(self.color) }}>
                {initials(self.name)}
              </span>
              <div className="pmeta">
                <b>{self.name} (you)</b>
                <span>this device</span>
              </div>
            </div>
            {view.kind === 'peers' &&
              view.peers.map((p) => (
                <div className="prow" key={p.replica}>
                  <span className={`pdot${p.idle ? '' : ' live'}`} style={{ ['--hue' as string]: hueVar(p.color) }}>
                    {initials(p.name)}
                  </span>
                  <div className="pmeta">
                    <b>{p.name}</b>
                    <span>replica {p.replica.slice(0, 6)}</span>
                  </div>
                  <button type="button" className={`btn${follow === p.replica ? ' armed' : ''}`} onClick={() => onFollow(p.replica)}>
                    <Icon name="eye" />
                    {follow === p.replica ? 'Following' : 'Follow'}
                  </button>
                </div>
              ))}
          </div>
          {view.kind === 'unknown' && <p className="rail-empty">The server is the only source of presence and it is unreachable.</p>}
        </div>
      )}

      {tab === 'sync' && (
        <div className="railbody" role="tabpanel" aria-label="Sync">
          <div className="syncbig" style={{ ['--hue' as string]: `var(--${status.kind})` }}>
            <span className="ring">
              <Icon name={status.kind === 'ok' ? 'check' : status.kind === 'sync' ? 'sync' : 'alert'} />
            </span>
            <div>
              <b>{status.title}</b>
              <span>{status.sub}</span>
            </div>
          </div>
          <div className="metrics">
            <div className="metric">
              <span className="lab">Connection</span>
              <span className={`val${connected ? ' ok' : ''}`}>{connected ? 'online' : 'offline'}</span>
            </div>
            <div className="metric">
              <span className="lab">Your unsent edits</span>
              <span className="val">{unacked}</span>
            </div>
          </div>

          {/* Work offline is a user choice, not engineer chaos, so it sits in the tab body; the CRDT-proof
              readouts and the fault-injection chaos below are folded into Diagnostics. */}
          <div className="row sync-offline">
            <span>
              Work offline<span className="desc">Closes the socket; edits stay saved on this device</span>
            </span>
            <button type="button" className="switch" role="switch" aria-checked={userOffline} aria-label="Simulate offline" onClick={() => session.setUserOffline(!userOffline)} />
          </div>

          <details className="diag">
            <summary>
              <Icon name="chevr" />
              Diagnostics
            </summary>
            <div className="diag-body">
              <p className="diag-note">The convergence proof, for the curious — and the chaos controls the tests share.</p>
              <div className="insp-foot" role="status" aria-live="polite" style={{ ['--hue' as string]: `var(--${model.footer.kind})` }} data-testid="inspector-footer">
                <Icon name={footIcon} />
                <span>{model.footer.text}</span>
              </div>
              {model.lanes.map((lane) => (
                <LaneRow key={lane.self ? 'self' : lane.replica} lane={lane} />
              ))}

              <div className="chaos">
                <div className="row">
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
                <div className="row">
                  <span>
                    Delay 2 s<span className="desc">Every outbound message</span>
                  </span>
                  <button type="button" className="switch" role="switch" aria-checked={delayed} aria-label="Delay 2 s" onClick={toggleDelay} />
                </div>
                <div className="row">
                  <span>
                    Force divergence<span className="desc">Demo the tripwire: a peer with a bad hash</span>
                  </span>
                  <button type="button" className="btn" onClick={forceDivergence} disabled={snapshot.hash === null}>
                    Trip
                  </button>
                </div>
              </div>
            </div>
          </details>
        </div>
      )}

      {/* Time-travel (§4.6) is not a tab — it swaps the whole editor for a read-only replay, so it sits
          below the tabs, always reachable, whichever tab is open. */}
      {historyPanel !== undefined && <div className="rail-history">{historyPanel}</div>}
    </aside>
  );
}

function LaneRow({ lane }: { lane: Lane }): React.JSX.Element {
  const hashClass = lane.diverged ? 'bad' : lane.hash !== null ? 'ok' : '';
  return (
    <div className={`lane${lane.stale ? ' stale' : ''}`} style={{ ['--hue' as string]: hueVar(lane.color) }} data-testid={`lane-${lane.self ? 'self' : lane.replica}`}>
      <div className="lane-h">
        <span className="lane-id mono">{lane.replica.slice(0, 4)}</span>
        <span className="lane-name">
          {lane.self ? 'You' : lane.name}
          {lane.stale && <span className="lane-meta"> · idle</span>}
        </span>
        <span className={`lane-hash mono ${hashClass}`} title={lane.hash ?? 'no hash yet'}>
          {shortHash(lane.hash)}
        </span>
      </div>
      <div className="chips-l">state vector</div>
      <div className="chips">
        {lane.chips.length === 0 ? <span className="chip">—</span> : lane.chips.map((c) => (
          <span className="chip" key={c.replica}>
            {c.replica.slice(0, 4)}:{c.seq}
          </span>
        ))}
      </div>
    </div>
  );
}
