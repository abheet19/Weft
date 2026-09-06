// colors.ts — a replica id to one of the eight presence hues (03-UI §2.2, `--p0`..`--p7`), PURE and
// deterministic so a peer keeps its colour across reconnects and every replica paints every other
// replica the same. A colour is NOT sent on the wire as identity — the presence frame carries a
// `color` a peer picked for itself — but the runner derives its own from its id here so the choice
// is stable without state, and the Inspector's self-lane uses the same function. It must never read
// a clock or draw randomness (a colour that changed on reload would make a peer look like a stranger).

import type { ReplicaId } from '@weft/crdt';

/** The palette is eight hues (03-UI §2.2). A colour on the wire is validated to 0..PALETTE_SIZE-1 (protocol MAX_PRESENCE_COLOR). */
export const PALETTE_SIZE = 8;

/**
 * FNV-1a over the id's char codes, folded to 0..7. FNV-1a spreads ids that differ in one character
 * (the adversarial "two replicas differing only in the last char", S1 §8) across the palette rather
 * than colliding, and needs no table. The id is 13 fixed base32 chars, so the loop is bounded.
 */
export function colorOf(replica: ReplicaId): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < replica.length; i++) {
    hash ^= replica.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // `>>> 0` makes the mix unsigned before the modulo, so the index is always 0..PALETTE_SIZE-1.
  return (hash >>> 0) % PALETTE_SIZE;
}

/** The CSS custom property for a palette index — `--p0`..`--p7` from 03-UI §2.2. The UI sets `--hue: var(--pN)`. */
export function hueVar(color: number): string {
  const index = Number.isInteger(color) && color >= 0 && color < PALETTE_SIZE ? color : 0;
  return `var(--p${index})`;
}
