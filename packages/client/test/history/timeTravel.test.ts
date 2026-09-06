// timeTravel.test.ts — the time-travel replay of S7 (03-UI §4.6). Time travel is a PURE fold, so
// the property is a definition check: for any op log this replica could apply, `replayTo(∅, ops, n)`
// equals `applyAll(∅, ops[0..n])` on canonical bytes at every position, the slider position maps to
// the right prefix (0 is empty, length is live), and a fractional or out-of-range slider value is
// clamped rather than throwing. The adversarial case: a 100 000-op log scrubs at several positions
// within a budget, so the History slider never freezes the page (LLD §8 S7).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyAll, canonicalString, emptyDoc, localDelete, localInsert, localSetBlock, ROOT, visibleItems, type BlockAttrs, type Content, type Op, type ReplicaId } from '@weft/crdt';
import { clampPosition, replayTo } from '../../src/history/timeTravel.ts';

const numRuns = process.env['CI'] ? 1_000 : 200;

type Intent = { kind: 'ins'; pos: number; ch: string } | { kind: 'del'; pos: number; len: number } | { kind: 'blk'; pos: number; attrs: BlockAttrs };

const arbAttrs = fc.constantFrom<BlockAttrs>({ type: 'paragraph' }, { type: 'heading', level: 1 }, { type: 'bullet' }, { type: 'quote' });
const arbIntent: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('ins' as const), pos: fc.nat({ max: 200 }), ch: fc.constantFrom('a', 'b', 'c', ' ', '𝄞') }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('del' as const), pos: fc.nat({ max: 200 }), len: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('blk' as const), pos: fc.nat({ max: 200 }), attrs: arbAttrs }) },
);

const me = 'bcdefghijklmn' as ReplicaId;

/** Build a real op log by performing intents against an evolving single-replica doc, so every op applies. */
function buildLog(intents: readonly Intent[]): readonly Op[] {
  let doc = emptyDoc();
  let seq = 0;
  const log: Op[] = [];
  const emit = (r: { ops: readonly Op[]; doc: typeof doc }): void => {
    doc = r.doc;
    seq += r.ops.length;
    log.push(...r.ops);
  };
  for (const intent of intents) {
    const len = visibleItems(doc).length;
    if (intent.kind === 'ins') emit(localInsert(doc, me, seq + 1, intent.pos % (len + 1), { kind: 'char', text: intent.ch } as Content));
    else if (intent.kind === 'del') {
      if (len === 0) continue;
      const from = intent.pos % len;
      emit(localDelete(doc, me, seq + 1, from, Math.min(len, from + intent.len)));
    } else {
      // Only a block closed by a real boundary can be retyped; the trailing block (closed by ROOT) throws.
      try {
        if (len === 0) continue;
        emit(localSetBlock(doc, me, seq + 1, intent.pos % len, intent.attrs));
      } catch {
        continue;
      }
    }
  }
  return log;
}

describe('clampPosition', () => {
  it('rounds and clamps a slider value to a real prefix 0..length', () => {
    expect(clampPosition(-3, 10)).toBe(0);
    expect(clampPosition(4.7, 10)).toBe(4);
    expect(clampPosition(99, 10)).toBe(10);
    expect(clampPosition(Number.NaN, 10)).toBe(10); // a broken slider reads as live, not as position 0
    expect(clampPosition(0, 0)).toBe(0);
  });
});

describe('replayTo — fold(apply, ∅, ops[0..n])', () => {
  it('equals applyAll(∅, ops[0..n]) at every position for a random op log, and the endpoints are empty and live', () => {
    fc.assert(
      fc.property(fc.array(arbIntent, { maxLength: 60 }), (intents) => {
        const log = buildLog(intents);
        const live = applyAll(emptyDoc(), log).doc;
        for (let n = 0; n <= log.length; n++) {
          const replayed = replayTo(emptyDoc(), log, n);
          expect(canonicalString(replayed)).toBe(canonicalString(applyAll(emptyDoc(), log.slice(0, n)).doc));
        }
        // Position 0 is the empty base; the last position is the live document.
        expect(visibleItems(replayTo(emptyDoc(), log, 0)).length).toBe(0);
        expect(canonicalString(replayTo(emptyDoc(), log, log.length))).toBe(canonicalString(live));
      }),
      { numRuns, seed: 0x5eed },
    );
  });

  it('the slider position maps to the right prefix: replayTo at n shows exactly the first n typed characters', () => {
    const log = buildLog([...'hello world'].map((ch, i) => ({ kind: 'ins' as const, pos: i, ch })));
    const textAt = (n: number): string =>
      visibleItems(replayTo(emptyDoc(), log, n))
        .map((it) => (it.content.kind === 'char' ? it.content.text : '▮'))
        .join('');
    expect(textAt(0)).toBe('');
    expect(textAt(5)).toBe('hello');
    expect(textAt(11)).toBe('hello world');
  });
});

describe('adversarial (LLD §8 S7): a 100 000-op log scrubs without freezing', () => {
  it('replays several slider positions of a 100 000-op log within budget and the end equals the live document', () => {
    const N = 100_000;
    const ops: Op[] = [];
    let parent = ROOT.id;
    for (let i = 1; i <= N; i++) {
      const id = { replica: me, seq: i };
      ops.push({ t: 'ins', id, parent, side: 'R', content: { kind: 'char', text: 'a' } });
      parent = id; // a right-leaning chain: forward typing, built without a per-char traversal
    }
    const started = Date.now();
    for (const n of [0, 25_000, 50_000, 75_000, N]) {
      const doc = replayTo(emptyDoc(), ops, n);
      expect(visibleItems(doc).length).toBe(n);
    }
    // Five folds over a 100 000-op log; a frozen or O(n²) replay would blow far past this.
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
