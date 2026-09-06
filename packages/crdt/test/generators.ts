// generators.ts — the fast-check arbitraries of LLD §6.1. Intents carry raw naturals, not indexes:
// `perform` resolves them against the replica's doc at the moment they run, so every intent is
// valid against that replica's evolving document and shrinking still works (smaller naturals →
// smaller indexes). Content draws from the alphabet 'abcd ' plus one astral char and, one time in
// five, a block boundary.
import fc from 'fast-check';
import { buildIndex, ROOT_KEY, idKey, type BlockAttrs, type MarkName } from '../src/index.ts';
import { block, brk, char, type Replica } from './helpers.ts';

export type IntentContent = { kind: 'char'; text: string } | { kind: 'block'; attrs: BlockAttrs } | { kind: 'break' };

export type Intent =
  | { kind: 'insert'; pos: number; content: IntentContent }
  | { kind: 'delete'; pos: number; len: number }
  | { kind: 'format'; pos: number; len: number; mark: MarkName; active: boolean }
  | { kind: 'setBlock'; pos: number; attrs: BlockAttrs };

export const arbBlockAttrs: fc.Arbitrary<BlockAttrs> = fc.constantFrom<BlockAttrs>(
  { type: 'paragraph' },
  { type: 'heading', level: 1 },
  { type: 'heading', level: 2 },
  { type: 'heading', level: 3 },
  { type: 'bullet' },
  { type: 'ordered' },
  { type: 'check' },
  { type: 'check', checked: true },
  { type: 'check', checked: false },
  { type: 'quote' },
  { type: 'code' },
  { type: 'divider' },
);

export const arbMark: fc.Arbitrary<MarkName> = fc.constantFrom<MarkName>('bold', 'italic', 'code', 'link', 'underline', 'strikethrough', 'highlight', 'textColor', 'highlightColor');

export const arbContent: fc.Arbitrary<IntentContent> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('a', 'b', 'c', 'd', ' ', '𝄞').map((text) => ({ kind: 'char', text }) as IntentContent) },
  { weight: 1, arbitrary: arbBlockAttrs.map((attrs) => ({ kind: 'block', attrs }) as IntentContent) },
  { weight: 1, arbitrary: fc.constant({ kind: 'break' } as IntentContent) },
);

const nat = fc.nat({ max: 999 });

export const arbIntent: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('insert' as const), pos: nat, content: arbContent }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), pos: nat, len: fc.integer({ min: 1, max: 5 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('format' as const), pos: nat, len: fc.integer({ min: 1, max: 6 }), mark: arbMark, active: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('setBlock' as const), pos: nat, attrs: arbBlockAttrs }) },
);

/** Per replica, 0..40 intents (LLD §6.1 arbScript). */
export const arbScript: fc.Arbitrary<Intent[]> = fc.array(arbIntent, { maxLength: 40 });

/** A partition schedule: segments of `rounds` rounds where replicas sharing a group label can talk. The test heals fully afterwards. */
export const arbSchedule = fc.array(
  fc.record({
    groups: fc.array(fc.nat({ max: 3 }), { minLength: 4, maxLength: 4 }),
    rounds: fc.integer({ min: 1, max: 8 }),
  }),
  { maxLength: 6 },
);

/** Run one intent against a replica's current doc. Returns false when the intent had nothing to act on (empty doc, no typeable block). */
export function perform(rep: Replica, intent: Intent): boolean {
  const len = rep.length();
  switch (intent.kind) {
    case 'insert': {
      const content = intent.content.kind === 'char' ? char(intent.content.text) : intent.content.kind === 'break' ? brk() : block(intent.content.attrs, rep.me, 0);
      rep.insert(intent.pos % (len + 1), content);
      return true;
    }
    case 'delete': {
      if (len === 0) return false;
      const from = intent.pos % len;
      rep.delete(from, Math.min(len, from + intent.len));
      return true;
    }
    case 'format': {
      if (len === 0) return false;
      const from = intent.pos % len;
      // A value-carrying mark gets a value so its LWW-on-value is exercised: an href for a link, a
      // colour for a colour mark. Two distinct colours are drawn (by pos) so concurrent writers race.
      const value = intent.mark === 'link' ? 'https://example.test/' : intent.mark === 'textColor' || intent.mark === 'highlightColor' ? (intent.pos % 2 === 0 ? '#0e8ea0' : '#c77d16') : undefined;
      rep.format(from, Math.min(len, from + intent.len), intent.mark, intent.active, value);
      return true;
    }
    case 'setBlock': {
      const ranges = buildIndex(rep.doc)
        .blockRanges()
        .filter((r) => idKey(r.boundary) !== ROOT_KEY);
      const range = ranges[intent.pos % Math.max(1, ranges.length)];
      if (range === undefined) return false;
      rep.setBlock(range.to, intent.attrs);
      return true;
    }
  }
}
