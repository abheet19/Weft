// Page.tsx — the L1 editor page in its four modes, which are three different things plus the
// ordinary one (03-UI §4.9): `loading` is three skeleton lines and nothing else, `empty` is the
// single ghost line over an editable document, `error` is the opaque card with the actual error
// and two actions, `doc` is the document. The markup is the prototype's `#page`; the ghost is the
// one change — it overlays the live editor instead of replacing it, so an empty document can be
// typed into without a click that first dismisses a placeholder. The card is `role="alert"`
// because a load that failed must be heard, not noticed later.

import { CARD, type CardCopy } from './copy.ts';
import { Icon } from './Icons.tsx';

export type PageMode = 'loading' | 'empty' | 'doc' | 'error';

interface PageProps {
  mode: PageMode;
  /** The error card's words; present exactly when `mode === 'error'`. */
  card: CardCopy | null;
  onRetry: () => void;
  onStartFresh: () => void;
  children: React.ReactNode;
}

export function Page({ mode, card, onRetry, onStartFresh, children }: PageProps): React.JSX.Element {
  return (
    <section className="page" data-mode={mode} aria-label="Document">
      {children}
      <div className="skel" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <p className="ghost" aria-hidden="true">
        {CARD.empty}
      </p>
      {card !== null && (
        <div className="err" role="alert">
          <div className="err-h">
            <Icon name="alert" />
            <span>{card.heading}</span>
          </div>
          <p>{card.body}</p>
          <pre>{card.detail}</pre>
          <div className="err-a">
            <button type="button" className="btn primary" onClick={onRetry}>
              {CARD.retry}
            </button>
            <button type="button" className="btn" onClick={onStartFresh}>
              {CARD.startFresh}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
