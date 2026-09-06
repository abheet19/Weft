// open.ts — how a browser tab becomes a session: claim a replica id for this tab (E41), open the
// device's IndexedDB store for the document (falling back to memory, visibly), read the persisted
// Simulate-offline toggle, start the runner with the browser's connectivity, and plant the text a
// `Start fresh (keeps a copy)` carried over. This file exists so that sequence is one tested
// function with every browser global injected — `indexedDB`, both Web Storages, `navigator.locks`,
// `navigator.storage`, the network events — rather than a React effect nobody can run twice in a
// test; the shell's hook is a thin wrapper. `browserDeps` is the one place that reads those globals,
// each behind a try/catch because a privacy setting can make the mere access throw. It must never
// decide anything about the document, never open a socket itself, and never leave a claim or a
// database connection behind when the start fails or the session closes.

import { localInsert, visibleItems, type Content, type Doc, type Op, type ReplicaId } from '@weft/crdt';
import { textOfTokens, tokensOfItems } from '../binding/tokens.ts';
import { colorOf } from '../presence/colors.ts';
import { claimReplica, type Claim } from '../store/claim.ts';
import { openIdbStore, type StorageKind } from '../store/idb.ts';
import type { Store } from '../store/memoryStore.ts';
import { readUserOffline, stashSeed, takeSeed, writeUserOffline, type Seed } from '../store/prefs.ts';
import { browserConnectivity, type Connectivity } from './connectivity.ts';
import { startRunner, type Runner, type RunnerSnapshot } from './runner.ts';

/** Everything a session takes from the browser, as values — `null` where the browser has none or refuses access. */
export interface BrowserDeps {
  indexedDB: IDBFactory | null;
  sessionStorage: Storage | null;
  localStorage: Storage | null;
  locks: LockManager | null;
  storageManager: StorageManager | null;
  connectivity: Connectivity | null;
  /** A fresh replica id when this tab needs one (the client's `identity.ts`). */
  mint(): ReplicaId;
}

export interface SessionDeps extends BrowserDeps {
  url: string;
  docId: string;
  onChange?: (snapshot: RunnerSnapshot) => void;
}

export interface Session {
  readonly runner: Runner;
  readonly store: Store;
  readonly me: ReplicaId;
  readonly storage: StorageKind;
  /** The text `Start fresh` planted into this document and where it came from, for the notice; null on an ordinary open. */
  readonly seeded: Seed | null;
  /** The Simulate-offline toggle: closes the socket for real and is remembered for this replica across a tab kill (LLD §4). */
  setUserOffline(offline: boolean): void;
  /** `Start fresh (keeps a copy)`: stash this document's text for `newDocId` so its first open plants it. This document's database is left untouched. */
  startFresh(newDocId: string): void;
  close(): Promise<void>;
}

/** Read one browser global; a privacy setting can make the access itself throw, which is the same as not having it. */
function guarded<T>(read: () => T | undefined): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

export function browserDeps(win: Window, mint: () => ReplicaId): BrowserDeps {
  return {
    indexedDB: guarded(() => win.indexedDB),
    sessionStorage: guarded(() => win.sessionStorage),
    localStorage: guarded(() => win.localStorage),
    locks: guarded(() => win.navigator.locks),
    storageManager: guarded(() => win.navigator.storage),
    connectivity: browserConnectivity(win),
    mint,
  };
}

export async function openSession(deps: SessionDeps): Promise<Session> {
  const held: { claim: Claim | null } = { claim: null };
  const opened = await openIdbStore(deps.docId, {
    claim: async (used) => {
      held.claim = await claimReplica(deps.docId, used, { sessionStorage: deps.sessionStorage, locks: deps.locks, mint: deps.mint });
      return held.claim.me;
    },
    indexedDB: deps.indexedDB,
    storageManager: deps.storageManager,
  });
  const release = (): void => {
    opened.store.close();
    held.claim?.release();
  };
  let runner: Runner;
  try {
    runner = await startRunner({
      url: deps.url,
      doc: deps.docId,
      me: opened.me,
      store: opened.store,
      presence: { name: opened.me.slice(0, 6), color: colorOf(opened.me) },
      offline: readUserOffline(deps.localStorage, deps.docId, opened.me),
      ...(deps.connectivity === null ? {} : { connectivity: deps.connectivity }),
      ...(deps.onChange === undefined ? {} : { onChange: deps.onChange }),
    });
  } catch (e) {
    release();
    throw e;
  }
  const seed = takeSeed(deps.sessionStorage, deps.docId);
  // A seed is planted only into an empty document: a reload with a stale seed must not append it.
  if (seed !== null && visibleItems(runner.doc).length === 0) await plant(runner, seed.text);
  return {
    runner,
    store: opened.store,
    me: opened.me,
    storage: opened.storage,
    seeded: seed,
    setUserOffline: (offline) => {
      writeUserOffline(deps.localStorage, deps.docId, opened.me, offline);
      runner.dispatch({ e: offline ? 'USER_OFFLINE' : 'USER_ONLINE' });
    },
    startFresh: (newDocId) => stashSeed(deps.sessionStorage, newDocId, { text: plainText(runner.doc), from: deps.docId }),
    close: async () => {
      await runner.close();
      release();
    },
  };
}

/** The visible text with block boundaries as newlines — what `Start fresh` carries over. */
export function plainText(doc: Doc): string {
  return textOfTokens(tokensOfItems(visibleItems(doc)));
}

/** Insert `text` at the start of an empty document as this replica's ops: one per code point, a paragraph boundary per newline. */
function plant(runner: Runner, text: string): Promise<void> {
  return runner.local((doc, me, nextSeq) => {
    const ops: Op[] = [];
    let cur = doc;
    let at = 0;
    for (const ch of text) {
      // A fresh boundary starts its register at lamport 0, as the binding's `toOps` does.
      const content: Content = ch === '\n' ? { kind: 'block', attrs: { type: 'paragraph' }, lamport: 0, replica: me } : { kind: 'char', text: ch };
      const step = localInsert(cur, me, nextSeq + ops.length, at++, content);
      ops.push(...step.ops);
      cur = step.doc;
    }
    return { ops, doc: cur };
  });
}
