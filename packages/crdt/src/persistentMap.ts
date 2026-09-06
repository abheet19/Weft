// persistentMap.ts — an immutable string-keyed map with cheap updates. It exists because `apply`
// must return a NEW Doc while the old one stays readable (time travel, the editor's before/after
// diff, tests), and copying a 100 000-entry Map per keystroke would make that O(n) per op. This is
// a hash array mapped trie: 5 bits of the key's hash choose a slot at each level, and `set`
// copies only the handful of nodes on the path from the root to the changed leaf — everything
// else is shared with the previous version; `delete` copies the same path. It must never mutate a
// node after construction, never expose an unstable iteration order across equal maps built
// differently (order is by hash, so it is a function of the contents), and never be used for
// anything but idKey → value.

/** FNV-1a over UTF-16 code units, folded to an unsigned 32-bit integer. Chosen because it is short enough to explain and good enough to spread sequential ids like "abc…:1", "abc…:2". */
export function hashString(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BITS = 5;
const MASK = (1 << BITS) - 1; // 31
// Levels use shifts 0,5,…,30; two distinct 32-bit hashes always differ in one of those chunks, so
// every path terminates by shift 30 and no depth guard is needed.

interface Leaf<V> {
  readonly kind: 0;
  readonly hash: number;
  readonly key: string;
  readonly value: V;
}
interface Branch<V> {
  readonly kind: 1;
  /** Bit i set ⇔ slot i is occupied; children are packed in slot order, so `popcount(bitmap & (bit-1))` is a child's index. */
  readonly bitmap: number;
  readonly children: readonly Node<V>[];
}
/** Keys whose 32-bit hashes are identical all the way down. Rare, but a correct map cannot pretend it never happens. */
interface Collision<V> {
  readonly kind: 2;
  readonly hash: number;
  readonly leaves: readonly Leaf<V>[];
}
type Node<V> = Leaf<V> | Branch<V> | Collision<V>;

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function getIn<V>(node: Node<V>, hash: number, key: string): V | undefined {
  let shift = 0;
  let cur: Node<V> = node;
  for (;;) {
    if (cur.kind === 0) return cur.key === key ? cur.value : undefined;
    if (cur.kind === 2) {
      for (const leaf of cur.leaves) if (leaf.key === key) return leaf.value;
      return undefined;
    }
    const bit = 1 << ((hash >>> shift) & MASK);
    if ((cur.bitmap & bit) === 0) return undefined;
    const next = cur.children[popcount(cur.bitmap & (bit - 1))];
    if (next === undefined) return undefined; // unreachable when bitmap and children agree
    cur = next;
    shift += BITS;
  }
}

/** Two leaves with different hashes: build the branch chain until their slots differ. */
function mergeLeaves<V>(a: Leaf<V>, b: Leaf<V>, shift: number): Node<V> {
  if (a.hash === b.hash) return { kind: 2, hash: a.hash, leaves: [a, b] };
  const bitA = 1 << ((a.hash >>> shift) & MASK);
  const bitB = 1 << ((b.hash >>> shift) & MASK);
  if (bitA === bitB) {
    return { kind: 1, bitmap: bitA, children: [mergeLeaves(a, b, shift + BITS)] };
  }
  // Children are packed in slot order. Compare the bits UNSIGNED: `1 << 31` is negative in JS and a
  // signed `<` would file slot 31 first, so popcount indexing would later find the wrong child.
  const children = bitA >>> 0 < bitB >>> 0 ? [a, b] : [b, a];
  return { kind: 1, bitmap: bitA | bitB, children };
}

function setIn<V>(node: Node<V>, leaf: Leaf<V>, shift: number): Node<V> {
  if (node.kind === 0) {
    if (node.key === leaf.key) return leaf;
    return mergeLeaves(node, leaf, shift);
  }
  if (node.kind === 2) {
    if (node.hash !== leaf.hash) {
      // A different hash reached this collision node, so the two must be told apart by a deeper
      // chunk of bits: wrap the collision in a branch at this level and insert the leaf below it.
      const wrapped: Branch<V> = { kind: 1, bitmap: 1 << ((node.hash >>> shift) & MASK), children: [node] };
      return setIn(wrapped, leaf, shift);
    }
    const i = node.leaves.findIndex((l) => l.key === leaf.key);
    const leaves = node.leaves.slice();
    if (i === -1) leaves.push(leaf);
    else leaves[i] = leaf;
    return { kind: 2, hash: node.hash, leaves };
  }
  const bit = 1 << ((leaf.hash >>> shift) & MASK);
  const idx = popcount(node.bitmap & (bit - 1));
  const children = node.children.slice();
  if ((node.bitmap & bit) === 0) {
    children.splice(idx, 0, leaf);
    return { kind: 1, bitmap: node.bitmap | bit, children };
  }
  children[idx] = setIn(node.children[idx] as Node<V>, leaf, shift + BITS);
  return { kind: 1, bitmap: node.bitmap, children };
}

/**
 * In-place insert for the bulk builder. Every node it touches was created inside `from`, so no
 * published map can observe the mutation — the trie is private until `from` returns it. Returns the
 * node to store at this position (a Leaf may turn into a Branch or Collision) and counts new keys.
 */
function setInPlace<V>(node: Node<V>, leaf: Leaf<V>, shift: number, grew: { n: number }): Node<V> {
  if (node.kind === 0) {
    if (node.key === leaf.key) return leaf;
    grew.n++;
    return mergeLeaves(node, leaf, shift);
  }
  if (node.kind === 2) {
    if (node.hash !== leaf.hash) {
      const wrapped: Branch<V> = { kind: 1, bitmap: 1 << ((node.hash >>> shift) & MASK), children: [node] };
      return setInPlace(wrapped, leaf, shift, grew);
    }
    const leaves = node.leaves as Leaf<V>[];
    const i = leaves.findIndex((l) => l.key === leaf.key);
    if (i === -1) {
      leaves.push(leaf);
      grew.n++;
    } else leaves[i] = leaf;
    return node;
  }
  const bit = 1 << ((leaf.hash >>> shift) & MASK);
  const idx = popcount(node.bitmap & (bit - 1));
  const children = node.children as Node<V>[];
  if ((node.bitmap & bit) === 0) {
    children.splice(idx, 0, leaf);
    grew.n++;
    return { kind: 1, bitmap: node.bitmap | bit, children };
  }
  children[idx] = setInPlace(children[idx] as Node<V>, leaf, shift + BITS, grew);
  return node;
}

/**
 * The node without `key`, or null when nothing is left below it. Copies the path like `setIn`; a
 * branch that empties is dropped from its parent's bitmap so `getIn` never meets a hollow slot.
 * Single-child branches are left as they are: they stay correct, and collapsing them buys nothing
 * for a map whose keys mostly come back.
 */
function deleteIn<V>(node: Node<V>, hash: number, key: string, shift: number): Node<V> | null {
  if (node.kind === 0) return node.key === key ? null : node;
  if (node.kind === 2) {
    const leaves = node.leaves.filter((l) => l.key !== key);
    if (leaves.length === node.leaves.length) return node;
    if (leaves.length === 1) return leaves[0] as Leaf<V>;
    return { kind: 2, hash: node.hash, leaves };
  }
  const bit = 1 << ((hash >>> shift) & MASK);
  if ((node.bitmap & bit) === 0) return node;
  const idx = popcount(node.bitmap & (bit - 1));
  const child = node.children[idx] as Node<V>;
  const next = deleteIn(child, hash, key, shift + BITS);
  if (next === child) return node;
  const children = node.children.slice();
  if (next === null) {
    children.splice(idx, 1);
    if (children.length === 0) return null;
    return { kind: 1, bitmap: node.bitmap & ~bit, children };
  }
  children[idx] = next;
  return { kind: 1, bitmap: node.bitmap, children };
}

function* leavesOf<V>(node: Node<V>): IterableIterator<Leaf<V>> {
  // Recursion is bounded by the trie's depth: 7 branch levels (32 bits / 5) plus one collision
  // node, whatever the map's size — so a 100 000-entry map cannot overflow the stack here.
  if (node.kind === 0) yield node;
  else if (node.kind === 2) yield* node.leaves;
  else for (const child of node.children) yield* leavesOf(child);
}

const EMPTY_BRANCH: Branch<never> = { kind: 1, bitmap: 0, children: [] };

/**
 * An immutable map that satisfies `ReadonlyMap<string, V>` so `Doc` can expose it verbatim, plus a
 * `set` that returns a new map sharing structure with this one. The hash function is injectable
 * only so tests can force collisions; production code always uses the default.
 */
export class PersistentMap<V> implements ReadonlyMap<string, V> {
  // Plain field declarations, not constructor parameter properties: Node's type stripping only
  // erases syntax that is pure annotation, and the bench/example run the .ts sources directly.
  private readonly root: Node<V>;
  public readonly size: number;
  private readonly hashOf: (key: string) => number;

  private constructor(root: Node<V>, size: number, hashOf: (key: string) => number) {
    this.root = root;
    this.size = size;
    this.hashOf = hashOf;
  }

  static empty<V>(hashOf: (key: string) => number = hashString): PersistentMap<V> {
    return new PersistentMap<V>(EMPTY_BRANCH, 0, hashOf);
  }

  /** Build from many entries at once. The trie is assembled in place and published only when complete, so this costs one allocation per node instead of one path copy per entry (decodeSnapshot's 100 000-item case). */
  static from<V>(entries: Iterable<readonly [string, V]>, hashOf: (key: string) => number = hashString): PersistentMap<V> {
    let root: Node<V> = { kind: 1, bitmap: 0, children: [] };
    const grew = { n: 0 };
    for (const [key, value] of entries) root = setInPlace(root, { kind: 0, hash: hashOf(key), key, value }, 0, grew);
    return new PersistentMap<V>(root, grew.n, hashOf);
  }

  get(key: string): V | undefined {
    return getIn(this.root, this.hashOf(key), key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Returns a map with `key ↦ value`; this map is unchanged. Cost: one path copy (≤ 7 small arrays). */
  set(key: string, value: V): PersistentMap<V> {
    const hash = this.hashOf(key);
    const grew = getIn(this.root, hash, key) === undefined;
    const root = setIn(this.root, { kind: 0, hash, key, value }, 0);
    return new PersistentMap<V>(root, grew ? this.size + 1 : this.size, this.hashOf);
  }

  /** Returns a map without `key`; this map is unchanged. Cost: one path copy, like `set`. */
  delete(key: string): PersistentMap<V> {
    const hash = this.hashOf(key);
    if (getIn(this.root, hash, key) === undefined) return this;
    const root = deleteIn(this.root, hash, key, 0) ?? EMPTY_BRANCH;
    return new PersistentMap<V>(root, this.size - 1, this.hashOf);
  }

  forEach(callback: (value: V, key: string, map: ReadonlyMap<string, V>) => void, thisArg?: unknown): void {
    for (const leaf of leavesOf(this.root)) callback.call(thisArg, leaf.value, leaf.key, this);
  }

  *entries(): MapIterator<[string, V]> {
    for (const leaf of leavesOf(this.root)) yield [leaf.key, leaf.value];
  }

  *keys(): MapIterator<string> {
    for (const leaf of leavesOf(this.root)) yield leaf.key;
  }

  *values(): MapIterator<V> {
    for (const leaf of leavesOf(this.root)) yield leaf.value;
  }

  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'PersistentMap';
  }
}
