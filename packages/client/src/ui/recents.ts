// recents.ts — the Documents screen's only data source: which documents THIS BROWSER has actually
// opened, read back from `localStorage`. Weft has no accounts and no server-side document list (an
// unlisted `/d/<id>` is the whole access model, see README "Where this project is"), so a documents
// list can only be honest if it is exactly the ids this device has opened — never a fabricated
// roster of "shared" or "teammate" documents. Each entry's title and word count are a live snapshot
// of derived content (`docTitle.ts`, `Editor.tsx`'s word count) at the moment it was last touched,
// not a claim about the document's current state anywhere else.
//
// This is disposable presentation data, unlike `store/prefs.ts` or the IndexedDB store: a parse
// failure or a full quota degrades to an empty (or trimmed) list, never a thrown StoreCorruptError —
// losing "recently opened" loses a convenience, not a document. `safeLocalStorage` in
// `browserStorage.ts` is the guarded accessor; every function here takes `Storage | null` as a
// parameter so it is testable without a real browser, the same shape `prefs.ts` uses.

const KEY = 'weft:recents';
const MAX_ENTRIES = 40;

export interface RecentDoc {
  readonly id: string;
  readonly title: string;
  readonly words: number;
  /** Epoch milliseconds of the last touch — the list's sort key, newest first. */
  readonly updatedAt: number;
}

function isRecentDoc(v: unknown): v is RecentDoc {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['id'] === 'string' && r['id'] !== '' && typeof r['title'] === 'string' && typeof r['words'] === 'number' && Number.isFinite(r['words']) && typeof r['updatedAt'] === 'number' && Number.isFinite(r['updatedAt']);
}

/** Every recorded document, most recently touched first. A missing key, unreadable JSON, or a shape
 * that is not an array of `RecentDoc` all read as "nothing recorded yet" rather than an error — this
 * list is a convenience, not a source of truth about any document. */
export function readRecents(storage: Storage | null): readonly RecentDoc[] {
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentDoc).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function write(storage: Storage, list: readonly RecentDoc[]): void {
  try {
    storage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // A full quota loses the convenience, never the document underneath it.
  }
}

/** Upsert one document's entry (by id) with `now` as its new `updatedAt`, moving it to the front. A
 * no-op when there is no usable storage. */
export function touchRecent(storage: Storage | null, entry: { id: string; title: string; words: number }, now: number): void {
  if (storage === null) return;
  const rest = readRecents(storage).filter((r) => r.id !== entry.id);
  write(storage, [{ id: entry.id, title: entry.title, words: entry.words, updatedAt: now }, ...rest]);
}

/** Forget one document — removes it from the local list only; the document itself (its IndexedDB
 * database, the copy on the relay) is completely untouched. */
export function forgetRecent(storage: Storage | null, id: string): void {
  if (storage === null) return;
  write(storage, readRecents(storage).filter((r) => r.id !== id));
}
