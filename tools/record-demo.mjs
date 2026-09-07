// record-demo.mjs — records the README hero demo: two browser windows on ONE document, both typing,
// one of them dropped OFFLINE mid-sentence, and every edit merging on reconnect.
//
// It drives the LIVE deployment (or a local dev build) with two independent Playwright browser
// contexts pointed at the same `/d/<id>`. Nothing here is staged: the offline beat is a real
// `context.setOffline(true)` — `navigator.onLine` flips, the socket drops, Weft's session machine
// goes to `offline`, and the pill starts counting changes held on that device. Both windows keep
// typing while they are apart, so the frames show the two documents genuinely DIVERGE. Bringing the
// context back online replays the held ops through the normal catch-up path; the frames show them
// CONVERGE, with Weft's own "Back online — N offline edits merged." notice as the proof. There is no
// conflict prompt because a CRDT has nothing to ask.
//
// Frames are captured as paired PNG screenshots (one per window) and composed side by side by
// `tools/compose-demo.py` (Pillow) into `docs/media/weft-merge.gif`. Captions are drawn on the
// composite, not injected into the page, so the product's own pixels are never touched.
//
// Run:
//   node tools/record-demo.mjs                                   # against https://weft-abheet.fly.dev
//   WEFT_URL=http://127.0.0.1:5173 node tools/record-demo.mjs     # against `npm run dev`
//   WEFT_KEEP_FRAMES=1 node tools/record-demo.mjs                 # keep the raw PNG frames
//
// Requires: Playwright (already a devDependency) and Python 3 with Pillow (`pip install pillow`).

import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTDIR = join(ROOT, 'docs', 'demo');
const FRAMES = join(ROOT, '.demo-frames');
const OUT = join(OUTDIR, 'weft-merge.gif');
const BASE = (process.env.WEFT_URL ?? 'https://weft-abheet.fly.dev').replace(/\/$/, '');

/** One pane, in CSS pixels. Below the 1000px shell breakpoint Weft is a single column — which is
 * exactly what a side-by-side wants — and 2x device pixels keep the text crisp after downscaling. */
const PANE = { width: 600, height: 600 };
const DSF = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A 12-char [a-z0-9] document id — the shape @weft/protocol's DOC_ID_RE accepts. */
function docId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// ── frame recorder ────────────────────────────────────────────────────────────────────────────────

let seq = 0;
const manifest = [];
let pages = { a: null, b: null };
/** Caption state the composer burns onto each frame. `offline` marks which pane is cut off. */
let scene = { caption: '', sub: '', offline: null };

/** Capture one composite frame: a screenshot of each window plus the current caption. `hold`
 * repeats the frame in the GIF, which is how a beat is held without capturing redundant pixels. */
async function frame(hold = 1) {
  const n = String(seq++).padStart(4, '0');
  const a = join(FRAMES, `a-${n}.png`);
  const b = join(FRAMES, `b-${n}.png`);
  await pages.a.screenshot({ path: a });
  await pages.b.screenshot({ path: b });
  manifest.push({ a, b, hold, ...scene });
}

function say(caption, sub = '', offline = null) {
  scene = { caption, sub, offline };
}

/** Type into BOTH windows at once — a few characters here, a few there — so the frames show two
 * people editing the same document concurrently, not one after the other. */
async function typeTogether(textA, textB, { chunk = 3 } = {}) {
  const steps = Math.ceil(Math.max(textA.length, textB.length) / chunk);
  for (let i = 0; i < steps; i++) {
    const sa = textA.slice(i * chunk, (i + 1) * chunk);
    const sb = textB.slice(i * chunk, (i + 1) * chunk);
    if (sa) await pages.a.keyboard.type(sa, { delay: 12 });
    if (sb) await pages.b.keyboard.type(sb, { delay: 12 });
    await frame();
  }
}

/** Hold the current state for `ms`, capturing a frame roughly every 125 ms so live UI (the pill,
 * the notice strip, a remote caret arriving) keeps moving while we wait. */
async function hold(ms) {
  const n = Math.max(1, Math.round(ms / 125));
  for (let i = 0; i < n; i++) {
    await sleep(60);
    await frame();
  }
}

/** Put the caret at the end of the paragraph containing `phrase`, in `page`. */
async function caretAtEndOf(page, phrase) {
  await page.locator('.doc .ProseMirror p', { hasText: phrase }).first().click();
  await page.keyboard.press('End');
  await sleep(120);
}

async function pill(page) {
  return await page.locator('[data-testid="pill-text"]').innerText().catch(() => '');
}

