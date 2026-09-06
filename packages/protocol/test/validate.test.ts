// validate.test.ts — the denied paths of LLD §5.2/§5.3, one example per rule: every LIMIT at its
// boundary and one past it, every version shape an attacker sends, unknown fields, unknown
// types, and the id/side/content rules that mirror `apply`'s refusals. A validator is only as
// good as the worst input it has been shown, so each rule here is shown the input that breaks it.
import { describe, expect, it } from 'vitest';
import { LIMITS, negotiate, validateClientMessage, validateOp, validateServerMessage, type Op, type ReplicaId } from '../src/index.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;
const ROOT = { replica: 'aaaaaaaaaaaaa', seq: 0 };
const id = (replica: ReplicaId, seq: number) => ({ replica, seq });
const ins = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ t: 'ins', id: id(A, 1), parent: ROOT, side: 'R', content: { kind: 'char', text: 'x' }, ...over });
const hello = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 1, t: 'hello', doc: 'doc-00001', replica: A, sv: {}, ...over });
const presence = (state: unknown): unknown => ({ v: 1, t: 'presence', state });

function refused(r: { ok: boolean; code?: string }, code = 'BAD_SHAPE'): void {
  expect(r.ok).toBe(false);
  expect(r).toMatchObject({ code });
}

describe('the envelope and versioning (LLD §5.3)', () => {
  it('accepts v: 1 and treats v: 1.0 as the number 1 it is once parsed', () => {
    expect(validateClientMessage({ v: 1, t: 'ping' }).ok).toBe(true);
    expect(validateClientMessage(JSON.parse('{"v":1.0,"t":"ping"}')).ok).toBe(true);
  });

  it('refuses v: 2 as UNSUPPORTED_VERSION so the sender can downgrade', () => {
    refused(validateClientMessage({ v: 2, t: 'ping' }), 'UNSUPPORTED_VERSION');
    refused(validateServerMessage({ v: 2, t: 'pong' }), 'UNSUPPORTED_VERSION');
  });

  it('refuses v: "1", v: -1, v: 0, v: 1.5 and a missing v as BAD_SHAPE, not as a version', () => {
    for (const v of ['1', -1, 0, 1.5, null, undefined, [1], {}]) refused(validateClientMessage({ v, t: 'ping' }));
    refused(validateClientMessage({ t: 'ping' }));
  });

  it('refuses a non-object, a non-string t and an unknown t', () => {
    for (const x of [null, 1, 'ping', [], true]) refused(validateClientMessage(x));
    refused(validateClientMessage({ v: 1, t: 7 }));
    refused(validateClientMessage({ v: 1, t: 'converged' }));
    refused(validateServerMessage({ v: 1, t: 'hello' }));
  });

  it('negotiate: the client names its maximum and the server answers in it or refuses', () => {
    expect(negotiate(1, [1])).toBe(1);
    expect(negotiate(1, [1, 2])).toBe(1);
    expect(negotiate(2, [1, 2])).toBe(2);
    expect(negotiate(2, [1])).toBeNull();
    expect(negotiate(3, [1, 2])).toBeNull();
  });
});

describe('unknown top-level fields are a shape error, never a feature', () => {
  it('on every client and server message type', () => {
    refused(validateClientMessage(hello({ extra: 1 })));
    refused(validateClientMessage({ v: 1, t: 'ops', ops: [ins()], extra: 1 }));
    refused(validateClientMessage({ v: 1, t: 'presence', state: null, extra: 1 }));
    refused(validateClientMessage({ v: 1, t: 'ping', extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'welcome', sv: {}, extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'ops', ops: [ins()], extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'ack', replica: A, seq: 1, extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'presence', replica: A, state: null, extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'quiet', sv: {}, extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'error', code: 'INTERNAL', reason: '', fatal: true, extra: 1 }));
    refused(validateServerMessage({ v: 1, t: 'pong', extra: 1 }));
  });

  it('a "__proto__" key from JSON.parse is an unknown field too, on messages, ops, attrs and state vectors', () => {
    refused(validateClientMessage(JSON.parse('{"v":1,"t":"ping","__proto__":{}}')));
    refused(validateOp(JSON.parse('{"t":"del","id":{"replica":"bcdefghijklmn","seq":1},"target":{"replica":"bcdefghijklmn","seq":2},"__proto__":{}}')));
    refused(validateOp(ins({ content: JSON.parse('{"kind":"block","attrs":{"type":"quote","__proto__":1},"lamport":0,"replica":"bcdefghijklmn"}') })));
    refused(validateClientMessage(hello({ sv: JSON.parse('{"__proto__":1}') })));
  });
});

