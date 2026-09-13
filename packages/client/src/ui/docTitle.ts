// docTitle.ts — a display title derived from the document's own content, never stored, never
// invented. Weft's schema has no title field (a document is exactly its visible content, see
// binding/schema.ts), so the redesign's top bar and its new Documents screen both need a pure read
// of "what to call this" that costs nothing extra to keep in sync: the first heading's text if the
// document opens with one, else the first non-empty block's text, trimmed and capped so a long
// opening line still reads as a label rather than a paragraph. Never the CRDT id, never a fabricated
// name — an untitled document says so.

import type { Node as PMNode } from 'prosemirror-model';

export const UNTITLED = 'Untitled document';
const MAX_LEN = 80;

/** One line of text, collapsed to single spaces and capped at `MAX_LEN` with an ellipsis. */
function clip(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_LEN) return collapsed;
  return `${collapsed.slice(0, MAX_LEN - 1).trimEnd()}…`;
}

/**
 * The title a reader would give this document: the first heading's text, else the first block that
 * has any text at all, else `UNTITLED` for a document with no content yet. Blocks are walked in
 * document order and only the FIRST candidate of each kind counts — a later heading never overrides
 * an earlier one, matching how a reader's eye works.
 */
export function deriveTitle(doc: PMNode): string {
  let firstHeading: string | null = null;
  let firstText: string | null = null;
  doc.forEach((block) => {
    if (firstHeading !== null) return; // a heading already found is the answer; stop looking
    const text = block.textContent;
    if (text.trim() === '') return;
    if (block.type.name === 'heading' && firstHeading === null) firstHeading = clip(text);
    else if (firstText === null) firstText = clip(text);
  });
  return firstHeading ?? firstText ?? UNTITLED;
}
