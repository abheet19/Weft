// lintDeps.test.ts — I14 as a build failure: a synthetic `server → crdt` import must make
// tools/lint-deps.mjs exit non-zero. The lint is copied into a scratch repository (it locates
// packages relative to its own path) so the real tree is never touched, and the same scratch tree
// with the import corrected must pass — otherwise the failure could be a broken lint, not a
// caught violation.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratches: string[] = [];

/** A throwaway repository holding only the lint and the source files the case needs. */
function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'weft-lint-deps-'));
  scratches.push(root);
  mkdirSync(join(root, 'tools'));
  copyFileSync(join(repoRoot, 'tools', 'lint-deps.mjs'), join(root, 'tools', 'lint-deps.mjs'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function lint(root: string): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [join(root, 'tools', 'lint-deps.mjs')], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

afterEach(() => {
  for (const d of scratches.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('I14: the server has no import path to the CRDT', () => {
  it('fails on a synthetic server → crdt import and names the file', () => {
    const root = scratchRepo({ 'packages/server/src/room.ts': `import { apply } from '@weft/crdt';\nexport const x = apply;\n` });
    const r = lint(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/server[\\/]src[\\/]room\.ts: imports @weft\/crdt \(forbidden: server → crdt\)/);
  });

  it('fails on a type-only import too — a type path is still an import path', () => {
    const root = scratchRepo({ 'packages/server/src/room.ts': `import type { Op } from '@weft/crdt';\nexport type X = Op;\n` });
    expect(lint(root).status).toBe(1);
  });

  it('fails on a dynamic import and on a relative path that escapes the package', () => {
    const root = scratchRepo({
      'packages/server/src/a.ts': `export const m = await import('@weft/crdt');\n`,
      'packages/server/src/b.ts': `import { x } from '../../crdt/src/index.ts';\nexport const y = x;\n`,
    });
    const r = lint(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('forbidden: server → crdt');
    expect(r.stderr).toContain('escapes package server');
  });

  it('passes the same tree once the import points at @weft/protocol', () => {
    const root = scratchRepo({ 'packages/server/src/room.ts': `import { LIMITS } from '@weft/protocol';\nexport const x = LIMITS;\n` });
    const r = lint(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('respect the LLD §1 dependency direction');
  });

  it('fails a PURE package that declares a runtime dependency or imports a bare specifier', () => {
    const root = scratchRepo({
      'packages/protocol/package.json': JSON.stringify({ name: '@weft/protocol', dependencies: { zod: '1' } }),
      'packages/protocol/src/x.ts': `import { z } from 'zod';\nexport const s = z;\n`,
    });
    const r = lint(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must not have a "dependencies" field');
    expect(r.stderr).toContain('bare import zod in PURE package protocol');
  });

  it('the real tree passes', () => {
    expect(lint(repoRoot).status).toBe(0);
  });
});
