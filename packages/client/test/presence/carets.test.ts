// carets.test.ts — a remote caret is an ItemAnchor, so it stays attached to the right character
// under concurrent edits (03-UI §4.3, LLD §8 S5). Inserting text BEFORE the anchored item shifts
// the caret's visible offset to follow it; deleting the anchored item clamps the caret to where the
// item was rather than dropping it to 0; and an anchor to an id this replica has not received is
// HIDDEN (null), never rendered at the document start. Built on real crdt docs and PositionIndex.

import { describe, expect, it } from 'vitest';
import { buildIndex, emptyDoc, localDelete, localInsert, type Doc, type ItemId, type ReplicaId } from '@weft/crdt';
import type { ItemAnchor } from '@weft/protocol';
import { anchorFromVisible, anchorVisibleOrHidden, visibleFromAnchor } from '../../src/binding/positions.ts';

const A = 'bcdefghijklmn' as ReplicaId;
const B = 'cdefghijklmno' as ReplicaId;

/** Type `text` for replica `me` starting at visible index `from`, returning the new doc. */
function type(doc: Doc, me: ReplicaId, from: number, text: string): Doc {
  let cur = doc;
  let seq = (cur.sv[me] ?? 0) + 1;
  let at = from;
  for (const ch of text) {
    const step = localInsert(cur, me, seq++, at++, { kind: 'char', text: ch });
    cur = step.doc;
  }
  return cur;
}

describe('remote caret anchoring', () => {
  it('follows its character when earlier text is inserted, and clamps when that character is deleted', () => {
    const doc = type(emptyDoc(), A, 0, 'abcde');
    // A peer's caret sits after the 3rd visible item ('c'): anchor after index 2.
    const anchor: ItemAnchor = anchorFromVisible(buildIndex(doc), 3);

    const inserted = type(doc, B, 0, 'XY'); // "XYabcde": 'c' is now at index 4, so after it is 5
    expect(visibleFromAnchor(buildIndex(inserted), anchor)).toBe(5);

    // Delete the anchored 'c' (index 4 of "XYabcde"): the caret clamps to where 'c' was, not to 0.
    const deleted = localDelete(inserted, B, (inserted.sv[B] ?? 0) + 1, 4, 5).doc;
    expect(visibleFromAnchor(buildIndex(deleted), anchor)).toBe(4);
  });

  it('hides a caret whose anchor names an item this replica has not received (or a hostile non-existent id)', () => {
    const doc = type(emptyDoc(), A, 0, 'abc');
    const unknown: ItemAnchor = { id: { replica: 'zzzzzzzzzzzzz', seq: 99 } as ItemId, side: 'after' };
    expect(anchorVisibleOrHidden(buildIndex(doc), unknown)).toBe(null);
    // A real anchor still resolves to an offset.
    expect(anchorVisibleOrHidden(buildIndex(doc), anchorFromVisible(buildIndex(doc), 2))).toBe(2);
  });
});
