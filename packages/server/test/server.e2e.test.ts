// server.e2e.test.ts — the relay over a REAL `ws` server on an ephemeral port, driven by raw
// WebSocket clients that speak the protocol and nothing more. Every §5.4 rejection is observed
// here with its close code; the ack is checked against the file at the moment it arrives (I10);
// replay (re-acknowledged, E23), the E12 dependency rule over the wire, quiet, presence limits
// and the presence rate, the version handshake, the frame-size ladder, the rate limits with
// three warnings, the bound on queued frames, one hot connection among many, an INTERNAL
// failure, a corrupt log refused without a retry storm (E26), the data-directory lock (E25), a
// 60 000-op catch-up that must not look like a slow consumer (E22), and a restart on the same
// port with the same data directory. Convergence of real replicas lives in @weft/client.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encode, LIMITS, type Op } from '@weft/protocol';
import { SERVER_LIMITS } from '../src/limits.ts';
import { startServer } from '../src/wsServer.ts';
import { chain, DOC, FakeFs, hello, id, ins, opsMsg, R, RawClient, ROOT } from './helpers.ts';

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let warnings: string[];
const url = (): string => `ws://127.0.0.1:${server.port}`;
const logPath = (): string => join(dataDir, `${DOC}.jsonl`);
const linesOnDisk = (): Op[] =>
  readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Op);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'weft-server-'));
  warnings = [];
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir, limits: { QUIET_MS: 60 }, warn: (m) => warnings.push(m) });
});

afterEach(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the happy path, watched closely', () => {
  it('hello → welcome; ops → ack only once the op is in the file; the peer receives the fan-out; quiet follows silence', async () => {
    const a = await RawClient.open(url());
    const b = await RawClient.open(url());
    a.send(hello(R.a));
    b.send(hello(R.b));
    expect(await a.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: {} });
    expect(await b.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: {} });

    a.send(opsMsg(chain(R.a, 1, 3)));
    const ack = await a.expect('ack');
    // I10: at the moment the ack is observed, the file already holds the ops.
    expect(linesOnDisk()).toEqual(chain(R.a, 1, 3));
    expect(ack).toEqual({ v: 1, t: 'ack', replica: R.a, seq: 3 });
    expect(await b.expect('ops')).toEqual({ v: 1, t: 'ops', ops: chain(R.a, 1, 3) });

    const quietA = await a.expect('quiet');
    const quietB = await b.expect('quiet');
    expect(quietA).toEqual({ v: 1, t: 'quiet', sv: { [R.a]: 3 } });
    expect(quietB).toEqual(quietA);
    a.close();
    b.close();
  });

  it('a late joiner with an empty state vector receives the whole log as ops (E7), and one with a partial sv only the diff', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, 5)));
    await a.expect('ack');

    const fresh = await RawClient.open(url());
    fresh.send(hello(R.b));
    expect(await fresh.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: { [R.a]: 5 } });
    expect(await fresh.expect('ops')).toEqual({ v: 1, t: 'ops', ops: chain(R.a, 1, 5) });

    const partial = await RawClient.open(url());
    partial.send(hello(R.c, { [R.a]: 3 }));
    await partial.expect('welcome');
    expect(await partial.expect('ops')).toEqual({ v: 1, t: 'ops', ops: chain(R.a, 4, 5) });
    a.close();
    fresh.close();
    partial.close();
  });

  it('presence is fanned out to peers, replayed to newcomers, cleared on disconnect, and never written to the log', async () => {
    const a = await RawClient.open(url());
    const b = await RawClient.open(url());
    a.send(hello(R.a));
    b.send(hello(R.b));
    await a.expect('welcome');
    await b.expect('welcome');
    a.send({ v: 1, t: 'presence', state: { name: 'Ada', color: 2 } });
    expect(await b.expect('presence')).toEqual({ v: 1, t: 'presence', replica: R.a, state: { name: 'Ada', color: 2 } });
    const c = await RawClient.open(url());
    c.send(hello(R.c));
    expect(await c.expect('presence')).toEqual({ v: 1, t: 'presence', replica: R.a, state: { name: 'Ada', color: 2 } });
    a.close();
    expect(await c.expect('presence')).toEqual({ v: 1, t: 'presence', replica: R.a, state: null });
    a.send(opsMsg([ins(R.a, 1)]));
    b.send(opsMsg([ins(R.b, 1)]));
    await b.expect('ack');
    expect(linesOnDisk()).toEqual([ins(R.b, 1)]);
    b.close();
    c.close();
  });

  it('ping is answered with pong before and after hello', async () => {
    const a = await RawClient.open(url());
    a.send({ v: 1, t: 'ping' });
    expect(await a.next()).toEqual({ v: 1, t: 'pong' });
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send({ v: 1, t: 'ping' });
    expect(await a.expect('pong')).toEqual({ v: 1, t: 'pong' });
    a.close();
  });
});

