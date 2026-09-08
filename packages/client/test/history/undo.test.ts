// undo.test.ts — local-only undo/redo as an inverse-op stack (design §0 A3, LLD §7 S7). The
// orchestration these tests drive — record a user action, undo (invert against the current doc, move
// to redo), redo (mirror) — is exactly the runner's, so proving it here proves the runner's undo. The
// invariants, each a property or a named example:
//   • undo/redo of every op kind (insert, delete, format, block) round-trips the visible text;
//   • undo NEVER emits an op touching a peer's item — every `del` it emits targets an item THIS
//     replica authored, and every re-insert mints a NEW id (I6: no resurrection) — over random
//     interleavings of my ops and a peer's;
//   • undo of a local insert a peer already deleted is a no-op (the char is gone, not resurrected);
//   • an empty undo stack is a no-op, and redo mirrors undo.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apply, emptyDoc, localDelete, localFormat, localInsert, localSetBlock, visibleItems, type BlockAttrs, type Doc, type Op, type ReplicaId } from '@weft/crdt';
import { emptyHistory, recordUser, redo, undo, type UndoHistory } from '../../src/history/undo.ts';

const ME = 'bcdefghijklmn' as ReplicaId;
const PEER = 'cdefghijklmno' as ReplicaId;
const numRuns = process.env['CI'] ? 1_000 : 200;

const textOf = (doc: Doc): string =>
  visibleItems(doc)
    .map((it) => (it.content.kind === 'char' ? it.content.text : it.content.kind === 'break' ? '⏎' : '▮'))
    .join('');

/** A tiny driver mirroring the runner: `me`'s doc, its next seq, and its undo/redo stacks. */
class Local {
  doc = emptyDoc();
  seq = 0;
  history: UndoHistory = emptyHistory;
  readonly emitted: Op[] = []; // every op undo/redo emitted, for the "never a peer's item" assertion

  /** A user edit: apply, and record how to invert it (a new edit clears redo). */
  user(edit: (doc: Doc, me: ReplicaId, nextSeq: number) => { ops: readonly Op[]; doc: Doc }): void {
    const before = this.doc;
    const { ops, doc } = edit(this.doc, ME, this.seq + 1);
    this.history = recordUser(this.history, before, ops);
    this.doc = doc;
    this.seq += ops.length;
  }

  undo(): void {
    const r = undo(this.history, this.doc, ME, this.seq + 1);
    if (r === null) return;
    this.history = r.history;
    this.doc = r.doc;
    this.seq += r.ops.length;
    this.emitted.push(...r.ops);
  }

  redo(): void {
    const r = redo(this.history, this.doc, ME, this.seq + 1);
    if (r === null) return;
    this.history = r.history;
    this.doc = r.doc;
    this.seq += r.ops.length;
    this.emitted.push(...r.ops);
  }

  /** A peer op arrives (applied like the runner's inbound). */
  receive(op: Op): void {
    const r = apply(this.doc, op);
    if (r.kind === 'applied' || r.kind === 'pending') this.doc = r.doc;
  }
}

