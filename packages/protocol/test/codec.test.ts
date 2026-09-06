// codec.test.ts — the size check happens BEFORE the parse, in bytes, for strings and byte
// frames alike; a binary frame that is not UTF-8 is a shape error; and the boundary is exact for
// 1-, 2-, 3- and 4-byte characters and for the lone surrogate the encoder rewrites.
import { describe, expect, it } from 'vitest';
import { decodeClient, decodeServer, encode, LIMITS } from '../src/index.ts';

const MAX = LIMITS.MAX_MESSAGE_BYTES;

describe('decode bounds the frame size in bytes before parsing', () => {
  it(`a ${MAX}-byte string that is not JSON is BAD_SHAPE; one more byte is TOO_LARGE without being parsed`, () => {
    expect(decodeClient('x'.repeat(MAX))).toMatchObject({ ok: false, code: 'BAD_SHAPE' });
    expect(decodeClient('x'.repeat(MAX + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(decodeServer('x'.repeat(MAX + 1))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('counts multi-byte characters by their UTF-8 length, not by string length', () => {
    const twoByte = 'é'.repeat(MAX / 2);
    const threeByte = '€'.repeat(MAX / 3);
    const fourByte = '😀'.repeat(MAX / 4);
    expect(decodeClient(twoByte)).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(`${twoByte}a`)).toMatchObject({ code: 'TOO_LARGE' });
    expect(decodeClient(`${threeByte}a`)).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(`${threeByte}aa`)).toMatchObject({ code: 'TOO_LARGE' });
    expect(decodeClient(fourByte)).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(`${fourByte}a`)).toMatchObject({ code: 'TOO_LARGE' });
  });

  it('counts a lone surrogate as the 3 bytes the encoder would emit for U+FFFD', () => {
    const almost = 'a'.repeat(MAX - 3);
    expect(decodeClient(`${almost}\ud800`)).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(`${almost}a\ud800`)).toMatchObject({ code: 'TOO_LARGE' });
    expect(decodeClient(`${'a'.repeat(MAX - 4)}𐀀`)).toMatchObject({ code: 'BAD_SHAPE' });
  });

  it(`a ${MAX}-byte byte frame is parsed and ${MAX + 1} bytes are TOO_LARGE`, () => {
    expect(decodeClient(new Uint8Array(MAX).fill(0x78))).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(new Uint8Array(MAX + 1).fill(0x78))).toMatchObject({ code: 'TOO_LARGE' });
  });

  it('a 10 MB frame is refused as TOO_LARGE in constant time', () => {
    const started = performance.now();
    expect(decodeClient(new Uint8Array(10 * 1024 * 1024))).toMatchObject({ code: 'TOO_LARGE' });
    expect(decodeClient('x'.repeat(10 * 1024 * 1024))).toMatchObject({ code: 'TOO_LARGE' });
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('decode handles bytes that are not text', () => {
  it('refuses invalid UTF-8 as BAD_SHAPE', () => {
    expect(decodeClient(new Uint8Array([0xff, 0xfe, 0x7b]))).toEqual({ ok: false, code: 'BAD_SHAPE', reason: 'frame is not UTF-8' });
  });

  it('refuses non-JSON text as BAD_SHAPE and accepts valid UTF-8 bytes of a valid message', () => {
    expect(decodeClient('{"v":1,')).toEqual({ ok: false, code: 'BAD_SHAPE', reason: 'frame is not JSON' });
    expect(decodeClient('')).toMatchObject({ code: 'BAD_SHAPE' });
    expect(decodeClient(new TextEncoder().encode(encode({ v: 1, t: 'ping' })))).toEqual({ ok: true, value: { v: 1, t: 'ping' } });
    expect(decodeServer(encode({ v: 1, t: 'pong' }))).toEqual({ ok: true, value: { v: 1, t: 'pong' } });
  });
});
