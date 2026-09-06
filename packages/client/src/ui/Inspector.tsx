// Inspector.tsx — the Sync Inspector side rail of 03-UI §4.5, ported from the prototype's `.panel`
// / `.lane` / `.insp-foot` markup and CSS. It is the demo's proof panel: one lane per replica (this
// device first) with its state-vector chips and content hash, and a footer computed from those same
// live facts — `A ≡ B ✓ converged` / `A ≠ B · N in flight` / `A ≠ B · hashes differ`. All of that
// comes from the pure `inspectorModel`, so this component only maps a value to markup. The Chaos
// panel below drives the runner's real controls — Simulate offline (closes the socket), Drop next N
// (opens a seq gap the client repairs), Delay (holds outbound frames) — the ones the tests and the
// demo share, plus a demo trigger for the divergence tripwire (a stubbed peer hash; it never touches
// the document). It reads a clock only to age the idle (stale) flag and decides nothing about the doc.

import { useEffect, useState } from 'react';
import type { ReplicaId } from '@weft/crdt';
import type { Session } from '../session/open.ts';
import type { RunnerSnapshot } from '../session/runner.ts';
import { hueVar } from '../presence/colors.ts';
import { inspectorModel, type Lane } from '../inspector/model.ts';
import { Icon } from './Icons.tsx';

interface InspectorProps {
  self: { replica: ReplicaId; name: string; color: number };
  snapshot: RunnerSnapshot;
  session: Session;
  userOffline: boolean;
  /** The History / time-travel panel (03-UI §4.6), rendered between the Inspector and Chaos panels. The shell owns it because scrubbing swaps the editor in the column; the rail only hosts its controls. */
  historyPanel?: React.ReactNode;
}

/** A short, readable form of a 64-hex hash for a lane; the full value is the element's title. */
function shortHash(hash: string | null): string {
  return hash === null ? '⋯' : `#${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

/** A fixed, valid replica id for the demo's stubbed divergent peer — never authored under, so it can never be a real replica. */
const PHANTOM = 'zzzzzzzzzzzzz' as ReplicaId;

function LaneRow({ lane }: { lane: Lane }): React.JSX.Element {
  const hue = hueVar(lane.color);
  const hashClass = lane.diverged ? 'bad' : lane.hash !== null ? 'ok' : '';
  return (
    <div className={`lane${lane.stale ? ' stale' : ''}`} style={{ ['--hue' as string]: hue }} data-testid={`lane-${lane.self ? 'self' : lane.replica}`}>
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
        {lane.chips.length === 0 ? (
          <span className="chip">—</span>
        ) : (
          lane.chips.map((c) => (
            <span className="chip" key={c.replica}>
              {c.replica.slice(0, 4)}:{c.seq}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

export function Inspector({ self, snapshot, session, userOffline, historyPanel }: InspectorProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [dropN, setDropN] = useState(3);
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const model = inspectorModel({ replica: self.replica, name: self.name, color: self.color, sv: snapshot.sv, hash: snapshot.hash }, snapshot.peers, snapshot.diverged, now);
  const footIcon = model.footer.kind === 'ok' ? 'check' : model.footer.kind === 'sync' ? 'sync' : 'alert';

  const toggleDelay = (): void => {
    const next = !delayed;
    setDelayed(next);
    session.runner.setDelay(next ? 2_000 : 0);
  };
  // Demo/e2e: inject a peer whose hash differs at our current state vector, tripping I13 honestly (a
  // stubbed hash, sanctioned by LLD §8 S5). Disabled until we have a hash of our own to differ from.
  const forceDivergence = (): void => {
    if (snapshot.hash === null) return;
    const bad = (snapshot.hash[0] === 'f' ? '0' : 'f') + snapshot.hash.slice(1);
    session.runner.receivePresence(PHANTOM, { name: 'phantom', color: 2, hash: bad, sv: snapshot.sv });
  };

  return (
    <aside className="rail" aria-label="Sync Inspector">
      <section className="panel" aria-labelledby="insp-h">
        <div className="panel-h">
          <h2 id="insp-h">Sync Inspector</h2>
          <span className="sub">from live messages</span>
        </div>
        <div>
          {model.lanes.map((lane) => (
            <LaneRow key={lane.self ? 'self' : lane.replica} lane={lane} />
          ))}
        </div>
        <div className="insp-foot" role="status" aria-live="polite" style={{ ['--hue' as string]: `var(--${model.footer.kind})` }} data-testid="inspector-footer">
          <Icon name={footIcon} />
          <span>{model.footer.text}</span>
        </div>
      </section>

      {historyPanel}

      <section className="panel" aria-labelledby="chaos-h">
        <div className="panel-h">
          <h2 id="chaos-h">Chaos</h2>
          <span className="sub">shared with the tests</span>
        </div>
        <div className="row">
          <span>
            Simulate offline
            <span className="desc">Closes the socket for real</span>
          </span>
          <button type="button" className="switch" role="switch" aria-checked={userOffline} aria-label="Simulate offline" onClick={() => session.setUserOffline(!userOffline)} />
        </div>
        <div className="row">
          <span>
            Drop next <output className="mono">{dropN}</output> op messages
            <span className="desc">Opens a seq gap the client repairs</span>
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
            Delay 2 s
            <span className="desc">Every outbound message</span>
          </span>
          <button type="button" className="switch" role="switch" aria-checked={delayed} aria-label="Delay 2 s" onClick={toggleDelay} />
        </div>
        <div className="row">
          <span>
            Force divergence
            <span className="desc">Demo the tripwire: a peer with a bad hash</span>
          </span>
          <button type="button" className="btn" onClick={forceDivergence} disabled={snapshot.hash === null}>
            Trip
          </button>
        </div>
      </section>
    </aside>
  );
}
