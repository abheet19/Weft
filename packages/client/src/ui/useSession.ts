// useSession.ts — the React lifecycle around `openSession`: open on mount (and again on `retry`),
// close on unmount, and turn the runner's `onChange` stream into state the shell renders — the
// session snapshot, whether the document is empty, the storage status (a working IndexedDB store,
// or this tab's memory when it could not be opened), and the reconnect notice's count. Durable
// storage is requested silently on load — `store.persist()` is called once and its boolean is
// discarded for UI purposes — because on Chrome it never prompts and returns false on localhost, so
// a warning drawn from it was alarmist; only the memory fallback is a real, surfaced warning. This
// file exists so `Shell` stays declarative and `open.ts`
// stays testable without React; it holds no copy and decides nothing about the document. The
// binding host it builds fans the runner's single `onChange` out to the editor plugin's
// subscribers. Everything observable about the session is proven in `open.ts`'s and the runner's
// tests; this file is excluded from coverage as the shell's `.tsx` files are.

import { useEffect, useRef, useState } from 'react';
import { visibleItems } from '@weft/crdt';
import type { BindingHost } from '../binding/plugin.ts';
import type { RunnerSnapshot } from '../session/runner.ts';
import { browserDeps, openSession, type Session } from '../session/open.ts';
import { newReplicaId } from '../identity.ts';
import { mergedOnReconnect } from './copy.ts';
import type { StorageStatus } from './pillCopy.ts';

export type SessionPhase =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: unknown }
  | {
      readonly phase: 'ready';
      readonly session: Session;
      readonly host: BindingHost;
      readonly snapshot: RunnerSnapshot;
      readonly empty: boolean;
      readonly storage: StorageStatus;
    };

export interface SessionCallbacks {
  /** A catch-up merged `n` offline edits (03-UI §4.7 "Back online"). */
  onMerged(n: number): void;
}

export function useSession(url: string, docId: string, attempt: number, callbacks: SessionCallbacks): SessionPhase {
  const [phase, setPhase] = useState<SessionPhase>({ phase: 'loading' });
  const cb = useRef(callbacks);
  cb.current = callbacks;
  useEffect(() => {
    let cancelled = false;
    let opened: Session | null = null;
    const listeners = new Set<() => void>();
    let last: RunnerSnapshot | null = null;
    setPhase({ phase: 'loading' });
    const onChange = (snapshot: RunnerSnapshot): void => {
      const session = opened;
      if (session === null || cancelled) return;
      const merged = last === null ? null : mergedOnReconnect(last.session, snapshot.session);
      last = snapshot;
      if (merged !== null) cb.current.onMerged(merged);
      for (const listener of listeners) listener();
      const empty = visibleItems(session.runner.doc).length === 0;
      setPhase((was) => (was.phase === 'ready' ? { ...was, snapshot, empty } : was));
    };
    openSession({ ...browserDeps(window, newReplicaId), url, docId, onChange }).then(
      (session) => {
        if (cancelled) {
          void session.close();
          return;
        }
        opened = session;
        last = session.runner.snapshot();
        const host: BindingHost = {
          get doc() {
            return session.runner.doc;
          },
          local: (edit) => session.runner.local(edit),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          undo: () => void session.runner.undo(),
          redo: () => void session.runner.redo(),
        };
        const storage: StorageStatus = session.storage.kind === 'memory' ? { kind: 'memory' } : { kind: 'idb' };
        setPhase({ phase: 'ready', session, host, snapshot: last, empty: visibleItems(session.runner.doc).length === 0, storage });
        // Request durable storage silently: ask once, discard the answer. It drives no UI — on Chrome
        // it never prompts and returns false on localhost, so a warning from it was a dead end. Only
        // the memory fallback above is a real, surfaced warning.
        if (session.storage.kind === 'idb') void session.store.persist();
      },
      (error: unknown) => {
        if (!cancelled) setPhase({ phase: 'error', error });
      },
    );
    return () => {
      cancelled = true;
      if (opened !== null) void opened.close();
    };
  }, [url, docId, attempt]);
  return phase;
}