describe('hello', () => {
  it('accepts doc ids of 8 and 64 chars and refuses 7, 65, uppercase and a non-string', () => {
    expect(validateClientMessage(hello({ doc: 'a'.repeat(8) })).ok).toBe(true);
    expect(validateClientMessage(hello({ doc: 'a'.repeat(64) })).ok).toBe(true);
    refused(validateClientMessage(hello({ doc: 'a'.repeat(7) })));
    refused(validateClientMessage(hello({ doc: 'a'.repeat(65) })));
    refused(validateClientMessage(hello({ doc: 'Doc-00001' })));
    refused(validateClientMessage(hello({ doc: 7 })));
  });

  it('refuses a malformed replica id (wrong length, wrong alphabet, wrong type)', () => {
    for (const replica of ['bcdefghijklm', 'bcdefghijklmnn', 'BCDEFGHIJKLMN', 'bcdefghijklm1', 7, null]) refused(validateClientMessage(hello({ replica })));
  });

  it(`accepts a state vector of ${LIMITS.MAX_SV_KEYS} replicas and refuses ${LIMITS.MAX_SV_KEYS + 1}`, () => {
    const sv: Record<string, number> = {};
    for (let i = 0; i < LIMITS.MAX_SV_KEYS; i++) sv[replicaNamed(i)] = i;
    expect(validateClientMessage(hello({ sv })).ok).toBe(true);
    sv[replicaNamed(LIMITS.MAX_SV_KEYS)] = 1;
    refused(validateClientMessage(hello({ sv })));
  });

  it('refuses a state vector with a bad key, a negative, fractional, huge or non-number value, or that is not an object', () => {
    for (const sv of [{ nope: 1 }, { [A]: -1 }, { [A]: 1.5 }, { [A]: 2 ** 53 }, { [A]: '1' }, [], null, 'x']) refused(validateClientMessage(hello({ sv })));
  });
});

