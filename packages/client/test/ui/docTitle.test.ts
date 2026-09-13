// docTitle.test.ts — deriveTitle reads the first heading, else the first non-empty block, else says
// UNTITLED; nothing here touches the DOM, so a plain prosemirror-model doc is enough (the same style
// as format.test.ts).

import { describe, expect, it } from 'vitest';
import { schema } from '../../src/binding/schema.ts';
import { deriveTitle, UNTITLED } from '../../src/ui/docTitle.ts';

function doc(...blocks: ReturnType<typeof schema.node>[]) {
  return schema.node('doc', null, blocks);
}
const para = (text: string) => schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
const heading = (text: string, level = 1) => schema.node('heading', { level }, text === '' ? [] : [schema.text(text)]);

describe('deriveTitle', () => {
  it('says UNTITLED for a document with no text anywhere', () => {
    expect(deriveTitle(doc(para('')))).toBe(UNTITLED);
  });

  it('uses the first heading when the document opens with one', () => {
    expect(deriveTitle(doc(heading('Fugue CRDT notes'), para('some body text')))).toBe('Fugue CRDT notes');
  });

  it('uses the first non-empty block when there is no heading', () => {
    expect(deriveTitle(doc(para(''), para('  the real first line  ')))).toBe('the real first line');
  });

  it('never lets a later heading override an earlier one', () => {
    expect(deriveTitle(doc(heading('First'), para('body'), heading('Second')))).toBe('First');
  });

  it('collapses internal whitespace to single spaces', () => {
    expect(deriveTitle(doc(para('a   b\tc')))).toBe('a b c');
  });

  it('caps a long first line with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const title = deriveTitle(doc(para(long)));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
  });
});
