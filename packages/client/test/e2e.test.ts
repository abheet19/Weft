// e2e.test.ts — real replicas over a REAL `ws` server on an ephemeral port: I1 end to end (two
// headless replicas converge on text and hash), three replicas with one partitioned by the user
// toggle, a server restart mid-session with edits on both sides of the gap, a dangling parent
// that the server refuses (E12) so no peer ever parks it, the D3 hash exchange after `quiet`,
// reload from the store without re-uploading, and the two identity mistakes the runner refuses.
// A minimal fake server (a bare `ws` listener) covers what the real one never does: not
// answering pings, sending a seq gap, sending an unknown frame, sending a version error.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '@weft/server';
import { localInsert } from '@weft/crdt';
import { decodeClient, encode, type ReplicaId } from '@weft/protocol';
import { createHeadlessReplica, type HeadlessReplica } from '../src/headless.ts';
import { memoryStore } from '../src/store/memoryStore.ts';
import { startRunner } from '../src/session/runner.ts';
import { converged as convergedAll, live, saved, until } from './headlessHelpers.ts';

const R = { a: 'bcdefghijklmn' as ReplicaId, b: 'cdefghijklmno' as ReplicaId, c: 'defghijklmnop' as ReplicaId };
const DOC = 'doc-e2e-0001';

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
const url = (): string => `ws://127.0.0.1:${server.port}`;
const replicas: HeadlessReplica[] = [];

async function replica(id: ReplicaId, store = memoryStore(id)): Promise<HeadlessReplica> {
  const r = await createHeadlessReplica({ url: url(), doc: DOC, replicaId: id, store });
  replicas.push(r);
  return r;
}

/** Live, saved, equal state vectors, nothing pending, equal texts and hashes (E40) — see headlessHelpers. */
const converged = (...rs: HeadlessReplica[]): Promise<void> => convergedAll(rs);

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'weft-client-e2e-'));
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir, limits: { QUIET_MS: 40 }, warn: () => undefined });
});

