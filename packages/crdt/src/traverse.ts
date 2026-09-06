// traverse.ts — reading the tree as a sequence. This file exists because the document a user sees
// is the in-order traversal of the Fugue tree (design §2.3): left children in id order, the node
// itself unless deleted, right children in id order. Everything that needs "the text" — tests,
// canonicalBytes, the position index, the insert rule's right neighbour — comes through here so
// there is one traversal to get right. The index it builds is EAGER for a fresh doc (one traversal
// per `buildIndex`) and INCREMENTAL for the binding's own edits: `withInserted`, `withDeleted` and
// `withItem` derive the index of the doc after a LOCAL op run without a traversal (S3 hardening,
// E47), each a new value that leaves the old one intact. It must never recurse (a forward-typed
// document is a chain as deep as it is long) and never skip tombstones when asked for the NEXT
// item: the Fugue rule needs the tombstone-inclusive neighbour or replicas disagree.

import { idKey, type ItemId } from './ids.ts';
import { childrenOf, getItem, type Doc } from './doc.ts';
import { ROOT, ROOT_KEY, type BlockAttrs, type Item } from './item.ts';
import { PersistentMap } from './persistentMap.ts';
import { firstSibling, siblingAfter, type SiblingList } from './siblings.ts';

/** The attrs of the block the root sentinel closes: always a plain paragraph (E5). The binding's normal form closes every document's trailing block with it. */
export const ROOT_ATTRS: BlockAttrs = Object.freeze({ type: 'paragraph' });

/** Push the keys of `list` in REVERSE order, so pops come out in id order. Walks chunks directly rather than flattening. */
function pushReversed(list: SiblingList, keys: string[], emit: (Item | null | undefined)[]): void {
  for (let c = list.chunks.length - 1; c >= 0; c--) {
    const chunk = list.chunks[c] as readonly ItemId[];
    for (let i = chunk.length - 1; i >= 0; i--) {
      keys.push(idKey(chunk[i] as ItemId));
      emit.push(undefined);
    }
  }
}

/**
 * Every item except ROOT in traversal order, tombstones included. The workhorse behind
 * `visibleItems`, `buildIndex`, `canonicalBytes` and `localInsert`. Iterative: a stack of
 * "visit this subtree" and "emit this item" frames replaces recursion.
 */
export function traversalOrder(doc: Doc): readonly Item[] {
  const out: Item[] = [];
  // Two parallel stacks avoid allocating a frame object per item. A "visit" frame carries the key
  // to look up; an "emit" frame carries the already-found Item (null = ROOT), so each item costs
  // exactly one items lookup and one children lookup.
  const keys: string[] = [ROOT_KEY];
  const emit: (Item | null | undefined)[] = [undefined];
  while (keys.length > 0) {
    const key = keys.pop() as string;
    const found = emit.pop();
    if (found !== undefined) {
      if (found !== null) out.push(found);
      continue;
    }
    const item = key === ROOT_KEY ? null : doc.items.get(key);
    if (item === undefined) continue; // a child id with no item cannot happen after `apply`; skipping keeps traversal total
    // Push in reverse so that pops come out as: L children (id order), self, R children (id order).
    const ch = childrenOf(doc, key);
    pushReversed(ch.R, keys, emit);
    keys.push(key);
    emit.push(item);
    pushReversed(ch.L, keys, emit);
  }
  return out;
}

/** The visible sequence in document order. O(n). Tests and canonicalBytes use it; the editor uses PositionIndex instead. */
export function visibleItems(doc: Doc): readonly Item[] {
  return traversalOrder(doc).filter((item) => !item.deleted);
}

/** One block of the visible sequence: visible indexes `from..to` (inclusive: `to` is the closing boundary's own index, or `length` for the trailing block closed by ROOT). */
export interface BlockRange {
  readonly from: number;
  readonly to: number;
  readonly boundary: ItemId;
  readonly attrs: BlockAttrs;
}

/**
 * Position index: visible offset ↔ ItemId, block boundaries, and the Fugue neighbours of a visible
 * index. `buildIndex` makes one from a traversal; the `with*` methods derive the index of the doc
 * after LOCAL ops in O(n) memory copies and O(log n) lookups, never a traversal — the binding's hot
 * path (E47). Every method is total over 0..length; an index outside is a programmer error and
 * throws RangeError. An index is a value: deriving from it does not change it.
 */