describe('undo/redo round-trips the visible text of every op kind', () => {
  it('an insert', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'char', text: 'b' }));
    expect(textOf(l.doc)).toBe('ab');
    l.undo();
    expect(textOf(l.doc)).toBe('a');
    l.redo();
    expect(textOf(l.doc)).toBe('ab');
    l.undo();
    l.undo();
    expect(textOf(l.doc)).toBe('');
  });

  it('a delete re-inserts the same text (with a new id) and redo removes it again', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'char', text: 'b' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 2, { kind: 'char', text: 'c' }));
    l.user((doc, me, seq) => localDelete(doc, me, seq, 0, 2)); // delete "ab"
    expect(textOf(l.doc)).toBe('c');
    l.undo();
    expect(textOf(l.doc)).toBe('abc'); // order preserved
    l.redo();
    expect(textOf(l.doc)).toBe('c');
  });

  it('a format toggles back, and a block type reverts', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'char', text: 'b' }));
    l.user((doc, me, seq) => localFormat(doc, me, seq, 0, 2, 'bold', true));
    const bold = (doc: Doc): boolean => visibleItems(doc).every((it) => it.marks.bold?.active === true);
    expect(bold(l.doc)).toBe(true);
    l.undo();
    expect(bold(l.doc)).toBe(false); // the mark is restored to its previous (absent) state
    l.redo();
    expect(bold(l.doc)).toBe(true);

    // A block change on a real boundary: insert a boundary, type in the first block, retype it.
    const l2 = new Local();
    l2.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'x' }));
    l2.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'block', attrs: { type: 'paragraph' }, lamport: 1, replica: me }));
    l2.user((doc, me, seq) => localSetBlock(doc, me, seq, 0, { type: 'heading', level: 1 } as BlockAttrs));
    const firstAttrs = (doc: Doc): BlockAttrs => (visibleItems(doc).find((it) => it.content.kind === 'block')?.content as { attrs: BlockAttrs }).attrs;
    expect(firstAttrs(l2.doc).type).toBe('heading');
    l2.undo();
    expect(firstAttrs(l2.doc).type).toBe('paragraph');
    l2.redo();
    expect(firstAttrs(l2.doc).type).toBe('heading');
  });

  it('a link format (with an href) reverts to unlinked and redo restores the href', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'char', text: 'b' }));
    l.user((doc, me, seq) => localFormat(doc, me, seq, 0, 2, 'link', true, 'https://example.test/'));
    const href = (doc: Doc): string | undefined => visibleItems(doc)[0]?.marks.link?.href;
    expect(href(l.doc)).toBe('https://example.test/');
    l.undo();
    expect(visibleItems(l.doc)[0]?.marks.link?.active).toBe(false);
    l.redo();
    expect(href(l.doc)).toBe('https://example.test/');
  });

  it('deleting a block boundary and undoing re-inserts a boundary (a new one, never the tombstone) so the blocks split again', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 1, { kind: 'block', attrs: { type: 'paragraph' }, lamport: 1, replica: me }));
    l.user((doc, me, seq) => localInsert(doc, me, seq, 2, { kind: 'char', text: 'b' }));
    expect(textOf(l.doc)).toBe('a▮b');
    l.user((doc, me, seq) => localDelete(doc, me, seq, 1, 2)); // delete the boundary — the blocks merge
    expect(textOf(l.doc)).toBe('ab');
    l.undo();
    expect(textOf(l.doc)).toBe('a▮b'); // the boundary is back (a fresh item)
  });
});

