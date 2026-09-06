// wsServer.ts — the socket edge of the relay. This file exists to turn a hostile byte stream
// into validated messages for a Room, and to be the ONLY place the server touches `ws`: it
// binds 127.0.0.1, bounds every frame in bytes before parsing, refuses binary frames, meters
// messages, ops and presence per second (three warnings, forgiven after a clean minute, then
// close 1008), bounds the frames waiting behind a slow handler, counts shape errors per minute,
// negotiates the protocol version (close 1002 when none), answers ping, caps each connection's
// live send queue so one stalled socket cannot hold everyone's fan-out in memory, and paces
// catch-up on the socket's buffer instead (E22). It also takes an exclusive lock on the data
// directory (E25): two servers appending to one log would interleave seqs and corrupt it. It
// must never import @weft/crdt (I14), never `JSON.parse` a frame itself (the codec does, after
// the size check), and never let an exception escape a handler — an unexpected error becomes
// `INTERNAL` and close 1011, with the cause on stderr.

import { promises as fsp } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { CLOSE_CODE, decodeClient, encode, LIMITS, type ClientMessage, type ErrorCode, type ReplicaId, type ServerMessage } from '@weft/protocol';
import { LogCorruptError, nodeFs, type LogFs } from './log/appendLog.ts';
import { RateWindow, SERVER_LIMITS, Warnings } from './limits.ts';
import type { Conn, Room } from './room.ts';
import { Rooms } from './rooms.ts';

/** LIMITS with its literal numbers widened, so an override such as `{ QUIET_MS: 60 }` is expressible. */
export type Limits = { readonly [K in keyof typeof LIMITS]: (typeof LIMITS)[K] extends number ? number : (typeof LIMITS)[K] };

export interface ServerOptions {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  /** Overrides for the server's OWN checks (rates, quiet period). The protocol validators keep their constants regardless. */
  limits?: Partial<Limits>;
  /** Where operational warnings go (recovered logs, dropped connections). Injected so tests can assert on them; production writes to stderr. */
  warn?: (message: string) => void;
  /** The file system the logs are written through. Injected so a test can stall or fail an fsync under the real socket edge; production uses Node's. */
  fs?: LogFs;
}

export async function startServer(o: ServerOptions): Promise<{ close(): Promise<void>; port: number }> {
  const limits = { ...LIMITS, ...o.limits };
  const warn = o.warn ?? ((m: string) => console.warn(m));
  const unlock = await lockDataDir(o.dataDir, warn);
  const rooms = new Rooms(o.dataDir, limits.QUIET_MS, warn, o.fs ?? nodeFs);
  const wss = new WebSocketServer({ host: o.host, port: o.port, maxPayload: SERVER_LIMITS.MAX_FRAME_BYTES });
  const connections = new Set<Connection>();
  wss.on('connection', (ws) => {
    const conn = new Connection(ws, rooms, limits, warn);
    connections.add(conn);
    ws.on('close', () => connections.delete(conn));
  });
  return new Promise((resolve, reject) => {
    wss.once('error', (e) => {
      void unlock().finally(() => reject(e));
    });
    wss.once('listening', () => {
      wss.on('error', (e) => warn(`server error: ${e.message}`));
      resolve({
        port: (wss.address() as AddressInfo).port,
        close: async () => {
          for (const conn of connections) conn.close(1001, 'server shutting down');
          await new Promise<void>((done, fail) => wss.close((e) => (e ? fail(e) : done())));
          await rooms.closeAll();
          await unlock();
        },
      });
    });
  });
}

/**
 * Creates `dataDir/.weft-server.lock` exclusively, holding this process's pid; returns the
 * release. A lock whose pid is no longer running is stale (a crash) and is taken over once, with
 * a warning. Liveness is `process.kill(pid, 0)`, which never signals; on Windows and POSIX alike
 * it throws ESRCH for a dead pid and EPERM for a live one owned by someone else.
 */
