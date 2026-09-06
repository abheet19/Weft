// global-setup.ts — one real stack for the whole e2e run: the @weft/server on an ephemeral port
// with a temporary data directory, a production Vite build whose VITE_WEFT_WS is that port, and a
// Vite preview server on another ephemeral port. The tests read the preview's origin from
// WEFT_E2E_BASE. Everything is torn down by the returned function, including the temp directory,
// so a run leaves nothing behind. Ports are never fixed: two runs, or a developer's own
// `npm run dev`, must not collide.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { startServer } from '@weft/server';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const clientRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
  const dataDir = mkdtempSync(join(tmpdir(), 'weft-e2e-data-'));
  const outDir = mkdtempSync(join(tmpdir(), 'weft-e2e-dist-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, warn: (m) => console.warn(`[server] ${m}`) });
  const ws = `ws://127.0.0.1:${server.port}`;
  await build({ root: clientRoot, configFile: join(clientRoot, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true }, define: { 'import.meta.env.VITE_WEFT_WS': JSON.stringify(ws) } });
  const previewServer = await preview({ root: clientRoot, configFile: join(clientRoot, 'vite.config.ts'), logLevel: 'warn', build: { outDir }, preview: { port: 0, strictPort: false, host: '127.0.0.1' } });
  const base = previewServer.resolvedUrls?.local[0];
  if (base === undefined) throw new Error('vite preview reported no local URL');
  process.env['WEFT_E2E_BASE'] = base.replace(/\/$/, '');
  console.log(`e2e: server ${ws} · preview ${base}`);
  return async () => {
    await previewServer.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  };
}