describe('undo never touches a peer’s item (I6: no resurrection)', () => {
  it('undo of a local insert a peer already deleted is a no-op — the char stays gone', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    const myId = { replica: ME, seq: 1 };
    // The peer deletes my character.
    l.receive({ t: 'del', id: { replica: PEER, seq: 1 }, target: myId });
    expect(textOf(l.doc)).toBe('');
    l.undo(); // must not resurrect
    expect(textOf(l.doc)).toBe('');
    expect(l.emitted).toEqual([]);
    // The tombstoned id is never re-used.
    expect(l.doc.items.get(`${ME}:1`)?.deleted).toBe(true);
  });

  it('a re-inserted (undone-delete) item has a NEW id, never the tombstoned one', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localDelete(doc, me, seq, 0, 1));
    l.undo(); // re-inserts "a"
    const live = visibleItems(l.doc);
    expect(live.map((it) => (it.content.kind === 'char' ? it.content.text : '?')).join('')).toBe('a');
    expect(live[0]?.id.seq).not.toBe(1); // not the original id:1
    expect(l.doc.items.get(`${ME}:1`)?.deleted).toBe(true); // the original stays a tombstone
  });

  it('over random interleavings of my ops and a peer’s, every undo op is mine and no del targets a peer’s item', () => {
    type Step = { who: 'me' | 'peer'; kind: 'ins' | 'del'; pos: number; len: number; ch: string };
    const arbStep: fc.Arbitrary<Step> = fc.record({
      who: fc.constantFrom<'me' | 'peer'>('me', 'peer'),
      kind: fc.constantFrom<'ins' | 'del'>('ins', 'ins', 'ins', 'del'),
      pos: fc.nat({ max: 40 }),
      len: fc.integer({ min: 1, max: 3 }),
      ch: fc.constantFrom('a', 'b', 'c', 'd'),
    });
    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 30 }), (steps) => {
        const l = new Local();
        let peerSeq = 0;
        for (const step of steps) {
          const len = visibleItems(l.doc).length;
          if (step.who === 'me') {
            if (step.kind === 'ins') l.user((doc, me, seq) => localInsert(doc, me, seq, step.pos % (len + 1), { kind: 'char', text: step.ch }));
            else if (len > 0) l.user((doc, me, seq) => localDelete(doc, me, seq, step.pos % len, Math.min(len, (step.pos % len) + step.len)));
          } else {
            // The peer inserts its own char (at the end, a legal place) or deletes a visible item.
            if (step.kind === 'ins' || len === 0) {
              const built = localInsert(l.doc, PEER, peerSeq + 1, len, { kind: 'char', text: step.ch });
              peerSeq += built.ops.length;
              for (const op of built.ops) l.receive(op);
            } else {
              const target = visibleItems(l.doc)[step.pos % len]!.id;
              l.receive({ t: 'del', id: { replica: PEER, seq: ++peerSeq }, target });
            }
          }
        }
        // Undo everything I did, then redo everything back.
        while (l.history.undo.length > 0) l.undo();
        while (l.history.redo.length > 0) l.redo();
        // Every op undo/redo emitted is mine; no `del` it emitted targets a peer-authored item; no ins reuses an id.
        const seenIns = new Set<string>();
        for (const op of l.emitted) {
          expect(op.id.replica).toBe(ME);
          if (op.t === 'del') expect(op.target.replica).toBe(ME);
          if (op.t === 'ins') {
            const key = `${op.id.replica}:${op.id.seq}`;
            expect(seenIns.has(key)).toBe(false);
            seenIns.add(key);
          }
        }
      }),
      { numRuns, seed: 0x5eed },
    );
  });
});

describe('denied paths', () => {
  it('undo with an empty stack is a no-op, and so is redo', () => {
    const l = new Local();
    l.undo();
    l.redo();
    expect(textOf(l.doc)).toBe('');
    expect(l.emitted).toEqual([]);
  });

  it('a new edit after an undo clears the redo stack (history branches)', () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.undo();
    expect(l.history.redo.length).toBe(1);
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'b' }));
    expect(l.history.redo.length).toBe(0);
  });
});
for (const mark of ['textColor', 'highlightColor'] as const) {
  it(`undo and redo restore the value of ${mark}`, () => {
    const l = new Local();
    l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'char', text: 'a' }));
    l.user((doc, me, seq) => localFormat(doc, me, seq, 0, 1, mark, true, 'red'));
    l.user((doc, me, seq) => localFormat(doc, me, seq, 0, 1, mark, true, 'blue'));
    l.undo();
    expect(visibleItems(l.doc)[0]?.marks[mark]?.value).toBe('red');
    l.redo();
    expect(visibleItems(l.doc)[0]?.marks[mark]?.value).toBe('blue');
  });
}
it('undo preserves the checked state of a deleted checklist boundary', () => {
  const l = new Local();
  l.user((doc, me, seq) => localInsert(doc, me, seq, 0, { kind: 'block', attrs: { type: 'check', checked: true }, lamport: 0, replica: me }));
  l.user((doc, me, seq) => localDelete(doc, me, seq, 0, 1));
  l.undo();
  const restored = visibleItems(l.doc)[0]?.content;
  expect(restored?.kind === 'block' && restored.attrs.checked).toBe(true);
});
