// appendLog.ts — the durable per-document op log. This file exists because the ack is a
// promise ("everything up to seq is on disk") and this is where the promise is kept: one JSONL
// file per doc, `append` resolves only after `fsync`, and the state vector is derived from the
// file on open — never trusted from memory after a restart. Recovery tolerates exactly one kind
// of damage, a torn last line (a crash between write and fsync), and refuses every other kind
// loudly rather than guess. The file system is a parameter so a test can cut the power between
// `write` and `sync`. It must never interpret an op beyond its id (the server is ignorant by
// design, I14), never acknowledge before `sync` has returned, and never fill or reorder a gap.

import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { validateOp, type Op, type ReplicaId, type StateVector } from '@weft/protocol';

/** The slice of a file system the log needs, so a test can inject one that loses unsynced writes. */
export interface LogFs {
  mkdir(dir: string): Promise<void>;
  /** The whole file, or empty bytes when it does not exist yet. */
  readFile(path: string): Promise<Uint8Array>;
  truncate(path: string, length: number): Promise<void>;
  /** Open for appending, creating the file when absent. */
  open(path: string): Promise<LogFile>;
}

export interface LogFile {
  /** Writes ALL of `data`; a partial write is the adapter's problem, never the log's. */
  write(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The one method of a Node file handle `writeAll` needs, so a test can hand it a handle that writes a few bytes at a time. */
export interface PartialWriter {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
}

/** One JSONL file per doc: one op per line, fsync per batch. Recovery tolerates a torn last line (truncate to last newline, log it). The server's SV is derived from the file, never trusted from memory after restart. */
export interface AppendLog {
  append(ops: readonly Op[]): Promise<void>; // resolves after fsync — the ack is sent only after this
  sv(): StateVector;
  read(theirs: StateVector): readonly Op[]; // catch-up payload
  length(): number;
  /** Highest seq accepted for `replica`, durable or still being written. The room's contiguity check reads this so two batches in flight never look like a gap. */
  accepted(replica: ReplicaId): number;
  /** Resolves once every append handed in so far has been synced or has failed; never rejects. A replay is acknowledged only after this (E23). */
  settled(): Promise<void>;
  /** Waits for in-flight appends, then releases the file handle (Windows will not let the file be reopened otherwise). */
  close(): Promise<void>;
}

/** A complete line that is not a valid op, or that breaks per-replica contiguity: the file was damaged by something other than a crash, and the server refuses to start on it. */
export class LogCorruptError extends Error {
  constructor(path: string, line: number, what: string) {
    super(`${path}:${line}: ${what}`);
    this.name = 'LogCorruptError';
  }
}

/** `append` was asked to write an op that does not continue its replica's sequence. The room checks first, so reaching this is a bug, not a client's fault. */
export class LogSeqError extends Error {
  constructor(replica: string, expected: number, got: number) {
    super(`replica ${replica}: expected seq ${expected}, got ${got}`);
    this.name = 'LogSeqError';
  }
}

export const nodeFs: LogFs = {
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  readFile: async (path) => {
    try {
      return await fsp.readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Uint8Array();
      throw e;
    }
  },
  truncate: (path, length) => fsp.truncate(path, length),
  open: async (path) => {
    const fh = await fsp.open(path, 'a');
    return {
      write: (data) => writeAll(fh, data),
      sync: () => fh.sync(),
      close: () => fh.close(),
    };
  },
};

/** `FileHandle.write` may write fewer bytes than asked (a full pipe, a signal); a torn line that was never on the way to the platter would look like a crash on reopen. Loops until every byte is handed over (E34). */
export async function writeAll(fh: PartialWriter, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await fh.write(data.subarray(offset));
    if (bytesWritten <= 0) throw new Error(`write made no progress at byte ${offset} of ${data.length}`);
    offset += bytesWritten;
  }
}

const NEWLINE = 0x0a;

export async function openAppendLog(path: string, fs: LogFs = nodeFs, warn: (message: string) => void = (m) => console.warn(m)): Promise<AppendLog> {
  await fs.mkdir(dirname(path));
  const bytes = await fs.readFile(path);
  const complete = bytes.lastIndexOf(NEWLINE) + 1;
  if (complete < bytes.length) {
    // A crash between write and fsync leaves a partial last line. Everything before it was
    // synced in an earlier batch, so truncating to the last newline is the recovery — and it is
    // said out loud, because the ops on that line were never acknowledged and their author will
    // re-upload them.
    await fs.truncate(path, complete);
    warn(`${path}: recovered from a torn last line (${bytes.length - complete} bytes dropped)`);
  }
  const ops = parseLines(path, bytes.subarray(0, complete));
  return new Log(await fs.open(path), ops);
}

/** Every complete line as a validated op, grouped by replica in seq order. Anything else is corruption and throws. */
function parseLines(path: string, bytes: Uint8Array): Map<string, Op[]> {
  const ops = new Map<string, Op[]>();
  if (bytes.length === 0) return ops;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new LogCorruptError(path, 0, 'file is not UTF-8');
  }
  const lines = text.split('\n');
  lines.pop(); // the split leaves an empty string after the final newline
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new LogCorruptError(path, i + 1, 'line is not JSON');
    }
    const valid = validateOp(parsed);
    if (!valid.ok) throw new LogCorruptError(path, i + 1, `line is not an op (${valid.reason})`);
    const op = valid.value;
    const held = ops.get(op.id.replica) ?? [];
    if (op.id.seq !== held.length + 1) throw new LogCorruptError(path, i + 1, `seq ${op.id.seq} of ${op.id.replica} does not follow ${held.length}`);
    held.push(op);
    ops.set(op.id.replica, held);
  });
  return ops;
}

