// capture-hero.mjs — drives the LIVE Weft deployment headlessly and writes the README hero stills.
//
// It points at the public site (no local server), types a short, realistic document with real
// formatting so the editor looks alive, and shoots two frames:
//   docs/media/weft-editor.png — the editor: persistent toolbar, a formatted document, the Outline rail
//   docs/media/weft-sync.png   — two browser contexts on the SAME doc id: presence + converged text
//
// Run:  node tools/capture-hero.mjs           (uses https://weft-abheet.fly.dev)
//       WEFT_URL=http://127.0.0.1:5173 node tools/capture-hero.mjs   (against a local dev build)
//
// Reproducible and idempotent: a fresh random doc id each run, headless Chromium at a crisp
// 1600×1000 @2x, dark theme (the default, and the best-looking). The PNG stills are the deliverable;
// GIFs are skipped when no `ffmpeg` is on PATH (Playwright's own bundled ffmpeg is an internal
// dependency for video capture, not a general converter).

import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MEDIA = join(ROOT, 'docs', 'media');
const BASE = (process.env.WEFT_URL ?? 'https://weft-abheet.fly.dev').replace(/\/$/, '');
const VIEWPORT = { width: 1600, height: 1000 };
const DSF = 2;

mkdirSync(MEDIA, { recursive: true });

/** A 12-char [a-z0-9] document id, the shape @weft/protocol's DOC_ID_RE accepts. */
function docId() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Select the first occurrence of `phrase` in the editor via a DOM Range (ProseMirror syncs its
 * selection from it) and apply a formatting shortcut over it — a real, persisted `fmt` op, the way
 * the toolbar and keyboard do it (empty-selection stored marks are not what this binding persists). */
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
  await sleep(200);
  await page.keyboard.press(shortcut);
  await sleep(250);
}

/** Type a formatted document into the focused ProseMirror editor via the keyboard (the same edits a user makes). */
async function writeDocument(page) {
  const editor = page.locator('.doc .ProseMirror');
  await editor.click();
  await sleep(150);

  // H1 title
  await page.keyboard.type('Weaving the Loom: field notes');
  await page.keyboard.press('Control+Alt+1');
  await page.keyboard.press('Enter');

  // Paragraph 1 (a bold run applied over a selection, below)
  await page.keyboard.type('Weft stores a document as a tree of characters, not a string. Every character has a permanent identity and hangs off the character it was typed after.');
  await page.keyboard.press('Enter');

  // Paragraph 2 (a highlight run applied over a selection, below)
  await page.keyboard.type('Two people typing at the same spot produce two branches, not two positions — so the merge is a fact about the tree, deterministic on every device.');
  await page.keyboard.press('Enter');

  // H2 subheading (a second outline entry)
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.type('What ships today');
  await page.keyboard.press('Enter');

  // Bulleted list
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.type('A from-scratch Fugue CRDT with a numbered property test per invariant');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Offline-first op-log in IndexedDB — your work survives a tab crash');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Presence, remote carets, and a divergence tripwire that cannot be hidden');
  await page.keyboard.press('Enter');

  // Quote (convert the trailing empty bullet)
  await page.keyboard.press('Control+Shift+.');
  await page.keyboard.type('"No lost edits" is a claim about the data model, not a wish.');
  await sleep(300);

  // Formatting over real selections (persisted marks): one bold phrase, one highlighted phrase.
  await applyMark(page, 'permanent identity', 'Control+b');
  await applyMark(page, 'two branches, not two positions', 'Control+Shift+h');

  // Collapse the selection to the top so no stray highlight-of-selection shows in the shot.
  await page.locator('.doc .ProseMirror').click();
  await page.keyboard.press('Control+Home');
  await sleep(500);
}

