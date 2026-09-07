// capture-reel.mjs — drives the LIVE Weft deployment and records a short LinkedIn-ready demo reel.
//
// It opens a fresh document on the public site, types a short titled document, and applies real
// formatting through the same keyboard/toolbar path a user takes (an H1 title, a bold run, an H2, a
// highlight, and a bulleted list) so the persistent toolbar and the populated Outline rail are visibly
// in action, ending on the honest `● Saved` pill. Playwright records the session as .webm; ffmpeg then
// trims the loading lead-in and converts it to a looping GIF with a generated palette.
//
// Run:  node tools/capture-reel.mjs           (uses https://weft-abheet.fly.dev)
//       WEFT_URL=http://127.0.0.1:5173 node tools/capture-reel.mjs   (against a local dev build)
//       FFMPEG=/path/to/ffmpeg node tools/capture-reel.mjs           (if ffmpeg is not on PATH)
//
// Output: docs/media/weft-demo.gif  (~1000px wide, ~12 fps, looping, well under 6 MB).

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
const OUT = join(MEDIA, 'weft-demo.gif');

mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find an ffmpeg to convert webm → gif. Prefers $FFMPEG, then PATH, then the winget install path. */
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

/** A 12-char [a-z0-9] document id, the shape @weft/protocol's DOC_ID_RE accepts. */
function docId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
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
  await sleep(250);
}

/** Type a short formatted document, paced so the toolbar + Outline read as a lively editing pass. */
async function writeDocument(page) {
  const editor = page.locator('.doc .ProseMirror');
  await editor.click();
  await sleep(120);

  // H1 title.
  await page.keyboard.type('Weft — field notes', { delay: 22 });
  await page.keyboard.press('Control+Alt+1');
  await page.keyboard.press('Enter');

  // A paragraph carrying the bold + highlight phrases we mark below.
  await page.keyboard.type(
    'Every character has a permanent identity, so two people can edit the same line offline and nothing is ever lost.',
    { delay: 12 },
  );
  await page.keyboard.press('Enter');

  // H2 subheading — a second Outline entry.
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.type('What ships today', { delay: 18 });
  await page.keyboard.press('Enter');

  // Bulleted list.
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.type('A from-scratch Fugue CRDT', { delay: 12 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Offline-first op-log in IndexedDB', { delay: 12 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Presence and remote carets', { delay: 12 });
  await sleep(200);

  // Marks over real selections: one bold phrase, one highlighted phrase.
  await applyMark(page, 'permanent identity', 'Control+b');
  await applyMark(page, 'nothing is ever lost', 'Control+Shift+h');

  // Collapse selection to the top so no stray selection highlight shows at the end.
  await editor.click();
  await page.keyboard.press('Control+Home');
  await sleep(300);
}

async function main() {
  const ffmpeg = findFfmpeg();
  console.log(`Weft reel capture → ${BASE}  (ffmpeg: ${ffmpeg})`);

  const tmp = mkdtempSync(join(tmpdir(), 'weft-reel-'));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    colorScheme: 'dark',
    recordVideo: { dir: tmp, size: VIEWPORT },
  });
  const t0 = Date.now(); // recording begins ~here
  const page = await context.newPage();

  const id = docId();
  await page.goto(`${BASE}/d/${id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 30000 });
  // Wait for the socket to be live (pill reads "Saved" on a fresh empty doc) BEFORE typing.
  await page
    .locator('[data-testid="pill-text"]')
    .filter({ hasText: 'Saved' })
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await sleep(500);

  const tStart = Date.now(); // the interesting motion starts here — trim the lead-in to this point
  await writeDocument(page);

  // Show the Outline rail with its two headings.
  await page.getByRole('tab', { name: 'Outline' }).click().catch(() => {});
  await page.locator('.ol-a').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  // End on the honest "● Saved" pill; clear any transient notice strip first.
  await page
    .locator('[data-testid="pill-text"]')
    .filter({ hasText: 'Saved' })
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  for (const x of await page.locator('.notice .xbtn').all()) await x.click().catch(() => {});
  await sleep(1100); // hold on the finished, saved state

  const tEnd = Date.now();
  const video = page.video();
  await context.close(); // flushes the .webm
  await browser.close();
  const webm = await video.path();

  const trimStart = Math.max(0, (tStart - t0) / 1000 - 0.4);
  const duration = (tEnd - tStart) / 1000 + 0.6;
  console.log(`  webm ${webm} — trim from ${trimStart.toFixed(2)}s for ${duration.toFixed(2)}s`);

  const filter = 'fps=13,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3';
  const args = ['-y', '-ss', trimStart.toFixed(2), '-t', duration.toFixed(2), '-i', webm, '-filter_complex', filter, '-loop', '0', OUT];
  const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}`);

  rmSync(tmp, { recursive: true, force: true });
  const mb = (statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log(`  wrote ${OUT} (${mb} MB)`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
