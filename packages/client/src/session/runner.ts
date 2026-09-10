// runner.ts — the only place in the client with IO: it owns the WebSocket (Node 22's and the
// browser's global `WebSocket`), the timers, and the store, feeds the pure session machine and
// executes its effects. This file exists to keep every ordering promise the design makes in one
// spot: a local op is applied, then persisted, then sent (I10 — `ws.send` happens-after
// `store.putOps` resolved); `unacked` is derived from the persisted seq and an acknowledgement
// that is monotonic within the current relay epoch (I11, E37); a lower welcome resets that epoch
// after relay data loss. Inbound ops go through `apply`, whose seq rule is the client-side
// I9, and a gap answers with a fresh hello; after catch-up, parked ops whose dependency the
// server counts but never created are dropped (E12) and a pending buffer past the limit ends the
// session as PENDING_OVERFLOW (E21); the content hash is published in presence after the
// server's `quiet`, together with the state vector it was computed for (D3, E27), and never for
// a document that has since changed. A hello whose welcome shows the server holding ops of THIS
// replica that this device does not have is a corrupt identity (FOREIGN_REPLICA, fatal, E13).
// S5 adds the awareness channel: this replica's PresenceState (name, colour, cursor as item
// anchors, and the content hash after `quiet`) is broadcast on a throttle separate from ops (a
// cursor storm costs at most one frame per PRESENCE_THROTTLE_MS), with a heartbeat so a still peer
// is not expired, and inbound presence maintains a peer table that a sweep expires at
// PRESENCE_TTL_MS. A socket close clears the table to "unknown", never to empty. Received hashes are
// compared to ours at equal state vectors: a mismatch latches the divergence tripwire (I13), which
// names the peer and clears only on an explicit dismissal. Presence is ephemeral — never persisted,
// never logged.
// The load decides how the session starts: the user's persisted Simulate-offline toggle or a
// browser that reports no network means `offline` without a socket, and the browser's `online` /
// `offline` events arrive as BROWSER_ONLINE / BROWSER_OFFLINE through an injectable Connectivity
// (LLD §4). It must never send before the store has resolved, never let a late event from a
// replaced socket reach the machine, never re-hello in a loop (E36), and never swallow a failure —
// a store error ends the session as `failed` with the reason (STORE_FAILED, E18), an unparseable
// frame is counted.

import { apply, dropPending, emptyDoc, pendingCount, svGet, unsatisfiablePending, type Doc, type Op, type ReplicaId, type StateVector } from '@weft/crdt';
import { decodeServer, encode, LIMITS, type ClientMessage, type PresenceState, type ServerMessage } from '@weft/protocol';
import { emptyHistory, recordUser, redo as redoHistory, undo as undoHistory, type UndoHistory } from '../history/undo.ts';
import { divergences, noDivergence, observeDivergence, type DivergedState } from '../inspector/divergence.ts';
import { hashDoc } from '../inspector/hash.ts';
import { emptyPeers, expirePeers, upsertPeer, type PeerTable } from '../presence/awareness.ts';
import { PRESENCE_HEARTBEAT_MS, PRESENCE_SWEEP_MS, PRESENCE_THROTTLE_MS } from '../presence/constants.ts';
import type { Store } from '../store/memoryStore.ts';
import type { Connectivity } from './connectivity.ts';
import { COMPACT_EVERY_OPS, PING_INTERVAL_MS, PONG_TIMEOUT_MS, REHELLO_MAX, REHELLO_WINDOW_MS } from './constants.ts';
import { initialSession, reduce, type Effect, type SessionEvent, type SessionState } from './machine.ts';