describe('ops and validateOp', () => {
  it(`accepts ${LIMITS.MAX_OPS_PER_MESSAGE} ops and refuses ${LIMITS.MAX_OPS_PER_MESSAGE + 1} and 0`, () => {
    const ops = Array.from({ length: LIMITS.MAX_OPS_PER_MESSAGE }, (_, i) => ins({ id: id(A, i + 1) }));
    expect(validateClientMessage({ v: 1, t: 'ops', ops }).ok).toBe(true);
    refused(validateClientMessage({ v: 1, t: 'ops', ops: [...ops, ins()] }));
    refused(validateClientMessage({ v: 1, t: 'ops', ops: [] }));
    refused(validateClientMessage({ v: 1, t: 'ops', ops: 'ins' }));
  });

  it('refuses an op array containing a string, naming the index', () => {
    const r = validateClientMessage({ v: 1, t: 'ops', ops: [ins(), 'ins'] });
    refused(r);
    if (!r.ok) expect(r.reason).toContain('ops[1]');
  });

  it('refuses a non-object op and an unknown op type', () => {
    refused(validateOp('ins'));
    refused(validateOp(null));
    refused(validateOp({ t: 'mov', id: id(A, 1) }));
  });

  it('ins: refuses seq 0 or a non-integer seq on the op itself, a self-parent, a left child of root, and a seq-0 parent that is not root', () => {
    refused(validateOp(ins({ id: id(A, 0) })));
    refused(validateOp(ins({ id: id(A, 1.5) })));
    refused(validateOp(ins({ id: id(A, 1), parent: id(A, 1) })));
    refused(validateOp(ins({ parent: ROOT, side: 'L' })));
    refused(validateOp(ins({ parent: id(B, 0) })));
    expect(validateOp(ins({ parent: id(B, 1), side: 'L' })).ok).toBe(true);
    refused(validateOp(ins({ side: 'M' })));
  });

  it(`ins: content is exactly one code point — 'a' and '𝄞' pass; '', 'ab', a lone surrogate and a non-string fail`, () => {
    expect(validateOp(ins({ content: { kind: 'char', text: 'a' } })).ok).toBe(true);
    expect(validateOp(ins({ content: { kind: 'char', text: '𝄞' } })).ok).toBe(true);
    for (const text of ['', 'ab', '\ud834', '\udd1e', '\udd1e\ud834', 7]) refused(validateOp(ins({ content: { kind: 'char', text } })));
    refused(validateOp(ins({ content: { kind: 'char' } })));
    refused(validateOp(ins({ content: { kind: 'word', text: 'a' } })));
  });

  it('ins: a soft break carries only its kind (E52); an extra key is refused', () => {
    expect(validateOp(ins({ content: { kind: 'break' } })).ok).toBe(true);
    refused(validateOp(ins({ content: { kind: 'break', text: 'x' } })));
  });

  it('ins: block content needs valid attrs, a lamport and a replica; level only on headings and only 1..3', () => {
    const blockContent = (attrs: unknown, over: Record<string, unknown> = {}) => ({ kind: 'block', attrs, lamport: 0, replica: A, ...over });
    expect(validateOp(ins({ content: blockContent({ type: 'heading', level: 3 }) })).ok).toBe(true);
    refused(validateOp(ins({ content: blockContent({ type: 'heading', level: 4 }) })));
    refused(validateOp(ins({ content: blockContent({ type: 'bullet', level: 1 }) })));
    refused(validateOp(ins({ content: blockContent({ type: 'table' }) })));
    refused(validateOp(ins({ content: blockContent({ type: 'quote' }, { lamport: -1 }) })));
    refused(validateOp(ins({ content: blockContent({ type: 'quote' }, { replica: 'x' }) })));
    refused(validateOp(ins({ content: blockContent({ type: 'quote' }, { kind: 'blocks' }) })));
  });

  it('mirrors the CRDT’s MALFORMED rules: no op authored under the root replica, a block seed names its author, lamports fit 31 bits, no U+0000 character', () => {
    refused(validateOp(ins({ id: { replica: 'aaaaaaaaaaaaa', seq: 1 } })));
    refused(validateOp({ t: 'del', id: { replica: 'aaaaaaaaaaaaa', seq: 1 }, target: id(B, 1) }));
    refused(validateClientMessage(hello({ replica: 'aaaaaaaaaaaaa' })));
    refused(validateOp(ins({ content: { kind: 'block', attrs: { type: 'quote' }, lamport: 0, replica: B } })));
    expect(validateOp(ins({ content: { kind: 'block', attrs: { type: 'quote' }, lamport: LIMITS.MAX_LAMPORT, replica: A } })).ok).toBe(true);
    refused(validateOp(ins({ content: { kind: 'block', attrs: { type: 'quote' }, lamport: LIMITS.MAX_LAMPORT + 1, replica: A } })));
    refused(validateOp({ t: 'fmt', id: id(A, 1), targets: [id(B, 1)], mark: 'bold', active: true, lamport: LIMITS.MAX_LAMPORT + 1 }));
    refused(validateOp({ t: 'blk', id: id(A, 1), target: id(B, 1), attrs: { type: 'quote' }, lamport: LIMITS.MAX_LAMPORT + 1 }));
    refused(validateOp(ins({ content: { kind: 'char', text: '\0' } })));
  });

  it('del: refuses the root, itself, a missing target and a wrong key set', () => {
    expect(validateOp({ t: 'del', id: id(A, 2), target: id(A, 1) }).ok).toBe(true);
    refused(validateOp({ t: 'del', id: id(A, 2), target: ROOT }));
    refused(validateOp({ t: 'del', id: id(A, 2), target: id(A, 2) }));
    refused(validateOp({ t: 'del', id: id(A, 2) }));
    refused(validateOp({ t: 'del', id: id(A, 0), target: id(A, 1) }));
  });

  it(`fmt: accepts ${LIMITS.MAX_FMT_TARGETS} targets and refuses ${LIMITS.MAX_FMT_TARGETS + 1} and 0`, () => {
    const fmt = (targets: unknown, over: Record<string, unknown> = {}) => ({ t: 'fmt', id: id(A, 1), targets, mark: 'bold', active: true, lamport: 1, ...over });
    const many = Array.from({ length: LIMITS.MAX_FMT_TARGETS }, (_, i) => id(B, i + 1));
    expect(validateOp(fmt(many)).ok).toBe(true);
    refused(validateOp(fmt([...many, id(B, 5000)])));
    refused(validateOp(fmt([])));
    refused(validateOp(fmt('all')));
    refused(validateOp(fmt([id(A, 1)])));
    refused(validateOp(fmt([ROOT])));
    refused(validateOp(fmt([id(B, 1)], { mark: 'underline' })));
    refused(validateOp(fmt([id(B, 1)], { active: 'yes' })));
    refused(validateOp(fmt([id(B, 1)], { lamport: 1.5 })));
    refused(validateOp(fmt([id(B, 1)], { mark: 'link', href: 7 })));
    expect(validateOp(fmt([id(B, 1)], { mark: 'link', href: 'https://example.org' })).ok).toBe(true);
    refused(validateOp(fmt([id(B, 1)], { id: id(A, 0) })));
    refused(validateOp({ t: 'fmt', id: id(A, 1), targets: [id(B, 1)] }));
  });

  it(`fmt href (E28): http, https and mailto pass up to ${LIMITS.MAX_HREF} chars; javascript:, data:, a leading space, ${LIMITS.MAX_HREF + 1} chars, and an href on a non-link mark are refused`, () => {
    const link = (href: unknown, mark = 'link') => ({ t: 'fmt', id: id(A, 2), targets: [id(A, 1)], mark, active: true, lamport: 1, href });
    for (const href of ['http://example.org', 'HTTPS://EXAMPLE.ORG/a?b=c#d', 'mailto:ada@example.org', `https://x.org/${'p'.repeat(LIMITS.MAX_HREF - 'https://x.org/'.length)}`]) expect(validateOp(link(href)).ok).toBe(true);
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'vbscript:x', ' https://example.org', '//example.org', 'example.org', '', `https://x.org/${'p'.repeat(LIMITS.MAX_HREF)}`]) refused(validateOp(link(href)));
    for (const mark of ['bold', 'italic', 'code']) refused(validateOp(link('https://example.org', mark)));
    expect(validateOp({ t: 'fmt', id: id(A, 2), targets: [id(A, 1)], mark: 'bold', active: true, lamport: 1 }).ok).toBe(true);
  });

  it('blk: refuses bad attrs, a bad lamport, the root as target and a wrong key set', () => {
    const blk = (over: Record<string, unknown> = {}) => ({ t: 'blk', id: id(A, 1), target: id(B, 1), attrs: { type: 'quote' }, lamport: 1, ...over });
    expect(validateOp(blk()).ok).toBe(true);
    refused(validateOp(blk({ attrs: { type: 'quote', level: 1 } })));
    refused(validateOp(blk({ lamport: -1 })));
    refused(validateOp(blk({ target: ROOT })));
    refused(validateOp(blk({ id: id(A, 0) })));
    refused(validateOp({ t: 'blk', id: id(A, 1), target: id(B, 1) }));
  });
});

