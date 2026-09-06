// item.ts — the shape of one node in the Fugue tree and the root sentinel. This file exists so
// that every module agrees on what an item carries and on the one item that is always present.
// It must never hold behaviour: no ordering, no integration, no traversal — only data shapes,
// the validators that say whether untrusted data has those shapes, and the constant ROOT, which
// is never emitted by a traversal and never deleted.

import { ROOT_REPLICA, REPLICA_ID_RE, type ItemId, type ReplicaId } from './ids.ts';

export type Side = 'L' | 'R';
export type MarkName = 'bold' | 'italic' | 'code' | 'link';

/** The closed set of mark names, in the order canonicalBytes sorts them. Exists so the snapshot decoder can refuse any other key (a `"__proto__"` mark is data, not a bug in the type system). */
export const MARK_NAMES: readonly MarkName[] = ['bold', 'code', 'italic', 'link'];

/**
 * The largest formatting lamport any op may carry (E9). Reaching it honestly takes two billion
 * format ops; a remote op above it is refused rather than allowed to poison every later local
 * format. 2^31 − 1 so the bound is the same in every language the protocol may be ported to.
 */
export const MAX_LAMPORT = 2 ** 31 - 1;

/**
 * LWW register per mark. lamport is a per-replica counter *for formatting only*; ties break on
 * replica id, then on the writing op's seq, so the order of writes is TOTAL and never depends on
 * wall time or on arrival order (E8). `replica` and `seq` together are the id of the op that wrote.
 */
export interface MarkState {
  readonly active: boolean;
  readonly lamport: number;
  readonly replica: ReplicaId;
  readonly seq: number;
  readonly href?: string;
}
export type MarkSet = Readonly<Partial<Record<MarkName, MarkState>>>;
export type BlockType = 'paragraph' | 'heading' | 'bullet' | 'quote';

/** The closed set of block types. Exists for the same reason as MARK_NAMES: the decoder validates against data, not types. */
export const BLOCK_TYPES: readonly BlockType[] = ['paragraph', 'heading', 'bullet', 'quote'];

export interface BlockAttrs {
  readonly type: BlockType;
  readonly level?: 1 | 2 | 3;
}

/**
 * One character: exactly one Unicode code point, which may be TWO UTF-16 code units (an astral
 * char such as 𝄞). Anything that maps visible positions to string offsets — the S3 binding above
 * all — must count code points, not `string.length`. A string, not a char type, so run-length
 * merging can arrive without changing the type (design §1.3 gap 1).
 */
export type CharContent = { readonly kind: 'char'; readonly text: string };

/** What an `ins` carries for a block boundary: the attrs plus the LWW seed. `replica` must be the op's author, so the stored register can name the writing op exactly. */
export type BlockContent = { readonly kind: 'block'; readonly attrs: BlockAttrs; readonly lamport: number; readonly replica: ReplicaId };

/**
 * A soft break (hard_break / Shift+Enter, E52). Inline like a char — one item, one visible token,
 * one code-point-equivalent position — but immutable: it carries no text and no register, so it
 * commutes and converges exactly as a char does and needs no LWW field.
 */
export type BreakContent = { readonly kind: 'break' };

/** Content as it travels in an `ins` op. */
export type Content = CharContent | BlockContent | BreakContent;

/** A boundary as STORED: the seed plus the writing op's seq, so `(lamport, replica, seq)` names one write and LWW ties cannot depend on arrival order (E8). */
export type BlockRegister = BlockContent & { readonly seq: number };

/** Content as it sits on an item. Differs from `Content` only in the block register's `seq`. */
export type ItemContent = CharContent | BlockRegister | BreakContent;

export interface Item {
  readonly id: ItemId;
  readonly parent: ItemId | null; // null only for ROOT
  readonly side: Side;
  readonly content: ItemContent;
  readonly deleted: boolean;
  readonly marks: MarkSet;
  /** Reserved for FugueMax (design §1.2). Always undefined in v1; present so the upgrade is additive. */
  readonly rightOrigin?: ItemId;
}

/** The root sentinel. Never emitted, never deleted, parent of the first insert. Its replica id is the reserved all-'a' id which REPLICA_ID_RE accepts but `newReplicaId` never generates. */
export const ROOT: Item = Object.freeze({
  id: Object.freeze({ replica: ROOT_REPLICA, seq: 0 }),
  parent: null,
  side: 'R',
  // The sentinel is a paragraph boundary: it closes the trailing block of every document, which is
  // how "a document always ends in a boundary" (design §2.2) holds without an explicit item.
  content: Object.freeze({ kind: 'block', attrs: Object.freeze({ type: 'paragraph' }), lamport: 0, replica: ROOT_REPLICA, seq: 0 }),
  deleted: false,
  marks: Object.freeze({}),
}) as Item;