export interface RunnerOptions {
  url: string;
  doc: string;
  me: ReplicaId;
  store: Store;
  /** What peers see; the hash and its state vector are added by the runner. */
  presence: { name: string; color: number };
  /** Called after every observable change; the UI subscribes here. */
  onChange?: (snapshot: RunnerSnapshot) => void;
  /** Keep-alive periods, injectable so a test can provoke a pong timeout in milliseconds rather than seconds. */
  keepAlive?: { pingMs: number; pongMs: number };
  /** Presence timing, injectable so a test can force a heartbeat, a sweep and a TTL expiry in milliseconds rather than tens of seconds. Defaults to the presence constants and the protocol TTL. */
  presenceTiming?: { heartbeatMs: number; sweepMs: number; ttlMs: number };
  /** The user's Simulate-offline toggle as persisted: start `offline · user`, no socket (LLD §4). */
  offline?: boolean;
  /** The browser's network report; absent for a headless Node replica, which has no such thing. */
  connectivity?: Connectivity;
}

/** Everything the UI draws, as values: the session state, what this replica holds, and what it has heard. */
export interface RunnerSnapshot {
  readonly session: SessionState;
  readonly sv: StateVector;
  /** Ops parked for a dependency that has not arrived — the Inspector shows it. Dead ones are dropped after every catch-up (E12). */
  readonly pending: number;
  /** SHA-256 of canonicalBytes as published after the last `quiet` whose sv matched ours; null while stale. */
  readonly hash: string | null;
  /** Known peers with their last-seen and last-moved timestamps — empty when disconnected (the UI reads `session` to tell "alone" from "unknown"). */
  readonly peers: PeerTable;
  /** The latched divergence tripwire (I13): which peers disagreed at an equal state vector; empty means the wire has not tripped. */
  readonly diverged: DivergedState;
  readonly lastQuiet: StateVector | null;
  /** Frames from the server that did not validate, or ops `apply` refused for shape: counted, never hidden. */
  readonly ignored: number;
  /** The last `supported` list a version error carried, for the error card. */
  readonly supported: readonly number[] | null;
  /** How many operations this replica's op log holds — the time-travel slider's maximum (03-UI §4.6). */
  readonly historyLength: number;
  /** Whether there is a local action to undo / redo (I13-adjacent: local-only, this replica's own ops). */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface Runner {
  readonly doc: Doc;
  snapshot(): RunnerSnapshot;
  /** Run a local edit through @weft/crdt's local.ts against the current doc and next seq; applied, persisted, then sent. Recorded on the undo stack. */
  local(edit: (doc: Doc, me: ReplicaId, nextSeq: number) => { ops: readonly Op[]; doc: Doc }): Promise<void>;
  /** Undo this replica's most recent local action by emitting real inverse ops (design §0 A3); a no-op when the stack is empty. */
  undo(): Promise<void>;
  /** Redo the most recently undone action. */
  redo(): Promise<void>;
  /** The time-travel op log (03-UI §4.6): the document this session opened with, and the ops applied since, in application order. `replayTo(base, ops, n)` is the document at slider position `n`. */
  history(): { base: Doc; ops: readonly Op[] };
  dispatch(ev: SessionEvent): void;
  /** The editor reports the local caret as item anchors; the runner broadcasts it, throttled. `undefined` withdraws the cursor (e.g. the editor lost focus). */
  setCursor(cursor: PresenceState['cursor']): void;
  /** Change the display name peers see (03-UI §4.8 "Set my name"). Presence-only and ephemeral — never persisted, never a document op — re-broadcast at once when live. */
  setName(name: string): void;
  /** Clear the divergence tripwire — the explicit action I13 requires. The alarm re-latches only if a peer publishes a differing hash again. */
  dismissDivergence(): void;
  /** Feed a presence frame in as if it came from the server. The runner uses it for the server's own frames; exposed so the demo/e2e can inject a divergent peer to exercise the tripwire (it never touches the document). */
  receivePresence(replica: ReplicaId, state: PresenceState | null): void;
  /** Chaos control (03-UI §4.5): drop the next `n` inbound op frames, opening a seq gap the client repairs with a re-hello — the "N in flight" then "converged" the demo shows. */
  dropNext(n: number): void;
  /** Chaos control: delay every outbound frame by `ms`, so a peer sits visibly behind before it catches up. 0 turns it off. */
  setDelay(ms: number): void;
  hash(): Promise<string>;
  close(): Promise<void>;
}

export async function startRunner(options: RunnerOptions): Promise<Runner> {
  const loaded = await options.store.load();
  if (loaded !== null && loaded.me !== options.me) throw new Error(`store belongs to replica ${loaded.me}, not ${options.me}`);
  const runner = new SessionRunner(options, loaded === null ? emptyDoc() : loaded.doc, loaded === null ? 0 : svGet(loaded.acked, options.me));
  runner.dispatch(startEvent(options));
  return runner;
}

/** The user's choice outranks the browser's report, and either keeps the socket closed from the first frame. */
function startEvent(options: RunnerOptions): SessionEvent {
  if (options.offline === true) return { e: 'START', offline: 'user' };
  if (options.connectivity !== undefined && !options.connectivity.online) return { e: 'START', offline: 'browser' };
  return { e: 'START' };
}

class SessionRunner implements Runner {
  doc: Doc;
  private state: SessionState = initialSession;
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server's sv from the current welcome; catch-up is done when ours covers it. */
  private welcomeSv: StateVector | null = null;
  /** My highest seq the store has confirmed, and my highest seq sent on the current socket. */
  private persistedUpTo: number;
  private sentUpTo = 0;
  /** My highest seq in the current server view. ACKs only move forward within one socket; a new welcome may lower this after relay data loss. */
  private acked: number;
  /** When each REHELLO on the current socket was sent, within the window; a loop is a failure, not a repair (E36). */
  private rehellos: number[] = [];
  private peers: PeerTable = emptyPeers;
  private diverged: DivergedState = noDivergence;
  /** The local caret as item anchors, resent on the heartbeat; undefined when the editor has withdrawn it. */
  private localCursor: PresenceState['cursor'];
  /** When the last presence frame went out and whether a throttled trailing send is pending. */
  private lastPresenceAt = 0;
  private presenceTrailing: ReturnType<typeof setTimeout> | null = null;
  private presenceSweep: ReturnType<typeof setInterval> | null = null;
  private lastQuiet: StateVector | null = null;
  private hashValue: string | null = null;
  /** Chaos (03-UI §4.5): inbound op frames still to drop, and an outbound delay in ms. Demo/test affordances; both default off. */
  private dropOps = 0;
  private delayMs = 0;
  private ignored = 0;
  private supported: readonly number[] | null = null;
  /** Local-only undo/redo stacks (design §0 A3): this replica's own actions, each invertible into real ops. */
  private undoState: UndoHistory = emptyHistory;
  /** The time-travel base (the doc this session opened with) and the ops applied since, in order (03-UI §4.6). */
  private readonly historyBase: Doc;
  private readonly log: Op[] = [];
  /** Operations applied since the last snapshot; a compaction is triggered when it reaches COMPACT_EVERY_OPS (D4). */
  private opsSinceCompact = 0;
  private compacting = false;
  private readonly queue: SessionEvent[] = [];
  private reducing = false;
  private readonly options: RunnerOptions;
  private readonly presenceTiming: { heartbeatMs: number; sweepMs: number; ttlMs: number };
  private readonly unsubscribeConnectivity: () => void;

