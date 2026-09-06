// room.test.ts — the Room's rules against a Conn double and the real log over a fake fs: seq
// contiguity (I9); the E12 dependency rule (UNKNOWN_DEPENDENCY, the whole batch refused, nothing
// stored); a replay that is re-acknowledged (acks are idempotent, E23) but never re-fanned-out or
// re-appended; the FOREIGN_REPLICA forgery; the ack that waits for fsync (I10) — proven by gating
// the fake fs's sync; durable ops reaching peers even when the sender left mid-fsync (E23); a
// failed fsync faulting the room for every member with the claims rolled back (E24); catch-up
// as a paced stream with live frames queued behind it in order and a unicast quiet for the
// joiner (E22, E31); re-hello, identity change, eviction of a stale connection, presence fan-out,
// and the quiet timer driven by injected timers.
import { describe, expect, it } from 'vitest';
import type { Op, ReplicaId } from '@weft/protocol';
import { openAppendLog } from '../src/log/appendLog.ts';
import { Room } from '../src/room.ts';
import { chain, DOC, FakeConn, FakeFs, hello, id, ins, R, ROOT, settle } from './helpers.ts';

type HelloMsg = Extract<ReturnType<typeof hello>, { t: 'hello' }>;

async function roomWith(fs = new FakeFs(), timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }) {
  const log = await openAppendLog('/data/doc.jsonl', fs, () => undefined);
  const room = new Room(DOC, log, { quietMs: 5, ...timers });
  return { room, log, fs };
}

async function joined(room: Room, replica: ReplicaId, sv: Record<string, number> = {}): Promise<FakeConn> {
  const conn = new FakeConn();
  await room.join(conn, hello(replica, sv) as HelloMsg);
  return conn;
}

const types = (conn: FakeConn): string[] => conn.sent.map((m) => (m.t === 'error' ? `error:${m.code}` : m.t === 'ack' ? `ack:${m.seq}` : m.t === 'ops' ? `ops:${m.ops.length}` : m.t));

