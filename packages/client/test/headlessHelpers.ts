// headlessHelpers.ts — what the end-to-end tests ask of a headless replica, in one place so every
// test file means the same thing by "converged": live, nothing unacknowledged, equal state
// vectors, NOTHING PARKED (E40 — two replicas holding identical garbage in their pending buffers
// share a text and a hash without having converged on anything), then equal texts and hashes.
import { expect } from 'vitest';
import type { HeadlessReplica } from '../src/headless.ts';

/** Poll until `cond` holds, or fail with `what` after `ms`. */
export async function until(cond: () => boolean, what: string | (() => string), ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${typeof what === 'string' ? what : what()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const live = (r: HeadlessReplica): boolean => r.state().session.s === 'live';
export const saved = (r: HeadlessReplica): boolean => live(r) && r.state().session.unacked === 0;
export const sameSv = (a: HeadlessReplica, b: HeadlessReplica): boolean => JSON.stringify(sorted(a.state().sv)) === JSON.stringify(sorted(b.state().sv));
const sorted = (o: object): unknown => Object.fromEntries(Object.entries(o).sort());

/** Every replica live, saved, with the same state vector and an EMPTY pending buffer (within `ms`); then every text and every hash equal. */
export async function converged(rs: readonly HeadlessReplica[], ms = 8000): Promise<void> {
  const first = rs[0] as HeadlessReplica;
  await until(
    () => rs.every((r) => saved(r) && sameSv(r, first) && r.state().pending === 0),
    () => `all ${rs.length} replicas live, saved, same sv, nothing pending (states: ${rs.map((r) => `${r.state().session.s}/unacked ${r.state().session.unacked}/pending ${r.state().pending} ${JSON.stringify(r.text())}`).join(' | ')})`,
    ms,
  );
  const hashes = await Promise.all(rs.map((r) => r.hash()));
  for (const r of rs) {
    expect(r.state().pending).toBe(0);
    expect(r.text()).toBe(first.text());
  }
  for (const h of hashes) expect(h).toBe(hashes[0]);
}
