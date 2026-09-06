// room.ts — every connection to one document. This file exists to hold the rules a dumb relay
// still enforces (design §3.7): an op's seq must be exactly known+1 for its replica (I9); an
// op may only depend on ids the server has already accepted (LLD E12/E21 — the CRDT-free check
// that keeps a hostile client from parking garbage in every peer forever); a connection may only
// send ops for the replica it said hello as (FOREIGN_REPLICA); and nothing is acknowledged or
// fanned out before the log's fsync has returned (I10). Catch-up is paced by the socket and
// live frames that arrive for a replica mid-catch-up are queued behind it, in order (E22).
// Presence is fanned out and forgotten. It must never import @weft/crdt (I14), never fill a
// gap, never acknowledge what is not durable, and never log presence.

import { LIMITS, type ClientMessage, type ErrorCode, type ItemId, type Op, type PresenceState, type ReplicaId, type ServerMessage, type StateVector } from '@weft/protocol';
import type { AppendLog } from './log/appendLog.ts';
import { SERVER_LIMITS } from './limits.ts';

/** What the room needs from a connection; the WebSocket lives behind it so the room can be driven by a test double. */
export interface Conn {
  replica: ReplicaId | null;
  /** A live frame: queued on the socket, subject to the slow-consumer cap. */
  send(message: ServerMessage): void;
  /** Catch-up frames: resolves once every one has been handed to the socket, pacing on its buffer instead of dropping the connection; resolves early when the connection closed. */
  sendMany(frames: readonly ServerMessage[]): Promise<void>;
  /** A non-fatal refusal: the connection stays open. */
  refuse(code: ErrorCode, reason: string): void;
  /** A fatal refusal: the error is sent, then the socket is closed with the code LLD §5.4 assigns; the room hears `leave` afterwards. */
  fail(code: ErrorCode, reason: string): void;
  /** The server is replacing this connection; no error, just the close. */
  close(code: number, reason: string): void;
}

export type HelloMsg = Extract<ClientMessage, { t: 'hello' }>;

export interface RoomOptions {
  quietMs?: number;
  /** Timers are injected so the quiet timer is testable without waiting; production uses the globals. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** All connections to one doc. Enforces per-replica seq contiguity (I9) and that a connection only sends ops for the replica it said hello as (FOREIGN_REPLICA). */
export class Room {
  private readonly members = new Map<Conn, PresenceState | null>();
  /** Members whose catch-up is still streaming, with the frames that arrived for them meanwhile; delivered in order once it ends. */
  private readonly catchingUp = new Map<Conn, ServerMessage[]>();
  private quietTimer: unknown = null;
  private readonly quietMs: number;
  private readonly timers: Required<Pick<RoomOptions, 'setTimeout' | 'clearTimeout'>>;
  private isFaulted = false;
  readonly doc: string;
  private readonly log: AppendLog;