describe('join and welcome (E7: no snapshot, the diff as ops; E31: a quiet for the joiner)', () => {
  it('welcomes with the durable state vector, streams exactly what the hello lacked in ≤ 512-op batches, then tells the joiner alone the state vector it now covers', async () => {
    const { room, log } = await roomWith();
    await log.append(chain(R.a, 1, 1030));
    const conn = await joined(room, R.b, { [R.a]: 5 });
    const [welcome, ...rest] = conn.sent;
    expect(welcome).toEqual({ v: 1, t: 'welcome', sv: { [R.a]: 1030 } });
    expect(types(conn)).toEqual(['welcome', 'ops:512', 'ops:512', 'ops:1', 'quiet']);
    expect(rest[0]?.t === 'ops' && rest[0].ops[0]).toEqual(ins(R.a, 6));
    expect(conn.sent.at(-1)).toEqual({ v: 1, t: 'quiet', sv: { [R.a]: 1030 } });
    expect(room.size).toBe(1);
  });

  it('a second hello from the same identity is a re-sync: another welcome, no error', async () => {
    const { room } = await roomWith();
    const conn = await joined(room, R.a);
    await room.join(conn, hello(R.a) as HelloMsg);
    expect(conn.ofType('welcome')).toHaveLength(2);
    expect(conn.ofType('error')).toEqual([]);
    expect(room.size).toBe(1);
  });

  it('a second hello with a different replica or doc is BAD_SHAPE fatal', async () => {
    const { room } = await roomWith();
    const conn = await joined(room, R.a);
    await room.join(conn, hello(R.b) as HelloMsg);
    expect(conn.ofType('error')).toEqual([expect.objectContaining({ code: 'BAD_SHAPE', fatal: true })]);
    const other = await joined(room, R.b);
    await room.join(other, hello(R.b, {}, 'another-doc') as HelloMsg);
    expect(other.ofType('error')).toEqual([expect.objectContaining({ code: 'BAD_SHAPE', fatal: true })]);
    expect(other.closes).toEqual([{ code: 1008, reason: 'BAD_SHAPE' }]);
  });

  it('a newer connection for the same replica evicts the older one and the room never empties in between', async () => {
    const { room } = await roomWith();
    const stale = await joined(room, R.a);
    const peer = await joined(room, R.b);
    const fresh = await joined(room, R.a);
    expect(stale.closes).toEqual([{ code: 1008, reason: expect.stringContaining('replaced') }]);
    expect(room.size).toBe(2);
    expect(fresh.closes).toEqual([]);
    // The peer hears the stale one leave (presence null) — not a duplicate identity.
    expect(peer.ofType('presence')).toEqual([{ v: 1, t: 'presence', replica: R.a, state: null }]);
  });

  it('E22: live ops that arrive while a joiner is still receiving its catch-up are delivered after it, in order', async () => {
    const { room, log } = await roomWith();
    await log.append(chain(R.a, 1, 600));
    const a = await joined(room, R.a);
    const slow = new FakeConn();
    let open = (): void => undefined;
    slow.catchUpGate = new Promise((r) => (open = r));
    const joining = room.join(slow, hello(R.b) as HelloMsg);
    await settle();
    expect(types(slow)).toEqual(['welcome']); // the catch-up is still on its way
    await room.onOps(a, chain(R.a, 601, 602));
    room.onPresence(a, { name: 'Ada', color: 1 });
    expect(types(slow)).toEqual(['welcome']); // nothing live overtakes the catch-up
    open();
    await joining;
    expect(types(slow)).toEqual(['welcome', 'ops:512', 'ops:88', 'ops:2', 'presence', 'quiet']);
    expect(slow.ofType('ops').flatMap((m) => m.ops.map((op) => op.id.seq))).toEqual(Array.from({ length: 602 }, (_, i) => i + 1));
  });

  it('E22: a joiner that leaves mid-catch-up receives nothing more and is not a member', async () => {
    const { room, log } = await roomWith();
    await log.append(chain(R.a, 1, 10));
    const slow = new FakeConn();
    let open = (): void => undefined;
    slow.catchUpGate = new Promise((r) => (open = r));
    const joining = room.join(slow, hello(R.b) as HelloMsg);
    await settle();
    room.leave(slow);
    open();
    await joining;
    expect(types(slow)).toEqual(['welcome', 'ops:10']); // the frames already handed to the socket; no quiet, no queue
    expect(room.size).toBe(0);
  });

  it('E31: N joins cost N quiet frames, not N² — joins never arm the room-wide timer', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const { room } = await roomWith(new FakeFs(), { setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => undefined });
    const members: FakeConn[] = [];
    for (let i = 0; i < 10; i++) members.push(await joined(room, `b${'a'.repeat(11)}${'bcdefghijklmn'[i] as string}` as ReplicaId));
    expect(timers).toEqual([]);
    expect(members.reduce((n, m) => n + m.ofType('quiet').length, 0)).toBe(10);
    for (const m of members) expect(m.ofType('quiet')).toEqual([{ v: 1, t: 'quiet', sv: {} }]);
  });
});