  constructor(options: RunnerOptions, doc: Doc, acked: number) {
    this.options = options;
    this.presenceTiming = options.presenceTiming ?? { heartbeatMs: PRESENCE_HEARTBEAT_MS, sweepMs: PRESENCE_SWEEP_MS, ttlMs: LIMITS.PRESENCE_TTL_MS };
    this.doc = doc;
    this.historyBase = doc; // time travel folds this session's ops onto the doc it opened with (empty for a fresh document)
    this.persistedUpTo = svGet(doc.sv, options.me);
    this.acked = acked;
    this.unsubscribeConnectivity = options.connectivity?.subscribe((online) => this.dispatch({ e: online ? 'BROWSER_ONLINE' : 'BROWSER_OFFLINE' })) ?? (() => undefined);
    // The offline count is honest from the first frame: persisted minus acknowledged, from the store (I11).
    if (this.persistedUpTo > 0) this.dispatch({ e: 'ACK', upToSeq: acked, mySeq: this.persistedUpTo });
  }

  snapshot(): RunnerSnapshot {
    return { session: this.state, sv: this.doc.sv, pending: pendingCount(this.doc), hash: this.hashValue, peers: this.peers, diverged: this.diverged, lastQuiet: this.lastQuiet, ignored: this.ignored, supported: this.supported, historyLength: this.log.length, canUndo: this.undoState.undo.length > 0, canRedo: this.undoState.redo.length > 0 };
  }