  constructor(doc: string, log: AppendLog, options: RoomOptions = {}) {
    this.doc = doc;
    this.log = log;
    this.quietMs = options.quietMs ?? LIMITS.QUIET_MS;
    this.timers = {
      setTimeout: options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  get size(): number {
    return this.members.size;
  }

  /** True once an append failed: the file and memory may disagree, every member has been told to reconnect, and the room must be closed rather than reused (E24). */
  get faulted(): boolean {
    return this.isFaulted;
  }

  /** Resolves when the newcomer has received the whole diff; the caller serialises this with the connection's later frames. */
  async join(conn: Conn, hello: HelloMsg): Promise<void> {
    if (conn.replica !== null && (conn.replica !== hello.replica || hello.doc !== this.doc)) {
      // A second hello is the client's REHELLO after a SEQ_GAP (LLD §4) and is welcome; a second
      // hello with a different identity is not a client this room can reason about.
      conn.fail('BAD_SHAPE', 'hello changed the connection identity');
      return;
    }
    if (conn.replica === null) {
      conn.replica = hello.replica;
      this.members.set(conn, null);
      this.evictSameReplica(conn);
      for (const [peer, state] of this.members) {
        if (peer !== conn && state !== null) conn.send({ v: 1, t: 'presence', replica: peer.replica as ReplicaId, state });
      }
    }
    conn.send({ v: 1, t: 'welcome', sv: this.log.sv() });
    // E7: the whole diff as ops, in batches the protocol allows. For a fresh replica that is the
    // whole log. `read` is a snapshot of the durable log; anything appended after it reaches this
    // connection through the queue, so per-replica order is kept.
    const missing = this.log.read(hello.sv);
    const batches: ServerMessage[] = [];
    for (let i = 0; i < missing.length; i += SERVER_LIMITS.CATCHUP_BATCH) batches.push({ v: 1, t: 'ops', ops: missing.slice(i, i + SERVER_LIMITS.CATCHUP_BATCH) });
    this.catchingUp.set(conn, []);
    await conn.sendMany(batches);
    const queued = this.catchingUp.get(conn) ?? [];
    this.catchingUp.delete(conn);
    if (!this.members.has(conn)) return; // left, or was replaced, while the catch-up streamed
    for (const message of queued) conn.send(message);
    // ⟨D3⟩ for the newcomer alone (E31): its state vector now covers the server's, so it can
    // publish its hash; the room-wide timer is armed by ops, not by joins, so N joins cost N
    // frames rather than N².
    conn.send({ v: 1, t: 'quiet', sv: this.log.sv() });
  }

  /** The same replica connecting twice is almost always a reconnect racing a half-open socket; the newer connection is the live one. The newcomer is already a member, so the room never empties here. */
  private evictSameReplica(newcomer: Conn): void {
    for (const peer of [...this.members.keys()]) {
      if (peer !== newcomer && peer.replica === newcomer.replica) {
        this.leave(peer);
        peer.close(1008, 'replaced by a newer connection for this replica');
      }
    }
  }

  async onOps(conn: Conn, ops: Op[]): Promise<void> {
    const replica = conn.replica;
    if (replica === null) {
      conn.fail('BAD_SHAPE', 'ops before hello');
      return;
    }
    const fresh = this.contiguousFresh(conn, replica, ops);
    if (fresh === null) return;
    const last = (ops[ops.length - 1] as Op).id.seq;
    if (fresh.length === 0) {
      // A replay of ops already accepted: the client lost the ack (a reconnect mid-fsync, B1).
      // Acks are idempotent (E23), so it is answered again — once the tail of the log is durable.
      await this.log.settled();
      this.ack(conn, replica, Math.min(last, own(this.log.sv(), replica)));
      return;
    }
    try {
      await this.log.append(fresh);
    } catch (e) {
      this.fault(conn, e);
      return;
    }
    // Membership gates only the ack: the ops are durable, so every peer receives them even if the
    // sender has left (E23) — otherwise a peer would be "live" with a state vector behind the server.
    this.ack(conn, replica, (fresh[fresh.length - 1] as Op).id.seq);
    this.broadcast({ v: 1, t: 'ops', ops: fresh }, conn);
    this.armQuiet();
  }

  private ack(conn: Conn, replica: ReplicaId, seq: number): void {
    if (seq >= 1 && this.members.has(conn)) conn.send({ v: 1, t: 'ack', replica, seq });
  }

  /**
   * The ops that continue this replica's sequence, or null when the batch was refused. Ops at or
   * below the accepted seq are a replay and are skipped (the caller re-acknowledges them); the
   * first op past known+1 is a gap and stops the batch — every op after it would be a gap too. An
   * op depending on an id the server has not accepted (E12) refuses the whole batch: nothing it
   * would have appended could ever be applied by a peer. Any op with another replica's id is a
   * forgery and ends the connection.
   */
  private contiguousFresh(conn: Conn, replica: ReplicaId, ops: Op[]): Op[] | null {
    const fresh: Op[] = [];
    let known = this.log.accepted(replica);
    for (const op of ops) {
      if (op.id.replica !== replica) {
        conn.fail('FOREIGN_REPLICA', 'op carries another replica id');
        return null;
      }
      if (op.id.seq <= known) continue;
      if (op.id.seq !== known + 1) {
        conn.refuse('SEQ_GAP', `expected seq ${known + 1}, got ${op.id.seq}`);
        return fresh.length > 0 ? fresh : null;
      }
      for (const dep of dependenciesOf(op)) {
        // Validators admit a seq-0 id only for the root, which every replica holds.
        if (dep.seq === 0) continue;
        const accepted = dep.replica === replica ? known : this.log.accepted(dep.replica);
        if (dep.seq > accepted) {
          conn.refuse('UNKNOWN_DEPENDENCY', `op ${replica}:${op.id.seq} depends on ${dep.replica}:${dep.seq}, which the server has not accepted`);
          return null;
        }
      }
      fresh.push(op);
      known = op.id.seq;
    }
    return fresh;
  }

  /** The log cannot promise durability any more: everyone is told to reconnect, and the owner closes this room so the next hello re-derives the truth from the file. */
  private fault(sender: Conn, e: unknown): void {
    this.isFaulted = true;
    const name = e instanceof Error ? e.name : 'Error';
    for (const peer of [...this.members.keys()]) {
      peer.fail('INTERNAL', peer === sender ? `append failed: ${name}` : 'the document log faulted; reconnect');
    }
    this.members.clear();
    this.catchingUp.clear();
    this.disarmQuiet();
  }

  onPresence(conn: Conn, state: PresenceState | null): void {
    if (conn.replica === null) {
      conn.fail('BAD_SHAPE', 'presence before hello');
      return;
    }
    this.members.set(conn, state);
    this.broadcast({ v: 1, t: 'presence', replica: conn.replica, state }, conn);
  }

  leave(conn: Conn): void {
    this.catchingUp.delete(conn);
    if (!this.members.delete(conn)) return;
    if (conn.replica !== null) this.broadcast({ v: 1, t: 'presence', replica: conn.replica, state: null }, conn);
    if (this.members.size === 0) this.disarmQuiet();
  }

  private broadcast(message: ServerMessage, except: Conn): void {
    for (const peer of this.members.keys()) if (peer !== except) this.deliver(peer, message);
  }

  /** A member still receiving its catch-up gets live frames afterwards, in arrival order, so it never sees an op before the one it depends on. */
  private deliver(peer: Conn, message: ServerMessage): void {
    const queue = this.catchingUp.get(peer);
    if (queue === undefined) peer.send(message);
    else queue.push(message);
  }

  /** ⟨D3⟩ After `quietMs` without ops, every member hears the server's state vector and can publish its hash. */
  private armQuiet(): void {
    this.disarmQuiet();
    this.quietTimer = this.timers.setTimeout(() => {
      this.quietTimer = null;
      const sv: StateVector = this.log.sv();
      for (const peer of this.members.keys()) this.deliver(peer, { v: 1, t: 'quiet', sv });
    }, this.quietMs);
  }

  private disarmQuiet(): void {
    if (this.quietTimer !== null) this.timers.clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  /** Waits for in-flight appends and releases the file. Called when the last member leaves or the log faulted. */
  close(): Promise<void> {
    this.disarmQuiet();
    return this.log.close();
  }
}

/** The ids an op cannot be applied without — the same fact @weft/crdt's `opDependencies` states, restated here because the server may not import it (I14). */
function dependenciesOf(op: Op): readonly ItemId[] {
  switch (op.t) {
    case 'ins':
      return [op.parent];
    case 'del':
    case 'blk':
      return [op.target];
    case 'fmt':
      return op.targets;
  }
}

function own(sv: StateVector, replica: ReplicaId): number {
  return Object.hasOwn(sv, replica) ? ((sv as Readonly<Record<string, number>>)[replica] ?? 0) : 0;
}
