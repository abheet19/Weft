// snapshot.ts — the tree as data, and back. This file exists so a replica can be stored and
// shipped without its whole op log (design §4.1): `encodeSnapshot` writes every item with
// tombstone text stripped, the parked ops (sorted by id), the formatting lamport and the state
// vector it all stands for (keys sorted) — so two replicas holding the same state encode the same
// bytes whatever order things arrived in — and `decodeSnapshot` rebuilds a Doc with identical
// canonicalBytes, sv, pending set and formatLamport (I12). Decoding treats its input as hostile
// JSON even though the type says Snapshot: every key set is exact, every id is validated,
// `"__proto__"` and `"constructor"` are refused as mark names, parked ops pass the same `refuse`
// as live ones, an unreachable or cyclic item fails the whole snapshot, and every object in the
// Doc is freshly built — nothing from the input is kept by reference. It must never accept a value
// that `apply` would not have produced.

import { compareIds, idKey, REPLICA_ID_RE, type ItemId, type ReplicaId } from './ids.ts';
import { refuse } from './apply.ts';
import { NO_CHILDREN, type Children, type Doc } from './doc.ts';
import { hasExactKeys, isItemContent, isLamport, isMarkSet, MARK_NAMES, NO_MARKS, ROOT, ROOT_KEY, type BlockAttrs, type Content, type Item, type ItemContent, type MarkSet, type MarkState, type Side } from './item.ts';
import { opDependencies, type Op } from './ops.ts';
import { PersistentMap } from './persistentMap.ts';
import { siblingsFrom } from './siblings.ts';
import type { StateVector } from './stateVector.ts';
import { svGet } from './stateVector.ts';
import { traversalOrder } from './traverse.ts';

/** One item as it travels. A deleted character keeps its id, parent and side (the tree needs them) but not its text. */
export interface SnapshotItem {
  readonly id: ItemId;
  readonly parent: ItemId;
  readonly side: Side;
  readonly content: ItemContent;
  readonly deleted: boolean;
  readonly marks: MarkSet;
}

/**
 * Serialised tree with tombstone text stripped, plus the SV it represents, the parked ops the SV
 * already counts (E11 — without them a snapshot would silently lose them), and the formatting
 * lamport (carried, not derived: a lamport no register kept still decides later LWW writes).
 * Decoding yields a Doc with identical canonicalBytes, sv, pending set and formatLamport (I12).
 */
export interface Snapshot {
  readonly v: 1;
  readonly sv: StateVector;
  readonly formatLamport: number;
  readonly items: readonly SnapshotItem[];
  readonly pending: readonly Op[];
}

const STRIPPED: ItemContent = Object.freeze({ kind: 'char', text: '' });

export function encodeSnapshot(doc: Doc): Snapshot {
  // Traversal order makes the encoding a function of the document, not of Map internals.
  const items: SnapshotItem[] = traversalOrder(doc).map((item) => ({
    id: item.id,
    parent: item.parent as ItemId, // only ROOT has a null parent and traversalOrder excludes ROOT
    side: item.side,
    content: item.deleted && item.content.kind === 'char' ? STRIPPED : item.content,
    deleted: item.deleted,
    marks: item.marks,
  }));
  // Parked ops by id, for the same reason: two replicas holding the same set encode the same bytes.
  const pending: Op[] = [];
  for (const ops of doc.pending.values()) pending.push(...ops);
  pending.sort((a, b) => compareIds(a.id, b.id));
  return { v: 1, sv: sortedSv(doc.sv), formatLamport: doc.formatLamport, items, pending };
}

/** The state vector with its keys in code-point order: JSON keeps insertion order, and arrival order is not part of the document. */
function sortedSv(sv: StateVector): StateVector {
  const out: Record<string, number> = {};
  for (const replica of Object.keys(sv).sort()) out[replica] = svGet(sv, replica);
  return Object.freeze(out) as StateVector;
}