  history(): { base: Doc; ops: readonly Op[] } {
    return { base: this.historyBase, ops: this.log };
  }

  /** Events are reduced one at a time even when an effect dispatches another, so the machine never sees an interleaving. */
  dispatch(ev: SessionEvent): void {
    this.queue.push(ev);
    if (this.reducing) return;
    this.reducing = true;
    for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
      const before = this.state;
      const { state, effects } = reduce(before, next, Date.now());
      this.state = state;
      for (const effect of effects) this.run(effect);
      if (state.s === 'live' && before.s !== 'live') this.wentLive();
    }
    this.reducing = false;
    this.notify();
  }

  async local(edit: (doc: Doc, me: ReplicaId, nextSeq: number) => { ops: readonly Op[]; doc: Doc }): Promise<void> {
    const before = this.doc;
    const { ops, doc } = edit(this.doc, this.options.me, svGet(this.doc.sv, this.options.me) + 1);
    // Remember how to invert this action before it is committed; a new edit also forgets the redo stack.
    this.undoState = recordUser(this.undoState, before, ops);
    await this.commit(ops, doc);
  }

  async undo(): Promise<void> {
    const r = undoHistory(this.undoState, this.doc, this.options.me, svGet(this.doc.sv, this.options.me) + 1);
    if (r === null) {
      this.notify();
      return;
    }
    this.undoState = r.history;
    // The inverse ops are real local ops: persisted, sent, and shown by the editor as any change (I7).
    // A store failure has already ended the session (storeFailed), so the rejection is not rethrown here.
    await this.commit(r.ops, r.doc).catch(() => undefined);
  }

  async redo(): Promise<void> {
    const r = redoHistory(this.undoState, this.doc, this.options.me, svGet(this.doc.sv, this.options.me) + 1);
    if (r === null) {
      this.notify();
      return;
    }
    this.undoState = r.history;
    await this.commit(r.ops, r.doc).catch(() => undefined);
  }

  /** Apply-persist-send for a set of local ops (a user edit, an undo or a redo): the doc is already the result of applying them; here they are logged for time travel, persisted before send (I10), and counted toward compaction. */
  private async commit(ops: readonly Op[], doc: Doc): Promise<void> {
    this.doc = doc;
    this.hashValue = null;
    if (ops.length === 0) {
      this.notify(); // an empty undo/redo still changes canUndo/canRedo
      return;
    }
    for (const op of ops) this.log.push(op);
    try {
      await this.options.store.putOps(ops);
    } catch (e) {
      // The session must know too (S3): the pill turns to `failed` rather than keep saying "Saved".
      this.storeFailed(e);
      throw e;
    }
    this.persistedUpTo = Math.max(this.persistedUpTo, (ops[ops.length - 1] as Op).id.seq);
    this.opsSinceCompact += ops.length;
    this.dispatch({ e: 'LOCAL_OPS_PERSISTED', count: ops.length });
    if (this.state.s === 'live') this.flushOwn();
    this.maybeCompact();
  }

