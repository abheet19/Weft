// Appending a leaf creates an explicit boundary for the preceding paragraph.
import { buildIndex, emptyDoc, localInsert } from '@weft/crdt';
import { EditorState, TextSelection } from 'prosemirror-state';
import { expect, it } from 'vitest';
import { transactionToOps } from '../../src/binding/toOps.ts';
import { normalize } from '../../src/binding/normalize.ts';
import { schema } from '../../src/binding/schema.ts';
import { R } from './helpers.ts';

for (const pos of [1, 3, 6]) {
  it(`preserves divider inserted at ${pos}`, () => {
    let doc = emptyDoc();
    let seq = 1;
    for (const text of 'above') {
      doc = localInsert(doc, R.a, seq, seq - 1, { kind: 'char', text }).doc;
      seq++;
    }
    const index = buildIndex(doc);
    const pm = normalize(index.items());
    const state = EditorState.create({ schema, doc: pm, selection: TextSelection.create(pm, pos) });
    const tr = state.tr.replaceSelectionWith(schema.nodes.divider!.create());
    const result = transactionToOps(doc, index, R.a, seq, tr);
    const expected = tr.doc.lastChild?.type.name === 'divider'
      ? schema.node('doc', null, [...Array.from({ length: tr.doc.childCount }, (_, i) => tr.doc.child(i)), schema.node('paragraph')])
      : tr.doc;
    expect(normalize(result.index.items()).eq(expected)).toBe(true);
  });
}
