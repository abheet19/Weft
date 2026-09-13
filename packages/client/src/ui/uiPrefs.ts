// uiPrefs.ts — the redesign's per-device look choices (theme, reduce-transparency, accent hue),
// persisted so they survive a reload instead of resetting to the system default every time. Before
// this file the shell held them in plain `useState`: real, but gone on refresh. Like `recents.ts`
// this is disposable presentation state behind the guarded `localStorage` of `browserStorage.ts`,
// never the durable per-document store — a parse failure just falls back to the same defaults the
// shell always opened with.

const KEY = 'weft:ui-prefs';

export type Accent = 'cyan' | 'amber';
export type ThemeChoice = 'light' | 'dark' | null; // null: follow the system, as the shell already did

export interface UiPrefs {
  readonly theme: ThemeChoice;
  readonly flat: boolean;
  readonly accent: Accent;
}

export const DEFAULT_UI_PREFS: UiPrefs = { theme: null, flat: false, accent: 'cyan' };

function isTheme(v: unknown): v is ThemeChoice {
  return v === null || v === 'light' || v === 'dark';
}
function isAccent(v: unknown): v is Accent {
  return v === 'cyan' || v === 'amber';
}

/** The saved preferences, or the defaults when there is no storage, no saved value, or the saved
 * value is not shaped like `UiPrefs` — a corrupt or foreign value degrades to "never saved" rather
 * than throwing, since nothing about the document depends on this file. */
export function readUiPrefs(storage: Storage | null): UiPrefs {
  if (storage === null) return DEFAULT_UI_PREFS;
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return DEFAULT_UI_PREFS;
  }
  if (raw === null) return DEFAULT_UI_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_UI_PREFS;
    const p = parsed as Record<string, unknown>;
    return {
      theme: isTheme(p['theme']) ? p['theme'] : DEFAULT_UI_PREFS.theme,
      flat: typeof p['flat'] === 'boolean' ? p['flat'] : DEFAULT_UI_PREFS.flat,
      accent: isAccent(p['accent']) ? p['accent'] : DEFAULT_UI_PREFS.accent,
    };
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

export function writeUiPrefs(storage: Storage | null, prefs: UiPrefs): void {
  if (storage === null) return;
  try {
    storage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort: a full quota just means the choice resets on the next load.
  }
}
