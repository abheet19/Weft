// dev.mjs — `npm run dev`: the relay on 127.0.0.1:4200 and the Vite dev server on 127.0.0.1:5173
// in one terminal, each line prefixed with its source, both stopped together. A 30-line script
// rather than a dependency, because the repository adds no runtime or tooling package it can
// write in an afternoon. Exits with the first child's non-zero code so a port clash is not hidden.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const win32 = process.platform === 'win32';

/** Spawn a workspace script and echo its output with a fixed-width prefix. On POSIX the child leads its own process group (`detached`), so `stop` can kill the whole tree — `npm` → `sh` → `node`/`vite` — with one signal; stdio stays piped, so nothing else changes. */
function run(label, args) {
  const child = spawn(npm, args, { cwd: root, shell: win32, env: process.env, detached: !win32 });
  const echo = (stream, out) => stream.on('data', (chunk) => out.write(String(chunk).replace(/^(?=.)/gm, `${label} `)));
  echo(child.stdout, process.stdout);
  echo(child.stderr, process.stderr);
  return child;
}

const server = run('[server]', ['run', 'dev:server']);
const client = run('[client]', ['run', 'dev', '-w', '@weft/client']);
const children = [server, client];

/** Stop a child AND its process tree: on Windows `npm.cmd` is a shell whose grandchildren (node, vite) outlive a plain kill and keep the ports; on POSIX the child is a process-group leader (see `run`), so the negative pid signals the whole group. A group that is already gone throws ESRCH, which is the outcome wanted. */
function stop(child) {
  if (child.exitCode !== null) return;
  if (win32) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  }
}

function stopAll(code) {
  for (const child of children) stop(child);
  process.exit(code);
}
for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
console.log('weft dev: server → ws://127.0.0.1:4200 · client → http://127.0.0.1:5173 (open it in two windows)');