async function text(page) {
  return (await page.locator('.doc .ProseMirror').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

// ── the demo ──────────────────────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUTDIR, { recursive: true });
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const id = docId();
  console.log(`Weft merge demo → ${BASE}/d/${id}`);

  const browser = await chromium.launch();
  const opts = { viewport: PANE, deviceScaleFactor: DSF, colorScheme: 'dark' };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);
  pages = { a: await ctxA.newPage(), b: await ctxB.newPage() };

  // Wake the machine and load both windows on the SAME document.
  for (const p of [pages.a, pages.b]) {
    await p.goto(`${BASE}/d/${id}`, { waitUntil: 'domcontentloaded' });
    await p.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 60_000 });
  }
  for (const p of [pages.a, pages.b]) {
    await p.locator('[data-testid="pill-text"]').filter({ hasText: 'Saved' }).waitFor({ timeout: 30_000 }).catch(() => {});
  }
  await sleep(1200);

  // ── Setup (not filmed): one window seeds a title and the two authors' lines, so that when the
  // recording starts each window already has its own paragraph to type into and the frames are all
  // motion rather than scaffolding.
  const ed = pages.a.locator('.doc .ProseMirror');
  await ed.click();
  await pages.a.keyboard.press('Control+End');
  await pages.a.keyboard.type('Release notes', { delay: 8 });
  await pages.a.keyboard.press('Control+Alt+1');
  await pages.a.keyboard.press('Enter');
  await pages.a.keyboard.type('Ana:', { delay: 8 });
  await pages.a.keyboard.press('Enter');
  await pages.a.keyboard.type('Ben:', { delay: 8 });
  await sleep(1500);
  await pages.b.locator('.doc .ProseMirror p', { hasText: 'Ben:' }).first().waitFor({ timeout: 30_000 });

  // Both carets in place: A on Ana's line, B on Ben's line.
  await caretAtEndOf(pages.a, 'Ana:');
  await caretAtEndOf(pages.b, 'Ben:');

  // ── Beat 1 · both online, both typing ────────────────────────────────────────────────────────
  say('Two windows. One document.', 'Both people typing at the same time — every edit shows up in both.');
  await hold(900);
  await typeTogether(' ship the CRDT core', ' and the offline op-log');
  await hold(2200);

  // ── Beat 2 · one window goes offline, both keep typing ───────────────────────────────────────
  await ctxB.setOffline(true);
  say('Window 2 just lost the network.', 'Real offline: navigator.onLine flips, the socket drops, the pill starts counting.', 'b');
  await pages.b.locator('[data-testid="pill-text"]').filter({ hasText: 'Offline' }).waitFor({ timeout: 30_000 });
  await hold(2400);

  say('Both keep typing anyway.', 'The documents DIVERGE — neither window can see the other’s new words.', 'b');
  await typeTogether(', plus presence and remote carets.', ', plus IndexedDB and the append log.');
  await hold(3600);

  const divergedA = await text(pages.a);
  const divergedB = await text(pages.b);
  console.log(`  diverged? ${divergedA !== divergedB ? 'YES' : 'NO — the beat did not happen'}`);
  console.log(`  offline pill: ${await pill(pages.b)}`);

  // ── Beat 3 · back online — everything merges ─────────────────────────────────────────────────
  say('Back online.', '', 'b');
  await ctxB.setOffline(false);
  await pages.b.locator('[data-testid="pill-text"]').filter({ hasText: 'Saved' }).waitFor({ timeout: 60_000 });
  await hold(900);

  say('Every edit merged. Nothing lost. No conflict prompt.', 'A CRDT has no central lock and no last-writer-wins — the merge is a fact about the tree.');
  await hold(4600);

  const finalA = await text(pages.a);
  const finalB = await text(pages.b);
  console.log(`  converged? ${finalA === finalB ? 'YES' : 'NO'}`);
  console.log(`  A: ${finalA}`);
  console.log(`  B: ${finalB}`);
  console.log(`  pills: A=${await pill(pages.a)}  B=${await pill(pages.b)}`);

  await browser.close();

  if (finalA !== finalB) throw new Error('windows did not converge — refusing to publish a demo that misrepresents the product');
  if (divergedA === divergedB) throw new Error('windows never diverged — the offline beat did not actually happen');

  // ── compose ──────────────────────────────────────────────────────────────────────────────────
  const manifestPath = join(FRAMES, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ out: OUT, frames: manifest }, null, 1));
  const py = spawnSync(process.env.PYTHON ?? 'python', [join(HERE, 'compose-demo.py'), manifestPath], { stdio: 'inherit' });
  if (py.status !== 0) throw new Error(`compose-demo.py exited ${py.status}`);

  if (process.env.WEFT_KEEP_FRAMES !== '1') rmSync(FRAMES, { recursive: true, force: true });
  console.log(`  wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