describe('ops: contiguity (I9), replay, forgery', () => {
  it('acks the last seq of a contiguous batch and fans the ops out to every other member only', async () => {
    const { room } = await roomWith();
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    const c = await joined(room, R.c);
    await room.onOps(a, chain(R.a, 1, 3));
    expect(a.ofType('ack')).toEqual([{ v: 1, t: 'ack', replica: R.a, seq: 3 }]);
    expect(a.ofType('ops')).toEqual([]);
    expect(b.ofType('ops')).toEqual([{ v: 1, t: 'ops', ops: chain(R.a, 1, 3) }]);
    expect(c.ofType('ops')).toEqual([{ v: 1, t: 'ops', ops: chain(R.a, 1, 3) }]);
  });

  it('attack: replaying already-acked ops is re-acknowledged (acks are idempotent, E23) but produces no fan-out and no log growth', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    await room.onOps(a, chain(R.a, 1, 400));
    const before = { fanout: b.ofType('ops').length, length: log.length() };
    await room.onOps(a, chain(R.a, 1, 400));
    await room.onOps(a, chain(R.a, 100, 250));
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([400, 400, 250]);
    expect(b.ofType('ops')).toHaveLength(before.fanout);
    expect(log.length()).toBe(before.length);
    expect(a.ofType('error')).toEqual([]);
  });

  it('E23 (B1): a reconnect whose store holds ops still being fsynced by the old socket re-sends them and is acknowledged once they are durable', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const { room, log } = await roomWith(fs);
    const a1 = await joined(room, R.a);
    const b = await joined(room, R.b);
    const inflight = room.onOps(a1, chain(R.a, 1, 3));
    await settle();
    const a2 = await joined(room, R.a, { [R.a]: 3 });
    expect(a2.ofType('welcome')).toEqual([{ v: 1, t: 'welcome', sv: {} }]); // durable only: the batch is not synced yet
    expect(a1.closes).toEqual([{ code: 1008, reason: expect.stringContaining('replaced') }]);
    const resend = room.onOps(a2, chain(R.a, 1, 3)); // everything ≤ accepted: a replay, answered after the tail is durable
    await settle();
    expect(a2.ofType('ack')).toEqual([]);
    release();
    await Promise.all([inflight, resend]);
    expect(a2.ofType('ack')).toEqual([{ v: 1, t: 'ack', replica: R.a, seq: 3 }]);
    expect(a1.ofType('ack')).toEqual([]); // evicted before the fsync returned
    expect(b.ofType('ops')).toEqual([{ v: 1, t: 'ops', ops: chain(R.a, 1, 3) }]);
    expect(log.sv()).toEqual({ [R.a]: 3 });
  });

  it('a batch that overlaps the known prefix appends only the new tail and acks its end', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    await room.onOps(a, chain(R.a, 1, 3));
    await room.onOps(a, chain(R.a, 2, 5));
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([3, 5]);
    expect(log.sv()).toEqual({ [R.a]: 5 });
  });

  it('attack: a future seq (known + 1000) is SEQ_GAP, non-fatal, and nothing is stored or acknowledged', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    await room.onOps(a, chain(R.a, 1, 2));
    await room.onOps(a, [ins(R.a, 1002)]);
    expect(a.ofType('error')).toEqual([expect.objectContaining({ code: 'SEQ_GAP', fatal: false, reason: 'expected seq 3, got 1002' })]);
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([2]);
    expect(a.closes).toEqual([]);
    expect(log.sv()).toEqual({ [R.a]: 2 });
  });

  it('a gap in the middle of a batch keeps the contiguous prefix and drops the rest', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    await room.onOps(a, [ins(R.a, 1), ins(R.a, 2), ins(R.a, 4), ins(R.a, 5)]);
    expect(a.ofType('ack')).toEqual([{ v: 1, t: 'ack', replica: R.a, seq: 2 }]);
    expect(a.ofType('error')).toEqual([expect.objectContaining({ code: 'SEQ_GAP' })]);
    expect(log.sv()).toEqual({ [R.a]: 2 });
  });

  it('a replay followed by a gap is refused, not acknowledged', async () => {
    const { room } = await roomWith();
    const a = await joined(room, R.a);
    await room.onOps(a, chain(R.a, 1, 5));
    await room.onOps(a, [ins(R.a, 1), ins(R.a, 2), ins(R.a, 7)]);
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([5]);
    expect(a.ofType('error')).toEqual([expect.objectContaining({ code: 'SEQ_GAP', reason: 'expected seq 6, got 7' })]);
  });

  it('attack: an op carrying another replica id is FOREIGN_REPLICA fatal and the whole batch is dropped', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    await room.onOps(a, [ins(R.a, 1), ins(R.b, 1)]);
    expect(a.ofType('error')).toEqual([expect.objectContaining({ code: 'FOREIGN_REPLICA', fatal: true })]);
    expect(a.closes).toEqual([{ code: 1008, reason: 'FOREIGN_REPLICA' }]);
    expect(a.ofType('ack')).toEqual([]);
    expect(b.ofType('ops')).toEqual([]);
    expect(log.length()).toBe(0);
  });

  it('ops and presence from a connection that never said hello are BAD_SHAPE fatal', async () => {
    const { room } = await roomWith();
    const stranger = new FakeConn();
    await room.onOps(stranger, [ins(R.a, 1)]);
    room.onPresence(stranger, null);
    expect(stranger.ofType('error').map((m) => m.code)).toEqual(['BAD_SHAPE', 'BAD_SHAPE']);
    expect(stranger.ofType('error').every((m) => m.fatal)).toBe(true);
  });
});