/** Thrown by decodeSnapshot. A TypeError because the input failed to be a Snapshot, whatever the annotation said. */
function bad(what: string): never {
  throw new TypeError(`invalid snapshot: ${what}`);
}

function readStateVector(x: unknown): StateVector {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) bad('sv is not an object');
  const out: Record<string, number> = {};
  for (const key of Object.keys(x)) {
    if (!REPLICA_ID_RE.test(key)) bad(`sv key ${JSON.stringify(key)} is not a replica id`);
    const n = (x as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(n) || (n as number) < 0) bad(`sv[${key}] is not a non-negative integer`);
    out[key] = n as number;
  }
  return Object.freeze(out) as StateVector;
}

/** The validated fields of one item, before its parent is known to exist. The Item is built once, in the second pass, pointing at the tree's own parent id. */
interface Decoded {
  readonly id: ItemId;
  readonly key: string;
  readonly parentKey: string;
  readonly side: Side;
  readonly content: ItemContent;
  readonly deleted: boolean;
  readonly marks: MarkSet;
}

const ITEM_KEYS = ['id', 'parent', 'side', 'content', 'deleted', 'marks'] as const;

function copyId(id: ItemId): ItemId {
  return { replica: id.replica, seq: id.seq };
}

function copyAttrs(attrs: BlockAttrs): BlockAttrs {
  return attrs.level === undefined ? { type: attrs.type } : { type: attrs.type, level: attrs.level };
}

function copyContent(content: ItemContent): ItemContent {
  if (content.kind === 'char') return { kind: 'char', text: content.text };
  if (content.kind === 'break') return { kind: 'break' };
  return { kind: 'block', attrs: copyAttrs(content.attrs), lamport: content.lamport, replica: content.replica, seq: content.seq };
}

function copyMarks(marks: MarkSet): MarkSet {
  const out: Partial<Record<keyof MarkSet, MarkState>> = {};
  for (const name of MARK_NAMES) {
    const state = marks[name];
    if (state === undefined) continue;
    out[name] = state.href === undefined ? { active: state.active, lamport: state.lamport, replica: state.replica, seq: state.seq } : { active: state.active, lamport: state.lamport, replica: state.replica, seq: state.seq, href: state.href };
  }
  return out;
}

/** A fresh Op with the same fields. Only called after `refuse` accepted the shape, so every field read here exists. */
function copyOp(op: Op): Op {
  switch (op.t) {
    case 'ins': {
      const content: Content = op.content.kind === 'char' ? { kind: 'char', text: op.content.text } : op.content.kind === 'break' ? { kind: 'break' } : { kind: 'block', attrs: copyAttrs(op.content.attrs), lamport: op.content.lamport, replica: op.content.replica };
      return { t: 'ins', id: copyId(op.id), parent: copyId(op.parent), side: op.side, content };
    }
    case 'del':
      return { t: 'del', id: copyId(op.id), target: copyId(op.target) };
    case 'blk':
      return { t: 'blk', id: copyId(op.id), target: copyId(op.target), attrs: copyAttrs(op.attrs), lamport: op.lamport };
    case 'fmt': {
      const base = { t: 'fmt' as const, id: copyId(op.id), targets: op.targets.map(copyId), mark: op.mark, active: op.active, lamport: op.lamport };
      return op.href === undefined ? base : { ...base, href: op.href };
    }
  }
}

