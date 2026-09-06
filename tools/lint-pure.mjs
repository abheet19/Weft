// lint-pure.mjs — the PURE rule of LLD §9 as a build failure, not a convention:
// nothing under packages/crdt/src or packages/protocol/src may read a clock, draw randomness, or
// schedule time. Convergence must never depend on wall time (design §3.6), and a pure `apply` is
// what makes the property tests meaningful. The client's PURE files (LLD §1.3: the session
// reducer, the stores, the pill's words) are held to the same rule one by one (S4, LLD §8 "clock
// set to 1970 / 2099 changes nothing"): the wall clock reaches them only as a parameter. Comments
// are blanked before scanning so a file header may name the forbidden calls. Exits 1 listing
// file:line for each hit.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PURE_DIRS = ['packages/crdt/src', 'packages/protocol/src'];
const PURE_FILES = ['packages/client/src/session/machine.ts', 'packages/client/src/store/memoryStore.ts', 'packages/client/src/store/idb.ts', 'packages/client/src/store/claim.ts', 'packages/client/src/store/prefs.ts', 'packages/client/src/ui/pillCopy.ts', 'packages/client/src/ui/copy.ts', 'packages/client/src/presence/awareness.ts', 'packages/client/src/presence/colors.ts', 'packages/client/src/presence/constants.ts', 'packages/client/src/inspector/divergence.ts', 'packages/client/src/inspector/model.ts', 'packages/client/src/history/timeTravel.ts', 'packages/client/src/history/undo.ts'];
const FORBIDDEN = [
  /\bDate\.now\b/,
  /\bnew\s+Date\b/,
  /\bMath\.random\b/,
  /\bcrypto\.getRandomValues\b/,
  /\bcrypto\.randomUUID\b/,
  /\bperformance\.now\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\bqueueMicrotask\b/,
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

/** Blank out comments but keep newlines so reported line numbers stay right. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const hits = [];
let files = 0;
const targets = [...PURE_DIRS.flatMap((dir) => walk(join(root, dir))), ...PURE_FILES.map((file) => join(root, file))];
for (const file of targets) {
  if (!existsSync(file)) {
    hits.push(`${relative(root, file)}: listed as PURE but does not exist`);
    continue;
  }
  files++;
  const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length) {
  console.error(`✗ lint-pure: ${hits.length} impure call(s) in PURE packages:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`✓ lint-pure: ${files} PURE source file(s) read no clock, no randomness, no timers.`);
