// capture-reel60.mjs — drives the LIVE Weft deployment through the REDESIGNED glass flow and records
// a smooth 60fps demo reel plus a looping README GIF.
//
// The flow it films is the redesign's real entry path, end to end, with nothing staged:
//   1. the Documents library landing (the app's "/" home — nav rail + New document)
//   2. New document → a real navigation to /d/<fresh-id> (Documents.tsx uses location.assign)
//   3. the glass editor: the persistent formatting toolbar, a live document, and the
//      Outline / People / Sync side rail
//   4. ending on the honest ● Saved pill (drawn from the server ack, never a timer)
//
// Playwright records the whole session (including the in-page navigation) as .webm; ffmpeg then trims
// the cold-start lead-in and emits TWO artifacts:
//   docs/media/weft-reel.mp4  — H.264, ~1280px wide, motion-interpolated to a true 60fps (minterpolate)
//   docs/media/weft-demo.gif  — a smaller looping GIF for the README
//
// Run:  node tools/capture-reel60.mjs                                   (uses https://weft-abheet.fly.dev)
//       WEFT_URL=http://127.0.0.1:5173 node tools/capture-reel60.mjs    (against a local dev build)
//       FFMPEG=/path/to/ffmpeg node tools/capture-reel60.mjs            (if ffmpeg is not on PATH)

import { chromium } from 'playwright';
import { mkdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MEDIA = join(ROOT, 'docs', 'media');
const BASE = (process.env.WEFT_URL ?? 'https://weft-abheet.fly.dev').replace(/\/$/, '');
const VIEWPORT = { width: 1280, height: 800 };
const DSF = 2;
const OUT_MP4 = join(MEDIA, 'weft-reel.mp4');
const OUT_GIF = join(MEDIA, 'weft-demo.gif');

mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find an ffmpeg. Prefers $FFMPEG, then PATH, then the known winget install path on this machine. */
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    /* not on PATH */
  }
  const winget =
    'C:/Users/abhee/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
  try {
    execSync(`"${winget}" -version`, { stdio: 'ignore' });
    return winget;
  } catch {
    throw new Error('ffmpeg not found — set $FFMPEG to its full path.');
  }
}

/** Select the first occurrence of `phrase` via a DOM Range and apply a formatting shortcut over it —
 * a real, persisted `fmt` op, the way the toolbar and keyboard do it. */
async function applyMark(page, phrase, shortcut) {
  const ok = await page.evaluate((p) => {
    const pm = document.querySelector('.doc .ProseMirror');
    if (pm === null) return false;
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.textContent.indexOf(p);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + p.length);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return true;
      }
    }
    return false;
  }, phrase);
  if (!ok) return;
  await sleep(180);
  await page.keyboard.press(shortcut);
  await sleep(260);
}

