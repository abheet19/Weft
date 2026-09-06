// helpers.ts — the server test harness: three fixed replica ids, op builders, a raw WebSocket
// client (Node 22's global WebSocket — deliberately NOT the Weft client, so the server is tested
// against the protocol alone), a fake file system whose unsynced writes can be lost on demand,
// and a Conn double the Room can be driven with. Nothing here reaches the CRDT.
import { CLOSE_CODE, decodeServer, encode, type ClientMessage, type ErrorCode, type ItemId, type Op, type ReplicaId, type ServerMessage } from '@weft/protocol';
import type { Conn } from '../src/room.ts';
import type { LogFile, LogFs } from '../src/log/appendLog.ts';

export const R = {
  a: 'bcdefghijklmn' as ReplicaId,
  b: 'cdefghijklmno' as ReplicaId,
  c: 'defghijklmnop' as ReplicaId,
};
export const ROOT: ItemId = { replica: 'aaaaaaaaaaaaa' as ReplicaId, seq: 0 };
export const DOC = 'doc-under-test';

export const id = (replica: ReplicaId, seq: number): ItemId => ({ replica, seq });
/** An insert of one char whose parent is the previous item of the same replica (or the root), so any prefix is a valid chain. */
export const ins = (replica: ReplicaId, seq: number, text = 'x'): Op => ({ t: 'ins', id: id(replica, seq), parent: seq === 1 ? ROOT : id(replica, seq - 1), side: 'R', content: { kind: 'char', text } });
export const chain = (replica: ReplicaId, from: number, to: number): Op[] => Array.from({ length: to - from + 1 }, (_, i) => ins(replica, from + i));

export const hello = (replica: ReplicaId, sv: Record<string, number> = {}, doc = DOC): ClientMessage => ({ v: 1, t: 'hello', doc, replica, sv: sv as ClientMessage extends { sv: infer S } ? S : never });
export const opsMsg = (ops: Op[]): ClientMessage => ({ v: 1, t: 'ops', ops });

/** A raw protocol speaker. Every inbound frame must validate as a ServerMessage — a server that emits something else has a bug the test should see. */
export class RawClient {
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: ((m: ServerMessage) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev: MessageEvent) => {
      const data: unknown = ev.data;
      const decoded = decodeServer(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
      if (!decoded.ok) throw new Error(`server sent an invalid frame: ${decoded.code} ${decoded.reason}`);
      const waiter = this.waiters.shift();
      if (waiter) waiter(decoded.value);
      else this.queue.push(decoded.value);
    };
    this.closed = new Promise((resolve) => {
      ws.onclose = (ev: { code: number; reason: string }) => resolve({ code: ev.code, reason: ev.reason });
    });
  }

  static open(url: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new RawClient(ws));
      ws.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(encode(message));
  }

  sendRaw(frame: string | Uint8Array): void {
    this.ws.send(frame);
  }

  /** The next frame, or a rejection after `timeoutMs` — a test that expects silence uses `silent`. */
  next(timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`no frame within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = (m: ServerMessage): void => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }

  /** The next frame of type `t`, skipping others (presence and quiet arrive at their own pace). */
  async expect<T extends ServerMessage['t']>(t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await this.next(Math.max(1, deadline - Date.now()));
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
  }

  /** True when nothing of type `t` arrives within `ms`. Frames of other types are kept for later. */
  async silent(t: ServerMessage['t'], ms: number): Promise<boolean> {
    const keep: ServerMessage[] = [];
    const deadline = Date.now() + ms;
    try {
      for (;;) {
        const m = await this.next(Math.max(1, deadline - Date.now()));
        if (m.t === t) {
          this.queue.unshift(...keep);
          return false;
        }
        keep.push(m);
      }
    } catch {
      this.queue.unshift(...keep);
      return true;
    }
  }

  close(): void {
    this.ws.close(1000);
  }
}

/** An in-memory file system that models the one failure the log is designed for: the OS accepted a write that never reached the platter. */
export class FakeFs implements LogFs {
  readonly files = new Map<string, { durable: Uint8Array; written: Uint8Array }>();
  readonly dirs: string[] = [];
  /** When set, the next sync fails with it. */
  syncError: Error | null = null;
  /** When set, syncs wait here until the test lets them through. */
  syncGate: Promise<void> | null = null;
  /** When set, closing a file fails with it. */
  closeError: Error | null = null;
  /** How many times a file was read: a corrupt log must be read once, not on every hello. */
  reads = 0;

  private file(path: string): { durable: Uint8Array; written: Uint8Array } {
    let f = this.files.get(path);
    if (f === undefined) {
      f = { durable: new Uint8Array(), written: new Uint8Array() };
      this.files.set(path, f);
    }
    return f;
  }

  async mkdir(dir: string): Promise<void> {
    this.dirs.push(dir);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.reads++;
    return this.files.get(path)?.written ?? new Uint8Array();
  }

  async truncate(path: string, length: number): Promise<void> {
    const f = this.file(path);
    f.written = f.written.slice(0, length);
    f.durable = f.durable.slice(0, Math.min(length, f.durable.length));
  }

  async open(path: string): Promise<LogFile> {
    const f = this.file(path);
    return {
      write: async (data) => {
        const next = new Uint8Array(f.written.length + data.length);
        next.set(f.written);
        next.set(data, f.written.length);
        f.written = next;
      },
      sync: async () => {
        if (this.syncGate !== null) await this.syncGate;
        if (this.syncError !== null) throw this.syncError;
        f.durable = f.written;
      },
      close: async () => {
        if (this.closeError !== null) throw this.closeError;
      },
    };
  }

  /** Power loss: whatever was written but not synced is gone. */
  crash(): void {
    for (const f of this.files.values()) f.written = f.durable;
  }

  text(path: string): string {
    return new TextDecoder().decode(this.files.get(path)?.written ?? new Uint8Array());
  }
}

/** A Room-side connection that records everything the room did to it. */
export class FakeConn implements Conn {
  replica: ReplicaId | null = null;
  readonly sent: ServerMessage[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  /** When set, a catch-up waits here before its frames are recorded — the socket of a slow joiner. */
  catchUpGate: Promise<void> | null = null;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  async sendMany(frames: readonly ServerMessage[]): Promise<void> {
    if (this.catchUpGate !== null) await this.catchUpGate;
    this.sent.push(...frames);
  }

  refuse(code: ErrorCode, reason: string): void {
    this.sent.push({ v: 1, t: 'error', code, reason, fatal: false });
  }

  fail(code: ErrorCode, reason: string): void {
    this.sent.push({ v: 1, t: 'error', code, reason, fatal: true });
    this.close(CLOSE_CODE[code], code);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  ofType<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
}

/** Yield to the event loop until pending promise chains settle. */
export function settle(rounds = 5): Promise<void> {
  return rounds === 0 ? Promise.resolve() : new Promise((r) => setImmediate(r)).then(() => settle(rounds - 1));
}