export interface PositionIndex {
  readonly length: number;
  /** The id at a visible offset, or null at (or past) the end. */
  idAt(visibleIndex: number): ItemId | null;
  /** The item at a visible offset, or null at (or past) the end. Its content is current as of the doc this index describes. */
  itemAt(visibleIndex: number): Item | null;
  /** The visible items in order — `visibleItems(doc)` without the traversal. Do not mutate. */
  items(): readonly Item[];
  /** The visible offset of `id`, or -1 when the item is deleted or unknown. */
  indexOf(id: ItemId): number;
  /** How many visible items precede `id` in traversal order, tombstones included in the search: the offset a cursor anchored to a deleted item falls back to (S3, `visibleFromAnchor`). -1 for an id the doc does not hold. */
  visibleBefore(id: ItemId): number;
  blockRanges(): readonly BlockRange[];
  /** The visible item at `visibleIndex - 1` (ROOT at 0) and its tombstone-inclusive successor — exactly what the Fugue insert rule consumes, in O(1) instead of a traversal. */
  neighboursAt(visibleIndex: number): { left: ItemId; right: ItemId | null };
  /**
   * The index of `doc` after `ids` were inserted LOCALLY as one run whose first item is visible at
   * `visibleIndex` (the first placed by the Fugue rule, each next the right child of the previous —
   * `localInsert`'s and the binding's `insertRun`'s shape). Such a run sits immediately after the
   * left neighbour in traversal order, which is what lets this skip the traversal. `doc` must be
   * the doc this index describes with exactly those ops applied.
   */
  withInserted(doc: Doc, visibleIndex: number, ids: readonly ItemId[]): PositionIndex;
  /** The index of `doc` after the visible items `[from, to)` were tombstoned. */
  withDeleted(doc: Doc, from: number, to: number): PositionIndex;
  /** The index of `doc` after the item at `visibleIndex` changed content in place (a `blk` register write). */
  withItem(doc: Doc, visibleIndex: number): PositionIndex;
}

/** A Fenwick tree over 0..size-1 in one Int32Array: point add and prefix sum in O(log n), and a whole-array copy for a persistent derivation is one memcpy. */
class Fenwick {
  private readonly tree: Int32Array;

  constructor(tree: Int32Array) {
    this.tree = tree;
  }

  static zeros(size: number): Fenwick {
    return new Fenwick(new Int32Array(size + 1));
  }

  clone(): Fenwick {
    return new Fenwick(this.tree.slice());
  }

  add(i: number, delta: number): void {
    for (let k = i + 1; k < this.tree.length; k += k & -k) this.tree[k] = (this.tree[k] as number) + delta;
  }

  /** Sum over 0..i inclusive; 0 for i < 0. */
  prefix(i: number): number {
    let sum = 0;
    for (let k = Math.min(i + 1, this.tree.length - 1); k > 0; k -= k & -k) sum += this.tree[k] as number;
    return sum;
  }

  point(i: number): number {
    return this.prefix(i) - this.prefix(i - 1);
  }
}

function sameId(a: ItemId, b: ItemId): boolean {
  return a.seq === b.seq && a.replica === b.replica;
}

/** Where an item sits: an original of the build at traversal position `p`, or a locally inserted item in gap `g` (between originals g-1 and g) at offset `j` of that gap. */
type Place = { readonly kind: 'orig'; readonly p: number } | { readonly kind: 'gap'; readonly g: number; readonly j: number };

function checkVisible(visibleIndex: number, length: number): void {
  if (!Number.isInteger(visibleIndex) || visibleIndex < 0 || visibleIndex > length) throw new RangeError(`visible index ${visibleIndex} is outside 0..${length}`);
}

/**
 * The index as a value. The originals of the build (`orig`, `byKey`, `vis0`, `live0`) are shared by
 * every derivation and never change; what a derivation copies is the visible array, the gap table
 * and two Fenwick trees — memcpys, not traversals or Map rebuilds. Locally inserted items live in
 * `gaps` (one list per gap between two originals) and are found through a persistent map, so two
 * indexes derived from one parent never see each other's items.
 */
