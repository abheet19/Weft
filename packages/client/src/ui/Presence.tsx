// Presence.tsx — the avatar stack of 03-UI §4.2, ported from the prototype's `#pres-btn` / `.stack`
// and its popover. It is the honest-degradation object made visual: connected and alone shows a
// single self avatar labelled `Only you`; connected with peers shows the stack and a `+N` overflow;
// DISCONNECTED shows a slashed ghost and `Peers unknown`, never "Only you" — the server is the one
// source of presence and it is unreachable. The three states come from the pure `presenceView`, so
// this component only maps a value to markup. Clicking a peer in the popover starts follow mode. It
// holds no timers of its own beyond the tick that ages the idle fade, and decides nothing about the
// document.

import { useEffect, useState } from 'react';
import type { ReplicaId } from '@weft/crdt';
import { initials, presenceView, type PeerAvatar, type PeerTable } from '../presence/awareness.ts';
import { hueVar } from '../presence/colors.ts';
import { Icon } from './Icons.tsx';

interface Self {
  readonly replica: ReplicaId;
  readonly name: string;
  readonly color: number;
}

interface PresenceProps {
  self: Self;
  peers: PeerTable;
  /** True while the socket is open; the switch between "alone" and "unknown". */
  connected: boolean;
  follow: ReplicaId | null;
  onFollow: (replica: ReplicaId) => void;
}

/** Up to four peer avatars in the stack; the rest collapse into a `+N` counter. */
const MAX_AVATARS = 4;

function Avatar({ name, color, idle, ghost }: { name?: string; color?: number; idle?: boolean; ghost?: boolean }): React.JSX.Element {
  if (ghost) {
    return (
      <span className="av ghost" role="img" aria-label="Peers unknown">
        <Icon name="userslash" />
      </span>
    );
  }
  return (
    <span className={`av${idle ? ' idle' : ''}`} role="img" aria-label={name} title={name} style={{ ['--hue' as string]: hueVar(color ?? 0) }}>
      {initials(name ?? '?')}
    </span>
  );
}

export function Presence({ self, peers, connected, follow, onFollow }: PresenceProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || e.target.closest('.pop-pres, .pres') === null) setOpen(false);
    };
    const escape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const view = presenceView(peers, connected, now);
  const shown: readonly PeerAvatar[] = view.kind === 'peers' ? view.peers.slice(0, MAX_AVATARS) : [];
  const overflow = view.kind === 'peers' ? view.peers.length - shown.length : 0;
  const label = view.kind === 'alone' ? 'Only you' : view.kind === 'unknown' ? 'Peers unknown' : '';
  // The top-bar avatars use visible initials. Include each visible string in the button name so
  // voice-control and screen-reader users identify the same target as a sighted user.
  const avatarText = [initials(self.name), ...shown.map((peer) => initials(peer.name)), ...(overflow > 0 ? [`+${overflow}`] : [])].join(', ');
  const buttonLabel = `${avatarText}. ${view.kind === 'peers' ? `Who is here: you and ${view.peers.length} more` : label}`;

  return (
    <div className="pres-wrap">
      <button type="button" className="gbtn pres" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((was) => !was)} aria-label={buttonLabel}>
        <span className="stack" data-testid="presence-stack" aria-hidden="true">
          <Avatar name={self.name} color={self.color} />
          {view.kind === 'unknown' && <Avatar ghost />}
          {shown.map((p) => (
            <Avatar key={p.replica} name={p.name} color={p.color} idle={p.idle} />
          ))}
          {overflow > 0 && <span className="av more">+{overflow}</span>}
        </span>
        {label !== '' && (
          <span className="pres-label" data-testid="presence-label">
            {label}
          </span>
        )}
      </button>
      {open && (
        <div className="pop pop-pres glass" role="dialog" aria-label="Who is here">
          <div className="in">
            <div className="person">
              <Avatar name={self.name} color={self.color} />
              <div className="who">
                <b>You</b>
                <span>
                  replica {self.replica.slice(0, 6)} · this device
                </span>
              </div>
            </div>
            {view.kind === 'peers' &&
              view.peers.map((p) => (
                <div className="person" key={p.replica}>
                  <Avatar name={p.name} color={p.color} idle={p.idle} />
                  <div className="who">
                    <b>{p.name}</b>
                    <span>replica {p.replica.slice(0, 6)}</span>
                  </div>
                  <button type="button" className={`btn${follow === p.replica ? ' armed' : ''}`} onClick={() => onFollow(p.replica)}>
                    <Icon name="eye" />
                    {follow === p.replica ? 'Following' : 'Follow'}
                  </button>
                </div>
              ))}
            {view.kind === 'alone' && (
              <div className="person">
                <div className="who">
                  <span>No one else is here. Anyone with the URL can edit.</span>
                </div>
              </div>
            )}
            {view.kind === 'unknown' && (
              <div className="person">
                <Avatar ghost />
                <div className="who">
                  <b>Peers unknown</b>
                  <span>The server is the only source of presence and it is unreachable.</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