async function captureEditor(browser) {
  const id = docId();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(`${BASE}/d/${id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 30000 });
  // Wait for the socket to be live (pill reads "Saved" on a fresh empty doc) BEFORE typing, so the
  // edits are acked as they go and no "offline edits merged" banner appears in the hero.
  await page.locator('[data-testid="pill-text"]').filter({ hasText: 'Saved' }).waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(600);
  await writeDocument(page);

  // Make sure the Outline rail is showing its two headings.
  await page.getByRole('tab', { name: 'Outline' }).click().catch(() => {});
  await page.locator('.ol-a').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  // Wait for the ack so the pill reads "Saved", then clear any transient notice strip.
  await page.locator('[data-testid="pill-text"]').filter({ hasText: 'Saved' }).waitFor({ timeout: 20000 }).catch(() => {});
  for (const x of await page.locator('.notice .xbtn').all()) await x.click().catch(() => {});
  await sleep(800);

  const out = join(MEDIA, 'weft-editor.png');
  await page.screenshot({ path: out });
  await context.close();
  return out;
}

async function setName(page, name) {
  page.once('dialog', (d) => d.accept(name).catch(() => {}));
  await page.keyboard.press('Control+k');
  await page.locator('dialog.cmdk[open], dialog.cmdk').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const input = page.locator('dialog.cmdk input[role="combobox"]');
  await input.fill('Set my name').catch(() => {});
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(400);
}

async function captureSync(browser) {
  const id = docId();
  const ctxA = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF, colorScheme: 'dark' });
  const ctxB = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF, colorScheme: 'dark' });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto(`${BASE}/d/${id}`, { waitUntil: 'domcontentloaded' });
  await a.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 30000 });
  await a.locator('[data-testid="pill-text"]').filter({ hasText: 'Saved' }).waitFor({ timeout: 20000 }).catch(() => {});
  await sleep(600);

  // A names itself and writes the shared title + first line.
  await a.locator('.doc .ProseMirror').click();
  await setName(a, 'Ada').catch(() => {});
  await a.locator('.doc .ProseMirror').click();
  await a.keyboard.type('Shared roadmap');
  await a.keyboard.press('Control+Alt+1');
  await a.keyboard.press('Enter');
  await a.keyboard.type('Ada: convergence is a property of the tree, not a lock. ');
  await sleep(1500);

  // B joins the same doc, names itself, and appends concurrently.
  await b.goto(`${BASE}/d/${id}`, { waitUntil: 'domcontentloaded' });
  await b.locator('.doc .ProseMirror').waitFor({ state: 'visible', timeout: 30000 });
  await sleep(1200);
  await b.locator('.doc .ProseMirror').click();
  await setName(b, 'Grace').catch(() => {});
  await b.locator('.doc .ProseMirror').click();
  await b.keyboard.press('Control+End');
  await b.keyboard.type('Grace: and both caret colours prove who is here.');
  await sleep(2500);

  // Type a little more in A so its caret is live in the shot and text has converged both ways.
  await a.locator('.doc .ProseMirror').click();
  await a.keyboard.press('Control+End');
  await a.keyboard.type(' Watch the text converge.');
  await sleep(3000);

  // Show People on A so the presence roster (2 here now) is visible alongside the remote caret.
  await a.getByRole('tab', { name: 'People' }).click().catch(() => {});
  await sleep(1200);
  // Clear any transient "offline edits merged" strip so the collaboration frame is clean.
  for (const x of await a.locator('.notice .xbtn').all()) await x.click().catch(() => {});
  await sleep(500);

  const out = join(MEDIA, 'weft-sync.png');
  await a.screenshot({ path: out });
  await ctxA.close();
  await ctxB.close();
  return out;
}

function report(path) {
  const kb = (statSync(path).size / 1024).toFixed(0);
  console.log(`  wrote ${path} (${kb} KB)`);
}

async function main() {
  console.log(`Weft hero capture → ${BASE}`);
  const browser = await chromium.launch();
  try {
    const e = await captureEditor(browser);
    report(e);
    const s = await captureSync(browser);
    report(s);
  } finally {
    await browser.close();
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