class Index implements PositionIndex {
  /** Traversal at build time, tombstones included. Only ids are read after a derivation — content and `deleted` may be stale. */
  private readonly orig: readonly Item[];
  private readonly byKey: ReadonlyMap<string, number>;
  /** `vis0[p]` = originals live at build among `orig[0..p)`. */
  private readonly vis0: Int32Array;
  private readonly live0: Uint8Array;
  /** `gaps[g]` = items inserted since the build between `orig[g-1]` and `orig[g]`, in traversal order; length `orig.length + 1`. */
  private readonly gaps: readonly (readonly Item[] | undefined)[];
  /** idKey of an inserted item → its gap. */
  private readonly inserted: PersistentMap<number>;
  private readonly visible: readonly Item[];
  /** Per original: 1 once tombstoned since the build. */
  private readonly delOrig: Fenwick;
  /** Per gap: live inserted items in it. */
  private readonly visIns: Fenwick;
  private ranges: readonly BlockRange[] | null = null;

  constructor(
    orig: readonly Item[],
    byKey: ReadonlyMap<string, number>,
    vis0: Int32Array,
    live0: Uint8Array,
    gaps: readonly (readonly Item[] | undefined)[],
    inserted: PersistentMap<number>,
    visible: readonly Item[],
    delOrig: Fenwick,
    visIns: Fenwick,
  ) {
    this.orig = orig;
    this.byKey = byKey;
    this.vis0 = vis0;
    this.live0 = live0;
    this.gaps = gaps;
    this.inserted = inserted;
    this.visible = visible;
    this.delOrig = delOrig;
    this.visIns = visIns;
  }

  get length(): number {
    return this.visible.length;
  }

  idAt(visibleIndex: number): ItemId | null {
    return this.visible[visibleIndex]?.id ?? null;
  }

  itemAt(visibleIndex: number): Item | null {
    return this.visible[visibleIndex] ?? null;
  }

  items(): readonly Item[] {
    return this.visible;
  }

  private place(id: ItemId): Place | null {
    const key = idKey(id);
    const p = this.byKey.get(key);
    if (p !== undefined) return { kind: 'orig', p };
    const g = this.inserted.get(key);
    if (g === undefined) return null;
    const list = this.gaps[g] as readonly Item[];
    // Typing extends the end of a gap, so the item asked about is usually the last one: scan backwards.
    for (let j = list.length - 1; j >= 0; j--) if (sameId((list[j] as Item).id, id)) return { kind: 'gap', g, j };
    throw new Error(`index corrupt: ${key} is recorded in gap ${g} but not present there`);
  }

  /** Visible items before original `p`: live originals ahead of it minus those tombstoned since, plus the live inserted items in the gaps ahead of it (gaps 0..p). */
  private beforeOriginal(p: number): number {
    return (this.vis0[p] as number) - this.delOrig.prefix(p - 1) + this.visIns.prefix(p);
  }

  visibleBefore(id: ItemId): number {
    const at = this.place(id);
    if (at === null) return -1;
    if (at.kind === 'orig') return this.beforeOriginal(at.p);
    // Gap g sits before original g: everything before that original except gap g itself, then the live items ahead in the gap.
    let n = (this.vis0[at.g] as number) - this.delOrig.prefix(at.g - 1) + this.visIns.prefix(at.g - 1);
    const list = this.gaps[at.g] as readonly Item[];
    for (let j = 0; j < at.j; j++) if (!(list[j] as Item).deleted) n++;
    return n;
  }

  indexOf(id: ItemId): number {
    const at = this.place(id);
    if (at === null) return -1;
    const live = at.kind === 'orig' ? this.live0[at.p] === 1 && this.delOrig.point(at.p) === 0 : !((this.gaps[at.g] as readonly Item[])[at.j] as Item).deleted;
    return live ? this.visibleBefore(id) : -1;
  }

  blockRanges(): readonly BlockRange[] {
    if (this.ranges === null) {
      const ranges: BlockRange[] = [];
      let from = 0;
      this.visible.forEach((item, i) => {
        if (item.content.kind === 'block') {
          ranges.push({ from, to: i, boundary: item.id, attrs: item.content.attrs });
          from = i + 1;
        }
      });
      // The trailing block is closed by the root sentinel (design §2.2: a document always ends in
      // a boundary), so it is always present — an empty document is one empty paragraph.
      ranges.push({ from, to: this.visible.length, boundary: ROOT.id, attrs: ROOT_ATTRS });
      this.ranges = ranges;
    }
    return this.ranges;
  }