function readItem(x: unknown, sv: StateVector): Decoded {
  if (!hasExactKeys(x, ITEM_KEYS)) bad('item has the wrong keys');
  // A well-formed id here is one whose replica the sv names (sv keys were validated against
  // REPLICA_ID_RE already) and whose seq is 1..sv[replica].
  const id = x.id as { replica?: unknown; seq?: unknown } | null;
  if (typeof id !== 'object' || id === null || typeof id.replica !== 'string' || !Number.isSafeInteger(id.seq)) bad('item id is malformed');
  const seq = id.seq as number;
  const replica = id.replica as ReplicaId;
  if (seq < 1) bad('item id is malformed');
  if (seq > svGet(sv, replica)) bad(`item ${replica}:${seq} is not covered by sv`);
  const ownKey = `${replica}:${seq}`;
  // The parent only needs a shape here: it must resolve to a stored item (or ROOT) below, and the
  // stored item's own id object is what the decoded item will point at.
  const parent = x.parent as { replica?: unknown; seq?: unknown } | null;
  if (typeof parent !== 'object' || parent === null || typeof parent.replica !== 'string' || typeof parent.seq !== 'number') bad(`item ${ownKey} has a malformed parent`);
  const parentKey = `${parent.replica}:${parent.seq}`;
  if (x.side !== 'L' && x.side !== 'R') bad(`item ${ownKey} has side ${String(x.side)}`);
  if (typeof x.deleted !== 'boolean') bad(`item ${ownKey} has a non-boolean deleted flag`);
  // A tombstone's text is stripped to "", which is not a code point; only a tombstone may carry it.
  const stripped = !isItemContent(x.content);
  if (stripped && !(x.deleted && hasExactKeys(x.content, ['kind', 'text']) && x.content.kind === 'char' && x.content.text === '')) bad(`item ${ownKey} has malformed content`);
  if (!isMarkSet(x.marks)) bad(`item ${ownKey} has a mark that is not a MarkName or not a valid register`);
  if (parentKey === ownKey) bad(`item ${ownKey} is its own parent`);
  if (parentKey === ROOT_KEY && x.side === 'L') bad(`item ${ownKey} is a left child of ROOT`);
  // Re-create plain objects: nothing from the untrusted input is kept by reference.
  const marks: MarkSet = Object.keys(x.marks).length === 0 ? NO_MARKS : copyMarks(x.marks);
  return { id: { replica, seq }, key: ownKey, parentKey, side: x.side, content: stripped ? STRIPPED : copyContent(x.content as ItemContent), deleted: x.deleted, marks };
}

/** Highest lamport any register kept. The carried formatLamport must be at least this, or the snapshot claims a state `apply` cannot produce. */
function maxRegisterLamport(items: readonly Item[]): number {
  let max = 0;
  for (const item of items) {
    if (item.content.kind === 'block' && item.content.lamport > max) max = item.content.lamport;
    for (const name of MARK_NAMES) {
      const state = item.marks[name];
      if (state !== undefined && state.lamport > max) max = state.lamport;
    }
  }
  return max;
}

/**
 * Validate and re-park the snapshot's parked ops. Each must pass `refuse`, be counted by the sv,
 * carry an id no item and no other parked op has, and miss at least one dependency — one that IS
 * satisfied would have been applied, so its presence here is a claim the encoder never makes.
 */
function readPending(raw: unknown, sv: StateVector, items: ReadonlyMap<string, Item>): PersistentMap<readonly Op[]> {
  if (!Array.isArray(raw)) bad('pending is not an array');
  let pending = PersistentMap.empty<readonly Op[]>();
  const seen = new Set<string>();
  for (const entry of raw) {
    const reason = refuse(entry);
    if (reason !== null) bad(`pending op is ${reason}`);
    const op = copyOp(entry as Op);
    const key = idKey(op.id);
    if (op.id.seq > svGet(sv, op.id.replica)) bad(`pending op ${key} is not covered by sv`);
    if (items.has(key) || seen.has(key)) bad(`pending op ${key} duplicates an item or another pending op`);
    seen.add(key);
    const missing = opDependencies(op).find((dep) => !items.has(idKey(dep)));
    if (missing === undefined) bad(`pending op ${key} has every dependency present`);
    const under = idKey(missing);
    pending = pending.set(under, [...(pending.get(under) ?? []), op]);
  }
  return pending;
}

