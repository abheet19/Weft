// appendLog.test.ts — the durable log: `read(sv)` returns exactly the diff (property), a torn last
// line is truncated and reported, a gap is refused, corruption is refused loudly, and — the
// interrupted path of I10 — a crash after `write` but before `sync` leaves the state vector at
// the last synced prefix when the file is reopened. The fault is injected through the fs
// parameter, never by mocking globals. One test uses the real file system so `nodeFs` is proven
// on the platform the suite runs on.
import fc from 'fast-check';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Op, StateVector } from '@weft/protocol';
import { LogCorruptError, LogSeqError, nodeFs, openAppendLog, writeAll } from '../src/log/appendLog.ts';
import { chain, FakeFs, ins, R } from './helpers.ts';

const PATH = '/data/doc.jsonl';
const numRuns = process.env['CI'] ? 10_000 : 1_000;

describe('append and read', () => {
  it('starts empty, appends, and derives the state vector from what it holds', async () => {
    const fs = new FakeFs();
    const log = await openAppendLog(PATH, fs, () => undefined);
    expect(log.sv()).toEqual({});
    expect(log.length()).toBe(0);
    await log.append(chain(R.a, 1, 3));
    await log.append([ins(R.b, 1)]);
    expect(log.sv()).toEqual({ [R.a]: 3, [R.b]: 1 });
    expect(log.length()).toBe(4);
    expect(fs.dirs).toContain('/data');
    expect(fs.text(PATH).split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('read(sv) returns exactly the ops the other side lacks, per replica in seq order (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ a: fc.nat({ max: 12 }), b: fc.nat({ max: 12 }), c: fc.nat({ max: 12 }) }),
        fc.record({ a: fc.nat({ max: 15 }), b: fc.nat({ max: 15 }), c: fc.nat({ max: 15 }) }),
        async (held, theirs) => {
          const log = await openAppendLog(PATH, new FakeFs(), () => undefined);
          for (const [k, n] of Object.entries(held)) if (n > 0) await log.append(chain(R[k as 'a' | 'b' | 'c'], 1, n));
          const sv = { [R.a]: theirs.a, [R.b]: theirs.b, [R.c]: theirs.c } as StateVector;
          const got = log.read(sv);
          const want: Op[] = [];
          for (const k of ['a', 'b', 'c'] as const) for (let s = theirs[k] + 1; s <= held[k]; s++) want.push(ins(R[k], s));
          expect(got).toEqual(want);
        },
      ),
      { numRuns: Math.floor(numRuns / 10) },
    );
  });

  it('read({}) is the whole log and read(own sv) is empty', async () => {
    const log = await openAppendLog(PATH, new FakeFs(), () => undefined);
    await log.append(chain(R.a, 1, 5));
    expect(log.read({})).toEqual(chain(R.a, 1, 5));
    expect(log.read(log.sv())).toEqual([]);
    expect(log.read({ [R.a]: 99 } as StateVector)).toEqual([]);
  });

  it('accepted(replica) advances before the write completes, so two batches in flight are contiguous', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const log = await openAppendLog(PATH, fs, () => undefined);
    const first = log.append(chain(R.a, 1, 2));
    expect(log.accepted(R.a)).toBe(2);
    expect(log.sv()).toEqual({});
    const second = log.append(chain(R.a, 3, 4));
    expect(log.accepted(R.a)).toBe(4);
    release();
    await Promise.all([first, second]);
    expect(log.sv()).toEqual({ [R.a]: 4 });
    expect(fs.text(PATH).split('\n').filter(Boolean)).toHaveLength(4);
  });
});

