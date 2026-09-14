// HistoryScreen.tsx — the redesign's full-page History (a nav-rail destination), giving the
// existing time-travel control (`History.tsx`) and its read-only replay (`HistoryDoc.tsx`) a whole
// screen instead of a cramped sidebar strip. It invents no data: this is the same op log the
// sidebar's History panel already scrubs, at a size where the replay is actually readable. Weft
// tracks one continuous op log per document, not named "sessions" — so unlike the design mockup's
// session picker, this screen is honest about there being exactly one timeline to scrub, opened
// wherever the sidebar's own copy still lives (they share the same position/showAuthors state, so
// scrubbing one moves the other).

import type { Doc, Op } from '@weft/crdt';
import { History } from './History.tsx';
import { HistoryDoc } from './HistoryDoc.tsx';
import { Icon } from './Icons.tsx';

interface HistoryScreenProps {
  base: Doc;
  ops: readonly Op[];
  length: number;
  position: number;
  onPosition: (position: number) => void;
  showAuthors: boolean;
  onShowAuthors: (show: boolean) => void;
}

export function HistoryScreen({ base, ops, length, position, onPosition, showAuthors, onShowAuthors }: HistoryScreenProps): React.JSX.Element {
  const at = Math.min(position, length);
  const live = at >= length;
  return (
    <div className="screenpage" aria-label="History">
      <h1 className="screenpage-h">History</h1>
      <p className="screenpage-sub">Replay every change made to this document in this session, in the order it happened. Drag the slider to see the document exactly as it was at any earlier moment.</p>
      <History length={length} position={position} onPosition={onPosition} showAuthors={showAuthors} onShowAuthors={onShowAuthors} />
      <section className="panel history-preview" aria-live="polite">
        <div className="panel-h">
          <h2>{live ? 'Live document' : `Document at change ${at}`}</h2>
          {!live && <span className="sub mono">{length - at} later change{length - at === 1 ? '' : 's'} not shown</span>}
        </div>
        <div className="page history-page">
          <HistoryDoc base={base} ops={ops} position={at} showAuthors={showAuthors} />
        </div>
      </section>
      <div className="panel history-restore">
        <Icon name="clock" />
        <div>
          <strong>Restoring a past version</strong>
          <p>Not available yet — this screen only shows the past, it never changes your document. Drag back to Live to keep editing.</p>
        </div>
      </div>
    </div>
  );
}
