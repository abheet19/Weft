// two-headless.mjs — two headless replicas, one real server, one document: both type at the same
// index at the same time, then converge. Run the server first (`npm run dev:server`), then:
//   node packages/client/examples/two-headless.mjs
// Prints each replica's text as it changes and, once both are live with nothing unacknowledged and
// equal state vectors, both texts and both SHA-256 content hashes — the convergence proof of
// design §3.5. WEFT_PORT selects the server port (default 4200). No clock enters the algorithm;
// the timestamps below are only for the reader.
import { createHeadlessReplica } from '../src/headless.ts';
import { memoryStore } from '../src/store/memoryStore.ts';

const url = `ws://127.0.0.1:${process.env.WEFT_PORT || 4200}`;
const doc = `demo-${Date.now().toString(36)}`; // a fresh document per run, so the output is the same every time
const started = Date.now();
const log = (who, what) => console.log(`${String(Date.now() - started).padStart(5)} ms  ${who}  ${what}`);

const a = await replica('bcdefghijklmn', 'A');
const b = await replica('cdefghijklmno', 'B');
await until(() => live(a) && live(b), 'both replicas live');

log('A ', 'types "Hello" at 0');
log('B ', 'types "World" at 0   (concurrently, same position)');
await Promise.all([a.insertText(0, 'Hello'), b.insertText(0, 'World')]);

await until(() => saved(a) && saved(b) && sameSv(a, b), 'both saved with equal state vectors');
const [hashA, hashB] = await Promise.all([a.hash(), b.hash()]);
console.log('');
console.log(`A text  ${JSON.stringify(a.text())}`);
console.log(`B text  ${JSON.stringify(b.text())}`);
console.log(`A hash  ${hashA}`);
console.log(`B hash  ${hashB}`);
console.log(`converged: ${a.text() === b.text() && hashA === hashB}`);
await Promise.all([a.close(), b.close()]);

async function replica(id, label) {
  const r = await createHeadlessReplica({ url, doc, replicaId: id, store: memoryStore(id), name: label });
  let lastText = null;
  const watch = setInterval(() => {
    const text = r.text();
    if (text !== lastText) {
      lastText = text;
      log(`${label} `, `sees ${JSON.stringify(text)}  (${r.state().session.s}, unacked ${r.state().session.unacked})`);
    }
  }, 5);
  const close = r.close;
  r.close = () => {
    clearInterval(watch);
    return close();
  };
  return r;
}

function live(r) {
  return r.state().session.s === 'live';
}

function saved(r) {
  return live(r) && r.state().session.unacked === 0;
}

function sameSv(x, y) {
  const key = (r) => JSON.stringify(Object.entries(r.state().sv).sort());
  return key(x) === key(y);
}

async function until(cond, what) {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) {
      console.error(`gave up waiting for: ${what} — is the server running on ${url}? (npm run dev:server)`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  log('  ', what);
}