describe('denied path: a gap is refused and nothing is written', () => {
  it('refuses a seq that skips ahead, a seq already held, and a gap inside one batch', async () => {
    const fs = new FakeFs();
    const log = await openAppendLog(PATH, fs, () => undefined);
    await log.append(chain(R.a, 1, 2));
    await expect(log.append([ins(R.a, 4)])).rejects.toBeInstanceOf(LogSeqError);
    await expect(log.append([ins(R.a, 2)])).rejects.toBeInstanceOf(LogSeqError);
    await expect(log.append([ins(R.a, 3), ins(R.a, 5)])).rejects.toThrow(/expected seq 4, got 5/);
    expect(log.sv()).toEqual({ [R.a]: 2 });
    expect(log.accepted(R.a)).toBe(2);
    expect(fs.text(PATH).split('\n').filter(Boolean)).toHaveLength(2);
    await log.append([ins(R.a, 3)]);
    expect(log.sv()).toEqual({ [R.a]: 3 });
  });
});

describe('interrupted path: recovery from the file', () => {
  it('kill after write before fsync: on reopen the state vector is the last synced prefix and the torn line is reported', async () => {
    const fs = new FakeFs();
    const warnings: string[] = [];
    const log = await openAppendLog(PATH, fs, (m) => warnings.push(m));
    await log.append(chain(R.a, 1, 3));
    // The next batch reaches the OS but the power goes before sync returns.
    fs.syncGate = new Promise(() => undefined);
    void log.append(chain(R.a, 4, 6)).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(fs.text(PATH).split('\n').filter(Boolean)).toHaveLength(6);
    // Simulate the platter holding a partial write: keep the synced bytes plus half a line of the unsynced batch.
    const f = fs.files.get(PATH) as { durable: Uint8Array; written: Uint8Array };
    f.durable = f.written.slice(0, f.durable.length + 20);
    fs.crash();
    fs.syncGate = null;
    const reopened = await openAppendLog(PATH, fs, (m) => warnings.push(m));
    expect(reopened.sv()).toEqual({ [R.a]: 3 });
    expect(reopened.length()).toBe(3);
    expect(warnings).toEqual([expect.stringMatching(/torn last line \(20 bytes dropped\)/)]);
    expect(fs.text(PATH).split('\n').filter(Boolean)).toHaveLength(3);
    // The author re-uploads from seq 4 and the log continues where the synced prefix ended.
    await reopened.append(chain(R.a, 4, 4));
    expect(reopened.sv()).toEqual({ [R.a]: 4 });
  });

  it('a clean crash (nothing torn) loses only the unsynced batch and reopens without a warning', async () => {
    const fs = new FakeFs();
    const log = await openAppendLog(PATH, fs, () => undefined);
    await log.append(chain(R.a, 1, 2));
    fs.syncGate = new Promise(() => undefined);
    void log.append(chain(R.a, 3, 3)).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    fs.crash();
    fs.syncGate = null;
    const warnings: string[] = [];
    const reopened = await openAppendLog(PATH, fs, (m) => warnings.push(m));
    expect(reopened.sv()).toEqual({ [R.a]: 2 });
    expect(warnings).toEqual([]);
  });

  it('a failed sync rejects the append, is never acknowledged, and poisons every later append until reopen', async () => {
    const fs = new FakeFs();
    const log = await openAppendLog(PATH, fs, () => undefined);
    await log.append(chain(R.a, 1, 1));
    fs.syncError = new Error('EIO');
    await expect(log.append(chain(R.a, 2, 2))).rejects.toThrow('EIO');
    fs.syncError = null;
    await expect(log.append(chain(R.a, 3, 3))).rejects.toThrow('EIO');
    expect(log.sv()).toEqual({ [R.a]: 1 });
    await log.close();
    fs.crash();
    const reopened = await openAppendLog(PATH, fs, () => undefined);
    expect(reopened.sv()).toEqual({ [R.a]: 1 });
  });

  it("E24: a failed sync rolls the claims back to the durable prefix, so `accepted` never says more than `sv` and a retry of the same seqs is not mistaken for a replay", async () => {
    const fs = new FakeFs();
    const log = await openAppendLog(PATH, fs, () => undefined);
    await log.append(chain(R.a, 1, 1));
    fs.syncError = new Error('ENOSPC');
    const failing = log.append(chain(R.a, 2, 3));
    const queued = log.append([ins(R.b, 1)]); // claimed behind the failing batch
    expect(log.accepted(R.a)).toBe(3);
    expect(log.accepted(R.b)).toBe(1);
    await expect(failing).rejects.toThrow('ENOSPC');
    await expect(queued).rejects.toThrow('ENOSPC');
    expect(log.accepted(R.a)).toBe(1);
    expect(log.accepted(R.b)).toBe(0);
    expect(log.sv()).toEqual({ [R.a]: 1 });
    // After the fault nothing is claimed any more either: the log is done until reopened.
    fs.syncError = null;
    await expect(log.append(chain(R.a, 2, 2))).rejects.toThrow('ENOSPC');
    expect(log.accepted(R.a)).toBe(1);
  });

  it('settled() resolves once every append handed in so far is durable or has failed, and never rejects', async () => {
    const fs = new FakeFs();
    let release = (): void => undefined;
    fs.syncGate = new Promise((r) => (release = r));
    const log = await openAppendLog(PATH, fs, () => undefined);
    void log.append(chain(R.a, 1, 2));
    let settled = false;
    const wait = log.settled().then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    release();
    await wait;
    expect(log.sv()).toEqual({ [R.a]: 2 });
    fs.syncError = new Error('EIO');
    await log.append(chain(R.a, 3, 3)).catch(() => undefined);
    await expect(log.settled()).resolves.toBeUndefined();
  });

  it('refuses a file with a complete line that is not an op, not JSON, not UTF-8, or that breaks contiguity', async () => {
    const cases: [string, Uint8Array, RegExp][] = [
      ['not JSON', new TextEncoder().encode('{"t":\n'), /line is not JSON/],
      ['not an op', new TextEncoder().encode('{"t":"mov"}\n'), /not an op/],
      ['not UTF-8', new Uint8Array([0xff, 0xfe, 0x0a]), /not UTF-8/],
      ['gap', new TextEncoder().encode(`${JSON.stringify(ins(R.a, 1))}\n${JSON.stringify(ins(R.a, 3))}\n`), /seq 3 of .* does not follow 1/],
    ];
    for (const [, bytes, re] of cases) {
      const fs = new FakeFs();
      fs.files.set(PATH, { durable: bytes, written: bytes });
      await expect(openAppendLog(PATH, fs, () => undefined)).rejects.toThrow(re);
      await expect(openAppendLog(PATH, fs, () => undefined)).rejects.toBeInstanceOf(LogCorruptError);
    }
  });
});

