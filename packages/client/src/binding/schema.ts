// schema.ts — the ProseMirror schema for design §0 A1: a flat sequence of blocks (paragraph,
// heading 1–3, bullet item, quote), inline text with bold / italic / code / link. This file exists
// so the editor can only ever hold what the CRDT can express: no nesting, no tables, no images,
// and a bullet item is a block of its own rather than a list wrapper, because the CRDT's block
// boundary carries one BlockAttrs and nothing above it. It must never grow a node the CRDT has no
// boundary type for, and it holds no behaviour — marks are declared here so paste and S6 share one
// schema, but S3 exercises paragraphs and boundaries only.

import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from 'prosemirror-model';

const HEADING_LEVELS = [1, 2, 3] as const;

/** Link schemes allowed to reach the DOM (mirrors the protocol's wire allowlist, E28). A validator refuses others on the wire; this refuses them at RENDER too (LLD §8 S6), so a `javascript:` href stored locally before it is caught still renders inert. */
const SAFE_HREF_SCHEME = /^(?:https?:|mailto:)/i;

/** The href to put in the DOM: the original if its scheme is allowed, else `#` — never a `javascript:` (or `data:`) URL that would run on click. */
export function safeHref(href: unknown): string {
  return typeof href === 'string' && SAFE_HREF_SCHEME.test(href) ? href : '#';
}

/** A colour a mark may carry (E56): only a `#rrggbb`/`#rrggbbaa` hex reaches a `style` attribute, so no attacker-chosen string (`red;position:fixed…`) is ever rendered. Mirrors the protocol's `MARK_COLOR_RE`; a mismatch renders no colour at all. */
const MARK_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The colour to put in a `style`, or `null` when the value is not a safe hex (so `toDOM` omits the style rather than emit an unsafe one). */
export function safeColor(color: unknown): string | null {
  return typeof color === 'string' && MARK_COLOR.test(color) ? color : null;
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: (): DOMOutputSpec => ['p', 0],
  },
  heading: {
    attrs: { level: { default: 1 } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, 0],
  },
  // A bare <li>: the design has no nested lists, so there is no <ul> to wrap it (the page CSS
  // gives it the list indent instead).
  bullet_item: {
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'li:not([data-ordered]):not([data-check])' }],
    toDOM: (): DOMOutputSpec => ['li', 0],
  },
  // A numbered item (S6): another bare <li>, marked so the page CSS numbers it with a counter; still
  // no <ol> wrapper, because the CRDT boundary carries one BlockAttrs and nothing above it.
  ordered_item: {
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'li[data-ordered]' }],
    toDOM: (): DOMOutputSpec => ['li', { 'data-ordered': 'true' }, 0],
  },
  // A checklist item (S6): its `checked` is a COLLABORATIVE attribute — a `blk` register on the
  // boundary, LWW like a heading's `level` — so a tick made offline merges like any other edit.
  check_item: {
    attrs: { checked: { default: false } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'li[data-check]', getAttrs: (dom) => ({ checked: dom.getAttribute('data-checked') === 'true' }) }],
    toDOM: (node): DOMOutputSpec => ['li', { 'data-check': 'true', 'data-checked': node.attrs.checked === true ? 'true' : 'false' }, 0],
  },
  quote: {
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (): DOMOutputSpec => ['blockquote', 0],
  },
  // A code block (S6): LITERAL text — `marks: ''` forbids inline marks, `code`/`whitespace: 'pre'`
  // keep spaces and newlines. Content is `inline*` so a soft break survives as a token on both sides
  // (the binding strips any marks the CRDT still carries on a code block's chars, see tokens.ts).
  code_block: {
    content: 'inline*',
    group: 'block',
    marks: '',
    code: true,
    defining: true,
    whitespace: 'pre',
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (): DOMOutputSpec => ['pre', 0],
  },
  // A divider (S6): a content-less rule. In the CRDT it is a boundary that closes an EMPTY block, so
  // it is the one block with no inline content; a leaf here.
  divider: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: (): DOMOutputSpec => ['hr'],
  },
  text: { group: 'inline' },
  // A soft break inside a block (Shift+Enter, E52): an inline leaf, not a new block. The CRDT stores
  // it as a `break` content item; here it is the one non-text inline node the schema allows.
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },
};

const marks: Record<string, MarkSpec> = {
  bold: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
  italic: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', 0],
  },
  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }, { style: 'text-decoration-line=underline' }],
    toDOM: (): DOMOutputSpec => ['u', 0],
  },
  strikethrough: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }, { style: 'text-decoration-line=line-through' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },
  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM: (): DOMOutputSpec => ['mark', 0],
  },
  // A text colour (S6): a mark carrying a value under LWW, exactly as `link` carries `href`. Its value
  // reaches the DOM only through `safeColor`, so a non-hex value renders as no colour rather than an
  // arbitrary `style`.
  textColor: {
    attrs: { color: { default: '' } },
    parseDOM: [{ style: 'color', getAttrs: (value) => ({ color: safeColor(value) ?? '' }) }],
    toDOM: (mark): DOMOutputSpec => {
      const color = safeColor(mark.attrs.color);
      return color === null ? ['span', 0] : ['span', { style: `color:${color}` }, 0];
    },
  },
  highlightColor: {
    attrs: { color: { default: '' } },
    parseDOM: [{ style: 'background-color', getAttrs: (value) => ({ color: safeColor(value) ?? '' }) }],
    toDOM: (mark): DOMOutputSpec => {
      const color = safeColor(mark.attrs.color);
      return color === null ? ['span', 0] : ['span', { style: `background-color:${color}` }, 0];
    },
  },
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href') }) }],
    toDOM: (mark): DOMOutputSpec => ['a', { href: safeHref(mark.attrs.href) }, 0],
  },
};

export const schema = new Schema({ nodes, marks });
