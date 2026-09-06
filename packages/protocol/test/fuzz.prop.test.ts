// fuzz.prop.test.ts — I15 (total validation) and the codec round trip as properties. The wire is
// the one input an attacker fully controls, so the decoder must return a coded refusal for every
// byte string — never throw — and must accept every message the encoder can produce.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeClient, decodeServer, encode, validateClientMessage, validateOp, validateServerMessage, ERROR_CODES } from '../src/index.ts';
import { arbClientMessage, arbOp, arbServerMessage, numRuns } from './generators.ts';

const decoders = [decodeClient, decodeServer];

describe('I15: decoding never throws and every refusal carries a code', () => {
  it('returns a coded result for any JSON value fed to the validators', () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        for (const validate of [validateClientMessage, validateServerMessage, validateOp]) {
          const r = validate(x);
          if (!r.ok) expect(ERROR_CODES).toContain(r.code);
        }
      }),
      { numRuns: numRuns() },
    );
  });

  it('returns a coded result for any string frame', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        for (const decode of decoders) {
          const r = decode(s);
          if (!r.ok) expect(ERROR_CODES).toContain(r.code);
        }
      }),
      { numRuns: numRuns() },
    );
  });

  it('returns a coded result for any byte frame, including invalid UTF-8', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        for (const decode of decoders) {
          const r = decode(bytes);
          if (!r.ok) expect(ERROR_CODES).toContain(r.code);
        }
      }),
      { numRuns: numRuns() },
    );
  });

  it('refuses every strict prefix of a valid frame as BAD_SHAPE (truncated JSON)', () => {
    fc.assert(
      fc.property(arbClientMessage, fc.nat(), (m, cut) => {
        const text = encode(m);
        const prefix = text.slice(0, cut % text.length);
        const r = decodeClient(prefix);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('BAD_SHAPE');
      }),
      { numRuns: numRuns() },
    );
  });
});

describe('round trip: decode accepts everything encode produces', () => {
  it('for client messages, as a string and as UTF-8 bytes, yielding the same value', () => {
    fc.assert(
      fc.property(arbClientMessage, (m) => {
        const text = encode(m);
        const asString = decodeClient(text);
        const asBytes = decodeClient(new TextEncoder().encode(text));
        expect(asString).toEqual({ ok: true, value: m });
        expect(asBytes).toEqual({ ok: true, value: m });
      }),
      { numRuns: numRuns() },
    );
  });

  it('for server messages, including welcome with a snapshot and error with a supported list', () => {
    fc.assert(
      fc.property(arbServerMessage, (m) => {
        expect(decodeServer(encode(m))).toEqual({ ok: true, value: m });
      }),
      { numRuns: numRuns() },
    );
  });

  it('for single ops through validateOp', () => {
    fc.assert(
      fc.property(arbOp, (op) => {
        expect(validateOp(JSON.parse(JSON.stringify(op)))).toEqual({ ok: true, value: op });
      }),
      { numRuns: numRuns() },
    );
  });

  it('a client message is never a valid server message of the same type unless the shapes coincide (ops only)', () => {
    fc.assert(
      fc.property(arbClientMessage, (m) => {
        const r = validateServerMessage(m);
        expect(r.ok).toBe(m.t === 'ops');
      }),
      { numRuns: numRuns() },
    );
  });
});
