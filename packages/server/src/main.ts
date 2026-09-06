// main.ts — the process entry point: read two environment variables, start the server, print
// where it listens, stop cleanly on SIGINT/SIGTERM. This file exists so `npm run dev:server` is
// one command and so configuration parsing lives outside the server proper, which takes typed
// options. It must never bind anything but 127.0.0.1 (the server type forbids it), never contain
// protocol logic, and never swallow a startup failure — a bad port or an unwritable data
// directory exits non-zero with the reason.

import { resolve } from 'node:path';
import { startServer } from './wsServer.ts';

const DEFAULT_PORT = 4200;
const DEFAULT_DATA_DIR = './data';

/** A TCP port from the environment, or the default; anything else is a configuration error worth stopping for. */
function portFrom(env: string | undefined): number {
  if (env === undefined || env === '') return DEFAULT_PORT;
  const port = Number(env);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`WEFT_PORT must be an integer in 1..65535, got "${env}"`);
  return port;
}

const dataDir = resolve(process.env['WEFT_DATA_DIR'] || DEFAULT_DATA_DIR);
const server = await startServer({ host: '127.0.0.1', port: portFrom(process.env['WEFT_PORT']), dataDir });
console.log(`weft server listening on ws://127.0.0.1:${server.port} — per-document logs in ${dataDir}`);

const shutdown = (signal: string): void => {
  console.log(`${signal}: closing`);
  server.close().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
