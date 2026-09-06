// rooms.test.ts — the owner of every document's log: a rejected close is a warning and never an
// unhandled rejection (E35); a corrupt log is read once and refused from memory afterwards (E26);
// a faulted room is closed even while members hold it, and the next acquire re-derives the truth
// from the file (E24); a release for a room that has already been superseded is a no-op.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogCorruptError } from '../src/log/appendLog.ts';
import { Rooms } from '../src/rooms.ts';
import { chain, DOC, FakeConn, FakeFs, hello, R, settle } from './helpers.ts';

type HelloMsg = Extract<ReturnType<typeof hello>, { t: 'hello' }>;

describe('Rooms', () => {
  it('E35: a log whose close rejects is reported through `warn`, not as an unhandled rejection, and the doc can be reopened', async () => {
    const fs = new FakeFs();
    const warnings: string[] = [];
    const rooms = new Rooms('/data', 5, (m) => warnings.push(m), fs);
    const room = await rooms.acquire(DOC);
    fs.closeError = new Error('EBADF');
    rooms.release(room);
    await settle();
    expect(warnings).toEqual([expect.stringMatching(/closing the log failed: EBADF/)]);
    fs.closeError = null;
    const again = await rooms.acquire(DOC);
    expect(again).not.toBe(room);
    await rooms.closeAll();
  });

  it('E26: a corrupt log (duplicate seq lines) is read once, remembered, and every later acquire is refused from memory', async () => {
    const fs = new FakeFs();
    const bytes = new TextEncoder().encode(`${JSON.stringify(chain(R.a, 1, 1)[0])}\n${JSON.stringify(chain(R.a, 1, 1)[0])}\n`);
    fs.files.set(join('/data', `${DOC}.jsonl`), { durable: bytes, written: bytes });
    const warnings: string[] = [];
    const rooms = new Rooms('/data', 5, (m) => warnings.push(m), fs);
    await expect(rooms.acquire(DOC)).rejects.toBeInstanceOf(LogCorruptError);
    await expect(rooms.acquire(DOC)).rejects.toBeInstanceOf(LogCorruptError);
    await expect(rooms.acquire(DOC)).rejects.toThrow(/seq 1 of .* does not follow 1/);
    expect(fs.reads).toBe(1);
    expect(warnings).toEqual([expect.stringMatching(/corrupt and needs an operator/)]);
    // Other documents are unaffected.
    const other = await rooms.acquire('another-doc');
    expect(other.doc).toBe('another-doc');
    await rooms.closeAll();
  });

  it('E24: a faulted room is released although members still hold it, and the next acquire is a fresh room read from the file', async () => {
    const fs = new FakeFs();
    const rooms = new Rooms('/data', 5, () => undefined, fs);
    const room = await rooms.acquire(DOC);
    const a = new FakeConn();
    const b = new FakeConn();
    await room.join(a, hello(R.a) as HelloMsg);
    await room.join(b, hello(R.b) as HelloMsg);
    fs.syncError = new Error('ENOSPC');
    await room.onOps(a, chain(R.a, 1, 2));
    expect(room.faulted).toBe(true);
    rooms.release(room); // what the first failed connection's detach does
    fs.syncError = null;
    fs.crash();
    const fresh = await rooms.acquire(DOC);
    expect(fresh).not.toBe(room);
    expect(fresh.faulted).toBe(false);
    rooms.release(room); // the second connection's detach: the entry now belongs to `fresh` and is left alone
    expect(await rooms.acquire(DOC)).toBe(fresh);
    const a2 = new FakeConn();
    await fresh.join(a2, hello(R.a, { [R.a]: 2 }) as HelloMsg);
    await fresh.onOps(a2, chain(R.a, 1, 2));
    expect(a2.ofType('ack').map((m) => m.seq)).toEqual([2]);
    await rooms.closeAll();
  });

  it('a room with members is kept; a release for a room that is not the current one is ignored', async () => {
    const rooms = new Rooms('/data', 5, () => undefined, new FakeFs());
    const room = await rooms.acquire(DOC);
    const a = new FakeConn();
    await room.join(a, hello(R.a) as HelloMsg);
    rooms.release(room);
    expect(await rooms.acquire(DOC)).toBe(room);
    room.leave(a);
    rooms.release(room);
    const next = await rooms.acquire(DOC);
    expect(next).not.toBe(room);
    rooms.release(room);
    expect(await rooms.acquire(DOC)).toBe(next);
    await rooms.closeAll();
  });
});