class Log implements AppendLog {
  /** Per replica, the ops on disk, index = seq − 1. Only `append`'s post-sync step adds to it. */
  private readonly durable: Map<string, Op[]>;
  /** Per replica, the highest seq handed to `append`, advanced before the write starts. */
  private readonly claimed = new Map<string, number>();
  /** Appends run one at a time in call order, so the file order is the seq order. */
  private tail: Promise<void> = Promise.resolve();
  /** Once a write or sync has failed, the file and memory may disagree; every later append fails too, until the log is reopened and the truth re-derived from the file. */
  private fault: Error | null = null;
  private readonly encoder = new TextEncoder();
  private readonly file: LogFile;

  constructor(file: LogFile, durable: Map<string, Op[]>) {
    this.file = file;
    this.durable = durable;
    for (const [replica, held] of durable) this.claimed.set(replica, held.length);
  }

  append(ops: readonly Op[]): Promise<void> {
    if (this.fault !== null) return Promise.reject(this.fault);
    // The contiguity check and the claim happen synchronously, before any await, so a second
    // batch arriving before the first has synced is measured against the first, not the disk.
    const next = new Map<string, number>();
    for (const op of ops) {
      const replica = op.id.replica;
      const expected = (next.get(replica) ?? this.claimed.get(replica) ?? 0) + 1;
      if (op.id.seq !== expected) return Promise.reject(new LogSeqError(replica, expected, op.id.seq));
      next.set(replica, op.id.seq);
    }
    for (const [replica, seq] of next) this.claimed.set(replica, seq);
    const data = this.encoder.encode(ops.map((op) => `${JSON.stringify(op)}\n`).join(''));
    const run = this.tail.then(() => this.persist(data, ops));
    this.tail = run.catch(() => undefined); // the chain stays usable; `run` itself still rejects to the caller
    return run;
  }

  private async persist(data: Uint8Array, ops: readonly Op[]): Promise<void> {
    if (this.fault !== null) {
      this.unclaim();
      throw this.fault;
    }
    try {
      await this.file.write(data);
      await this.file.sync();
    } catch (e) {
      this.fault = e instanceof Error ? e : new Error(String(e));
      this.unclaim();
      throw this.fault;
    }
    for (const op of ops) {
      const held = this.durable.get(op.id.replica) ?? [];
      held.push(op);
      this.durable.set(op.id.replica, held);
    }
  }

  sv(): StateVector {
    const sv: Record<string, number> = {};
    for (const [replica, held] of this.durable) sv[replica] = held.length;
    return sv as StateVector;
  }

  read(theirs: StateVector): readonly Op[] {
    const out: Op[] = [];
    for (const replica of [...this.durable.keys()].sort()) {
      const have = Object.hasOwn(theirs, replica) ? ((theirs as Readonly<Record<string, number>>)[replica] ?? 0) : 0;
      out.push(...(this.durable.get(replica) ?? []).slice(have));
    }
    return out;
  }

  length(): number {
    let n = 0;
    for (const held of this.durable.values()) n += held.length;
    return n;
  }

  accepted(replica: ReplicaId): number {
    return this.claimed.get(replica) ?? 0;
  }

  /** After a fault nothing claimed past the durable prefix will ever be written, so the claims fall back to it (E24): a replay of those ops is then fresh again, not silently dropped. */
  private unclaim(): void {
    this.claimed.clear();
    for (const [replica, held] of this.durable) this.claimed.set(replica, held.length);
  }

  settled(): Promise<void> {
    return this.tail;
  }

  async close(): Promise<void> {
    await this.tail;
    await this.file.close();
  }
}