/** The Map key of ROOT, precomputed because every insert at index 0 and every traversal starts here. */
export const ROOT_KEY = `${ROOT_REPLICA}:0`;

/** An empty MarkSet shared by every fresh item so a 100 000-item document allocates one, not 100 000. */
export const NO_MARKS: MarkSet = Object.freeze({});

/** True for a plain object with exactly these own keys — the shape check every validator below starts with, so an extra `"__proto__"` or `"constructor"` key is refused rather than ignored. */
export function hasExactKeys(x: unknown, keys: readonly string[], optional: readonly string[] = []): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  let present = 0;
  for (const k of keys) {
    if (!Object.hasOwn(x, k)) return false;
    present++;
  }
  for (const k of optional) if (Object.hasOwn(x, k)) present++;
  // Every own key is accounted for iff the counts agree; an extra key (or "__proto__") makes them differ.
  return Object.keys(x).length === present;
}

export function isMarkName(x: unknown): x is MarkName {
  return typeof x === 'string' && (MARK_NAMES as readonly string[]).includes(x);
}

export function isBlockAttrs(x: unknown): x is BlockAttrs {
  if (!hasExactKeys(x, ['type'], ['level'])) return false;
  if (!(BLOCK_TYPES as readonly string[]).includes(x.type as string)) return false;
  return x.level === undefined || x.level === 1 || x.level === 2 || x.level === 3;
}

/** A formatting lamport: an integer in 0..MAX_LAMPORT. NaN, Infinity or 2^53 would poison every later LWW comparison (see MAX_LAMPORT). */
export function isLamport(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= MAX_LAMPORT;
}

/** The seq of a writing op: a positive safe integer. Seq 0 belongs to ROOT alone, which never writes. */
function isWriterSeq(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 1;
}

/**
 * Exactly one Unicode code point, never U+0000 and never a lone surrogate: `fromCodePoint` of the
 * first code point must reproduce the whole string, which fails for "", "ab", "a\0b" and "\ud83d".
 */
export function isCharText(x: unknown): x is string {
  if (typeof x !== 'string') return false;
  const cp = x.codePointAt(0);
  if (cp === undefined || cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return false;
  return String.fromCodePoint(cp).length === x.length;
}

function isBlockSeed(x: Record<string, unknown>): boolean {
  return x.kind === 'block' && isBlockAttrs(x.attrs) && isLamport(x.lamport) && typeof x.replica === 'string' && REPLICA_ID_RE.test(x.replica);
}

/** A break carries nothing but its kind (E52); an extra key is a different, refused shape. */
function isBreak(x: unknown): x is BreakContent {
  return hasExactKeys(x, ['kind']) && (x as Record<string, unknown>).kind === 'break';
}

/** Content as an `ins` op carries it. */
export function isContent(x: unknown): x is Content {
  if (hasExactKeys(x, ['kind', 'text'])) return x.kind === 'char' && isCharText(x.text);
  if (isBreak(x)) return true;
  return hasExactKeys(x, ['kind', 'attrs', 'lamport', 'replica']) && isBlockSeed(x);
}

/** Content as an item stores it (a snapshot's view): a char, a break, or a block register that names its writer. */
export function isItemContent(x: unknown): x is ItemContent {
  if (hasExactKeys(x, ['kind', 'text'])) return x.kind === 'char' && isCharText(x.text);
  if (isBreak(x)) return true;
  return hasExactKeys(x, ['kind', 'attrs', 'lamport', 'replica', 'seq']) && isBlockSeed(x) && isWriterSeq(x.seq);
}

function isMarkState(x: unknown): x is MarkState {
  if (!hasExactKeys(x, ['active', 'lamport', 'replica', 'seq'], ['href'])) return false;
  if (typeof x.active !== 'boolean' || !isLamport(x.lamport) || !isWriterSeq(x.seq)) return false;
  if (typeof x.replica !== 'string' || !REPLICA_ID_RE.test(x.replica)) return false;
  return x.href === undefined || typeof x.href === 'string';
}

/** A MarkSet from untrusted data: only MarkName keys, each a valid register. `"__proto__"` is not a mark. */
export function isMarkSet(x: unknown): x is MarkSet {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  for (const k of Object.keys(x)) {
    if (!isMarkName(k) || !isMarkState((x as Record<string, unknown>)[k])) return false;
  }
  return true;
}
