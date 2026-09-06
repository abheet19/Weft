// StatusPill.tsx — the honest object (03-UI §4.1): colour + word + count + storage suffix, drawn
// ONLY from the session state the reducer holds and the storage status the store reported. The
// markup is the prototype's pill (a button inside a live region) and its popover (`#pop-pill`: the
// meaning in a sentence, the last error, `Retry now` while degraded); the words come from
// pillCopy. The one clock this component reads ticks once a second while the countdown or the
// popover is showing, for labels only, never for a decision. The popover is the screen's one
// transient: it closes on Escape and on any pointer press outside it.

import { useEffect, useState } from 'react';
import type { SessionState } from '../session/machine.ts';
import { Icon } from './Icons.tsx';
import { pillCopy, type StorageStatus } from './pillCopy.ts';

interface StatusPillProps {
  session: SessionState;
  storage: StorageStatus;
  /** `Retry now`: USER_ONLINE, the reducer's "skip the wait". */
  onRetry: () => void;
}

export function StatusPill({ session, storage, onRetry }: StatusPillProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (session.s !== 'degraded' && !open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session, open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || e.target.closest('.pop, .pill') === null) setOpen(false);
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
  const copy = pillCopy(session, now, storage);
  const suffix = copy.suffix === null ? '' : `· ${copy.suffix}`;
  return (
    <>
      <div className="pill glass" role="status" aria-live="polite" style={{ ['--hue' as string]: `var(--${copy.hue})` }} data-hue={copy.hue}>
        <button type="button" className="in" aria-haspopup="dialog" aria-expanded={open} aria-controls="pop-pill" onClick={() => setOpen((was) => !was)}>
          <span className="dot" aria-hidden="true" />
          <span data-testid="pill-text">{copy.text}</span>
          {copy.suffix !== null && (
            <span className="suffix" data-testid="pill-suffix">
              {suffix}
            </span>
          )}
          <Icon name={copy.icon} />
        </button>
      </div>
      {open && (
        <div className="pop glass" id="pop-pill" role="dialog" aria-label="Sync details">
          <div className="in">
            <h3>
              {copy.text}
              {suffix}
            </h3>
            <p>{copy.body}</p>
            {copy.retry && (
              <button type="button" className="btn primary" onClick={onRetry}>
                <Icon name="sync" />
                Retry now
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