describe('every §5.4 rejection, observed by a raw client', () => {
  it('BAD_SHAPE (non-fatal) for unknown types, non-JSON, unknown fields and binary frames; the connection stays open', async () => {
    const a = await RawClient.open(url());
    a.sendRaw('{"v":1,"t":"converged"}');
    expect(await a.next()).toMatchObject({ t: 'error', code: 'BAD_SHAPE', fatal: false });
    a.sendRaw('{"v":1,');
    expect(await a.next()).toMatchObject({ t: 'error', code: 'BAD_SHAPE', reason: 'frame is not JSON' });
    a.sendRaw('{"v":1,"t":"ping","extra":1}');
    expect(await a.next()).toMatchObject({ t: 'error', code: 'BAD_SHAPE' });
    a.sendRaw(new TextEncoder().encode(encode({ v: 1, t: 'ping' })));
    expect(await a.next()).toMatchObject({ t: 'error', code: 'BAD_SHAPE', reason: 'binary frames are not accepted' });
    a.send({ v: 1, t: 'ping' });
    expect(await a.next()).toEqual({ v: 1, t: 'pong' });
    a.close();
  });

  it(`attack: ${SERVER_LIMITS.BAD_SHAPE_PER_MINUTE + 1} malformed frames in a minute → RATE_LIMITED fatal, close 1008`, async () => {
    const a = await RawClient.open(url());
    for (let i = 0; i <= SERVER_LIMITS.BAD_SHAPE_PER_MINUTE; i++) a.sendRaw('nope');
    for (let i = 0; i < SERVER_LIMITS.BAD_SHAPE_PER_MINUTE; i++) expect(await a.next()).toMatchObject({ code: 'BAD_SHAPE' });
    expect(await a.next()).toMatchObject({ code: 'BAD_SHAPE' });
    expect(await a.next()).toMatchObject({ code: 'RATE_LIMITED', fatal: true });
    expect(await a.closed).toMatchObject({ code: 1008 });
  });

  it('UNSUPPORTED_VERSION: hello v:2 → error with the supported list, then close 1002', async () => {
    const a = await RawClient.open(url());
    a.sendRaw(JSON.stringify({ v: 2, t: 'hello', doc: DOC, replica: R.a, sv: {} }));
    expect(await a.next()).toEqual({ v: 1, t: 'error', code: 'UNSUPPORTED_VERSION', reason: 'protocol version 2 is not supported', fatal: true, supported: [1] });
    expect(await a.closed).toMatchObject({ code: 1002 });
  });

  it('attack: v: "1", v: -1 and v: 1.5 are BAD_SHAPE, and v: 1.0 is simply 1', async () => {
    const a = await RawClient.open(url());
    for (const v of ['"1"', '-1', '1.5']) {
      a.sendRaw(`{"v":${v},"t":"ping"}`);
      expect(await a.next()).toMatchObject({ code: 'BAD_SHAPE' });
    }
    a.sendRaw('{"v":1.0,"t":"ping"}');
    expect(await a.next()).toEqual({ v: 1, t: 'pong' });
    a.close();
  });

  it('attack: ops before hello → BAD_SHAPE fatal, close 1008; presence before hello likewise', async () => {
    const a = await RawClient.open(url());
    a.send(opsMsg([ins(R.a, 1)]));
    expect(await a.next()).toMatchObject({ code: 'BAD_SHAPE', fatal: true, reason: 'ops before hello' });
    expect(await a.closed).toMatchObject({ code: 1008 });
    const b = await RawClient.open(url());
    b.send({ v: 1, t: 'presence', state: null });
    expect(await b.next()).toMatchObject({ code: 'BAD_SHAPE', fatal: true, reason: 'presence before hello' });
    expect(await b.closed).toMatchObject({ code: 1008 });
  });

  it('attack: hello twice with the same identity re-syncs; hello with another identity is fatal', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(hello(R.b));
    expect(await a.expect('error')).toMatchObject({ code: 'BAD_SHAPE', fatal: true });
    expect(await a.closed).toMatchObject({ code: 1008 });
  });

  it('SEQ_GAP (non-fatal) for a future seq, nothing stored, connection still usable', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, 2)));
    await a.expect('ack');
    a.send(opsMsg([ins(R.a, 1002)]));
    expect(await a.expect('error')).toMatchObject({ code: 'SEQ_GAP', fatal: false, reason: 'expected seq 3, got 1002' });
    expect(linesOnDisk()).toHaveLength(2);
    a.send(opsMsg([ins(R.a, 3)]));
    expect(await a.expect('ack')).toMatchObject({ seq: 3 });
    a.close();
  });

  it('attack: replay of acked ops → acknowledged again (E23, the ack is idempotent), no fan-out, log unchanged', async () => {
    const a = await RawClient.open(url());
    const b = await RawClient.open(url());
    a.send(hello(R.a));
    b.send(hello(R.b));
    await a.expect('welcome');
    await b.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, 400)));
    expect(await a.expect('ack')).toMatchObject({ seq: 400 });
    await b.expect('ops');
    const before = readFileSync(logPath(), 'utf8');
    a.send(opsMsg(chain(R.a, 1, 400)));
    expect(await a.expect('ack')).toMatchObject({ seq: 400 });
    expect(await b.silent('ops', 100)).toBe(true);
    expect(readFileSync(logPath(), 'utf8')).toBe(before);
    a.close();
    b.close();
  });

  it('attack (A1, E12): an op whose parent the server never accepted is UNKNOWN_DEPENDENCY non-fatal; a peer never receives it and the file stays empty', async () => {
    const peer = await RawClient.open(url());
    const evil = await RawClient.open(url());
    peer.send(hello(R.b));
    evil.send(hello(R.c));
    await peer.expect('welcome');
    await evil.expect('welcome');
    evil.send(opsMsg([{ t: 'ins', id: id(R.c, 1), parent: id(R.c, 500), side: 'R', content: { kind: 'char', text: 'g' } }]));
    expect(await evil.expect('error')).toMatchObject({ code: 'UNKNOWN_DEPENDENCY', fatal: false });
    evil.send(opsMsg([{ t: 'del', id: id(R.c, 1), target: id(R.b, 999) }]));
    expect(await evil.expect('error')).toMatchObject({ code: 'UNKNOWN_DEPENDENCY', fatal: false });
    expect(await peer.silent('ops', 100)).toBe(true);
    expect(readFileSync(logPath(), 'utf8')).toBe('');
    evil.send(opsMsg([ins(R.c, 1)])); // still usable
    expect(await evil.expect('ack')).toMatchObject({ seq: 1 });
    peer.close();
    evil.close();
  });

  it('attack (A5): a hello whose state vector claims more than the server holds gets the welcome and nothing else, and its next op is a gap', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, 3)));
    await a.expect('ack');
    const liar = await RawClient.open(url());
    liar.send(hello(R.b, { [R.b]: 900, [R.a]: 900 }));
    expect(await liar.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: { [R.a]: 3 } });
    expect(await liar.silent('ops', 100)).toBe(true);
    liar.send(opsMsg([ins(R.b, 901)]));
    expect(await liar.expect('error')).toMatchObject({ code: 'SEQ_GAP', reason: 'expected seq 1, got 901' });
    a.close();
    liar.close();
  });

  it('attack: forged replica id → FOREIGN_REPLICA fatal, close 1008, nothing stored', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg([ins(R.b, 1)]));
    expect(await a.expect('error')).toMatchObject({ code: 'FOREIGN_REPLICA', fatal: true });
    expect(await a.closed).toMatchObject({ code: 1008 });
    expect(readFileSync(logPath(), 'utf8')).toBe('');
  });

  it(`TOO_LARGE (non-fatal) for a frame over ${LIMITS.MAX_MESSAGE_BYTES} bytes, and 1009 from the transport for a 10 MB frame`, async () => {
    const a = await RawClient.open(url());
    a.sendRaw('x'.repeat(LIMITS.MAX_MESSAGE_BYTES + 1));
    expect(await a.next()).toMatchObject({ code: 'TOO_LARGE', fatal: false });
    a.send({ v: 1, t: 'ping' });
    expect(await a.next()).toEqual({ v: 1, t: 'pong' });
    a.sendRaw('x'.repeat(10 * 1024 * 1024));
    expect(await a.closed).toMatchObject({ code: 1009 });
  });

  it('attack: 513 ops in one message → BAD_SHAPE, and an op array containing a string → BAD_SHAPE naming the index', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, LIMITS.MAX_OPS_PER_MESSAGE + 1)));
    expect(await a.expect('error')).toMatchObject({ code: 'BAD_SHAPE', fatal: false });
    a.sendRaw(JSON.stringify({ v: 1, t: 'ops', ops: [ins(R.a, 1), 'ins'] }));
    expect(await a.expect('error')).toMatchObject({ code: 'BAD_SHAPE', reason: expect.stringContaining('ops[1]') });
    expect(readFileSync(logPath(), 'utf8')).toBe('');
    a.close();
  });

  it('attack: a presence name of 10 000 chars is BAD_SHAPE and never reaches the peer', async () => {
    const a = await RawClient.open(url());
    const b = await RawClient.open(url());
    a.send(hello(R.a));
    b.send(hello(R.b));
    await a.expect('welcome');
    await b.expect('welcome');
    a.send({ v: 1, t: 'presence', state: { name: 'n'.repeat(10_000), color: 0 } });
    expect(await a.expect('error')).toMatchObject({ code: 'BAD_SHAPE' });
    expect(await b.silent('presence', 100)).toBe(true);
    a.close();
    b.close();
  });

  it(`attack (A6, E30): presence is metered on its own — ${LIMITS.RATE_PRESENCE_PER_SEC + 1} presence frames in a burst warn the sender and the peers receive at most ${LIMITS.RATE_PRESENCE_PER_SEC}`, async () => {
    const a = await RawClient.open(url());
    const b = await RawClient.open(url());
    a.send(hello(R.a));
    b.send(hello(R.b));
    await a.expect('welcome');
    await b.expect('welcome');
    for (let i = 0; i <= LIMITS.RATE_PRESENCE_PER_SEC; i++) a.send({ v: 1, t: 'presence', state: { name: 'Ada', color: i % 8 } });
    expect(await a.expect('error')).toMatchObject({ code: 'RATE_LIMITED', fatal: false, reason: expect.stringContaining('warning 1') });
    let delivered = 0;
    for (;;) {
      const m = await b.next(150).catch(() => null);
      if (m === null) break;
      if (m.t === 'presence') delivered++;
    }
    expect(delivered).toBe(LIMITS.RATE_PRESENCE_PER_SEC);
    a.close();
    b.close();
  });

  it(`attack (E33): frames queued behind a stalled fsync are bounded at ${SERVER_LIMITS.MAX_QUEUED_FRAMES}; the excess is RATE_LIMITED — three warnings, then close 1008`, async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const stalled = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dataDir, 'stalled'), fs, limits: { RATE_MESSAGES_PER_SEC: 10_000 }, warn: (m) => warnings.push(m) });
    const a = await RawClient.open(`ws://127.0.0.1:${stalled.port}`);
    a.send(hello(R.a));
    await a.expect('welcome');
    // One frame is being handled (its fsync never returns); MAX_QUEUED_FRAMES more may wait; the next four are one too many, then fatal.
    const burst = 1 + SERVER_LIMITS.MAX_QUEUED_FRAMES + SERVER_LIMITS.RATE_WARNINGS + 1;
    for (let i = 1; i <= burst; i++) a.send(opsMsg([ins(R.a, i)]));
    const errors: string[] = [];
    for (;;) {
      const m = await a.next();
      if (m.t !== 'error') continue;
      errors.push(`${m.code}:${m.fatal}`);
      if (m.fatal) break;
    }
    expect(errors).toEqual(['RATE_LIMITED:false', 'RATE_LIMITED:false', 'RATE_LIMITED:false', 'RATE_LIMITED:true']);
    expect(await a.closed).toMatchObject({ code: 1008 });
    release();
    await stalled.close();
  });

  it(`RATE_LIMITED: ${LIMITS.RATE_MESSAGES_PER_SEC} messages/s — three warnings, then fatal and close 1008`, async () => {
    const a = await RawClient.open(url());
    const burst = LIMITS.RATE_MESSAGES_PER_SEC + SERVER_LIMITS.RATE_WARNINGS + 1;
    for (let i = 0; i < burst; i++) a.send({ v: 1, t: 'ping' });
    // Refusals are sent the moment a frame is metered, ahead of the pongs still queued behind the
    // handler chain, and the fatal close drops those pongs — so only the errors are counted here.
    const errors: unknown[] = [];
    for (;;) {
      const m = await a.next();
      if (m.t !== 'error') continue;
      errors.push(m);
      if (m.fatal) break;
    }
    expect(errors).toEqual([
      expect.objectContaining({ code: 'RATE_LIMITED', fatal: false, reason: 'rate limit exceeded (warning 1 of 3)' }),
      expect.objectContaining({ code: 'RATE_LIMITED', fatal: false, reason: 'rate limit exceeded (warning 2 of 3)' }),
      expect.objectContaining({ code: 'RATE_LIMITED', fatal: false, reason: 'rate limit exceeded (warning 3 of 3)' }),
      expect.objectContaining({ code: 'RATE_LIMITED', fatal: true }),
    ]);
    expect(await a.closed).toMatchObject({ code: 1008 });
  });

  it('INTERNAL: when the log cannot be opened (a directory sits where the file should be) the hello is answered INTERNAL fatal and closed 1011', async () => {
    mkdirSync(logPath());
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    expect(await a.next()).toMatchObject({ code: 'INTERNAL', fatal: true, reason: 'unexpected server error' });
    expect(await a.closed).toMatchObject({ code: 1011 });
    expect(warnings.some((w) => w.startsWith('internal error'))).toBe(true);
  });

  it('E26: a corrupt log (duplicate seq lines) is refused INTERNAL fatal with a reason naming the operator, read once, and refused again from memory on the next hello', async () => {
    writeFileSync(logPath(), `${JSON.stringify(ins(R.a, 1))}\n${JSON.stringify(ins(R.a, 1))}\n`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await RawClient.open(url());
      a.send(hello(R.b));
      expect(await a.next()).toMatchObject({ code: 'INTERNAL', fatal: true, reason: expect.stringMatching(/corrupt.*operator/) });
      expect(await a.closed).toMatchObject({ code: 1011 });
    }
    expect(warnings.filter((w) => /corrupt and needs an operator/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => w.startsWith('internal error'))).toEqual([]);
    // Another document on the same server is served normally.
    const b = await RawClient.open(url());
    b.send(hello(R.b, {}, 'another-doc-01'));
    expect(await b.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: {} });
    b.close();
  });

  it('a data directory that is a file refuses to start', async () => {
    const file = join(dataDir, 'not-a-dir');
    writeFileSync(file, 'x');
    await expect(startServer({ host: '127.0.0.1', port: 0, dataDir: file, warn: () => undefined })).rejects.toThrow();
  });
});