describe('E12/E21: an op may only depend on what the server has accepted', () => {
  const insUnder = (replica: ReplicaId, seq: number, parent: { replica: ReplicaId; seq: number }): Op => ({ t: 'ins', id: id(replica, seq), parent, side: 'R', content: { kind: 'char', text: 'g' } });

  it('attack (A1): a parent the server has never seen is UNKNOWN_DEPENDENCY, non-fatal; nothing is stored, acknowledged or fanned out', async () => {
    const { room, log } = await roomWith();
    const peer = await joined(room, R.b);
    const evil = await joined(room, R.c);
    await room.onOps(evil, [insUnder(R.c, 1, id(R.c, 500))]);
    expect(evil.ofType('error')).toEqual([expect.objectContaining({ code: 'UNKNOWN_DEPENDENCY', fatal: false, reason: expect.stringContaining(`${R.c}:500`) })]);
    expect(evil.closes).toEqual([]);
    expect(evil.ofType('ack')).toEqual([]);
    expect(peer.ofType('ops')).toEqual([]);
    expect(log.length()).toBe(0);
    expect(log.accepted(R.c)).toBe(0);
  });

  it('attack (A1): a del of an id nobody wrote, and an ins parented on a foreign replica’s future seq, are refused the same way', async () => {
    const { room, log } = await roomWith();
    const evil = await joined(room, R.c);
    await room.onOps(evil, [{ t: 'del', id: id(R.c, 1), target: id(R.b, 999) }]);
    await room.onOps(evil, [insUnder(R.c, 1, id(R.a, 1))]);
    await room.onOps(evil, [{ t: 'blk', id: id(R.c, 1), target: id(R.a, 1), attrs: { type: 'quote' }, lamport: 1 }]);
    await room.onOps(evil, [{ t: 'fmt', id: id(R.c, 1), targets: [id(R.a, 1)], mark: 'bold', active: true, lamport: 1 }]);
    expect(evil.ofType('error').map((m) => m.code)).toEqual(['UNKNOWN_DEPENDENCY', 'UNKNOWN_DEPENDENCY', 'UNKNOWN_DEPENDENCY', 'UNKNOWN_DEPENDENCY']);
    expect(log.length()).toBe(0);
  });

  it('the whole batch is refused, including the valid ops before the offending one, so the client re-hellos and re-sends', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    await room.onOps(a, [ins(R.a, 1), ins(R.a, 2), insUnder(R.a, 3, id(R.b, 7)), ins(R.a, 4)]);
    expect(a.ofType('error').map((m) => m.code)).toEqual(['UNKNOWN_DEPENDENCY']);
    expect(a.ofType('ack')).toEqual([]);
    expect(log.length()).toBe(0);
    expect(log.accepted(R.a)).toBe(0);
    // The honest retry after a re-hello succeeds.
    await room.onOps(a, chain(R.a, 1, 4));
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([4]);
  });

  it('dependencies on the root, on an op earlier in the same batch, on own accepted ops and on a peer’s accepted ops are all fine (B4)', async () => {
    const { room, log } = await roomWith();
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    await room.onOps(a, chain(R.a, 1, 3)); // each parented on the previous one, the first on the root
    expect(a.ofType('ack').map((m) => m.seq)).toEqual([3]);
    await room.onOps(b, [insUnder(R.b, 1, id(R.a, 3)), { t: 'del', id: id(R.b, 2), target: id(R.a, 1) }, { t: 'fmt', id: id(R.b, 3), targets: [id(R.a, 2), id(R.b, 1)], mark: 'bold', active: true, lamport: 1 }]);
    expect(b.ofType('ack').map((m) => m.seq)).toEqual([3]);
    expect(b.ofType('error')).toEqual([]);
    expect(log.sv()).toEqual({ [R.a]: 3, [R.b]: 3 });
  });

  it('a dependency on an op that is accepted but not yet durable (in flight) is fine: the check reads `accepted`, not `sv`', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const { room } = await roomWith(fs);
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    const first = room.onOps(a, chain(R.a, 1, 1));
    const second = room.onOps(b, [insUnder(R.b, 1, id(R.a, 1))]);
    await settle();
    expect(b.ofType('error')).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(b.ofType('ack').map((m) => m.seq)).toEqual([1]);
  });
});