/** Type a short formatted document, paced so the toolbar + Outline read as a lively editing pass. */
async function writeDocument(page) {
  const editor = page.locator('.doc .ProseMirror');
  await editor.click();
  await sleep(140);

  // H1 title.
  await page.keyboard.type('Weft — field notes', { delay: 26 });
  await page.keyboard.press('Control+Alt+1');
  await page.keyboard.press('Enter');

  // A paragraph carrying the bold + highlight phrases we mark below.
  await page.keyboard.type(
    'Every character has a permanent identity, so two people can edit the same line offline and nothing is ever lost.',
    { delay: 13 },
  );
  await page.keyboard.press('Enter');

  // H2 subheading — a second Outline entry.
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.type('What ships today', { delay: 20 });
  await page.keyboard.press('Enter');

  // Bulleted list.
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.type('A from-scratch Fugue CRDT', { delay: 13 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Offline-first op-log in IndexedDB', { delay: 13 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Presence and remote carets', { delay: 13 });
  await sleep(220);

  // Marks over real selections: one bold phrase, one highlighted phrase — the toolbar buttons light up.
  await applyMark(page, 'permanent identity', 'Control+b');
  await applyMark(page, 'nothing is ever lost', 'Control+Shift+h');

  // Collapse the selection to the top so no stray selection highlight shows. `force: true`: the
  // highlight mark can leave a transient popover overlapping the editor box for a frame.
  await editor.click({ force: true });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Home');
  await sleep(320);
}

/** Briefly click through the side rail's three tabs so People and Sync are shown, then rest on the
 * populated Outline — the redesign's rail, in motion. */
async function showRail(page) {
  const tab = async (name) => {
    await page.getByRole('tab', { name }).click().catch(() => {});
    await sleep(950);
  };
  await tab('People'); // "Only you" on a fresh doc — honest
  await tab('Sync'); // the calm "Saved" status with the honest counts
  await tab('Outline'); // rest here: the two headings we just wrote
  await page.locator('.ol-a').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await sleep(500);
}

async function main() {
  const ffmpeg = findFfmpeg();
  console.log(`Weft 60fps reel → ${BASE}  (ffmpeg: ${ffmpeg})`);

  const tmp = mkdtempSync(join(tmpdir(), 'weft-reel60-'));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    colorScheme: 'dark',
    recordVideo: { dir: tmp, size: VIEWPORT },
  });
  const t0 = Date.now(); // recording begins ~here
  const page = await context.newPage();

  // ── Beat 1 · the Documents library landing (the redesign's "/" home). Generous timeout: Fly
  // auto-stops the machine, so the first hit may cold-start. ────────────────────────────────────
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.locator('.screenpage[aria-label="Documents"]').waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('.navrail').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await sleep(900);

  const tStart = Date.now(); // the interesting motion starts here — trim the cold-start lead-in to this
  await sleep(1100); // hold on the landing so the reel opens on the library

  // ── Beat 2 · New document → a real navigation to /d/<fresh-id> (Documents.tsx location.assign) ──
  await page.locator('.docs-head button.btn.primary').first().click();
  await page.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 60000 });
  // Wait for the socket to be live (pill reads "Saved" on a fresh empty doc) BEFORE typing.
  await page
    .locator('[data-testid="pill-text"]')
    .filter({ hasText: 'Saved' })
    .waitFor({ timeout: 25000 })
    .catch(() => {});
  await sleep(650);

  // ── Beat 3 · the glass editor: type a formatted document through the persistent toolbar ────────
  await writeDocument(page);

  // ── Beat 4 · the Outline / People / Sync rail, then the honest ● Saved pill ────────────────────
  await showRail(page);
  await page
    .locator('[data-testid="pill-text"]')
    .filter({ hasText: 'Saved' })
    .waitFor({ timeout: 25000 })
    .catch(() => {});
  for (const x of await page.locator('.notice .xbtn').all()) await x.click().catch(() => {});
  await sleep(1200); // hold on the finished, saved state

  const tEnd = Date.now();
  const video = page.video();
  await context.close(); // flushes the .webm
  await browser.close();
  const webm = await video.path();

  const trimStart = Math.max(0, (tStart - t0) / 1000 - 0.3);
  const duration = (tEnd - tStart) / 1000 + 0.5;
  console.log(`  webm ${webm} — trim from ${trimStart.toFixed(2)}s for ${duration.toFixed(2)}s`);

  // ── 60fps MP4 · motion-interpolate to a true 60fps for smoothness (minterpolate), H.264, ~1280px ──
  const mp4Filter =
    'scale=1280:-2:flags=lanczos,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p';
  const mp4Args = [
    '-y', '-ss', trimStart.toFixed(2), '-t', duration.toFixed(2), '-i', webm,
    '-vf', mp4Filter,
    '-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-movflags', '+faststart', '-r', '60',
    '-an', OUT_MP4,
  ];
  console.log('  ffmpeg → weft-reel.mp4 (60fps, minterpolate)…');
  let r = spawnSync(ffmpeg, mp4Args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg (mp4) exited ${r.status}`);

  // ── Looping GIF · smaller, for the README (a GIF has no use for 60fps) ─────────────────────────
  const gifFilter =
    'fps=15,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3';
  const gifArgs = [
    '-y', '-ss', trimStart.toFixed(2), '-t', duration.toFixed(2), '-i', webm,
    '-filter_complex', gifFilter, '-loop', '0', OUT_GIF,
  ];
  console.log('  ffmpeg → weft-demo.gif (looping)…');
  r = spawnSync(ffmpeg, gifArgs, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg (gif) exited ${r.status}`);

  rmSync(tmp, { recursive: true, force: true });
  const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);
  console.log(`  wrote ${OUT_MP4} (${mb(OUT_MP4)} MB, 60fps)`);
  console.log(`  wrote ${OUT_GIF} (${mb(OUT_GIF)} MB)`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