describe('presence', () => {
  const state = (over: Record<string, unknown> = {}) => ({ name: 'Ada', color: 3, ...over });

  it('accepts null (leaving), a bare state, and a state with cursor, hash and the sv the hash was computed against (E27)', () => {
    expect(validateClientMessage(presence(null)).ok).toBe(true);
    expect(validateClientMessage(presence(state())).ok).toBe(true);
    const cursor = { anchor: { id: null, side: 'before' }, head: { id: id(A, 4), side: 'after' } };
    expect(validateClientMessage(presence(state({ cursor, hash: 'a'.repeat(64) }))).ok).toBe(true);
    expect(validateClientMessage(presence(state({ hash: 'a'.repeat(64), sv: { [A]: 3, [B]: 1 } }))).ok).toBe(true);
    expect(validateClientMessage(presence(state({ sv: {} }))).ok).toBe(true);
    for (const sv of [null, 'x', { nope: 1 }, { [A]: -1 }, JSON.parse('{"__proto__":1}')]) refused(validateClientMessage(presence(state({ sv }))));
  });

  it(`accepts a name of ${LIMITS.MAX_PRESENCE_NAME} code points (even as ${2 * LIMITS.MAX_PRESENCE_NAME} UTF-16 units) and refuses ${LIMITS.MAX_PRESENCE_NAME + 1}, empty, control characters, format characters (E29) and a non-string`, () => {
    expect(validateClientMessage(presence(state({ name: 'n'.repeat(LIMITS.MAX_PRESENCE_NAME) }))).ok).toBe(true);
    expect(validateClientMessage(presence(state({ name: '\u{1F600}'.repeat(LIMITS.MAX_PRESENCE_NAME) }))).ok).toBe(true);
    expect(validateClientMessage(presence(state({ name: 'Ada Lovelace \u2014 1815' }))).ok).toBe(true);
    for (const name of ['n'.repeat(LIMITS.MAX_PRESENCE_NAME + 1), '\u{1F600}'.repeat(LIMITS.MAX_PRESENCE_NAME + 1), '', 'a\tb', 'a\nb', 'a\u0000b', 7]) refused(validateClientMessage(presence(state({ name }))));
    // Format characters: RTL override, zero-width space, zero-width joiner, soft hyphen, BOM.
    for (const name of ['\u202Eevil', 'a\u200Bb', 'a\u200Db', 'a\u00ADb', '\uFEFFAda']) refused(validateClientMessage(presence(state({ name }))));
  });

  it(`accepts colours 0..${LIMITS.MAX_PRESENCE_COLOR} and refuses ${LIMITS.MAX_PRESENCE_COLOR + 1}, -1 and 1.5`, () => {
    expect(validateClientMessage(presence(state({ color: 0 }))).ok).toBe(true);
    expect(validateClientMessage(presence(state({ color: LIMITS.MAX_PRESENCE_COLOR }))).ok).toBe(true);
    for (const color of [LIMITS.MAX_PRESENCE_COLOR + 1, -1, 1.5, '3']) refused(validateClientMessage(presence(state({ color }))));
  });

  it('refuses a malformed cursor, a malformed hash, an unknown field and a non-object state', () => {
    refused(validateClientMessage(presence(state({ cursor: { anchor: { id: null, side: 'before' } } }))));
    refused(validateClientMessage(presence(state({ cursor: { anchor: { id: null, side: 'left' }, head: { id: null, side: 'after' } } }))));
    refused(validateClientMessage(presence(state({ cursor: { anchor: { id: 'x', side: 'after' }, head: { id: null, side: 'after' } } }))));
    refused(validateClientMessage(presence(state({ hash: 'A'.repeat(64) }))));
    refused(validateClientMessage(presence(state({ hash: 'a'.repeat(63) }))));
    refused(validateClientMessage(presence(state({ extra: 1 }))));
    refused(validateClientMessage(presence('Ada')));
    refused(validateClientMessage({ v: 1, t: 'presence' }));
  });

  it('server presence needs a well-formed replica', () => {
    expect(validateServerMessage({ v: 1, t: 'presence', replica: A, state: state() }).ok).toBe(true);
    refused(validateServerMessage({ v: 1, t: 'presence', replica: 'x', state: null }));
    refused(validateServerMessage({ v: 1, t: 'presence', replica: A, state: 'x' }));
  });
});

