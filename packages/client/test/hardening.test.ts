// hardening.test.ts — the S2 hostile-review findings, each as a test that failed before its fix:
// a 60 000-op catch-up converging on a headless replica (E22); dead parked ops dropped after
// catch-up (E12) and a pending buffer past the limit ending as PENDING_OVERFLOW (E21); a
// re-hello loop ending as `failed` instead of hammering the server (E36); `unacked` derived from
// a monotonic acknowledged seq — ack 5 then ack 3 — and honest from the store before the first
// frame (E37); compaction never pruning own ops, so a server that lost its log is refilled (E38);
// `close()` while connecting returning promptly (E39); a hash never published for a document that
// changed while the digest ran, and carrying the sv it was computed for (E27); and the honesty of
// `converged` itself — identical parked garbage on two replicas is not convergence (E40).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@weft/server';
import { canonicalBytes, emptyDoc, localInsert, type Op, type ReplicaId, type StateVector } from '@weft/crdt';
import { decodeClient, encode, LIMITS, type ClientMessage } from '@weft/protocol';
import { createHeadlessReplica, type HeadlessReplica } from '../src/headless.ts';
import { memoryStore } from '../src/store/memoryStore.ts';
import { startRunner, type Runner } from '../src/session/runner.ts';
import { REHELLO_MAX } from '../src/session/constants.ts';
import { converged, live, saved, until } from './headlessHelpers.ts';

const R = { a: 'bcdefghijklmn' as ReplicaId, b: 'cdefghijklmno' as ReplicaId, c: 'defghijklmnop' as ReplicaId };
const ROOT = { replica: 'aaaaaaaaaaaaa' as ReplicaId, seq: 0 };
const DOC = 'doc-hardening-01';
const ins = (replica: ReplicaId, seq: number, parent = seq === 1 ? ROOT : { replica, seq: seq - 1 }, text = 'x'): Op => ({ t: 'ins', id: { replica, seq }, parent, side: 'R', content: { kind: 'char', text } });
const chain = (replica: ReplicaId, from: number, to: number): Op[] => Array.from({ length: to - from + 1 }, (_, i) => ins(replica, from + i));

