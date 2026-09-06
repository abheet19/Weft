// validate.ts — structural validation of untrusted decoded JSON. This file exists because the
// wire is hostile: every frame is checked field by field, with EXACT key sets (an extra key,
// `"__proto__"` included, is a shape error, not a feature), before either end reads a value.
// The id/side/content/attrs checks duplicate @weft/crdt's small validators on purpose: this
// package depends on nothing, and `validateOp` must refuse every shape `apply` would refuse
// as MALFORMED, so an honest peer never reaches that path. It must never throw (I15), never
// echo attacker-controlled text into a reason, and never grow a rule that is not a row in
// LLD §5.2 or a refusal in the CRDT.

import { ERROR_CODES, type ErrorCode } from './errors.ts';
import { DOC_ID_RE, HASH_RE, HREF_SCHEME_RE, LIMITS, REPLICA_ID_RE } from './limits.ts';
import type { BlockAttrs, ClientMessage, Content, ItemAnchor, ItemContent, ItemId, MarkSet, Op, PresenceState, ServerMessage, Snapshot, SnapshotItem, StateVector } from './messages.ts';
import { negotiate } from './version.ts';

export type Valid<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; reason: string };

const MARK_NAMES: readonly string[] = ['bold', 'code', 'italic', 'link'];
const BLOCK_TYPES: readonly string[] = ['paragraph', 'heading', 'bullet', 'quote'];
/** The one id with seq 0 that exists: the root sentinel of every document. Any other seq-0 id can never be an item, and nothing is ever authored under this replica. */
const ROOT_REPLICA = 'aaaaaaaaaaaaa';

function fail(code: ErrorCode, reason: string): Valid<never> {
  return { ok: false, code, reason };
}

