// Documents.tsx — the redesign's Documents screen (the nav rail's first destination and, for a
// browser that has opened more than one, the natural landing page). Weft has no accounts and no
// server-side document index (an unlisted `/d/<id>` is the whole access model), so this screen's
// only honest data source is `recents.ts`'s local registry of documents THIS device has actually
// opened — never a fabricated "shared with you" roster. Opening or creating a document is a real
// navigation (`location.assign`), matching how Shell's own New Document / Start Fresh already work.

import { useMemo, useState } from 'react';
import { newDocId } from '../identity.ts';
import { safeLocalStorage } from './browserStorage.ts';
import { Icon } from './Icons.tsx';
import { forgetRecent, readRecents, type RecentDoc } from './recents.ts';

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const DAY_MS = 86_400_000;

/** A short "updated …" phrase (03-UI has no such control elsewhere, so this is new and deliberately coarse: minutes/hours/days only, never a false precision like seconds). */
function relativeTime(ms: number, now: number): string {
  const delta = now - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return RELATIVE.format(-Math.round(delta / 60_000), 'minute');
  if (delta < DAY_MS) return RELATIVE.format(-Math.round(delta / 3_600_000), 'hour');
  return RELATIVE.format(-Math.round(delta / DAY_MS), 'day');
}

function open(id: string): void {
  location.assign(`/d/${id}`);
}

export function Documents(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [now] = useState(() => Date.now());
  // Re-read on every render rather than once: a doc edited in another tab, or forgotten just now, should show up without a reload.
  const [version, setVersion] = useState(0);
  const storage = useMemo(() => safeLocalStorage(), []);
  const all = useMemo(() => readRecents(storage), [storage, version]);
  const q = query.trim().toLowerCase();
  const filtered = q === '' ? all : all.filter((d) => d.title.toLowerCase().includes(q) || d.id.includes(q));

  const onForget = (d: RecentDoc, e: React.MouseEvent): void => {
    e.stopPropagation();
    forgetRecent(storage, d.id);
    setVersion((v) => v + 1);
  };

  return (
    <div className="screenpage" aria-label="Documents">
      <div className="docs-head">
        <div>
          <h1 className="screenpage-h">Documents</h1>
          <p className="screenpage-sub">Every document this browser has opened — Weft has no accounts, so this list lives here and nowhere else. Open the same link on another device and it will not appear there.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => open(newDocId())}>
          <Icon name="plus" />
          New document
        </button>
      </div>

      {all.length > 0 && (
        <div className="docs-search">
          <Icon name="search" />
          <input type="text" placeholder="Search this device’s documents…" aria-label="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="mono docs-count">
            {filtered.length} of {all.length}
          </span>
        </div>
      )}

      {all.length === 0 ? (
        <div className="panel docs-empty">
          <Icon name="grid" />
          <h2>Nothing opened yet on this device</h2>
          <p>Start a new document, or open a link someone shared with you — it will show up here from then on.</p>
          <button type="button" className="btn primary" onClick={() => open(newDocId())}>
            <Icon name="plus" />
            New document
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="panel docs-empty">
          <Icon name="search" />
          <h2>No document matches “{query.trim()}”</h2>
          <button type="button" className="btn" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="docs-grid">
          {filtered.map((d) => (
            // A div, not a button: it hosts a real <button> (Forget) inside it, which HTML forbids inside a <button>. Keyboard users get the same activation via Enter/Space.
            <div
              key={d.id}
              className="doc-card panel"
              role="button"
              tabIndex={0}
              onClick={() => open(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(d.id);
                }
              }}
            >
              <button type="button" className="doc-card-forget" aria-label={`Forget ${d.title}`} onClick={(e) => onForget(d, e)}>
                <Icon name="x" />
              </button>
              <h3>{d.title}</h3>
              <div className="doc-card-meta">
                <span>
                  {d.words} word{d.words === 1 ? '' : 's'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="mono">{d.id}</span>
              </div>
              <div className="doc-card-foot">{relativeTime(d.updatedAt, now)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