describe('server-only messages', () => {
  it('welcome: sv is required and the optional snapshot is checked for shape', () => {
    expect(validateServerMessage({ v: 1, t: 'welcome', sv: { [A]: 3 } }).ok).toBe(true);
    refused(validateServerMessage({ v: 1, t: 'welcome' }));
    refused(validateServerMessage({ v: 1, t: 'welcome', sv: 'x' }));
    const snapshot = (over: Record<string, unknown>) => ({ v: 1, t: 'welcome', sv: {}, snapshot: { v: 1, sv: {}, formatLamport: 0, items: [], pending: [], ...over } });
    expect(validateServerMessage(snapshot({})).ok).toBe(true);
    refused(validateServerMessage(snapshot({ v: 2 })));
    refused(validateServerMessage(snapshot({ items: {} })));
    refused(validateServerMessage(snapshot({ items: [{}] })));
    refused(validateServerMessage(snapshot({ formatLamport: LIMITS.MAX_LAMPORT + 1 })));
    refused(validateServerMessage(snapshot({ pending: [{ t: 'del', id: id(A, 1), target: ROOT }] })));
    refused(validateServerMessage(snapshot({ pending: {} })));
    refused(validateServerMessage({ v: 1, t: 'welcome', sv: {}, snapshot: { v: 1, sv: {}, items: [] } }));
    expect(validateServerMessage(snapshot({ pending: [{ t: 'del', id: id(A, 2), target: id(B, 9) }] })).ok).toBe(true);
  });

  it('welcome snapshot items: a deleted char may carry empty text, a live one may not, block registers name their writer, marks are a closed set', () => {
    const item = (over: Record<string, unknown>) => ({ id: id(A, 1), parent: ROOT, side: 'R', content: { kind: 'char', text: 'x' }, deleted: false, marks: {}, ...over });
    const welcome = (items: unknown[]) => ({ v: 1, t: 'welcome', sv: {}, snapshot: { v: 1, sv: {}, formatLamport: 0, items, pending: [] } });
    const register = { kind: 'block', attrs: { type: 'quote' }, lamport: 0, replica: B, seq: 1 };
    expect(validateServerMessage(welcome([item({})])).ok).toBe(true);
    expect(validateServerMessage(welcome([item({ deleted: true, content: { kind: 'char', text: '' } })])).ok).toBe(true);
    expect(validateServerMessage(welcome([item({ content: register })])).ok).toBe(true);
    expect(validateServerMessage(welcome([item({ marks: { bold: { active: true, lamport: 1, replica: A, seq: 3 } } })])).ok).toBe(true);
    expect(validateServerMessage(welcome([item({ marks: { link: { active: true, lamport: 1, replica: A, seq: 3, href: 'https://x' } } })])).ok).toBe(true);
    refused(validateServerMessage(welcome([item({ marks: { link: { active: true, lamport: 1, replica: A, seq: 3, href: 'javascript:1' } } })])));
    refused(validateServerMessage(welcome([item({ marks: { bold: { active: true, lamport: 1, replica: A, seq: 3, href: 'https://x' } } })])));
    refused(validateServerMessage(welcome([item({ content: { kind: 'char', text: '' } })])));
    refused(validateServerMessage(welcome([item({ content: { ...register, seq: 0 } })])));
    refused(validateServerMessage(welcome([item({ content: { kind: 'block', attrs: { type: 'quote' }, lamport: 0, replica: B } })])));
    refused(validateServerMessage(welcome([item({ deleted: 'no' })])));
    refused(validateServerMessage(welcome([item({ parent: id(A, 1) })])));
    refused(validateServerMessage(welcome([item({ id: { replica: 'aaaaaaaaaaaaa', seq: 1 } })])));
    refused(validateServerMessage(welcome([item({ marks: JSON.parse('{"__proto__":{"active":true,"lamport":1,"replica":"bcdefghijklmn","seq":1}}') })])));
    refused(validateServerMessage(welcome([item({ marks: { bold: { active: true, lamport: 1, replica: A } } })])));
    refused(validateServerMessage(welcome([item({ marks: { bold: { active: true, lamport: 1, replica: A, seq: 0 } } })])));
    refused(validateServerMessage(welcome([item({ marks: { bold: { active: true, lamport: 1, replica: A, seq: 1, href: 7 } } })])));
    refused(validateServerMessage(welcome([item({ marks: [] })])));
  });

  it('ack: seq is a positive integer and replica is well-formed', () => {
    expect(validateServerMessage({ v: 1, t: 'ack', replica: A, seq: 1 }).ok).toBe(true);
    refused(validateServerMessage({ v: 1, t: 'ack', replica: A, seq: 0 }));
    refused(validateServerMessage({ v: 1, t: 'ack', replica: 'x', seq: 1 }));
    refused(validateServerMessage({ v: 1, t: 'ack', replica: A }));
  });

  it('quiet: carries a state vector', () => {
    expect(validateServerMessage({ v: 1, t: 'quiet', sv: {} }).ok).toBe(true);
    refused(validateServerMessage({ v: 1, t: 'quiet', sv: null }));
    refused(validateServerMessage({ v: 1, t: 'quiet' }));
  });

  it(`error: reason of ${LIMITS.MAX_ERROR_REASON} chars passes, ${LIMITS.MAX_ERROR_REASON + 1} fails; code, fatal and supported are checked`, () => {
    const error = (over: Record<string, unknown> = {}) => ({ v: 1, t: 'error', code: 'SEQ_GAP', reason: 'r'.repeat(LIMITS.MAX_ERROR_REASON), fatal: false, ...over });
    expect(validateServerMessage(error()).ok).toBe(true);
    expect(validateServerMessage(error({ supported: [1, 2] })).ok).toBe(true);
    refused(validateServerMessage(error({ reason: 'r'.repeat(LIMITS.MAX_ERROR_REASON + 1) })));
    refused(validateServerMessage(error({ reason: 7 })));
    refused(validateServerMessage(error({ code: 'OOPS' })));
    refused(validateServerMessage(error({ fatal: 'yes' })));
    refused(validateServerMessage(error({ supported: [0] })));
    refused(validateServerMessage(error({ supported: 1 })));
    refused(validateServerMessage({ v: 1, t: 'error', code: 'SEQ_GAP' }));
  });

  it('ping and pong carry nothing else', () => {
    expect(validateServerMessage({ v: 1, t: 'pong' }).ok).toBe(true);
    refused(validateClientMessage({ v: 1, t: 'ping', at: 1 }));
    refused(validateServerMessage({ v: 1, t: 'pong', at: 1 }));
  });

  it('the value returned is the input object, so callers may rely on identity', () => {
    const op: Op = { t: 'del', id: id(A, 2), target: id(A, 1) };
    const r = validateOp(op);
    expect(r.ok && r.value).toBe(op);
  });
});

/** The i-th distinct well-formed replica id: 'b' + a 12-digit base32 rendering of i. */
function replicaNamed(i: number): string {
  const digits = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = '';
  let n = i;
  for (let k = 0; k < 12; k++) {
    s = digits[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return `b${s}`;
}