describe('I10: nothing leaves the room before fsync', () => {
  it('holds the ack and the fan-out while sync is pending and releases both when it completes', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const { room } = await roomWith(fs);
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    const pending = room.onOps(a, chain(R.a, 1, 2));
    await settle();
    expect(fs.text('/data/doc.jsonl').split('\n').filter(Boolean)).toHaveLength(2);
    expect(a.ofType('ack')).toEqual([]);
    expect(b.ofType('ops')).toEqual([]);
    release();
    await pending;
    expect(a.ofType('ack')).toEqual([{ v: 1, t: 'ack', replica: R.a, seq: 2 }]);
    expect(b.ofType('ops')).toHaveLength(1);
  });

  it('E24 (B2): a failed fsync is INTERNAL fatal to the sender AND to every other member, faults the room, and nothing is acknowledged', async () => {
    const fs = new FakeFs();
    const { room, log } = await roomWith(fs);
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    fs.syncError = new Error('ENOSPC');
    await room.onOps(a, chain(R.a, 1, 2));
    expect(a.ofType('error')).toEqual([expect.objectContaining({ code: 'INTERNAL', fatal: true, reason: 'append failed: Error' })]);
    expect(a.closes).toEqual([{ code: 1011, reason: 'INTERNAL' }]);
    expect(b.ofType('error')).toEqual([expect.objectContaining({ code: 'INTERNAL', fatal: true, reason: expect.stringContaining('reconnect') })]);
    expect(b.closes).toEqual([{ code: 1011, reason: 'INTERNAL' }]);
    expect(a.ofType('ack')).toEqual([]);
    expect(b.ofType('ops')).toEqual([]);
    expect(room.faulted).toBe(true);
    expect(room.size).toBe(0);
    expect(log.accepted(R.a)).toBe(0); // the claim was rolled back: a retry of 1..2 is fresh, not a silently dropped replay
    await room.close();
    // Disk freed, room reopened from the file (as Rooms does): the retry is accepted and acknowledged.
    fs.syncError = null;
    fs.crash();
    const { room: again } = await roomWith(fs);
    const a2 = await joined(again, R.a, { [R.a]: 2 });
    expect(a2.ofType('welcome')).toEqual([{ v: 1, t: 'welcome', sv: {} }]);
    await again.onOps(a2, chain(R.a, 1, 2));
    expect(a2.ofType('ack')).toEqual([{ v: 1, t: 'ack', replica: R.a, seq: 2 }]);
    expect(a2.ofType('error')).toEqual([]);
  });

  it('E23 (B3): a sender that leaves while its fsync is in flight gets no ack, but peers still get the durable ops', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const { room } = await roomWith(fs);
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    const pending = room.onOps(a, chain(R.a, 1, 1));
    room.leave(a);
    release();
    await pending;
    expect(a.ofType('ack')).toEqual([]);
    expect(b.ofType('ops')).toEqual([{ v: 1, t: 'ops', ops: chain(R.a, 1, 1) }]);
    // The op is durable; the author learns so from the welcome of its next hello.
    const again = await joined(room, R.a);
    expect(again.ofType('welcome')).toEqual([{ v: 1, t: 'welcome', sv: { [R.a]: 1 } }]);
  });
});

describe('presence is ephemeral', () => {
  it('fans a state out to the other members, tells a newcomer the current states, and announces departures', async () => {
    const { room } = await roomWith();
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    room.onPresence(a, { name: 'Ada', color: 1 });
    expect(b.ofType('presence')).toEqual([{ v: 1, t: 'presence', replica: R.a, state: { name: 'Ada', color: 1 } }]);
    expect(a.ofType('presence')).toEqual([]);
    const c = await joined(room, R.c);
    expect(c.ofType('presence')).toEqual([{ v: 1, t: 'presence', replica: R.a, state: { name: 'Ada', color: 1 } }]);
    room.leave(a);
    expect(c.ofType('presence').at(-1)).toEqual({ v: 1, t: 'presence', replica: R.a, state: null });
    room.leave(a); // idempotent
    expect(room.size).toBe(2);
  });
});

describe('⟨D3⟩ quiet', () => {
  it('after the quiet period following ops, every member hears the durable state vector once; new ops re-arm it; the last leave disarms it', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const { room } = await roomWith(new FakeFs(), { setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: (h) => cleared.push(h) });
    const a = await joined(room, R.a);
    const b = await joined(room, R.b);
    await room.onOps(a, chain(R.a, 1, 1));
    expect(timers.at(-1)?.ms).toBe(5);
    (timers.at(-1) as { fn: () => void }).fn();
    expect(a.ofType('quiet')).toEqual([{ v: 1, t: 'quiet', sv: {} }, { v: 1, t: 'quiet', sv: { [R.a]: 1 } }]); // the join's own, then the room's
    expect(b.ofType('quiet').at(-1)).toEqual({ v: 1, t: 'quiet', sv: { [R.a]: 1 } });
    const armed = timers.length;
    await room.onOps(b, [{ t: 'ins', id: id(R.b, 1), parent: ROOT, side: 'R', content: { kind: 'char', text: 'y' } }]);
    expect(timers.length).toBe(armed + 1);
    room.leave(a);
    room.leave(b);
    expect(cleared).toContain(timers.length);
    await room.close();
  });
});