export function decodeSnapshot(s: Snapshot): Doc {
  const raw: unknown = s;
  if (!hasExactKeys(raw, ['v', 'sv', 'formatLamport', 'items', 'pending'])) bad('not an object with exactly v, sv, formatLamport, items, pending');
  if (raw.v !== 1) bad(`unsupported version ${String(raw.v)}`);
  const sv = readStateVector(raw.sv);
  if (!isLamport(raw.formatLamport)) bad('formatLamport is not a lamport');
  if (!Array.isArray(raw.items)) bad('items is not an array');

  // Pass 1: validate every item and number it. Integers, not keys, drive the rest: a 100 000-item
  // snapshot must decode in well under the bench budget, and string-keyed Map traffic was its cost.
  const decoded: Decoded[] = [];
  const indexOf = new Map<string, number>([[ROOT_KEY, -1]]); // -1 stands for ROOT
  for (const entry of raw.items) {
    const d = readItem(entry, sv);
    if (indexOf.has(d.key)) bad(`duplicate item ${d.key}`);
    indexOf.set(d.key, decoded.length);
    decoded.push(d);
  }
  const n = decoded.length;

  // Pass 2: parents must exist (ROOT or a decoded item). Each Item is built once, pointing at the
  // tree's own parent id object; children lists are gathered per parent index (n = ROOT).
  const parentIdx = new Int32Array(n);
  const items: Item[] = [];
  const lists: ({ L: ItemId[]; R: ItemId[] } | undefined)[] = new Array<{ L: ItemId[]; R: ItemId[] } | undefined>(n + 1);
  for (let i = 0; i < n; i++) {
    const d = decoded[i] as Decoded;
    const pi = indexOf.get(d.parentKey);
    if (pi === undefined) bad(`item ${d.key} has an unknown parent ${d.parentKey}`);
    parentIdx[i] = pi;
    const parentId = pi === -1 ? ROOT.id : (decoded[pi] as Decoded).id;
    items.push({ id: d.id, parent: parentId, side: d.side, content: d.content, deleted: d.deleted, marks: d.marks });
    const slot = pi === -1 ? n : pi;
    let list = lists[slot];
    if (list === undefined) {
      list = { L: [], R: [] };
      lists[slot] = list;
    }
    list[d.side].push(d.id);
  }
  if (raw.formatLamport < maxRegisterLamport(items)) bad('formatLamport is below a register it must have seen');

  // Every item must hang from ROOT. Every parent exists, so the only way to be unreachable is a
  // cycle — which would be invisible on this replica while sv claims it, the exact divergence a
  // snapshot must not smuggle in. Walk each item's parent chain once: 0 = unvisited, 1 = on the
  // current path, 2 = known to reach ROOT.
  const state = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const path: number[] = [];
    let cur = i;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      path.push(cur);
      cur = parentIdx[cur] as number;
    }
    if (cur !== -1 && state[cur] === 1) bad('items contain a cycle not reachable from ROOT');
    for (const p of path) state[p] = 2;
  }

  // Children lists sorted by id — the invariant apply maintains — then both tries built in one go.
  const childEntries: [string, Children][] = [];
  for (let slot = 0; slot <= n; slot++) {
    const list = lists[slot];
    if (list === undefined) continue;
    childEntries.push([slot === n ? ROOT_KEY : (decoded[slot] as Decoded).key, { L: siblingsFrom(list.L.sort(compareIds)), R: siblingsFrom(list.R.sort(compareIds)) }]);
  }
  if (lists[n] === undefined) childEntries.push([ROOT_KEY, NO_CHILDREN]);
  const itemEntries = function* (): IterableIterator<readonly [string, Item]> {
    yield [ROOT_KEY, ROOT];
    for (let i = 0; i < n; i++) yield [(decoded[i] as Decoded).key, items[i] as Item];
  };
  const itemMap = PersistentMap.from(itemEntries());
  return {
    items: itemMap,
    children: PersistentMap.from(childEntries),
    sv,
    pending: readPending(raw.pending, sv, itemMap),
    formatLamport: raw.formatLamport,
  };
}
