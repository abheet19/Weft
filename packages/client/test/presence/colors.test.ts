// colors.test.ts — the palette assignment is deterministic (a peer keeps its colour across
// reconnects), always in range, and spreads ids that differ by one character rather than colliding
// (the adversarial "ids differing only in the last char"). The hue variable maps an index to the
// prototype's `--pN` and clamps a hostile out-of-range colour to a real one.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ReplicaId } from '@weft/crdt';
import { colorOf, hueVar, PALETTE_SIZE } from '../../src/presence/colors.ts';

const arbId = fc.stringMatching(/^[a-z2-7]{13}$/) as fc.Arbitrary<ReplicaId>;

describe('colorOf', () => {
  it('is stable for a replica id (the same id maps to the same colour every time)', () => {
    fc.assert(fc.property(arbId, (id) => colorOf(id) === colorOf(id)));
  });

  it('is always an integer in 0..PALETTE_SIZE-1', () => {
    fc.assert(
      fc.property(arbId, (id) => {
        const c = colorOf(id);
        return Number.isInteger(c) && c >= 0 && c < PALETTE_SIZE;
      }),
    );
  });

  it('spreads the eight ids that differ only in the last character across more than one hue', () => {
    const hues = new Set('234567ab'.split('').map((last) => colorOf(('bcdefghijklm' + last) as ReplicaId)));
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe('hueVar', () => {
  it('maps a valid index to the prototype token --pN', () => {
    expect(hueVar(0)).toBe('var(--p0)');
    expect(hueVar(7)).toBe('var(--p7)');
  });

  it('clamps a hostile out-of-range colour (99, -1, NaN) to a real hue', () => {
    for (const bad of [99, -1, 8, Number.NaN, 1.5]) expect(hueVar(bad)).toBe('var(--p0)');
  });
});
