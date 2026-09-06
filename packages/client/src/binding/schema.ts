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
    parseDOM: [{ tag: 'li' }],
    toDOM: (): DOMOutputSpec => ['li', 0],
  },
  quote: {
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (): DOMOutputSpec => ['blockquote', 0],
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
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href') }) }],
    toDOM: (mark): DOMOutputSpec => ['a', { href: safeHref(mark.attrs.href) }, 0],
  },
};

export const schema = new Schema({ nodes, marks });