describe('E25: one server per data directory', () => {
  it('attack (A3): a second server on the same data directory refuses to start; after the first closes, a new one may', async () => {
    await expect(startServer({ host: '127.0.0.1', port: 0, dataDir, warn: () => undefined })).rejects.toThrow(/locked by another weft server \(pid \d+\)/);
    expect(readFileSync(join(dataDir, SERVER_LIMITS.LOCK_FILE), 'utf8')).toBe(String(process.pid));
    await server.close();
    const next = await startServer({ host: '127.0.0.1', port: 0, dataDir, warn: () => undefined });
    server = next; // afterEach closes it
    expect(readFileSync(join(dataDir, SERVER_LIMITS.LOCK_FILE), 'utf8')).toBe(String(process.pid));
  });

  it('a lock left by a process that is no longer running is taken over with a warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-stale-'));
    writeFileSync(join(dir, SERVER_LIMITS.LOCK_FILE), '2147483646'); // no such pid
    const stale: string[] = [];
    const taken = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, warn: (m) => stale.push(m) });
    expect(stale).toEqual([expect.stringMatching(/stale lock left by pid 2147483646/)]);
    await taken.close();
    expect(() => readFileSync(join(dir, SERVER_LIMITS.LOCK_FILE))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('E22: catch-up is paced, not capped', () => {
  it('a fresh replica joining a 60 000-op document receives every op without being dropped as a slow consumer (time measured and printed)', async () => {
    const N = 60_000;
    writeFileSync(join(dataDir, 'doc-big-0001.jsonl'), chain(R.a, 1, N).map((op) => `${JSON.stringify(op)}\n`).join(''));
    const fresh = await RawClient.open(url());
    const t0 = performance.now();
    fresh.send(hello(R.b, {}, 'doc-big-0001'));
    expect(await fresh.expect('welcome', 20_000)).toEqual({ v: 1, t: 'welcome', sv: { [R.a]: N } });
    let received = 0;
    let batches = 0;
    let next = 1;
    while (received < N) {
      const m = await fresh.expect('ops', 20_000);
      batches++;
      for (const op of m.ops) expect(op.id.seq).toBe(next++);
      received += m.ops.length;
    }
    const quiet = await fresh.expect('quiet', 20_000);
    const ms = performance.now() - t0;
    console.log(`E22 catch-up: ${N} ops in ${batches} frames delivered to a fresh replica in ${ms.toFixed(0)} ms (measured on this machine)`);
    expect(quiet).toEqual({ v: 1, t: 'quiet', sv: { [R.a]: N } });
    expect(batches).toBe(Math.ceil(N / SERVER_LIMITS.CATCHUP_BATCH));
    expect(warnings.filter((w) => w.includes('slow consumer'))).toEqual([]);
    // Still a live member afterwards.
    fresh.send(opsMsg([ins(R.b, 1)]));
    expect(await fresh.expect('ack', 20_000)).toMatchObject({ seq: 1 });
    fresh.close();
  });
});

describe('attack: resource exhaustion', () => {
  it(`500 connections to one doc; ${LIMITS.RATE_OPS_PER_SEC} ops/s from one of them → only that one is limited`, async () => {
    // Opened in batches: 500 simultaneous SYNs exceed what one loopback listener accepts at once.
    const clients: RawClient[] = [];
    while (clients.length < 500) clients.push(...(await Promise.all(Array.from({ length: 50 }, () => RawClient.open(url())))));
    clients.forEach((c, i) => c.send(hello(replicaNo(i))));
    await Promise.all(clients.map((c) => c.expect('welcome', 10_000)));
    const hot = clients[0] as RawClient;
    // 7 × 512 = 3 584 ops in one burst: the cap is passed on the fourth message (warning 1), the fifth and sixth warn again, the seventh is fatal.
    for (let i = 0; i < 7; i++) hot.send(opsMsg(chain(replicaNo(0), i * 512 + 1, (i + 1) * 512)));
    const seen: string[] = [];
    for (;;) {
      const m = await hot.next(10_000);
      if (m.t === 'error') seen.push(`${m.code}:${m.fatal}`);
      if (m.t === 'error' && m.fatal) break;
    }
    expect(seen).toEqual(['RATE_LIMITED:false', 'RATE_LIMITED:false', 'RATE_LIMITED:false', 'RATE_LIMITED:true']);
    expect(await hot.closed).toMatchObject({ code: 1008 });
    // Everyone else is fine: a ping is answered and an op is acked and fanned out.
    const witness = clients[1] as RawClient;
    const other = clients[499] as RawClient;
    other.send({ v: 1, t: 'ping' });
    expect(await other.expect('pong', 10_000)).toEqual({ v: 1, t: 'pong' });
    witness.send(opsMsg([ins(replicaNo(1), 1)]));
    expect(await witness.expect('ack', 10_000)).toMatchObject({ seq: 1 });
    // `other` (client 499) also receives the hot client's ops that survived the rate limit — they are fanned
    // out to everyone and legitimately precede replica 1's op, especially under Windows-CI timing. Drain 'ops'
    // frames until the witness's op arrives, then assert client 499 got exactly that fanned-out op (unchanged:
    // what this proves — the rate limit isolated only the hot client, and the fan-out still reaches 499).
    const want = ins(replicaNo(1), 1);
    const deadline = Date.now() + 10_000;
    let fannedOut: { ops: Op[] } | undefined;
    for (;;) {
      const m = await other.expect('ops', Math.max(1, deadline - Date.now()));
      if (m.ops.some((op) => op.id.replica === want.id.replica && op.id.seq === want.id.seq)) {
        fannedOut = m;
        break;
      }
    }
    expect(fannedOut).toMatchObject({ ops: [want] });
    for (const c of clients) c.close();
  });
});

describe('restart', () => {
  it('a new server on the same port and data dir serves the ops the old one fsynced, and a torn tail is recovered', async () => {
    const a = await RawClient.open(url());
    a.send(hello(R.a));
    await a.expect('welcome');
    a.send(opsMsg(chain(R.a, 1, 4)));
    await a.expect('ack');
    const port = server.port;
    await server.close();
    expect(await a.closed).toMatchObject({ code: 1001 });
    // Something died mid-write after the last fsync.
    writeFileSync(logPath(), `${readFileSync(logPath(), 'utf8')}{"t":"ins","id":{"replica":"bcdefghijklmn","seq":5}`);
    server = await startServer({ host: '127.0.0.1', port, dataDir, warn: (m) => warnings.push(m) });
    expect(server.port).toBe(port);
    const b = await RawClient.open(url());
    b.send(hello(R.b));
    expect(await b.expect('welcome')).toEqual({ v: 1, t: 'welcome', sv: { [R.a]: 4 } });
    expect(await b.expect('ops')).toEqual({ v: 1, t: 'ops', ops: chain(R.a, 1, 4) });
    expect(warnings).toEqual([expect.stringMatching(/torn last line/)]);
    // The author re-hellos with what it holds and continues from 5.
    const again = await RawClient.open(url());
    again.send(hello(R.a, { [R.a]: 5 }));
    await again.expect('welcome');
    again.send(opsMsg([{ t: 'ins', id: id(R.a, 5), parent: ROOT, side: 'R', content: { kind: 'char', text: 'z' } }]));
    expect(await again.expect('ack')).toMatchObject({ seq: 5 });
    b.close();
    again.close();
  });
});

/** The i-th distinct replica id, for the many-connection test. */
function replicaNo(i: number): typeof R.a {
  const digits = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = '';
  let n = i;
  for (let k = 0; k < 12; k++) {
    s = digits[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return `b${s}` as typeof R.a;
}