async function lockDataDir(dataDir: string, warn: (message: string) => void): Promise<() => Promise<void>> {
  await fsp.mkdir(dataDir, { recursive: true });
  const path = join(dataDir, SERVER_LIMITS.LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fsp.open(path, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => fsp.rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await fsp.readFile(path, 'utf8').catch(() => ''));
      if (attempt === 0 && !isRunning(pid)) {
        warn(`${path}: taking over a stale lock left by pid ${pid}`);
        await fsp.rm(path, { force: true });
        continue;
      }
      throw new Error(`${dataDir} is locked by another weft server (pid ${pid}); two servers on one data directory would corrupt its logs`);
    }
  }
}

function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class Connection implements Conn {
  replica: ReplicaId | null = null;
  private room: Room | null = null;
  private closed = false;
  /** Messages are handled one at a time in arrival order, so a hello's room lookup finishes before the ops behind it are judged. */
  private chain: Promise<void> = Promise.resolve();
  /** Frames waiting in `chain`; bounded so a flood during a stalled fsync cannot grow memory without limit (E33). */
  private queued = 0;
  private readonly messagesPerSec: RateWindow;
  private readonly opsPerSec: RateWindow;
  private readonly presencePerSec: RateWindow;
  private readonly badShapesPerMin = new RateWindow(SERVER_LIMITS.BAD_SHAPE_PER_MINUTE, 60_000);
  private readonly warnings = new Warnings(SERVER_LIMITS.RATE_WARNINGS, SERVER_LIMITS.WARNINGS_DECAY_MS);
  private helloTimer: ReturnType<typeof setTimeout> | null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ws: WebSocket;
  private readonly rooms: Rooms;
  private readonly limits: Limits;
  private readonly warn: (message: string) => void;

  constructor(ws: WebSocket, rooms: Rooms, limits: Limits, warn: (message: string) => void) {
    this.ws = ws;
    this.rooms = rooms;
    this.limits = limits;
    this.warn = warn;
    this.messagesPerSec = new RateWindow(limits.RATE_MESSAGES_PER_SEC, 1000);
    this.opsPerSec = new RateWindow(limits.RATE_OPS_PER_SEC, 1000);
    this.presencePerSec = new RateWindow(limits.RATE_PRESENCE_PER_SEC, 1000);
    this.helloTimer = setTimeout(() => this.close(1008, 'no hello'), SERVER_LIMITS.HELLO_TIMEOUT_MS);
    ws.on('message', (data, isBinary) => this.receive(data, isBinary));
    ws.on('close', () => this.detach());
    ws.on('error', (e) => warn(`socket error: ${e.message}`));
  }

  send(message: ServerMessage): void {
    if (this.closed) return;
    if (this.ws.bufferedAmount > SERVER_LIMITS.SEND_QUEUE_BYTES) {
      this.warn(`dropping slow consumer ${this.replica ?? '(no hello)'}: ${this.ws.bufferedAmount} bytes queued`);
      this.close(1008, 'send queue full');
      return;
    }
    this.ws.send(encode(message));
  }

  async sendMany(frames: readonly ServerMessage[]): Promise<void> {
    for (const frame of frames) {
      if (this.closed) return;
      // The callback fires once the frame has left user space (with `null`/`undefined` on success); an error means the socket is gone.
      const written = await new Promise<boolean>((resolve) => this.ws.send(encode(frame), (e) => resolve(e === undefined || e === null)));
      if (!written) return;
      while (!this.closed && this.ws.bufferedAmount > SERVER_LIMITS.CATCHUP_LOW_WATER_BYTES) await new Promise((r) => setTimeout(r, 1));
    }
  }

  refuse(code: ErrorCode, reason: string): void {
    this.send({ v: 1, t: 'error', code, reason: clip(reason), fatal: false });
  }

  fail(code: ErrorCode, reason: string): void {
    const supported = code === 'UNSUPPORTED_VERSION' ? { supported: [...this.limits.PROTO_VERSIONS] } : {};
    this.send({ v: 1, t: 'error', code, reason: clip(reason), fatal: true, ...supported });
    this.close(CLOSE_CODE[code], code);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(code, reason);
    // A peer that never answers the close handshake would otherwise hold the socket open forever.
    setTimeout(() => this.ws.terminate(), 1000).unref();
    this.detach();
  }

  private detach(): void {
    this.closed = true;
    if (this.helloTimer !== null) clearTimeout(this.helloTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.helloTimer = null;
    this.idleTimer = null;
    if (this.room !== null) {
      this.room.leave(this);
      this.rooms.release(this.room);
      this.room = null;
    }
  }

  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(1008, 'idle'), SERVER_LIMITS.IDLE_TIMEOUT_MS);
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    this.touch();
    const now = Date.now();
    if (this.messagesPerSec.add(1, now)) {
      this.rateLimited(now);
      return;
    }
    if (isBinary) {
      this.badShape('binary frames are not accepted');
      return;
    }
    const bytes = toBytes(data);
    if (bytes.byteLength > this.limits.MAX_MESSAGE_BYTES) {
      this.refuse('TOO_LARGE', `frame of ${bytes.byteLength} bytes exceeds ${this.limits.MAX_MESSAGE_BYTES}`);
      return;
    }
    const decoded = decodeClient(bytes);
    if (!decoded.ok) {
      if (decoded.code === 'UNSUPPORTED_VERSION') this.fail(decoded.code, decoded.reason);
      else if (decoded.code === 'BAD_SHAPE') this.badShape(decoded.reason);
      else this.refuse(decoded.code, decoded.reason);
      return;
    }
    const message = decoded.value;
    if ((message.t === 'ops' && this.opsPerSec.add(message.ops.length, now)) || (message.t === 'presence' && this.presencePerSec.add(1, now)) || this.queued >= SERVER_LIMITS.MAX_QUEUED_FRAMES) {
      this.rateLimited(now);
      return;
    }
    this.queued++;
    this.chain = this.chain
      .then(() => this.handle(message))
      .catch((e: unknown) => this.internal(e))
      .finally(() => this.queued--);
  }

  private async handle(message: ClientMessage): Promise<void> {
    switch (message.t) {
      case 'hello':
        if (this.room === null) {
          const room = await this.acquire(message.doc);
          if (this.helloTimer !== null) clearTimeout(this.helloTimer);
          this.helloTimer = null;
          if (room === null) return;
          if (this.closed) {
            // Closed while the log was opening: the join must not resurrect the connection as a member.
            this.rooms.release(room);
            return;
          }
          this.room = room;
        }
        await this.room.join(this, message);
        return;
      case 'ops':
        if (this.room === null) this.fail('BAD_SHAPE', 'ops before hello');
        else await this.room.onOps(this, message.ops);
        return;
      case 'presence':
        if (this.room === null) this.fail('BAD_SHAPE', 'presence before hello');
        else this.room.onPresence(this, message.state);
        return;
      case 'ping':
        this.send({ v: 1, t: 'pong' });
        return;
    }
  }

  /** The room, or null after telling the client why there is none. A corrupt log is the operator's problem, not a transient the client should retry into (E26). */
  private async acquire(doc: string): Promise<Room | null> {
    try {
      return await this.rooms.acquire(doc);
    } catch (e) {
      if (!(e instanceof LogCorruptError)) throw e;
      this.fail('INTERNAL', 'the log for this document is corrupt and needs an operator; the server refuses it until repaired');
      return null;
    }
  }

  private badShape(reason: string): void {
    this.refuse('BAD_SHAPE', reason);
    if (this.badShapesPerMin.add(1, Date.now())) this.fail('RATE_LIMITED', 'too many malformed frames');
  }

  private rateLimited(now: number): void {
    if (this.warnings.add(now)) this.fail('RATE_LIMITED', 'rate limit exceeded after warnings');
    else this.refuse('RATE_LIMITED', `rate limit exceeded (warning ${this.warnings.current} of ${SERVER_LIMITS.RATE_WARNINGS})`);
  }

  private internal(e: unknown): void {
    this.warn(`internal error on ${this.replica ?? '(no hello)'}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    this.fail('INTERNAL', 'unexpected server error');
  }
}

function clip(reason: string): string {
  return reason.length > LIMITS.MAX_ERROR_REASON ? reason.slice(0, LIMITS.MAX_ERROR_REASON) : reason;
}

/** `ws` hands text frames over as a Buffer by default, but its type admits the other two shapes; one view for the codec. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