function bad(reason: string): Valid<never> {
  return fail('BAD_SHAPE', reason);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** A plain object with exactly the required keys and a subset of the optional ones. Counting own keys is what makes `"__proto__"` a mismatch rather than a silently ignored extra. */
function hasExactKeys(x: unknown, required: readonly string[], optional: readonly string[] = []): x is Record<string, unknown> {
  if (!isRecord(x)) return false;
  let present = 0;
  for (const k of required) {
    if (!Object.hasOwn(x, k)) return false;
    present++;
  }
  for (const k of optional) if (Object.hasOwn(x, k)) present++;
  return Object.keys(x).length === present;
}

function isUint(x: unknown): x is number {
  return Number.isSafeInteger(x) && (x as number) >= 0;
}

/** A formatting lamport: 0..MAX_LAMPORT, so every port of the protocol can hold one in a 32-bit integer. */
function isLamport(x: unknown): x is number {
  return isUint(x) && x <= LIMITS.MAX_LAMPORT;
}

function isReplicaId(x: unknown): boolean {
  return typeof x === 'string' && REPLICA_ID_RE.test(x);
}

function isItemId(x: unknown, minSeq: number): x is ItemId {
  return hasExactKeys(x, ['replica', 'seq']) && isReplicaId(x.replica) && isUint(x.seq) && x.seq >= minSeq;
}

/** The id an op is written under: a real seq, and never the root's replica — nothing is authored there. */
function isAuthorId(x: unknown): x is ItemId {
  return isItemId(x, 1) && x.replica !== ROOT_REPLICA;
}

/** An id an op depends on: a real item (seq ≥ 1) or the root sentinel. A seq-0 id of any other replica names nothing and would park the op forever. */
function isDependency(x: unknown): x is ItemId {
  return isItemId(x, 0) && (x.seq >= 1 || x.replica === ROOT_REPLICA);
}

function isRoot(id: ItemId): boolean {
  return id.seq === 0 && id.replica === ROOT_REPLICA;
}

function sameId(a: ItemId, b: ItemId): boolean {
  return a.seq === b.seq && a.replica === b.replica;
}

/** Exactly one Unicode code point, never U+0000 and never a lone surrogate — the same rule as the CRDT's `isCharText`. A lone surrogate is refused because the wire is UTF-8 and would rewrite it to U+FFFD, splitting the two replicas' hashes. */
function isCharText(s: string): boolean {
  const cp = s.codePointAt(0);
  if (cp === undefined || cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return false;
  return String.fromCodePoint(cp).length === s.length;
}

/** LLD §5.2: `level` only on headings, and only 1..3. Stricter than the CRDT's own check, which is the point of validating at the edge. */
function isBlockAttrs(x: unknown): x is BlockAttrs {
  if (!hasExactKeys(x, ['type'], ['level'])) return false;
  if (typeof x.type !== 'string' || !BLOCK_TYPES.includes(x.type)) return false;
  if (x.level === undefined) return true;
  return x.type === 'heading' && (x.level === 1 || x.level === 2 || x.level === 3);
}

function isBlockSeed(x: Record<string, unknown>): boolean {
  return x.kind === 'block' && isBlockAttrs(x.attrs) && isLamport(x.lamport) && isReplicaId(x.replica);
}

/** A soft break (E52): its only key is its kind, so an extra key is a different, refused shape. */
function isBreak(x: unknown): boolean {
  return hasExactKeys(x, ['kind']) && (x as Record<string, unknown>).kind === 'break';
}

/** Content as an `ins` carries it. The block seed's `replica` must be the op's author (`author`), so the stored register names the writing op exactly. */
function isContent(x: unknown, author: ItemId): x is Content {
  if (hasExactKeys(x, ['kind', 'text'])) return x.kind === 'char' && typeof x.text === 'string' && isCharText(x.text);
  if (isBreak(x)) return true;
  return hasExactKeys(x, ['kind', 'attrs', 'lamport', 'replica']) && isBlockSeed(x) && x.replica === author.replica;
}

/** Content as a snapshot item stores it: a char (empty when `stripped`, i.e. deleted), a break, or a block register naming its writer's seq. */
function isItemContent(x: unknown, stripped: boolean): x is ItemContent {
  if (hasExactKeys(x, ['kind', 'text'])) return x.kind === 'char' && typeof x.text === 'string' && (isCharText(x.text) || (stripped && x.text === ''));
  if (isBreak(x)) return true;
  return hasExactKeys(x, ['kind', 'attrs', 'lamport', 'replica', 'seq']) && isBlockSeed(x) && isUint(x.seq) && x.seq >= 1;
}

function isSide(x: unknown): boolean {
  return x === 'L' || x === 'R';
}

function isStateVector(x: unknown): x is StateVector {
  if (!isRecord(x)) return false;
  const keys = Object.keys(x);
  if (keys.length > LIMITS.MAX_SV_KEYS) return false;
  return keys.every((k) => REPLICA_ID_RE.test(k) && isUint(x[k]));
}

/** A link's destination (E28): bounded, and only a scheme a browser may follow without running code. Checked here so a hostile `javascript:` never reaches a peer's store, let alone its renderer. */
function isHref(x: unknown): x is string {
  return typeof x === 'string' && x.length <= LIMITS.MAX_HREF && HREF_SCHEME_RE.test(x);
}

/** `href` travels only on a `link` mark; on any other mark it has no meaning and is refused rather than carried around. */
function hrefFits(mark: unknown, href: unknown): boolean {
  return href === undefined || (mark === 'link' && isHref(href));
}

/** A target of del/blk/fmt: something that exists, is not the root, and is not the op itself. Mirrors `apply`'s TARGET_IS_ROOT and SELF_PARENT. */
function isTarget(x: unknown, own: ItemId): x is ItemId {
  return isDependency(x) && !isRoot(x) && !sameId(x, own);
}

function validateIns(x: Record<string, unknown>): Valid<Op> {
  if (!hasExactKeys(x, ['t', 'id', 'parent', 'side', 'content'])) return bad('ins: wrong key set');
  if (!isAuthorId(x.id)) return bad('ins: malformed id');
  if (!isDependency(x.parent)) return bad('ins: malformed parent');
  if (!isSide(x.side)) return bad('ins: side must be L or R');
  if (!isContent(x.content, x.id)) return bad('ins: malformed content');
  if (sameId(x.parent, x.id)) return bad('ins: parent is the op itself');
  // The Fugue rule never hangs anything to the left of the root; such an op is a forgery or a bug.
  if (isRoot(x.parent) && x.side === 'L') return bad('ins: left child of root');
  return { ok: true, value: x as unknown as Op };
}

function validateDel(x: Record<string, unknown>): Valid<Op> {
  if (!hasExactKeys(x, ['t', 'id', 'target'])) return bad('del: wrong key set');
  if (!isAuthorId(x.id)) return bad('del: malformed id');
  if (!isTarget(x.target, x.id)) return bad('del: malformed target');
  return { ok: true, value: x as unknown as Op };
}

function validateFmt(x: Record<string, unknown>): Valid<Op> {
  if (!hasExactKeys(x, ['t', 'id', 'targets', 'mark', 'active', 'lamport'], ['href'])) return bad('fmt: wrong key set');
  if (!isAuthorId(x.id)) return bad('fmt: malformed id');
  const { targets } = x;
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > LIMITS.MAX_FMT_TARGETS) return bad(`fmt: targets must have 1..${LIMITS.MAX_FMT_TARGETS} ids`);
  const own = x.id;
  if (!targets.every((t) => isTarget(t, own))) return bad('fmt: malformed target');
  if (typeof x.mark !== 'string' || !MARK_NAMES.includes(x.mark)) return bad('fmt: unknown mark');
  if (typeof x.active !== 'boolean') return bad('fmt: active must be boolean');
  if (!isLamport(x.lamport)) return bad('fmt: malformed lamport');
  if (!hrefFits(x.mark, x.href)) return bad(`fmt: href must be a link's http(s) or mailto URL of at most ${LIMITS.MAX_HREF} chars`);
  return { ok: true, value: x as unknown as Op };
}

function validateBlk(x: Record<string, unknown>): Valid<Op> {
  if (!hasExactKeys(x, ['t', 'id', 'target', 'attrs', 'lamport'])) return bad('blk: wrong key set');
  if (!isAuthorId(x.id)) return bad('blk: malformed id');
  if (!isTarget(x.target, x.id)) return bad('blk: malformed target');
  if (!isBlockAttrs(x.attrs)) return bad('blk: malformed attrs');
  if (!isLamport(x.lamport)) return bad('blk: malformed lamport');
  return { ok: true, value: x as unknown as Op };
}

export function validateOp(x: unknown): Valid<Op> {
  if (!isRecord(x)) return bad('op is not an object');
  switch (x.t) {
    case 'ins':
      return validateIns(x);
    case 'del':
      return validateDel(x);
    case 'fmt':
      return validateFmt(x);
    case 'blk':
      return validateBlk(x);
    default:
      return bad('unknown op type');
  }
}

/** The `ops` field of either direction: 1..MAX_OPS_PER_MESSAGE valid ops; the reason names the first offending index. */
function validateOps(x: unknown): Valid<Op[]> {
  if (!Array.isArray(x) || x.length < 1 || x.length > LIMITS.MAX_OPS_PER_MESSAGE) return bad(`ops must have 1..${LIMITS.MAX_OPS_PER_MESSAGE} entries`);
  for (let i = 0; i < x.length; i++) {
    const r = validateOp(x[i]);
    if (!r.ok) return bad(`ops[${i}]: ${r.reason}`);
  }
  return { ok: true, value: x as Op[] };
}

function isAnchor(x: unknown): x is ItemAnchor {
  if (!hasExactKeys(x, ['id', 'side'])) return false;
  return (x.id === null || isItemId(x.id, 0)) && (x.side === 'before' || x.side === 'after');
}

/** A name is text a peer will render: control characters (Cc) have no honest rendering, and format characters (Cf — bidi overrides, zero-width joiners) let one name impersonate another; both are refused rather than stripped. Length is counted in code points (E29), so forty emoji are forty characters, not eighty. */
function isPresenceName(x: unknown): boolean {
  if (typeof x !== 'string' || x.length > 2 * LIMITS.MAX_PRESENCE_NAME || /[\p{Cc}\p{Cf}]/u.test(x)) return false;
  const codePoints = [...x].length; // bounded above by the UTF-16 check, so this never spreads a whole frame
  return codePoints >= 1 && codePoints <= LIMITS.MAX_PRESENCE_NAME;
}

function isPresenceState(x: unknown): x is PresenceState {
  if (!hasExactKeys(x, ['name', 'color'], ['cursor', 'hash', 'sv'])) return false;
  if (!isPresenceName(x.name)) return false;
  if (!isUint(x.color) || x.color > LIMITS.MAX_PRESENCE_COLOR) return false;
  if (x.cursor !== undefined && !(hasExactKeys(x.cursor, ['anchor', 'head']) && isAnchor(x.cursor.anchor) && isAnchor(x.cursor.head))) return false;
  if (x.sv !== undefined && !isStateVector(x.sv)) return false;
  return x.hash === undefined || (typeof x.hash === 'string' && HASH_RE.test(x.hash));
}

function isMarkSet(x: unknown): x is MarkSet {
  if (!isRecord(x)) return false;
  return Object.keys(x).every((k) => {
    const m = x[k];
    if (!MARK_NAMES.includes(k) || !hasExactKeys(m, ['active', 'lamport', 'replica', 'seq'], ['href'])) return false;
    return typeof m.active === 'boolean' && isLamport(m.lamport) && isReplicaId(m.replica) && isUint(m.seq) && m.seq >= 1 && hrefFits(k, m.href);
  });
}

function isSnapshotItem(x: unknown): x is SnapshotItem {
  if (!hasExactKeys(x, ['id', 'parent', 'side', 'content', 'deleted', 'marks'])) return false;
  if (!isAuthorId(x.id) || !isDependency(x.parent) || sameId(x.parent, x.id) || !isSide(x.side)) return false;
  if (typeof x.deleted !== 'boolean' || !isItemContent(x.content, x.deleted)) return false;
  return isMarkSet(x.marks);
}

/** Shape only. Reachability, cycles and whether each parked op really lacks a dependency are the decoder's business (@weft/crdt), which the client runs after this passes. */
function isSnapshot(x: unknown): x is Snapshot {
  if (!hasExactKeys(x, ['v', 'sv', 'formatLamport', 'items', 'pending'])) return false;
  if (x.v !== 1 || !isStateVector(x.sv) || !isLamport(x.formatLamport)) return false;
  if (!Array.isArray(x.items) || !x.items.every(isSnapshotItem)) return false;
  return Array.isArray(x.pending) && x.pending.every((op) => validateOp(op).ok);
}

/** The envelope every frame shares. A bad `v` is a shape error; a well-formed but unknown `v` is a version error, so the sender can downgrade (LLD §5.3). */
function envelope(x: unknown): Valid<Record<string, unknown>> {
  if (!isRecord(x)) return bad('message is not an object');
  if (!Object.hasOwn(x, 'v') || !Number.isSafeInteger(x.v) || (x.v as number) < 1) return bad('v must be a positive integer');
  if (negotiate(x.v as number, LIMITS.PROTO_VERSIONS) === null) return fail('UNSUPPORTED_VERSION', `protocol version ${x.v as number} is not supported`);
  if (typeof x.t !== 'string') return bad('t must be a string');
  return { ok: true, value: x };
}

function accept<T>(x: Record<string, unknown>): Valid<T> {
  return { ok: true, value: x as unknown as T };
}

/** Structural validation of an untrusted decoded JSON value. Never throws. Rejects unknown top-level fields (a v2 field on a v1 message is a shape error, not a feature). */
export function validateClientMessage(x: unknown): Valid<ClientMessage> {
  const env = envelope(x);
  if (!env.ok) return env;
  const m = env.value;
  switch (m.t) {
    case 'hello':
      if (!hasExactKeys(m, ['v', 't', 'doc', 'replica', 'sv'])) return bad('hello: wrong key set');
      if (typeof m.doc !== 'string' || !DOC_ID_RE.test(m.doc)) return bad('hello: malformed doc id');
      if (!isReplicaId(m.replica) || m.replica === ROOT_REPLICA) return bad('hello: malformed replica id');
      if (!isStateVector(m.sv)) return bad('hello: malformed state vector');
      return accept(m);
    case 'ops': {
      if (!hasExactKeys(m, ['v', 't', 'ops'])) return bad('ops: wrong key set');
      const ops = validateOps(m.ops);
      return ops.ok ? accept(m) : ops;
    }
    case 'presence':
      if (!hasExactKeys(m, ['v', 't', 'state'])) return bad('presence: wrong key set');
      if (m.state !== null && !isPresenceState(m.state)) return bad('presence: malformed state');
      return accept(m);
    case 'ping':
      return hasExactKeys(m, ['v', 't']) ? accept(m) : bad('ping: wrong key set');
    default:
      return bad('unknown message type');
  }
}

export function validateServerMessage(x: unknown): Valid<ServerMessage> {
  const env = envelope(x);
  if (!env.ok) return env;
  const m = env.value;
  switch (m.t) {
    case 'welcome':
      if (!hasExactKeys(m, ['v', 't', 'sv'], ['snapshot'])) return bad('welcome: wrong key set');
      if (!isStateVector(m.sv)) return bad('welcome: malformed state vector');
      if (m.snapshot !== undefined && !isSnapshot(m.snapshot)) return bad('welcome: malformed snapshot');
      return accept(m);
    case 'ops': {
      if (!hasExactKeys(m, ['v', 't', 'ops'])) return bad('ops: wrong key set');
      const ops = validateOps(m.ops);
      return ops.ok ? accept(m) : ops;
    }
    case 'ack':
      if (!hasExactKeys(m, ['v', 't', 'replica', 'seq'])) return bad('ack: wrong key set');
      if (!isReplicaId(m.replica) || !isUint(m.seq) || m.seq < 1) return bad('ack: malformed replica or seq');
      return accept(m);
    case 'presence':
      if (!hasExactKeys(m, ['v', 't', 'replica', 'state'])) return bad('presence: wrong key set');
      if (!isReplicaId(m.replica)) return bad('presence: malformed replica id');
      if (m.state !== null && !isPresenceState(m.state)) return bad('presence: malformed state');
      return accept(m);
    case 'quiet':
      if (!hasExactKeys(m, ['v', 't', 'sv'])) return bad('quiet: wrong key set');
      return isStateVector(m.sv) ? accept(m) : bad('quiet: malformed state vector');
    case 'error':
      return validateError(m);
    case 'pong':
      return hasExactKeys(m, ['v', 't']) ? accept(m) : bad('pong: wrong key set');
    default:
      return bad('unknown message type');
  }
}

function validateError(m: Record<string, unknown>): Valid<ServerMessage> {
  if (!hasExactKeys(m, ['v', 't', 'code', 'reason', 'fatal'], ['supported'])) return bad('error: wrong key set');
  if (typeof m.code !== 'string' || !(ERROR_CODES as readonly string[]).includes(m.code)) return bad('error: unknown code');
  if (typeof m.reason !== 'string' || m.reason.length > LIMITS.MAX_ERROR_REASON) return bad(`error: reason must be a string of at most ${LIMITS.MAX_ERROR_REASON} chars`);
  if (typeof m.fatal !== 'boolean') return bad('error: fatal must be boolean');
  if (m.supported !== undefined && !(Array.isArray(m.supported) && m.supported.every((v) => isUint(v) && v >= 1))) return bad('error: supported must list positive integers');
  return accept(m);
}
