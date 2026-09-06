// History.tsx — the History / time-travel side rail (03-UI §4.6), ported from the prototype's
// `.panel` with the range slider and "Show authors" checkbox. It is a thin control: a slider over
// this replica's op log with a numeric position, whose value the shell turns into a read-only replay
// of `fold(apply, ∅, ops[0..n])`. Dragging off the end puts the page in read-only time-travel;
// returning to the end restores live editing (the shell swaps the live editor back). It reads the op
// count from the runner snapshot and decides nothing about the document.

interface HistoryProps {
  /** The op log's length — the slider's maximum, and the "live" position. */
  length: number;
  /** The current slider position; equals `length` when live (not scrubbing). */
  position: number;
  onPosition: (position: number) => void;
  showAuthors: boolean;
  onShowAuthors: (show: boolean) => void;
}

export function History({ length, position, onPosition, showAuthors, onShowAuthors }: HistoryProps): React.JSX.Element {
  const live = position >= length;
  // The webkit track fill is a CSS var (prototype §13); 100% when there are no ops so the empty track reads as "all of it".
  const fill = `${length === 0 ? 100 : (position / length) * 100}%`;
  return (
    <section className="panel" aria-labelledby="hist-h">
      <div className="panel-h">
        <h2 id="hist-h">History</h2>
        <span className="sub mono" data-testid="history-pos">
          {position} / {length}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={length}
        step={1}
        value={Math.min(position, length)}
        style={{ ['--fill' as string]: fill }}
        aria-label="Time-travel position (operations applied)"
        data-testid="history-slider"
        onChange={(e) => onPosition(e.target.valueAsNumber)}
      />
      <div className="hist-meta">
        <span data-testid="history-note">{live ? 'Live — editing' : 'Read-only — scrubbing'}</span>
        <label className="chk">
          <input type="checkbox" checked={showAuthors} onChange={(e) => onShowAuthors(e.target.checked)} /> Show authors
        </label>
      </div>
      <p className="hint">
        The page re-renders <code>fold(apply, ∅, ops[0..n])</code>. Named versions and restore are not in v1.
      </p>
    </section>
  );
}