const type = (r: Runner, index: number, text: string): Promise<void> =>
  r.local((doc, me, next) => {
    const ops: Op[] = [];
    let cur = doc;
    let at = index;
    for (const ch of text) {
      const step = localInsert(cur, me, next + ops.length, at++, { kind: 'char', text: ch });
      ops.push(...step.ops);
      cur = step.doc;
    }
    return { ops, doc: cur };
  });

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('against the real server', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let dataDir: string;
  const url = (): string => `ws://127.0.0.1:${server.port}`;
  const open: { close(): Promise<void> }[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'weft-hardening-'));
    server = await startServer({ host: '127.0.0.1', port: 0, dataDir, limits: { QUIET_MS: 30 }, warn: () => undefined });
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((r) => r.close()));
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function replica(id: ReplicaId, store = memoryStore(id), doc = DOC): Promise<HeadlessReplica> {
    const r = await createHeadlessReplica({ url: url(), doc, replicaId: id, store });
    open.push(r);
    return r;
  }

  it('E22 (A2): a fresh replica joining a 60 000-op document goes live with every op applied, nothing pending, and is not dropped as a slow consumer (time measured and printed)', async () => {
    const N = 60_000;
    writeFileSync(join(dataDir, 'doc-big-0001.jsonl'), chain(R.a, 1, N).map((op) => `${JSON.stringify(op)}\n`).join(''));
    const t0 = performance.now();
    const fresh = await replica(R.b, memoryStore(R.b), 'doc-big-0001');
    await until(() => saved(fresh) && fresh.state().sv[R.a] === N, () => `live with ${N} ops (state ${fresh.state().session.s}, sv ${JSON.stringify(fresh.state().sv)})`, 60_000);
    const ms = performance.now() - t0;
    console.log(`E22 client catch-up: ${N} ops applied by a headless replica in ${ms.toFixed(0)} ms (measured on this machine)`);
    expect(fresh.state().pending).toBe(0);
    expect(fresh.text()).toHaveLength(N);
    await fresh.insertText(0, '!');
    await until(() => saved(fresh), 'saved after the catch-up');
    expect(fresh.text().startsWith('!')).toBe(true);
  });

  it('E38 (C1): after compaction, a server that lost its log is refilled from the store — every own op is re-uploaded, the session is saved again, no re-hello loop', async () => {
    const store = memoryStore(R.a);
    const r = await replica(R.a, store);
    await until(() => live(r), 'live');
    await r.insertText(0, 'abc');
    await until(() => saved(r), 'saved');
    const loaded = await store.load();
    if (loaded === null) throw new Error('the store holds the three ops just typed');
    await store.compact(loaded.doc);
    expect(store.opLog().get(R.a, 1, 3)).toHaveLength(3);
    const port = server.port;
    await server.close();
    await until(() => r.state().session.s === 'degraded', 'degraded');
    const fresh = mkdtempSync(join(tmpdir(), 'weft-hardening-lost-'));
    server = await startServer({ host: '127.0.0.1', port, dataDir: fresh, limits: { QUIET_MS: 30 }, warn: () => undefined });
    await until(() => saved(r), () => `saved again after the server lost its log (${JSON.stringify(r.state().session)})`, 15_000);
    expect(readFileSync(join(fresh, `${DOC}.jsonl`), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    await r.insertText(3, 'd');
    await until(() => saved(r), 'saved after typing more');
    expect(readFileSync(join(fresh, `${DOC}.jsonl`), 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
    expect(r.state().session.s).toBe('live');
    rmSync(fresh, { recursive: true, force: true });
  });

  it('E39 (C4): close() while connecting to a reachable server, and to a dead port, resolves promptly and ends offline', async () => {
    const r = await startRunner({ url: url(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 0 } });
    expect(r.snapshot().session.s).toBe('connecting');
    const timeout = (ms: number): Promise<'timeout'> => new Promise((res) => setTimeout(() => res('timeout'), ms));
    expect(await Promise.race([Promise.all([r.close(), r.close()]).then(() => 'closed'), timeout(3000)])).toBe('closed');
    expect(r.snapshot().session).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
    await r.close(); // idempotent
    const dead = await startRunner({ url: 'ws://127.0.0.1:1', doc: DOC, me: R.b, store: memoryStore(R.b), presence: { name: 'b', color: 0 } });
    expect(await Promise.race([dead.close().then(() => 'closed'), timeout(3000)])).toBe('closed');
    expect(dead.snapshot().session.s).toBe('offline');
  });

  it('E27 (C3): a hash computed for a document that changed while the digest ran is never published, and a published hash names the sv it was computed for', async () => {
    const r = await startRunner({ url: url(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 0 } });
    open.push(r);
    await until(() => r.snapshot().session.s === 'live', 'live');
    await type(r, 0, 'abc');
    await until(() => r.snapshot().hash !== null, 'hash after quiet');
    // A slow digest makes the window observable: quiet fires, the digest of D1 runs, an op lands meanwhile.
    const subtle = crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    const slowDigest: typeof subtle.digest = async (alg, data) => {
      await new Promise((res) => setTimeout(res, 100));
      return realDigest(alg, data);
    };
    Object.defineProperty(subtle, 'digest', { value: slowDigest, configurable: true, writable: true });
    const published: { hash: string; sv: Record<string, number> }[] = [];
    const peer = new WebSocket(url());
    peer.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string) as { t: string; replica?: string; state?: { hash?: string; sv?: Record<string, number> } | null };
      if (m.t === 'presence' && m.replica === R.a && m.state?.hash !== undefined) published.push({ hash: m.state.hash, sv: m.state.sv ?? {} });
    };
    try {
      await new Promise((res) => (peer.onopen = res));
      peer.send(encode({ v: 1, t: 'hello', doc: DOC, replica: R.b, sv: r.snapshot().sv }));
      await new Promise((res) => setTimeout(res, 100));
      peer.send(encode({ v: 1, t: 'ops', ops: [ins(R.b, 1, ROOT, 'X')] }));
      await until(() => r.snapshot().sv[R.b] === 1, 'op 1 applied');
      const hashD1 = hex(await realDigest('SHA-256', canonicalBytes(r.doc)));
      await new Promise((res) => setTimeout(res, 60)); // quiet (30 ms) has fired; D1's digest is in flight
      peer.send(encode({ v: 1, t: 'ops', ops: [ins(R.b, 2, ROOT, 'Y')] }));
      await until(() => r.snapshot().sv[R.b] === 2, 'op 2 applied');
      await new Promise((res) => setTimeout(res, 400)); // D1's digest resolved and was discarded; D2's quiet cycle completed
      const hashD2 = hex(await realDigest('SHA-256', canonicalBytes(r.doc)));
      expect(hashD1).not.toBe(hashD2);
      expect([null, hashD2]).toContain(r.snapshot().hash);
      // Whatever was published is consistent: a hash for the sv it names, never D1's hash under D2's sv.
      const svD2 = JSON.stringify(Object.entries(r.snapshot().sv).sort());
      for (const p of published) if (JSON.stringify(Object.entries(p.sv).sort()) === svD2) expect(p.hash).toBe(hashD2);
      expect(published.some((p) => p.hash === hashD2)).toBe(true);
    } finally {
      Object.defineProperty(subtle, 'digest', { value: realDigest, configurable: true, writable: true });
      peer.close();
    }
  });
});

