// lint-deps.mjs — enforces the dependency direction of LLD §1 (gate 2 of the six):
//   client → crdt, protocol · server → protocol · crdt → nothing · protocol → nothing.
// It reads every source file under packages/*/src and fails on any import that crosses the line:
// an `@weft/<pkg>` specifier not in the allow-list, a relative path that escapes the package, or
// (for the two PURE packages) any bare specifier at all — zero runtime dependencies means zero.
// It also refuses a `dependencies` field in a PURE package's package.json. Exits 1 with a list.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

/** LLD §1: which workspace packages each package may import. Keys are directory names. */
const ALLOWED = {
  crdt: [],
  protocol: [],
  client: ['crdt', 'protocol'],
  server: ['protocol'],
};
/** PURE packages: no bare imports of any kind and no runtime dependencies. */
const PURE = new Set(['crdt', 'protocol']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every module specifier in a file: static imports/re-exports, side-effect imports, dynamic import(). */
function specifiersOf(text) {
  const out = [];
  for (const m of text.matchAll(/(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** True when `target` is inside `dir` (or is `dir`). */
function within(dir, target) {
  const rel = relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const problems = [];
const pkgs = existsSync(packagesDir)
  ? readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory())
  : [];

for (const pkg of pkgs) {
  const pkgDir = join(packagesDir, pkg);
  const allowed = ALLOWED[pkg];
  if (!allowed) {
    problems.push(`${pkg}: not in the LLD §1 module map — add it to ALLOWED in tools/lint-deps.mjs first`);
    continue;
  }
  const manifestPath = join(pkgDir, 'package.json');
  if (PURE.has(pkg) && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.dependencies !== undefined) {
      problems.push(`${pkg}/package.json: PURE package must not have a "dependencies" field`);
    }
  }
  for (const file of walk(join(pkgDir, 'src'))) {
    const rel = relative(root, file);
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('@weft/')) {
        const target = spec.slice('@weft/'.length).split('/')[0];
        if (!allowed.includes(target)) problems.push(`${rel}: imports ${spec} (forbidden: ${pkg} → ${target})`);
      } else if (spec.startsWith('.')) {
        if (!within(pkgDir, resolve(dirname(file), spec))) {
          problems.push(`${rel}: relative import ${spec} escapes package ${pkg}`);
        }
      } else if (PURE.has(pkg)) {
        problems.push(`${rel}: bare import ${spec} in PURE package ${pkg} (zero dependencies means zero)`);
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ lint-deps: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ lint-deps: ${pkgs.length} package(s) respect the LLD §1 dependency direction.`);