describe('writeAll (E34)', () => {
  it('loops until every byte is handed over when the handle writes a few at a time, and refuses a handle that makes no progress', async () => {
    const chunks: Uint8Array[] = [];
    const short = { write: async (data: Uint8Array) => (chunks.push(data.slice(0, 3)), { bytesWritten: Math.min(3, data.length) }) };
    const data = new TextEncoder().encode('0123456789');
    await writeAll(short, data);
    expect(chunks.map((c) => new TextDecoder().decode(c))).toEqual(['012', '345', '678', '9']);
    await expect(writeAll({ write: async () => ({ bytesWritten: 0 }) }, data)).rejects.toThrow(/no progress at byte 0 of 10/);
    await expect(writeAll(short, new Uint8Array())).resolves.toBeUndefined();
  });
});

describe('nodeFs on the real file system', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('creates the directory, appends with fsync, recovers a torn line, and reads back the same ops after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-log-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'doc.jsonl');
    const log = await openAppendLog(path, nodeFs, () => undefined);
    await log.append(chain(R.a, 1, 3));
    await log.close();
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Op)).toEqual(chain(R.a, 1, 3));
    writeFileSync(path, `${onDisk}{"t":"ins","id":{"rep`);
    const warnings: string[] = [];
    const reopened = await openAppendLog(path, nodeFs, (m) => warnings.push(m));
    expect(reopened.sv()).toEqual({ [R.a]: 3 });
    expect(warnings).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(onDisk);
    await reopened.append([ins(R.b, 1)]);
    await reopened.close();
    const again = await openAppendLog(path, nodeFs, () => undefined);
    expect(again.read({})).toEqual([...chain(R.a, 1, 3), ins(R.b, 1)]);
    await again.close();
  });
});