describe('against a server that misbehaves (bare ws listener)', () => {
  let fake: WebSocketServer;
  const hellos: unknown[] = [];
  let script: (send: (m: object) => void, msg: ClientMessage) => void = () => undefined;
  const open: { close(): Promise<void> }[] = [];

  beforeEach(async () => {
    hellos.length = 0;
    fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    fake.on('connection', (ws) => {
      ws.on('message', (data) => {
        const m = decodeClient(data as Buffer);
        if (!m.ok) return;
        if (m.value.t === 'hello') hellos.push(m.value);
        script((o) => ws.send(JSON.stringify(o)), m.value);
      });
    });
    await new Promise((r) => fake.once('listening', r));
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((r) => r.close()));
    for (const c of fake.clients) c.terminate();
    await new Promise<void>((r) => fake.close(() => r()));
  });

  const fakeUrl = (): string => `ws://127.0.0.1:${(fake.address() as { port: number }).port}`;

  async function runner(me: ReplicaId, store = memoryStore(me)): Promise<Runner> {
    const r = await startRunner({ url: fakeUrl(), doc: DOC, me, store, presence: { name: me.slice(0, 6), color: 0 } });
    open.push(r);
    return r;
  }

  it('E12: after catch-up, an op parked on the id of a non-insert op (which can never become an item) is dropped, and the session goes live with nothing pending', async () => {
    script = (send, msg) => {
      if (msg.t !== 'hello') return;
      send({ v: 1, t: 'welcome', sv: { [R.a]: 1, [R.b]: 2 } });
      // b:1 is a del, so b:2's parent b:1 will never exist; the server (E12) accepted it because b:1 is an accepted id.
      send({ v: 1, t: 'ops', ops: [ins(R.a, 1), { t: 'del', id: { replica: R.b, seq: 1 }, target: { replica: R.a, seq: 1 } }, ins(R.b, 2, { replica: R.b, seq: 1 })] });
    };
    const r = await runner(R.c);
    await until(() => r.snapshot().session.s === 'live', 'live');
    expect(r.snapshot().pending).toBe(0);
    expect(r.snapshot().sv).toEqual({ [R.a]: 1, [R.b]: 2 });
  });

  it(`E21: more than ${LIMITS.MAX_PENDING_PER_REPLICA} ops still parked after catch-up end the session as PENDING_OVERFLOW (failed); editing continues; USER_ONLINE re-hellos`, async () => {
    const N = LIMITS.MAX_PENDING_PER_REPLICA + 1;
    script = (send, msg) => {
      if (msg.t !== 'hello') return;
      send({ v: 1, t: 'welcome', sv: { [R.b]: N } });
      // Every op hangs under c:1, which the welcome does not count: not dead, just never arriving.
      const ops = Array.from({ length: N }, (_, i) => ins(R.b, i + 1, { replica: R.c, seq: 1 }));
      for (let i = 0; i < N; i += LIMITS.MAX_OPS_PER_MESSAGE) send({ v: 1, t: 'ops', ops: ops.slice(i, i + LIMITS.MAX_OPS_PER_MESSAGE) });
    };
    const r = await runner(R.a);
    await until(() => r.snapshot().session.s === 'failed', () => `failed (${JSON.stringify(r.snapshot().session)}, pending ${r.snapshot().pending})`, 20_000);
    expect(r.snapshot().session).toMatchObject({ s: 'failed', code: 'PENDING_OVERFLOW', reason: expect.stringContaining(String(N)) });
    await type(r, 0, 'still typing');
    expect(r.snapshot().session.unacked).toBe(12);
    const before = hellos.length;
    r.dispatch({ e: 'USER_ONLINE' });
    await until(() => hellos.length > before, 'a fresh hello after USER_ONLINE');
  });

  it(`E36: a server that answers every upload with SEQ_GAP causes at most ${REHELLO_MAX} re-hellos per socket, then the session is failed with reason REHELLO_LOOP`, async () => {
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (msg.t === 'ops') send({ v: 1, t: 'error', code: 'SEQ_GAP', reason: 'expected seq 7, got 1', fatal: false });
    };
    const store = memoryStore(R.a);
    const r = await runner(R.a, store);
    await type(r, 0, 'a');
    await until(() => r.snapshot().session.s === 'failed', () => `failed (${JSON.stringify(r.snapshot().session)}, hellos ${hellos.length})`);
    expect(r.snapshot().session).toMatchObject({ s: 'failed', code: 'SEQ_GAP', reason: expect.stringMatching(/^REHELLO_LOOP/) });
    expect(hellos.length).toBe(1 + REHELLO_MAX); // the first hello plus the re-hellos the window allowed
    await new Promise((res) => setTimeout(res, 300));
    expect(hellos.length).toBe(1 + REHELLO_MAX); // and no more: nothing retries by itself
  });

  it('E38: a replacement relay cannot render Saved until it acknowledges every retained own op', async () => {
    const store = memoryStore(R.a);
    await store.putOps(chain(R.a, 1, 3));
    await store.markAcked({ [R.a]: 3 } as StateVector); // the previous relay had all three
    const uploads: Op[] = [];
    let acknowledge = (): void => {
      throw new Error('the replacement relay has not received the replay');
    };
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (msg.t === 'ops') {
        uploads.push(...msg.ops);
        acknowledge = () => send({ v: 1, t: 'ack', replica: R.a, seq: 3 });
      }
    };
    const r = await runner(R.a, store);
    await until(() => r.snapshot().session.s === 'live' && uploads.length === 3, 'all retained ops replayed without an ack');
    expect(r.snapshot().session).toMatchObject({ s: 'live', unacked: 3 });
    expect(uploads.map((op) => op.id.seq)).toEqual([1, 2, 3]);
    acknowledge();
    await until(() => r.snapshot().session.s === 'live' && r.snapshot().session.unacked === 0, 'saved only after the replacement relay ack');
  });

  it('E37 (C2): unacked is derived from the monotonic acknowledged seq — ack 5 then ack 3 leaves it at 0', async () => {
    script = (send, msg) => {
      if (msg.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (msg.t === 'ops') {
        send({ v: 1, t: 'ack', replica: R.a, seq: 5 });
        send({ v: 1, t: 'ack', replica: R.a, seq: 3 });
        send({ v: 1, t: 'quiet', sv: { [R.a]: 5 } });
      }
    };
    const r = await runner(R.a);
    await until(() => r.snapshot().session.s === 'live', 'live');
    await type(r, 0, 'hello');
    expect(r.snapshot().session.unacked).toBe(5);
    await until(() => r.snapshot().lastQuiet !== null, 'the quiet after both acks');
    expect(r.snapshot().session).toMatchObject({ s: 'live', unacked: 0 });
  });

  it('E37: the unacked count is honest from the store before the first frame — 3 persisted, 1 acknowledged → 2, while still connecting', async () => {
    const store = memoryStore(R.a);
    // Three own ops a:1..3, typed one after another, as the store would hold them after a session.
    const ops: Op[] = [];
    let doc = emptyDoc();
    for (const [i, ch] of ['a', 'b', 'c'].entries()) {
      const step = localInsert(doc, R.a, i + 1, i, { kind: 'char', text: ch });
      ops.push(...step.ops);
      doc = step.doc;
    }
    await store.putOps(ops);
    await store.markAcked({ [R.a]: 1 } as StateVector);
    script = () => undefined; // a server that never answers the hello
    const r = await runner(R.a, store);
    expect(r.snapshot().session).toMatchObject({ s: 'connecting', unacked: 2 });
  });

  it('E40: identical parked garbage on two replicas is NOT convergence — `converged` refuses although texts, hashes and state vectors agree', async () => {
    script = (send, msg) => {
      if (msg.t !== 'hello') return;
      send({ v: 1, t: 'welcome', sv: {} });
      send({ v: 1, t: 'ops', ops: [ins(R.c, 1, { replica: R.c, seq: 500 }, 'g')] }); // parked: c:500 is not counted by the welcome, so it is not dead either
    };
    const a = await createHeadlessReplica({ url: fakeUrl(), doc: DOC, replicaId: R.a, store: memoryStore(R.a) });
    const b = await createHeadlessReplica({ url: fakeUrl(), doc: DOC, replicaId: R.b, store: memoryStore(R.b) });
    open.push(a, b);
    await until(() => saved(a) && saved(b) && a.state().pending === 1 && b.state().pending === 1, 'both live and saved with the same parked op');
    expect(a.text()).toBe(b.text());
    expect(await a.hash()).toBe(await b.hash());
    expect(JSON.stringify(a.state().sv)).toBe(JSON.stringify(b.state().sv));
    await expect(converged([a, b], 300)).rejects.toThrow(/nothing pending/);
  });
});
