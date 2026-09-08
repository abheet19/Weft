// A divider is an atom. Equal-count block diffs must never edit inside it, including
// normalized CRDT states whose divider boundary currently has text before it.
import { emptyDoc, localInsert } from '@weft/crdt';
import { EditorState } from 'prosemirror-state';
import { expect, it } from 'vitest';
import { correction, mirrorOf } from '../../src/binding/toTransaction.ts';
import { normalize } from '../../src/binding/normalize.ts';
import { schema } from '../../src/binding/schema.ts';
import { R } from './helpers.ts';

for (const text of ['', 'restored text']) {
  it(`reconciles a divider to its normal form with ${text.length} text characters`, () => {
    let doc = emptyDoc();
    let seq = 1;
    let at = 0;
    for (const ch of text) doc = localInsert(doc, R.a, seq++, at++, { kind: 'char', text: ch }).doc;
    doc = localInsert(doc, R.a, seq, at, { kind: 'block', attrs: { type: 'divider' }, lamport: 0, replica: R.a }).doc;
    const mirror = mirrorOf(doc);
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('divider'), schema.node('paragraph')]) });
    const changed = state.apply(correction(state, mirror));
    expect(() => changed.doc.check()).not.toThrow();
    expect(changed.doc.eq(normalize(mirror.index.items()))).toBe(true);
    // Reverse the change: a text block becoming a leaf must be safe too.
    const leafDoc = localInsert(emptyDoc(), R.a, 1, 0, { kind: 'block', attrs: { type: 'divider' }, lamport: 0, replica: R.a }).doc;
    const leafMirror = mirrorOf(leafDoc);
    const reversed = changed.apply(correction(changed, leafMirror));
    expect(() => reversed.doc.check()).not.toThrow();
    expect(reversed.doc.eq(normalize(leafMirror.index.items()))).toBe(true);
  });
}
