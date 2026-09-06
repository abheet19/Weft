// headless.ts — a Weft replica with no editor: text in, text out, over the real protocol. This
// file exists so S2 can prove convergence end to end from Node (two of these against the real
// server) and so a demo script can print two documents agreeing, before any UI exists. It is a
// thin factory over the session runner: local edits go through @weft/crdt's local.ts, everything
// else is the runner's. It must never contain sync logic of its own and never render — `text()`
// is the visible sequence with block boundaries as newlines, nothing more.

import { localDelete, localInsert, visibleItems, type ReplicaId } from '@weft/crdt';
import type { Store } from './store/memoryStore.ts';
import { startRunner, type RunnerSnapshot } from './session/runner.ts';
import type { SessionEvent } from './session/machine.ts';

export interface HeadlessOptions {
  url: string;
  doc: string;
  replicaId: ReplicaId;
  store: Store;
  /** Shown to peers; defaults to the first six characters of the replica id, colour 0. */
  name?: string;
  color?: number;
}

export interface HeadlessReplica {
  /** Insert `text` so that its first code point lands at visible index `index`. Resolves once the ops are persisted (and sent, when live). */
  insertText(index: number, text: string): Promise<void>;
  /** Delete visible indexes `from` (inclusive) to `to` (exclusive). */
  deleteRange(from: number, to: number): Promise<void>;
  text(): string;
  state(): RunnerSnapshot;
  hash(): Promise<string>;
  /** Drive the session from outside: USER_OFFLINE / USER_ONLINE for partition tests and the offline toggle. */
  dispatch(ev: SessionEvent): void;
  close(): Promise<void>;
}

export async function createHeadlessReplica(o: HeadlessOptions): Promise<HeadlessReplica> {
  const runner = await startRunner({ url: o.url, doc: o.doc, me: o.replicaId, store: o.store, presence: { name: o.name ?? o.replicaId.slice(0, 6), color: o.color ?? 0 } });
  return {
    insertText: (index, text) =>
      runner.local((doc, me, nextSeq) => {
        // One op per code point, each placed after the previous one, all applied and persisted as one batch.
        const ops = [];
        let cur = doc;
        let at = index;
        for (const ch of text) {
          const step = localInsert(cur, me, nextSeq + ops.length, at++, { kind: 'char', text: ch });
          ops.push(...step.ops);
          cur = step.doc;
        }
        return { ops, doc: cur };
      }),
    deleteRange: (from, to) => runner.local((doc, me, nextSeq) => localDelete(doc, me, nextSeq, from, to)),
    text: () =>
      visibleItems(runner.doc)
        .map((item) => (item.content.kind === 'char' ? item.content.text : '\n'))
        .join(''),
    state: () => runner.snapshot(),
    hash: () => runner.hash(),
    dispatch: (ev) => runner.dispatch(ev),
    close: () => runner.close(),
  };
}