  hash(): Promise<string> {
    return hashDoc(this.doc);
  }

  async close(): Promise<void> {
    const ws = this.ws;
    // Node 22's WebSocket, closed while CONNECTING, emits `error` synchronously and never `close`;
    // waiting for a close event there would hang forever (E39). Only a socket that reached OPEN owes us one.
    const owesClose = ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING);
    this.unsubscribeConnectivity();
    this.dispatch({ e: 'USER_OFFLINE' });
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (ws !== null && owesClose) {
      await new Promise<void>((done) => {
        ws.addEventListener('close', () => done(), { once: true });
        ws.addEventListener('error', () => done(), { once: true });
      });
    }
  }

  private run(effect: Effect): void {
    switch (effect.f) {
      case 'OPEN_SOCKET':
        this.openSocket();
        return;
      case 'CLOSE_SOCKET':
        this.closeSocket(effect.code);
        return;
      case 'SEND_HELLO':
        this.sendHello();
        return;
      case 'REHELLO':
        if (this.rehelloLoop()) return;
        this.sendHello();
        return;
      case 'SEND_OPS_SINCE':
        // The server said how much of mine it holds; everything after that is re-sent on this socket.
        this.sentUpTo = svGet(effect.sv, this.options.me);
        this.flushOwn();
        return;
      case 'SCHEDULE':
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.dispatch({ e: 'TIMER', now: Date.now() }), Math.max(0, effect.at - Date.now()));
        return;
    }
  }

  private sendHello(): void {
    this.welcomeSv = null;
    this.send({ v: 1, t: 'hello', doc: this.options.doc, replica: this.options.me, sv: this.doc.sv });
  }

  /** True — and the session failed — when this socket has re-helloed more than REHELLO_MAX times within the window: the state-vector exchange is not repairing anything. */
  private rehelloLoop(): boolean {
    const now = Date.now();
    this.rehellos = [...this.rehellos.filter((at) => now - at < REHELLO_WINDOW_MS), now];
    if (this.rehellos.length <= REHELLO_MAX) return false;
    this.dispatch({ e: 'SERVER_ERROR', code: 'SEQ_GAP', fatal: true, reason: `REHELLO_LOOP: ${this.rehellos.length} re-hellos in ${REHELLO_WINDOW_MS / 1000} s; the server keeps refusing this replica's ops` });
    return true;
  }

  private openSocket(): void {
    const ws = new WebSocket(this.options.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.rehellos = [];
    // Every handler checks that this socket is still the current one: a replaced socket's late
    // close or error must not be mistaken for the new socket's.
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.startKeepAlive();
      this.dispatch({ e: 'SOCKET_OPEN' });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ws === this.ws) this.receive(ev.data as string | ArrayBuffer);
    };
    ws.onclose = (ev: { code: number; reason: string }) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.stopKeepAlive();
      this.clearPeers();
      this.dispatch({ e: 'SOCKET_CLOSED', code: ev.code, reason: ev.reason });
    };
    ws.onerror = () => {
      if (ws === this.ws) this.dispatch({ e: 'SOCKET_ERROR', reason: 'socket error' });
    };
  }

  private closeSocket(code: number): void {
    const ws = this.ws;
    this.ws = null;
    this.stopKeepAlive();
    this.clearPeers();
    if (ws !== null && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(code);
  }

  dropNext(n: number): void {
    this.dropOps = Math.max(0, Math.trunc(n));
  }

  setDelay(ms: number): void {
    this.delayMs = Math.max(0, Math.trunc(ms));
  }

  private send(message: ClientMessage): void {
    const frame = encode(message);
    const flush = (): void => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
    };
    // Equal delays fire FIFO, so the on-wire order is preserved; a live-only check at flush time
    // drops a frame whose socket closed during the delay rather than throwing.
    if (this.delayMs > 0) setTimeout(flush, this.delayMs);
    else flush();
  }

  /** Own ops the current socket has not carried yet, in ≤ MAX_OPS_PER_MESSAGE batches. Only persisted ops are eligible (I10). */
  private flushOwn(): void {
    if (this.persistedUpTo <= this.sentUpTo) return;
    const ops = this.options.store.opLog().get(this.options.me, this.sentUpTo + 1, this.persistedUpTo);
    for (let i = 0; i < ops.length; i += LIMITS.MAX_OPS_PER_MESSAGE) this.send({ v: 1, t: 'ops', ops: ops.slice(i, i + LIMITS.MAX_OPS_PER_MESSAGE) });
    this.sentUpTo = this.persistedUpTo;
  }

  private wentLive(): void {
    this.flushOwn();
    this.sendPresenceNow();
  }

  setCursor(cursor: PresenceState['cursor']): void {
    this.localCursor = cursor;
    this.schedulePresence();
  }

  setName(name: string): void {
    this.options.presence.name = name;
    // A name is not throttled with cursor storms: it changes rarely, so send it immediately when live.
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.sendPresenceNow();
    this.notify();
  }

  dismissDivergence(): void {
    this.diverged = noDivergence;
    this.notify();
  }

  receivePresence(replica: ReplicaId, state: PresenceState | null): void {
    this.peers = upsertPeer(this.peers, replica, state, Date.now());
    this.recomputeDivergence();
    this.notify();
  }

  /** The full presence frame this replica publishes: name and colour always, the cursor when it has one, and the hash + its state vector only while the hash still describes the current document (E27). */
  private buildPresence(): PresenceState {
    const { name, color } = this.options.presence;
    const state: PresenceState = { name, color };
    if (this.localCursor !== undefined) state.cursor = this.localCursor;
    // hashValue is cleared on every doc change, so a non-null hash always matches doc.sv, which the last quiet named.
    if (this.hashValue !== null && this.lastQuiet !== null) {
      state.hash = this.hashValue;
      state.sv = this.doc.sv;
    }
    return state;
  }

  private sendPresenceNow(): void {
    if (this.presenceTrailing !== null) {
      clearTimeout(this.presenceTrailing);
      this.presenceTrailing = null;
    }
    this.lastPresenceAt = Date.now();
    this.send({ v: 1, t: 'presence', state: this.buildPresence() });
  }

  /** Presence is throttled separately from ops (LLD §8 S5): send at most once per PRESENCE_THROTTLE_MS, with a trailing send so the final cursor position is never dropped. */
  private schedulePresence(): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    const wait = this.lastPresenceAt + PRESENCE_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      this.sendPresenceNow();
      return;
    }
    if (this.presenceTrailing === null) this.presenceTrailing = setTimeout(() => this.sendPresenceNow(), wait);
  }

  private recomputeDivergence(): void {
    this.diverged = observeDivergence(this.diverged, divergences(this.peers, this.doc.sv, this.hashValue));
  }

  private receive(data: string | ArrayBuffer): void {
    const decoded = decodeServer(typeof data === 'string' ? data : new Uint8Array(data));
    if (!decoded.ok) {
      this.ignored++; // forward compatibility: an unknown or malformed frame is counted, never fatal (LLD §5.2)
      this.notify();
      return;
    }
    // Chaos: swallow the next N op frames, opening a seq gap the client repairs by re-hello (honest — the ops are re-sent on catch-up, not lost).
    if (decoded.value.t === 'ops' && this.dropOps > 0) {
      this.dropOps--;
      this.ignored++;
      this.notify();
      return;
    }
    this.handle(decoded.value);
  }

  private handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.welcomed(message.sv);
        return;
      case 'ops':
        this.inbound(message.ops);
        return;
      case 'ack':
        if (message.replica === this.options.me) this.ackedUpTo(message.seq);
        return;
      case 'presence':
        this.receivePresence(message.replica, message.state);
        return;
      case 'quiet':
        this.lastQuiet = message.sv;
        if (covers(this.doc.sv, message.sv) && covers(message.sv, this.doc.sv) && pendingCount(this.doc) === 0) void this.publishHash();
        this.notify();
        return;
      case 'error':
        if (message.supported !== undefined) this.supported = message.supported;
        this.dispatch({ e: 'SERVER_ERROR', code: message.code, fatal: message.fatal, reason: message.reason });
        return;
      case 'pong':
        if (this.pongTimer !== null) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
    }
  }

  private welcomed(theirSv: StateVector): void {
    const theirs = svGet(theirSv, this.options.me);
    if (theirs > this.persistedUpTo) {
      this.dispatch({ e: 'SERVER_ERROR', code: 'FOREIGN_REPLICA', fatal: true, reason: 'the server holds ops of this replica that this device does not: the replica id was reused with another store' });
      return;
    }
    this.welcomeSv = theirSv;
    // A welcome is the durable baseline for this relay epoch. If a restarted relay lost its log,
    // an older acknowledgement must not render Saved while retained own ops are being re-uploaded.
    this.acked = theirs;
    this.dispatch({ e: 'WELCOME', theirSv, mySv: this.doc.sv });
    this.ackedUpTo(theirs); // the server's sv IS an acknowledgement of everything of mine it holds
    this.checkCatchUp();
  }

  private inbound(ops: readonly Op[]): void {
    const fresh: Op[] = [];
    for (const op of ops) {
      const result = apply(this.doc, op);
      this.doc = result.doc;
      if (result.kind === 'rejected') {
        if (result.reason === 'SEQ_GAP') {
          // Client-side I9: the server skipped a seq for some replica; a fresh state-vector exchange repairs it.
          this.dispatch({ e: 'SERVER_ERROR', code: 'SEQ_GAP', fatal: false, reason: `inbound gap at ${op.id.replica}:${op.id.seq}` });
          break;
        }
        this.ignored++;
      } else if (result.kind !== 'duplicate') fresh.push(op);
    }
    this.hashValue = null;
    if (fresh.length > 0) {
      for (const op of fresh) this.log.push(op); // time travel folds every op this replica applied, mine and peers'
      this.opsSinceCompact += fresh.length;
      this.options.store.putOps(fresh).catch((e: unknown) => this.storeFailed(e));
    }
    if (this.state.s === 'live') this.checkPendingBound();
    this.checkCatchUp();
    this.maybeCompact();
    this.notify();
  }

  /**
   * IndexedDB compaction (D4, LLD §7 S7): every COMPACT_EVERY_OPS operations, snapshot the current
   * doc and prune the covered FOREIGN ops in ONE transaction (own ops are never pruned — E38). A
   * single compaction runs at a time; ops that arrive while it is in flight are applied and persisted
   * on their own and carry higher seqs than the snapshot covers, so nothing is lost (§8 S7).
   */
  private maybeCompact(): void {
    if (this.compacting || this.opsSinceCompact < COMPACT_EVERY_OPS) return;
    this.opsSinceCompact = 0;
    this.compacting = true;
    const doc = this.doc;
    this.options.store
      .compact(doc)
      .catch((e: unknown) => this.storeFailed(e))
      .finally(() => {
        this.compacting = false;
      });
  }

  private ackedUpTo(seq: number): void {
    this.acked = Math.max(this.acked, seq);
    if (seq > 0) this.options.store.markAcked({ [this.options.me]: seq } as StateVector).catch((e: unknown) => this.storeFailed(e));
    this.dispatch({ e: 'ACK', upToSeq: this.acked, mySeq: this.persistedUpTo });
  }

  /** A store that cannot write is the one failure the offline story cannot absorb: say so, terminally (E18), rather than keep editing into the void. */
  private storeFailed(e: unknown): void {
    this.dispatch({ e: 'STORE_FAILED', reason: `store failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  /**
   * Catch-up is complete once ours covers the welcome's sv. Then every dependency the server counts
   * has either arrived or never created an item (an id of a non-insert op — the author's bug); ops
   * parked on the latter would wait forever and are dropped (E12). What is still parked is bounded (E21).
   */
  private checkCatchUp(): void {
    if (this.state.s !== 'syncing' || this.welcomeSv === null || !covers(this.doc.sv, this.welcomeSv)) return;
    this.doc = dropPending(this.doc, unsatisfiablePending(this.doc, this.welcomeSv));
    if (this.checkPendingBound()) return;
    this.dispatch({ e: 'CATCHUP_DONE' });
  }

  /** True — and the session failed — when more ops are parked than the protocol allows (LLD §5.4 PENDING_OVERFLOW); USER_ONLINE re-hellos. */
  private checkPendingBound(): boolean {
    const parked = pendingCount(this.doc);
    if (parked <= LIMITS.MAX_PENDING_PER_REPLICA) return false;
    this.dispatch({ e: 'SERVER_ERROR', code: 'PENDING_OVERFLOW', fatal: true, reason: `${parked} ops are parked for dependencies that never arrived (limit ${LIMITS.MAX_PENDING_PER_REPLICA})` });
    return true;
  }

  /** The hash is a statement about ONE document (the one the last `quiet` named): if the doc changed while the digest ran, the result is not published (E27). */
  private async publishHash(): Promise<void> {
    const doc = this.doc;
    const hash = await hashDoc(doc);
    if (this.doc !== doc) return;
    this.hashValue = hash;
    this.sendPresenceNow();
    // Our own hash is now known: a peer that already published a differing hash at this sv trips the wire.
    this.recomputeDivergence();
    this.notify();
  }

  private startKeepAlive(): void {
    const { pingMs, pongMs } = this.options.keepAlive ?? { pingMs: PING_INTERVAL_MS, pongMs: PONG_TIMEOUT_MS };
    this.stopKeepAlive();
    this.pingTimer = setInterval(() => {
      this.send({ v: 1, t: 'ping' });
      if (this.pongTimer === null) this.pongTimer = setTimeout(() => this.dispatch({ e: 'SOCKET_ERROR', reason: 'pong timeout' }), pongMs);
    }, pingMs);
    this.presenceSweep = setInterval(() => this.sweepPresence(), this.presenceTiming.sweepMs);
  }

  /** Expire peers gone quiet past the TTL, and re-publish our own presence on the heartbeat so a still peer does not expire us. */
  private sweepPresence(): void {
    const now = Date.now();
    const expired = expirePeers(this.peers, now, this.presenceTiming.ttlMs);
    if (expired !== this.peers) {
      this.peers = expired;
      this.notify();
    }
    if (now - this.lastPresenceAt >= this.presenceTiming.heartbeatMs) this.sendPresenceNow();
  }

  private stopKeepAlive(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    if (this.presenceSweep !== null) clearInterval(this.presenceSweep);
    if (this.presenceTrailing !== null) clearTimeout(this.presenceTrailing);
    this.pingTimer = null;
    this.pongTimer = null;
    this.presenceSweep = null;
    this.presenceTrailing = null;
  }

  /** A closed socket makes the peer table stale: it is cleared so the UI shows "Peers unknown", never "Only you" (honest degradation). The divergence latch is NOT cleared — a fault, once seen, waits for an explicit dismissal (I13). */
  private clearPeers(): void {
    if (this.peers === emptyPeers) return;
    this.peers = emptyPeers;
    this.notify();
  }

  private notify(): void {
    this.options.onChange?.(this.snapshot());
  }
}

/** True when `mine` holds at least everything `theirs` names. */
function covers(mine: StateVector, theirs: StateVector): boolean {
  return Object.keys(theirs).every((replica) => svGet(mine, replica) >= svGet(theirs, replica));
}