  neighboursAt(visibleIndex: number): { left: ItemId; right: ItemId | null } {
    checkVisible(visibleIndex, this.visible.length);
    if (visibleIndex === 0) return { left: ROOT.id, right: this.gaps[0]?.[0]?.id ?? this.orig[0]?.id ?? null };
    const left = this.visible[visibleIndex - 1] as Item;
    const at = this.place(left.id) as Place;
    // After an original come the items inserted just behind it, then the next original; after an
    // inserted item come the rest of its gap, then the original that closes the gap.
    if (at.kind === 'orig') return { left: left.id, right: this.gaps[at.p + 1]?.[0]?.id ?? this.orig[at.p + 1]?.id ?? null };
    return { left: left.id, right: (this.gaps[at.g] as readonly Item[])[at.j + 1]?.id ?? this.orig[at.g]?.id ?? null };
  }

  private itemOf(doc: Doc, id: ItemId): Item {
    const item = getItem(doc, id);
    if (item === undefined) throw new RangeError(`${idKey(id)} is not in the doc this index is being derived for`);
    return item;
  }

  withInserted(doc: Doc, visibleIndex: number, ids: readonly ItemId[]): PositionIndex {
    checkVisible(visibleIndex, this.visible.length);
    if (ids.length === 0) return this;
    const items = ids.map((id) => {
      const item = this.itemOf(doc, id);
      if (item.deleted) throw new RangeError(`${idKey(id)} is a tombstone; withInserted describes live inserts`);
      return item;
    });
    // The run goes immediately after the left neighbour: at the head of the gap behind an original
    // (before anything inserted there earlier), or right behind an inserted left inside its gap.
    let g: number;
    let at: number;
    if (visibleIndex === 0) [g, at] = [0, 0];
    else {
      const place = this.place((this.visible[visibleIndex - 1] as Item).id) as Place;
      [g, at] = place.kind === 'orig' ? [place.p + 1, 0] : [place.g, place.j + 1];
    }
    const old = this.gaps[g] ?? [];
    const gaps = this.gaps.slice();
    gaps[g] = [...old.slice(0, at), ...items, ...old.slice(at)];
    let inserted = this.inserted;
    for (const id of ids) inserted = inserted.set(idKey(id), g);
    const visible = [...this.visible.slice(0, visibleIndex), ...items, ...this.visible.slice(visibleIndex)];
    const visIns = this.visIns.clone();
    visIns.add(g, items.length);
    return new Index(this.orig, this.byKey, this.vis0, this.live0, gaps, inserted, visible, this.delOrig, visIns);
  }

  withDeleted(doc: Doc, from: number, to: number): PositionIndex {
    checkVisible(from, this.visible.length);
    checkVisible(to, this.visible.length);
    if (from > to) throw new RangeError(`from ${from} is after to ${to}`);
    if (from === to) return this;
    const gaps = this.gaps.slice();
    const copied = new Set<number>();
    const delOrig = this.delOrig.clone();
    const visIns = this.visIns.clone();
    // Consecutive visible items of one gap are consecutive live entries of its list: after placing
    // one, the next is found by stepping forward, not by another scan (a 1 000-item delete inside a
    // 50 000-item gap is then O(k), not O(k · gap)).
    let hint: { g: number; j: number } | null = null;
    for (let v = from; v < to; v++) {
      const item = this.visible[v] as Item;
      const tomb = this.itemOf(doc, item.id);
      if (!tomb.deleted) throw new RangeError(`${idKey(item.id)} is still live; withDeleted describes tombstoned items`);
      let at: Place | null = null;
      if (hint !== null) {
        const list = this.gaps[hint.g] as readonly Item[];
        let j: number = hint.j + 1;
        while (j < list.length && (list[j] as Item).deleted) j++;
        if (j < list.length && sameId((list[j] as Item).id, item.id)) at = { kind: 'gap', g: hint.g, j };
      }
      at ??= this.place(item.id) as Place;
      if (at.kind === 'orig') {
        delOrig.add(at.p, 1);
        hint = null;
      } else {
        if (!copied.has(at.g)) {
          gaps[at.g] = (gaps[at.g] as readonly Item[]).slice();
          copied.add(at.g);
        }
        (gaps[at.g] as Item[])[at.j] = tomb;
        visIns.add(at.g, -1);
        hint = { g: at.g, j: at.j };
      }
    }
    const visible = [...this.visible.slice(0, from), ...this.visible.slice(to)];
    return new Index(this.orig, this.byKey, this.vis0, this.live0, gaps, this.inserted, visible, delOrig, visIns);
  }

