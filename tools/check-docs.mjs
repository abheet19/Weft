// check-docs.mjs — the one CI check a design-phase repository can honestly make:
// every relative Markdown link and image in README.md and docs/**/*.md points at a file that exists,
// and every in-page anchor (#heading) points at a heading in the target file.
// Zero dependencies. Exits 1 with a list of broken links, 0 otherwise.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === '.git') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

/** GitHub's heading → anchor rule: lowercase, strip punctuation except hyphens/spaces, spaces → hyphens. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/ /g, '-');   // GitHub replaces EACH space and does not trim: '## ⚙ Tech stack' → '-tech-stack'
}

function anchorsOf(file) {
  const text = readFileSync(file, 'utf8');
  const seen = new Map();
  const out = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    let s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    if (n > 0) s = `${s}-${n}`;
    out.add(s);
  }
  return out;
}

// The root-level portfolio docs (README, DESIGN) plus everything under docs/. DESIGN.md lives at the
// root (it is the interview brief the README links to), so it is named explicitly rather than walked.
const files = [join(root, 'README.md'), join(root, 'DESIGN.md'), ...walk(join(root, 'docs'))].filter(existsSync);
const broken = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"|src="([^"]+)"/g)) {
    const target = m[1] ?? m[2] ?? m[3];
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const targetFile = pathPart ? resolve(dirname(file), pathPart) : file;
    if (!existsSync(targetFile)) {
      broken.push(`${relative(root, file)} → ${target} (missing file)`);
      continue;
    }
    if (anchor && targetFile.endsWith('.md') && !anchorsOf(targetFile).has(anchor)) {
      broken.push(`${relative(root, file)} → ${target} (missing heading)`);
    }
  }
}

if (broken.length) {
  console.error(`✗ ${broken.length} broken link(s):`);
  for (const b of broken) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`✓ ${files.length} documents checked; every relative link resolves.`);
