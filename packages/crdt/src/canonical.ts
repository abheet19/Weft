// canonical.ts — the bytes two converged replicas must share. This file exists so "same
// document" is checkable: the Inspector hashes these bytes and compares them across replicas
// (design §3.5), and every property test asserts equality on them. The encoding is a JSON ARRAY
// of tuples — never an object — because an object key can be dropped, reordered or shadowed by
// a prototype without changing how it prints, and a hash that silently drops a key is the Zeno
// bug this project exists to not repeat. It must never depend on Map iteration order (only on the
// traversal), never include tombstones, and never include anything a user cannot see.

import type { Doc } from './doc.ts';
import { markValue, MARK_NAMES, VALUE_MARKS, type BlockAttrs, type Item } from './item.ts';
import { visibleItems } from './traverse.ts';

/** A boundary's canonical form: `['block', type, level|null]`, with a fourth `checked` element ONLY when a checklist item carries a tick — so a plain block's tuple is unchanged and byte-identical to before this slice. */
type CanonicalBlock = readonly ['block', string, number | null] | readonly ['block', string, number | null, boolean];

/** The content half of a canonical tuple: a bare string is a char; `['break']` is a soft break (E52); a `CanonicalBlock` is a boundary — three shapes JSON tells apart. */
type CanonicalContent = string | readonly ['break'] | CanonicalBlock;

/** An active value-carrying mark's `[name, value|null]`, sorted by name — the LWW value that must converge (a link's href, a colour's value). */
type CanonicalValue = readonly [string, string | null];

/** One visible item as a tuple: `[content, activeMarksSorted]`, plus the sorted `[name, value]` pairs of the active value-carrying marks (link, colours) as a third element when any is active. */
type CanonicalTuple = readonly [CanonicalContent, readonly string[]] | readonly [CanonicalContent, readonly string[], readonly CanonicalValue[]];

function blockContent(attrs: BlockAttrs): CanonicalBlock {
  const base = ['block', attrs.type, attrs.level ?? null] as const;
  return attrs.checked === undefined ? base : [...base, attrs.checked];
}

function tupleOf(item: Item): CanonicalTuple {
  const content: CanonicalContent = item.content.kind === 'char' ? item.content.text : item.content.kind === 'break' ? (['break'] as const) : blockContent(item.content.attrs);
  // MARK_NAMES is already in sorted order, so filtering it yields the sorted active set.
  const marks = MARK_NAMES.filter((name) => item.marks[name]?.active === true);
  // VALUE_MARKS is sorted; a value under LWW converges, so its inclusion here is what proves a colour
  // or an href agreed — an active value mark keeps its slot (value null when it carries none).
  const values: CanonicalValue[] = [];
  for (const name of VALUE_MARKS) {
    const state = item.marks[name];
    if (state?.active === true) values.push([name, markValue(name, state) ?? null]);
  }
  return values.length > 0 ? [content, marks, values] : [content, marks];
}

/** The bytes two converged replicas must share: visible chars, active marks, block attrs — as a JSON *array* (never an object, so no key can be silently dropped; see Zeno's __proto__ lesson). Deterministic. */
export function canonicalBytes(doc: Doc): Uint8Array<ArrayBuffer> {
  const tuples = visibleItems(doc).map(tupleOf);
  return new TextEncoder().encode(JSON.stringify(tuples));
}

/** The same content as a string, for tests and error messages. Equality of these strings is equality of the bytes. */
export function canonicalString(doc: Doc): string {
  return new TextDecoder().decode(canonicalBytes(doc));
}
