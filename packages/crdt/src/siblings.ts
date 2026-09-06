// siblings.ts — one item's children on one side, kept sorted by compareIds. This file exists
// because the sibling list is where a hostile (or merely unlucky) op stream could make `apply`
// quadratic: N inserts under one parent and side each copied an N-element array, and 100 000 of
// them took tens of seconds. Chunking bounds an insert at one chunk copy plus one chunk-table copy
// while the list stays immutable — an older Doc never sees a newer sibling. It must never mutate a
// chunk after it is published, never hold an empty or unsorted chunk, and never hold anything but
// ItemIds.

import { compareIds, type ItemId } from './ids.ts';

/** The sorted children of one item on one side. `length` is the total across chunks. */
export interface SiblingList {
  readonly length: number;
  /** Non-empty, each sorted by compareIds, consecutive: every id in chunk i sorts before every id in chunk i+1. */
  readonly chunks: readonly (readonly ItemId[])[];
}

/**
 * A chunk that grows past this is split in two, so a copy is never more than 257 ids and the table
 * is n/128..n/256 entries. Near √(2n) for the 100 000-sibling flood the bench runs, which measured
 * fastest among 64, 256, 512 and 1024; honest lists (a few concurrent inserts at one seat) never
 * reach it.
 */
export const MAX_CHUNK = 256;

/** Shared by every childless side so the children map does not allocate per insert. */
export const NO_SIBLINGS: SiblingList = Object.freeze({ length: 0, chunks: Object.freeze([]) });

/** Build from ids already sorted by compareIds (the snapshot decoder sorts once); half-full chunks leave room for later inserts. */
export function siblingsFrom(sorted: readonly ItemId[]): SiblingList {
  if (sorted.length === 0) return NO_SIBLINGS;
  const chunks: (readonly ItemId[])[] = [];
  for (let i = 0; i < sorted.length; i += MAX_CHUNK / 2) chunks.push(sorted.slice(i, i + MAX_CHUNK / 2));
  return { length: sorted.length, chunks };
}

/** Index of the chunk that holds or would hold `id`: the first whose last id is not below it, else the last chunk. */
function chunkFor(chunks: readonly (readonly ItemId[])[], id: ItemId): number {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const chunk = chunks[mid] as readonly ItemId[];
    if (compareIds(chunk[chunk.length - 1] as ItemId, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first position in a sorted chunk whose id is not below `id`. */
function lowerBound(chunk: readonly ItemId[], id: ItemId): number {
  let lo = 0;
  let hi = chunk.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareIds(chunk[mid] as ItemId, id) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A list with `id` in sorted position; this list is untouched. Cost: one chunk copy (≤ MAX_CHUNK + 1) and one table copy (n / (MAX_CHUNK / 2) at worst). */
export function insertSibling(list: SiblingList, id: ItemId): SiblingList {
  if (list.length === 0) return { length: 1, chunks: [[id]] };
  const at = chunkFor(list.chunks, id);
  const chunk = list.chunks[at] as readonly ItemId[];
  const grown = chunk.slice();
  grown.splice(lowerBound(chunk, id), 0, id);
  const chunks = list.chunks.slice();
  if (grown.length > MAX_CHUNK) {
    const half = grown.length >>> 1;
    chunks.splice(at, 1, grown.slice(0, half), grown.slice(half));
  } else {
    chunks[at] = grown;
  }
  return { length: list.length + 1, chunks };
}

/** The lowest id, or undefined when empty. The traversal's "first left child" question. */
export function firstSibling(list: SiblingList): ItemId | undefined {
  return list.chunks[0]?.[0];
}

/** The sibling that follows `id`, or undefined when `id` is last or is not in the list. The traversal's "next sibling" question. */
export function siblingAfter(list: SiblingList, id: ItemId): ItemId | undefined {
  if (list.length === 0) return undefined;
  const at = chunkFor(list.chunks, id);
  const chunk = list.chunks[at] as readonly ItemId[];
  const i = lowerBound(chunk, id);
  if (i === chunk.length || compareIds(chunk[i] as ItemId, id) !== 0) return undefined;
  return chunk[i + 1] ?? list.chunks[at + 1]?.[0];
}

/** Every sibling in order, as one array. For callers that want to look at a whole list (tests, the example script); the traversal walks chunks directly. */
export function siblingArray(list: SiblingList): readonly ItemId[] {
  return list.chunks.flat();
}
