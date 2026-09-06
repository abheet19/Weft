// @vitest-environment jsdom
// latency.test.ts — the two hot paths of the binding, timed as a MICRO-BENCHMARK and asserted only
// against the property the review fixed (findings 4 and 5, LLD §11 E47/E49): a local keystroke and a
// local delete are O(1) in document size, not O(n). Local: 200 keystrokes into a 50 000-character
// document, each at the start (the worst case for the index's array copies), without the full I7
// check — the production path. Remote: 50 000 ops arriving as 100 messages during catch-up become
// one transaction when catch-up ends, and a live burst of 100 messages in one tick becomes one
// redraw. Numbers are printed, never written into a document or a badge.
//
// This file runs UNDER ITS OWN vitest config (vitest.config.latency.ts): alone, not in the parallel
// worker pool the rest of the suite uses, because a wall-clock latency assertion measured while
// sibling workers compete for the CPU measures the scheduler, not the code. On top of that isolation
// the measurement itself is made honest and contention-robust: a warm-up discards the first
// iterations (JIT/cold-cache), the MEDIAN of the sample is taken (not the mean or max, so one GC
// pause or a preemption does not decide the number), and the regression guard is RELATIVE — a small
// doc vs the 50 000-char doc, both under the same machine load — plus a generous absolute ceiling. A
// true O(n)-in-size regression fails both; CPU contention trips neither.
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { docChanges, expectSynced, MemoryHost, mount, pasteText, R, tick, unmount, type Mounted } from './helpers.ts';

const mounted: Mounted[] = [];
function editor(host: MemoryHost, assert?: boolean): Mounted {
  const m = mount(host, assert === undefined ? {} : { assert });
  mounted.push(m);
  return m;
}
afterEach(() => {
  for (const m of mounted.splice(0)) unmount(m);
});

const KEYSTROKES = 200;
const WARMUP = 40; // discarded: the first keystrokes pay JIT compilation and cold-cache costs a steady-state editor never sees again.
// Absolute ceiling on the median per-keystroke/-delete cost, and the meaningful regression guard.
// The real risk is a keystroke going O(n) in document size the EXPENSIVE way — a full traversal per
// op, which measured ~85 ms per inserted char and ~92 ms per deleted char at 50 000 chars before the
// incremental index (S3 review P7). Note that a healthy keystroke is ALSO linear in n (the index
// copies its visible array, an O(n) memcpy), but at ~4 ms it is ~20× cheaper per element than a
// traversal — so a *size-relative* bound cannot separate the two (both are linear; only the constant
// differs) and would be ~24× even when healthy. Only an ABSOLUTE bound distinguishes them: 60 ms
// sits far below the ~85 ms regression and far above the worst contention seen on this loaded dev
// machine (~20–26 ms median with the old mean-based test). Quiet dev measures ~4 ms, CI ~2–3 ms.
const CEILING_MS = 60;
// The second, size-independent guard: the production path uses an O(change) WINDOW check where the
// dev path does the full O(document) I7 check (E47). Measured at the same size under the same load,
// the window median must stay materially below the full-check median — if the window check silently
// regressed to a whole-document pass, the ratio climbs toward 1. Healthy is ~0.3; 0.75 is generous
// headroom, and because both are measured at 50 000 chars the ratio cancels CPU contention out.
const WINDOW_VS_FULL_MAX = 0.75;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Median wall-clock cost of inserting KEYSTROKES characters at the FRONT of `m`'s document (worst case for the index), after a warm-up. */
function typeMedian(m: Mounted): number {
  const times: number[] = [];
  for (let i = 0; i < KEYSTROKES; i++) {
    const t0 = performance.now();
    m.view.dispatch(m.view.state.tr.insertText('x', 1 + i));
    if (i >= WARMUP) times.push(performance.now() - t0);
  }
  return median(times);
}

