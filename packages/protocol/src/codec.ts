// codec.ts — bytes in, validated message out; message in, JSON out. This file exists so nobody
// calls `JSON.parse` on the wire directly: the size is bounded BEFORE parsing, the parse is
// caught, and the result is validated, in that order, every time. It must never allocate a copy
// of an oversized frame to measure it (the string path counts UTF-8 bytes in a loop), and never
// let a decoding failure escape as an exception (I15).

import { LIMITS } from './limits.ts';
import type { ClientMessage, ServerMessage } from './messages.ts';
import { validateClientMessage, validateServerMessage, type Valid } from './validate.ts';

/** decode = size check (bytes, before parsing) → JSON.parse in try → validate. Exists so nobody calls JSON.parse on the wire directly. */
export function decodeClient(bytes: string | Uint8Array): Valid<ClientMessage> {
  return decode(bytes, validateClientMessage);
}

export function decodeServer(bytes: string | Uint8Array): Valid<ServerMessage> {
  return decode(bytes, validateServerMessage);
}

export function encode(m: ClientMessage | ServerMessage): string {
  return JSON.stringify(m);
}

function decode<T>(bytes: string | Uint8Array, validate: (x: unknown) => Valid<T>): Valid<T> {
  const text = toText(bytes);
  if (!text.ok) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return { ok: false, code: 'BAD_SHAPE', reason: 'frame is not JSON' };
  }
  return validate(parsed);
}

function toText(bytes: string | Uint8Array): Valid<string> {
  const tooLarge: Valid<never> = { ok: false, code: 'TOO_LARGE', reason: `frame exceeds ${LIMITS.MAX_MESSAGE_BYTES} bytes` };
  if (typeof bytes === 'string') return exceedsUtf8(bytes, LIMITS.MAX_MESSAGE_BYTES) ? tooLarge : { ok: true, value: bytes };
  if (bytes.byteLength > LIMITS.MAX_MESSAGE_BYTES) return tooLarge;
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, code: 'BAD_SHAPE', reason: 'frame is not UTF-8' };
  }
}

/** True when the UTF-8 encoding of `s` is longer than `max` bytes, computed without encoding. The two cheap bounds (1 and 3 bytes per UTF-16 unit) settle almost every frame; the loop runs only for frames near the limit. */
function exceedsUtf8(s: string, max: number): boolean {
  if (s.length > max) return true;
  if (s.length * 3 <= max) return false;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3; // a BMP char, or a lone surrogate that the encoder rewrites to the 3-byte U+FFFD
    if (bytes > max) return true;
  }
  return false;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
