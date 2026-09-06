// @vitest-environment jsdom
// binding.mirror.prop.test.ts — invariant I7 as a property. Two editors, each bound to its own
// in-memory replica, take a random script of local ProseMirror transactions — typing (astral
// characters included), deleting ranges, Enter mid-paragraph (through the binding's own Enter, so
// bullets and quotes continue), Backspace at a block start (joins, including into headings), block-
// type changes over a range, pasting several paragraphs — interleaved with deliveries of each
// other's ops in either direction. After every step both editors mirror their CRDT (text equal,
// block structure the normal form, no fault); after the final exchange both replicas share one
// canonical byte string and both editors show one document. Runs 100 scripts locally and 1 000
// under CI=1: each script mounts two real editor views, so the crdt's 10 000 would take longer
// than the whole suite is worth.
import fc from 'fast-check';
import { chainCommands, joinBackward, setBlockType, splitBlock, toggleMark } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { enterInListBlock } from '../../src/binding/keymap.ts';
import { schema } from '../../src/binding/schema.ts';
import { exchange, expectMirror, expectSynced, hashOf, MemoryHost, mount, numRuns, pasteText, R, textOfPm, textPositions, tick, unmount, type Mounted } from './helpers.ts';

const ALPHABET = ['a', 'b', ' ', '𝄞', '\u{1F469}', '‍', 'é'];
const BLOCK_TYPES = ['paragraph', 'heading', 'bullet_item', 'quote'] as const;
const MARKS = ['bold', 'italic', 'code', 'link'] as const;

type Action =
  | { who: 0 | 1; kind: 'type'; at: number; text: string }
  | { who: 0 | 1; kind: 'delete'; from: number; to: number }
  | { who: 0 | 1; kind: 'enter'; at: number }
  | { who: 0 | 1; kind: 'break'; at: number }
  | { who: 0 | 1; kind: 'backspaceStart'; block: number }
  | { who: 0 | 1; kind: 'setType'; from: number; to: number; type: (typeof BLOCK_TYPES)[number] }
  | { who: 0 | 1; kind: 'mark'; from: number; to: number; mark: (typeof MARKS)[number] }
  | { who: 0 | 1; kind: 'paste'; at: number; text: string }
  | { kind: 'deliver'; direction: 'ab' | 'ba' | 'both' };

const who = fc.constantFrom<0 | 1>(0, 1);
const nat = fc.nat({ max: 500 });
const arbAction: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ who, kind: fc.constant('type' as const), at: nat, text: fc.array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 4 }).map((cs) => cs.join('')) }) },
  { weight: 3, arbitrary: fc.record({ who, kind: fc.constant('delete' as const), from: nat, to: nat }) },
  { weight: 2, arbitrary: fc.record({ who, kind: fc.constant('enter' as const), at: nat }) },
  { weight: 1, arbitrary: fc.record({ who, kind: fc.constant('break' as const), at: nat }) },
  { weight: 2, arbitrary: fc.record({ who, kind: fc.constant('backspaceStart' as const), block: nat }) },
  { weight: 2, arbitrary: fc.record({ who, kind: fc.constant('setType' as const), from: nat, to: nat, type: fc.constantFrom(...BLOCK_TYPES) }) },
  { weight: 3, arbitrary: fc.record({ who, kind: fc.constant('mark' as const), from: nat, to: nat, mark: fc.constantFrom(...MARKS) }) },
  { weight: 1, arbitrary: fc.record({ who, kind: fc.constant('paste' as const), at: nat, text: fc.constantFrom('p\nq', 'x\n\ny 𝄞\nz', '\n') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('deliver' as const), direction: fc.constantFrom<'ab' | 'ba' | 'both'>('ab', 'ba', 'both') }) },
);

/** The shell's Enter: the binding's command first, the base keymap's splitBlock behind it. */
const enter = chainCommands(enterInListBlock, splitBlock);
const arbScript = fc.array(arbAction, { maxLength: 30 });

/** A raw natural becomes a cursor position valid in THIS document, so shrinking still yields valid scripts. */
function cursor(m: Mounted, raw: number): number {
  const positions = textPositions(m.view.state.doc);
  return positions[raw % positions.length] as number;
}

function perform(m: Mounted, action: Exclude<Action, { kind: 'deliver' }>): void {
  const { view } = m;
  switch (action.kind) {
    case 'type':
      view.dispatch(view.state.tr.insertText(action.text, cursor(m, action.at)));
      return;
    case 'delete': {
      const [from, to] = [cursor(m, action.from), cursor(m, action.to)].sort((x, y) => x - y) as [number, number];
      if (from !== to) view.dispatch(view.state.tr.deleteRange(from, to));
      return;
    }
    case 'enter':
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor(m, action.at))));
      enter(view.state, view.dispatch);
      return;
    case 'break': {
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor(m, action.at)));
      view.dispatch(tr.replaceSelectionWith(schema.nodes.hard_break!.create()));
      return;
    }
    case 'mark': {
      const [from, to] = [cursor(m, action.from), cursor(m, action.to)].sort((x, y) => x - y) as [number, number];
      if (from === to) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      toggleMark(schema.marks[action.mark]!, action.mark === 'link' ? { href: 'https://example.test/' } : null)(view.state, view.dispatch);
      return;
    }
    case 'setType': {
      const [from, to] = [cursor(m, action.from), cursor(m, action.to)].sort((x, y) => x - y) as [number, number];
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      setBlockType(schema.nodes[action.type]!, action.type === 'heading' ? { level: 2 } : null)(view.state, view.dispatch);
      return;
    }
    case 'backspaceStart': {
      const block = action.block % view.state.doc.childCount;
      let pos = 1;
      for (let i = 0; i < block; i++) pos += view.state.doc.child(i).nodeSize;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
      joinBackward(view.state, view.dispatch);
      return;
    }
    case 'paste':
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor(m, action.at))));
      pasteText(m, action.text);
      return;
  }
}

async function deliver(a: MemoryHost, b: MemoryHost, direction: 'ab' | 'ba' | 'both'): Promise<void> {
  if (direction === 'both') return exchange(a, b);
  const [from, to] = direction === 'ab' ? [a, b] : [b, a];
  const ops = from.pull();
  if (ops.length > 0) to.receive(ops);
  await tick();
}

describe('I7 — editor mirror', () => {
  it('holds on both editors after every local transaction and every delivery, and both replicas converge at the end', async () => {
    await fc.assert(
      fc.asyncProperty(arbScript, async (script) => {
        const editors: [Mounted, Mounted] = [mount(new MemoryHost(R.a)), mount(new MemoryHost(R.b))];
        try {
          for (const action of script) {
            if (action.kind === 'deliver') await deliver(editors[0].host, editors[1].host, action.direction);
            else perform(editors[action.who], action);
            for (const m of editors) expectMirror(m);
          }
          await exchange(editors[0].host, editors[1].host);
          await exchange(editors[0].host, editors[1].host); // ops generated during the first sync's tick, if any
          for (const m of editors) expectSynced(m);
          expect(hashOf(editors[0].host.doc)).toBe(hashOf(editors[1].host.doc));
          expect(textOfPm(editors[0].view.state.doc)).toBe(textOfPm(editors[1].view.state.doc));
          expect(editors[0].view.state.doc.eq(editors[1].view.state.doc)).toBe(true);
        } finally {
          for (const m of editors) unmount(m);
        }
      }),
      { numRuns: numRuns(true) },
    );
    // Remote changes are paced per animation frame (E49), so every delivery costs a jsdom frame (~16 ms): 1 000 scripts under CI=1 need more than the suite's 120 s default.
  }, 900_000);
});
