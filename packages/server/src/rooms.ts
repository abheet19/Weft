// rooms.ts — one Room per document, opened on the first hello and closed when the last member
// leaves or the log faults. This file exists so the life cycle of a document's log has one owner:
// a reopen waits for the previous close (the file is never read while its last batch is still
// being written), a room whose append failed is closed even while members hold it so the next
// hello re-derives the truth from the file (E24), a log that refused to open as corrupt is
// remembered and refused from memory instead of being re-read on every client backoff (E26),
// and every close is observed — a rejected close is a warning, never an unhandled rejection
// (E35). It must never hand out a faulted room and never delete another room's entry.

import { join } from 'node:path';
import { LogCorruptError, nodeFs, openAppendLog, type LogFs } from './log/appendLog.ts';
import { Room } from './room.ts';

interface Entry {
  ready: Promise<Room>;
  /** Set once `ready` resolves, so `release` can check it is releasing the room it was handed. */
  room: Room | null;
}

export class Rooms {
  private readonly open = new Map<string, Entry>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly corrupt = new Map<string, LogCorruptError>();
  private readonly dataDir: string;
  private readonly quietMs: number;
  private readonly warn: (message: string) => void;
  private readonly fs: LogFs;

  constructor(dataDir: string, quietMs: number, warn: (message: string) => void, fs: LogFs = nodeFs) {
    this.dataDir = dataDir;
    this.quietMs = quietMs;
    this.warn = warn;
    this.fs = fs;
  }

  /** The live room for `doc`, opening its log if needed. Rejects with the remembered `LogCorruptError` for a document an operator must repair first. */
  async acquire(doc: string): Promise<Room> {
    const corrupt = this.corrupt.get(doc);
    if (corrupt !== undefined) throw corrupt;
    await this.closing.get(doc);
    let entry = this.open.get(doc);
    if (entry === undefined || entry.room?.faulted === true) {
      const fresh: Entry = { ready: Promise.resolve(null as unknown as Room), room: null };
      fresh.ready = openAppendLog(join(this.dataDir, `${doc}.jsonl`), this.fs, this.warn).then(
        (log) => {
          fresh.room = new Room(doc, log, { quietMs: this.quietMs });
          return fresh.room;
        },
        (e: unknown) => {
          // A failed open must not poison every later hello for this doc — unless the file itself is the problem.
          if (this.open.get(doc) === fresh) this.open.delete(doc);
          if (e instanceof LogCorruptError) {
            this.corrupt.set(doc, e);
            this.warn(`${doc}: the log is corrupt and needs an operator; every hello for it is refused until the server restarts (${e.message})`);
          }
          throw e;
        },
      );
      this.open.set(doc, fresh);
      entry = fresh;
    }
    return entry.ready;
  }

  /** Called after every leave: closes the room once nobody holds it, or at once when its log faulted. */
  release(room: Room): void {
    const entry = this.open.get(room.doc);
    if (entry?.room !== room) return; // already released, or superseded by a newer room for this doc
    if (room.size > 0 && !room.faulted) return;
    this.open.delete(room.doc);
    const done = room
      .close()
      .catch((e: unknown) => this.warn(`${room.doc}: closing the log failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        if (this.closing.get(room.doc) === done) this.closing.delete(room.doc);
      });
    this.closing.set(room.doc, done);
  }

  async closeAll(): Promise<void> {
    const opened = [...this.open.values()].map((entry) =>
      entry.ready.then(
        (room) => room.close(),
        () => undefined,
      ),
    );
    this.open.clear();
    await Promise.allSettled([...opened, ...this.closing.values()]);
  }
}
