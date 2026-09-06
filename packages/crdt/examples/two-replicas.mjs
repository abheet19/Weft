// two-replicas.mjs — design §2.7 on two in-memory replicas. Run: node packages/crdt/examples/two-replicas.mjs
// Both start from "Hi". Offline, a types " there" after "i" and b types "!" after "i". Their ops
// then cross, in opposite orders, and both traversals print the same text. No server, no clock.
import { emptyDoc, localInsert, apply, visibleItems, idKey, siblingArray } from '../src/index.ts';

const text = (doc) => visibleItems(doc).map((it) => it.content.text).join('');
const tree = (doc) => [...doc.children].filter(([, c]) => c.L.length + c.R.length).map(([k, c]) => `${k} → L${JSON.stringify(siblingArray(c.L).map(idKey))} R${JSON.stringify(siblingArray(c.R).map(idKey))}`).join('\n    ');

/** One replica: its id, its contiguous seq counter, its doc, and the ops it produced. */
function replica(me) {
  const r = { me, seq: 0, doc: emptyDoc(), log: [] };
  r.type = (index, s) => {
    for (const ch of s) {
      const { ops, doc } = localInsert(r.doc, r.me, ++r.seq, index++, { kind: 'char', text: ch });
      r.doc = doc;
      r.log.push(...ops);
    }
  };
  r.receive = (ops) => ops.forEach((op) => (r.doc = apply(r.doc, op).doc));
  return r;
}

const a = replica('abcdefghijklm'); // 13 chars of [a-z2-7]; sorts before b's id
const b = replica('bcdefghijklmn');

a.type(0, 'Hi');
b.receive(a.log); // both hold "Hi" — then the network goes away
console.log(`shared start   a="${text(a.doc)}"  b="${text(b.doc)}"`);

a.type(2, ' there'); // a, offline
b.type(2, '!'); // b, offline, same position
console.log(`offline edits  a="${text(a.doc)}"  b="${text(b.doc)}"`);

b.receive(a.log.slice(2)); // a's edits reach b
a.receive(b.log); // b's edit reaches a — the other order
console.log(`after merge    a="${text(a.doc)}"  b="${text(b.doc)}"  same: ${text(a.doc) === text(b.doc)}`);
console.log(`\n  tree (both replicas): the space (a:3) and "!" (b:1) are both right children of "i" (a:2); siblings sort by id\n    ${tree(a.doc)}`);