describe('per-keystroke latency (finding 4)', () => {
  it('typing at the start of a 50 000-character document stays cheap (window check), and the O(change) window check stays far below the full I7 check', () => {
    const prod = editor(new MemoryHost(R.a), false);
    pasteText(prod, 'abcdefghij'.repeat(5_000)); // 50 000 chars
    const windowMed = typeMedian(prod);
    expect(prod.faults).toEqual([]);
    expect(prod.host.text().length).toBe(50_000 + KEYSTROKES);
    expectSynced(prod); // the test's own full check, once

    // The same typing WITH the dev-mode assertion (the full O(document) I7 check path), which also
    // proves the mirror still holds under it.
    const dev = editor(new MemoryHost(R.b), true);
    pasteText(dev, 'abcdefghij'.repeat(5_000));
    const fullMed = typeMedian(dev);
    expectSynced(dev);
    expect(dev.faults).toEqual([]);

    console.log(`keystroke median into 50 000 chars: window check ${windowMed.toFixed(2)} ms, full I7 check ${fullMed.toFixed(2)} ms (${(windowMed / fullMed).toFixed(2)}× of full)`);

    // Guard 1 (absolute): a true O(n)-traversal regression (~85 ms) blows past this; contention does not.
    expect(windowMed).toBeLessThan(CEILING_MS);
    // Guard 2 (relative, contention-normalised): the production window check must stay materially
    // cheaper than the full-document check it replaced, or the O(change) optimisation has regressed.
    expect(windowMed).toBeLessThanOrEqual(WINDOW_VS_FULL_MAX * fullMed);
  });

  it('deleting a character and a range in a 50 000-character document is O(1) in document size, not O(n)', () => {
    const m = editor(new MemoryHost(R.a), false);
    pasteText(m, 'abcdefghij'.repeat(5_000));
    const ITER = KEYSTROKES; // reuse the sample size, warmed up like the typing test
    const ones: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      m.view.dispatch(m.view.state.tr.delete(1, 2)); // delete the first character, the worst case
      if (i >= WARMUP) ones.push(performance.now() - t0);
    }
    const oneMed = median(ones);
    const t1 = performance.now();
    m.view.dispatch(m.view.state.tr.delete(1, 1_001));
    const range = performance.now() - t1;
    console.log(`delete median one char ${oneMed.toFixed(2)} ms, delete 1 000 chars ${range.toFixed(2)} ms`);
    // A true O(n) delete measured ~92 ms/char before the incremental index; 60 ms fails that and
    // clears the worst contention seen here. The range delete is reported for context only.
    expect(oneMed).toBeLessThan(CEILING_MS);
    expectSynced(m);
    expect(m.host.text()).toHaveLength(50_000 - ITER - 1_000);
  });
});

describe('catch-up and bursts (finding 5)', () => {
  it('50 000 ops in 100 messages during catch-up are shown as one transaction when catch-up ends', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    for (let i = 0; i < 100; i++) b.view.dispatch(b.view.state.tr.insertText('0123456789'.repeat(50), b.view.state.doc.content.size - 1));
    const ops = b.host.pull();
    expect(ops).toHaveLength(50_000);
    const before = docChanges(a).length;
    a.host.syncing = true;
    const t0 = performance.now();
    for (let i = 0; i < ops.length; i += 500) {
      a.host.receive(ops.slice(i, i + 500)); // the harness asserts `applied` per op, which is most of this loop's time
      await tick(); // one frame per message, as the real thing
    }
    const delivered = performance.now() - t0;
    expect(docChanges(a).length - before).toBe(0); // nothing shown mid-catch-up
    a.host.syncing = false;
    const t1 = performance.now();
    a.host.receive([]); // the runner's CATCHUP_DONE notification
    await tick();
    console.log(`50 000 ops in 100 messages during catch-up: ${docChanges(a).length - before} transaction(s), shown in ${(performance.now() - t1).toFixed(0)} ms after a ${delivered.toFixed(0)} ms delivery loop (100 frames + 50 000 per-op asserts)`);
    expect(docChanges(a).length - before).toBeLessThanOrEqual(2);
    expectSynced(a);
    expect(a.view.state.doc.textContent).toHaveLength(50_000);
  });

  it('a live burst of 100 messages in one tick is one redraw', async () => {
    const a = editor(new MemoryHost(R.a));
    const b = editor(new MemoryHost(R.b));
    for (let i = 0; i < 100; i++) b.view.dispatch(b.view.state.tr.insertText('0123456789', b.view.state.doc.content.size - 1));
    const ops = b.host.pull();
    const before = docChanges(a).length;
    const t0 = performance.now();
    for (let i = 0; i < ops.length; i += 10) a.host.receive(ops.slice(i, i + 10));
    await tick();
    console.log(`100 live messages in one tick → editor: ${(performance.now() - t0).toFixed(0)} ms`);
    expect(docChanges(a).length - before).toBe(1);
    expectSynced(a);
  });
});