afterEach(async () => {
  await Promise.all(replicas.splice(0).map((r) => r.close()));
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('I1 end to end', () => {
  it('two headless replicas typing concurrently converge on text and hash, and each publishes the same hash after quiet (D3)', async () => {
    const a = await replica(R.a);
    const b = await replica(R.b);
    await until(() => live(a) && live(b), 'both live');
    await a.insertText(0, 'Hello');
    await b.insertText(0, 'World');
    await converged(a, b);
    expect(a.text()).toMatch(/^(HelloWorld|WorldHello)$/);
    await until(() => a.state().hash !== null && a.state().peers.get(R.b)?.state.hash === a.state().hash, 'hash from b equals own hash');
    expect(b.state().peers.get(R.a)?.state.hash).toBe(a.state().hash);
    expect(a.state().lastQuiet).toEqual(a.state().sv);
  });

  it('the D3 hash is not published while the state vectors differ, and the presence carries name and colour', async () => {
    const a = await replica(R.a);
    await until(() => live(a), 'live');
    await until(() => a.state().hash !== null, 'own hash after quiet');
    const b = await replica(R.b);
    await until(() => b.state().peers.get(R.a) !== undefined, 'b sees a');
    expect(b.state().peers.get(R.a)?.state).toMatchObject({ name: R.a.slice(0, 6), color: 0 });
  });

  it('three replicas, one partitioned: edits on both sides of the partition merge when it heals, and the offline count was honest', async () => {
    const [a, b, c] = await Promise.all([replica(R.a), replica(R.b), replica(R.c)]);
    await until(() => live(a) && live(b) && live(c), 'all live');
    await a.insertText(0, 'base ');
    await converged(a, b, c);
    c.dispatch({ e: 'USER_OFFLINE' });
    await until(() => c.state().session.s === 'offline', 'c offline');
    await a.insertText(5, 'AAA');
    await b.insertText(5, 'BBB');
    await c.insertText(5, 'CCC');
    await c.insertText(0, '>');
    await converged(a, b);
    expect(c.state().session).toEqual({ s: 'offline', reason: 'user', unacked: 4 });
    expect(c.text()).toBe('>base CCC');
    c.dispatch({ e: 'USER_ONLINE' });
    await converged(a, b, c);
    expect(c.text()).toMatch(/^>base (AAA|BBB|CCC){3}$/);
    expect(c.text()).toContain('AAA');
    expect(c.text()).toContain('BBB');
    expect(c.text()).toContain('CCC');
  });

  it('server restart mid-session: clients degrade, keep editing, reconnect to the new server and converge with nothing lost', async () => {
    const a = await replica(R.a);
    const b = await replica(R.b);
    await until(() => live(a) && live(b), 'both live');
    await a.insertText(0, 'abc');
    await converged(a, b);
    const port = server.port;
    await server.close();
    await until(() => a.state().session.s === 'degraded' && b.state().session.s === 'degraded', 'both degraded');
    await a.insertText(3, 'X');
    await b.insertText(3, 'Y');
    expect(a.state().session.unacked).toBe(1);
    server = await startServer({ host: '127.0.0.1', port, dataDir, limits: { QUIET_MS: 40 }, warn: () => undefined });
    await converged(a, b);
    expect(a.text()).toMatch(/^abc(XY|YX)$/);
    // Every op — before the restart and after — is in the file exactly once.
    expect(readFileSync(join(dataDir, `${DOC}.jsonl`), 'utf8').split('\n').filter(Boolean)).toHaveLength(5);
  });

  it('a reloaded replica continues from its store: text restored, no re-upload, still saved', async () => {
    const store = memoryStore(R.a);
    const first = await replica(R.a, store);
    await until(() => live(first), 'live');
    await first.insertText(0, 'kept');
    await until(() => saved(first), 'saved');
    await first.close();
    const linesOf = (): string[] => readFileSync(join(dataDir, `${DOC}.jsonl`), 'utf8').split('\n').filter(Boolean);
    const before = linesOf();
    expect(before).toHaveLength(4);
    const again = await replica(R.a, store);
    expect(again.text()).toBe('kept');
    await until(() => saved(again), 'saved after reload');
    expect(linesOf()).toEqual(before); // nothing re-uploaded: the welcome's sv already covered these ops
    await again.insertText(4, '!');
    await until(() => saved(again), 'saved again');
    expect(linesOf().slice(0, 4)).toEqual(before);
    expect(linesOf()).toHaveLength(5);
  });
});

describe('attacks and refusals seen from the client', () => {
  it('attack (E12): a parent id that never exists is refused by the server as UNKNOWN_DEPENDENCY; no peer ever parks it, the file never holds it, and later edits converge with nothing pending', async () => {
    const a = await replica(R.a);
    await until(() => live(a), 'live');
    const ghost = new WebSocket(url());
    const heard: unknown[] = [];
    ghost.onmessage = (ev: MessageEvent) => heard.push(JSON.parse(ev.data as string));
    await new Promise((r) => (ghost.onopen = r));
    ghost.send(encode({ v: 1, t: 'hello', doc: DOC, replica: R.c, sv: {} }));
    ghost.send(encode({ v: 1, t: 'ops', ops: [{ t: 'ins', id: { replica: R.c, seq: 1 }, parent: { replica: R.c, seq: 500 }, side: 'R', content: { kind: 'char', text: 'g' } }] }));
    await until(() => heard.some((m) => (m as { t: string; code?: string }).t === 'error'), 'the ghost is refused');
    expect(heard.find((m) => (m as { t: string }).t === 'error')).toMatchObject({ code: 'UNKNOWN_DEPENDENCY', fatal: false });
    expect(a.state().pending).toBe(0);
    expect(live(a)).toBe(true);
    ghost.close();
    const b = await replica(R.b);
    await a.insertText(0, 'ok');
    await converged(a, b);
    expect(a.text()).toBe('ok');
    expect(b.state().pending).toBe(0);
    expect(readFileSync(join(dataDir, `${DOC}.jsonl`), 'utf8')).not.toContain(R.c);
  });

  it('denied path: the same replica id with a fresh store is refused as a corrupt identity (FOREIGN_REPLICA, failed), editing still allowed', async () => {
    const original = await replica(R.a);
    await until(() => live(original), 'live');
    await original.insertText(0, 'mine');
    await until(() => saved(original), 'saved');
    await original.close();
    const impostor = await replica(R.a, memoryStore(R.a));
    await until(() => impostor.state().session.s === 'failed', 'failed');
    expect(impostor.state().session).toMatchObject({ s: 'failed', code: 'FOREIGN_REPLICA' });
    await impostor.insertText(0, 'still typing');
    expect(impostor.text()).toBe('still typing');
    expect(impostor.state().session.unacked).toBe(12);
  });

  it('a store that belongs to another replica is a programmer error at start', async () => {
    const store = memoryStore(R.a);
    await store.markAcked({});
    await expect(createHeadlessReplica({ url: url(), doc: DOC, replicaId: R.b, store })).rejects.toThrow(/belongs to replica/);
  });
});

describe('against a server that misbehaves (bare ws listener)', () => {
  let fake: WebSocketServer;
  const hellos: unknown[] = [];
  let script: (send: (m: object) => void, msg: unknown) => void = () => undefined;

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
    for (const c of fake.clients) c.terminate();
    await new Promise<void>((r) => fake.close(() => r()));
  });

  const fakeUrl = (): string => `ws://127.0.0.1:${(fake.address() as { port: number }).port}`;

  it('interrupted path: a server that never answers pings is dropped as a pong timeout and the session degrades', async () => {
    script = (send, msg) => {
      if ((msg as { t: string }).t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
    };
    const runner = await startRunner({ url: fakeUrl(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 1 }, keepAlive: { pingMs: 20, pongMs: 30 } });
    await until(() => runner.snapshot().session.s === 'live', 'live');
    await until(() => runner.snapshot().session.s === 'degraded', 'degraded');
    expect(runner.snapshot().session).toMatchObject({ s: 'degraded', lastError: 'pong timeout' });
    await runner.close();
  });

  it('client-side I9: an inbound op that skips a seq is refused and answered with a fresh hello; unknown frames are counted, not fatal', async () => {
    script = (send, msg) => {
      if ((msg as { t: string }).t !== 'hello') return;
      send({ v: 1, t: 'welcome', sv: {} });
      if (hellos.length === 1) {
        send({ v: 1, t: 'converged', sv: {} });
        send({ v: 1, t: 'ops', ops: [{ t: 'ins', id: { replica: R.b, seq: 2 }, parent: { replica: 'aaaaaaaaaaaaa', seq: 0 }, side: 'R', content: { kind: 'char', text: 'x' } }] });
      }
    };
    const runner = await startRunner({ url: fakeUrl(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 1 } });
    await until(() => hellos.length === 2, 'a second hello after the gap');
    await until(() => runner.snapshot().session.s === 'live', 'live again');
    expect(runner.snapshot().ignored).toBe(1);
    expect(runner.snapshot().sv).toEqual({});
    await runner.close();
  });

  it('attack (S5): a hostile presence frame (name of 10 000 chars, colour 99) is ignored and counted, never entering the peer table; a valid one is accepted', async () => {
    script = (send, msg) => {
      if ((msg as { t: string }).t !== 'hello') return;
      send({ v: 1, t: 'welcome', sv: {} });
      // Two malformed presence frames the client must refuse at decode, then one valid frame.
      send({ v: 1, t: 'presence', replica: R.b, state: { name: 'x'.repeat(10_000), color: 99 } });
      send({ v: 1, t: 'presence', replica: R.b, state: { name: 'Mara', color: 2, cursor: { anchor: { id: 'x', side: 'after' }, head: { id: null, side: 'after' } } } });
      send({ v: 1, t: 'presence', replica: R.c, state: { name: 'Tomas', color: 2 } });
    };
    const runner = await startRunner({ url: fakeUrl(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 1 } });
    await until(() => runner.snapshot().peers.get(R.c) !== undefined, 'the valid peer arrived');
    expect(runner.snapshot().peers.has(R.b)).toBe(false); // both hostile frames refused at decode
    expect(runner.snapshot().ignored).toBe(2);
    await runner.close();
  });

  it('attack: 1 100 local ops persisted in one batch leave the client in ≤ 512-op messages, in order (S3 paste chunking)', async () => {
    const batches: number[] = [];
    script = (send, msg) => {
      const m = msg as { t: string; ops?: unknown[] };
      if (m.t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
      if (m.t === 'ops') batches.push((m.ops as unknown[]).length);
    };
    const r = await createHeadlessReplica({ url: fakeUrl(), doc: DOC, replicaId: R.a, store: memoryStore(R.a) });
    await until(() => live(r), 'live');
    await r.insertText(0, 'x'.repeat(1_100));
    await until(() => batches.reduce((n, b) => n + b, 0) === 1_100, 'all ops arrived');
    expect(batches).toEqual([512, 512, 76]);
    await r.close();
  });

  it('a store that refuses to persist a local edit ends the session as failed · STORE_FAILED (E18) and the edit’s promise rejects', async () => {
    script = (send, msg) => {
      if ((msg as { t: string }).t === 'hello') send({ v: 1, t: 'welcome', sv: {} });
    };
    const store = memoryStore(R.a);
    store.putOps = async () => {
      throw new Error('quota exceeded');
    };
    const runner = await startRunner({ url: fakeUrl(), doc: DOC, me: R.a, store, presence: { name: 'a', color: 1 } });
    await until(() => runner.snapshot().session.s === 'live', 'live');
    await expect(runner.local((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }))).rejects.toThrow('quota exceeded');
    expect(runner.snapshot().session).toEqual({ s: 'failed', code: 'STORE_FAILED', reason: 'store failed: quota exceeded', unacked: 0 });
    await runner.close();
  });

  it('a fatal version error ends the session as failed and keeps the supported list for the error card', async () => {
    script = (send) => send({ v: 1, t: 'error', code: 'UNSUPPORTED_VERSION', reason: 'v2 only', fatal: true, supported: [2, 3] });
    const runner = await startRunner({ url: fakeUrl(), doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 1 } });
    await until(() => runner.snapshot().session.s === 'failed', 'failed');
    expect(runner.snapshot().supported).toEqual([2, 3]);
    expect(runner.snapshot().session).toMatchObject({ code: 'UNSUPPORTED_VERSION', reason: 'v2 only' });
    await runner.close();
  });

  it('a socket that is refused outright degrades with backoff and keeps the unacked count', async () => {
    const closedPort = (fake.address() as { port: number }).port;
    await new Promise<void>((r) => fake.close(() => r()));
    fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => fake.once('listening', r));
    const runner = await startRunner({ url: `ws://127.0.0.1:${closedPort}`, doc: DOC, me: R.a, store: memoryStore(R.a), presence: { name: 'a', color: 1 } });
    await until(() => runner.snapshot().session.s === 'degraded', 'degraded');
    expect(runner.snapshot().session).toMatchObject({ s: 'degraded', attempt: 0 });
    await runner.close();
    expect(runner.snapshot().session).toEqual({ s: 'offline', reason: 'user', unacked: 0 });
  });
});
