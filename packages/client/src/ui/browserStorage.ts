// browserStorage.ts — the one place the redesign's UI-convenience features (the Documents recents
// list, the persisted theme/accent choice) reach for `window.localStorage` directly. It exists so
// every read of that global goes through the same guard `session/open.ts`'s `browserDeps` already
// uses for the durable store: a privacy setting, a full quota, or a locked-down profile can make the
// mere property access throw, and that must read as "no storage", never as a crash. Unlike
// `store/prefs.ts` (the durable per-document toggles the CRDT session depends on), what lives behind
// this file is disposable presentation state — losing it never loses a document or an edit.

/** `window.localStorage`, or null when the browser has none or refuses access. Never throws. */
export function safeLocalStorage(win: Window = window): Storage | null {
  try {
    const storage = win.localStorage;
    // Some privacy modes hand back an object whose methods throw instead of throwing on access;
    // a cheap round-trip write proves it is actually usable before anything relies on it.
    const probe = '__weft_storage_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