  withItem(doc: Doc, visibleIndex: number): PositionIndex {
    checkVisible(visibleIndex, this.visible.length);
    const old = this.visible[visibleIndex];
    if (old === undefined) throw new RangeError(`visible index ${visibleIndex} holds no item`);
    const item = this.itemOf(doc, old.id);
    if (item.deleted) throw new RangeError(`${idKey(old.id)} is a tombstone; withItem describes a content change of a live item`);
    const visible = this.visible.slice();
    visible[visibleIndex] = item;
    let gaps = this.gaps;
    const at = this.place(old.id) as Place;
    if (at.kind === 'gap') {
      const copy = gaps.slice();
      const list = (copy[at.g] as readonly Item[]).slice();
      list[at.j] = item;
      copy[at.g] = list;
      gaps = copy;
    }
    return new Index(this.orig, this.byKey, this.vis0, this.live0, gaps, this.inserted, visible, this.delOrig, this.visIns);
  }
}

export function buildIndex(doc: Doc): PositionIndex {
  const orig = traversalOrder(doc);
  const visible: Item[] = [];
  const byKey = new Map<string, number>();
  const vis0 = new Int32Array(orig.length + 1);
  const live0 = new Uint8Array(orig.length);
  orig.forEach((item, p) => {
    byKey.set(idKey(item.id), p);
    vis0[p] = visible.length;
    if (!item.deleted) {
      live0[p] = 1;
      visible.push(item);
    }
  });
  vis0[orig.length] = visible.length;
  const gaps = new Array<readonly Item[] | undefined>(orig.length + 1).fill(undefined);
  return new Index(orig, byKey, vis0, live0, gaps, PersistentMap.empty<number>(), visible, Fenwick.zeros(orig.length), Fenwick.zeros(orig.length + 1));
}

/** The block that holds visible index `v`: ranges tile 0..length, so exactly one has `v <= to`; found by binary search over `to`. Throws RangeError outside 0..length. */
export function blockRangeAt(index: PositionIndex, visibleIndex: number): BlockRange {
  checkVisible(visibleIndex, index.length);
  const ranges = index.blockRanges();
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (visibleIndex <= (ranges[mid] as BlockRange).to) hi = mid;
    else lo = mid + 1;
  }
  return ranges[lo] as BlockRange;
}

/** The first item of the subtree rooted at `id`: follow first-left-children down. */
function leftmost(doc: Doc, id: ItemId): ItemId {
  let cur = id;
  for (;;) {
    const first = firstSibling(childrenOf(doc, idKey(cur)).L);
    if (first === undefined) return cur;
    cur = first;
  }
}

/** For the Fugue rule: the next item in traversal order INCLUDING tombstones (design §2.3). */
export function nextInTraversal(doc: Doc, id: ItemId): ItemId | null {
  const firstRight = firstSibling(childrenOf(doc, idKey(id)).R);
  // After a node come its right subtrees; the first item of the first one is the successor.
  if (firstRight !== undefined) return leftmost(doc, firstRight);
  // Otherwise climb: the successor is the next sibling's subtree, or — when we were a left child
  // with no later sibling — the parent itself; a right child with no later sibling defers to the
  // parent's own successor.
  let cur = getItem(doc, id);
  while (cur !== undefined && cur.parent !== null) {
    const next = siblingAfter(childrenOf(doc, idKey(cur.parent))[cur.side], cur.id);
    if (next !== undefined) return leftmost(doc, next);
    if (cur.side === 'L') return cur.parent;
    cur = getItem(doc, cur.parent);
  }
  return null;
}

/** The visible item at `visibleIndex - 1` (or ROOT at index 0) and its tombstone-inclusive successor, from one traversal. This is exactly the pair the Fugue insert rule consumes; `PositionIndex.neighboursAt` answers the same in O(1) when an index is at hand. */
export function neighboursAt(doc: Doc, visibleIndex: number): { left: ItemId; right: ItemId | null } {
  const order = traversalOrder(doc);
  if (visibleIndex === 0) return { left: ROOT.id, right: order[0]?.id ?? null };
  let seen = 0;
  for (let i = 0; i < order.length; i++) {
    const item = order[i] as Item;
    if (item.deleted) continue;
    seen++;
    if (seen === visibleIndex) return { left: item.id, right: order[i + 1]?.id ?? null };
  }
  throw new RangeError(`visible index ${visibleIndex} is past the end of a document with ${seen} visible items`);
}
