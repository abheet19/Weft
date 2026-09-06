// generators.ts — fast-check arbitraries for well-formed wire messages, used by the round-trip
// property (everything `encode` produces, `decode` accepts). Sizes are kept small enough that an
// encoded message stays under LIMITS.MAX_MESSAGE_BYTES, so a rejection in the property is a
// validator bug and never a size effect. The self-reference and authorship rules are enforced by
// construction here; the denied-path tests break them on purpose.
import fc from 'fast-check';
import type { BlockAttrs, ClientMessage, Content, ItemAnchor, ItemContent, ItemId, MarkState, Op, PresenceState, ReplicaId, ServerMessage, Snapshot, SnapshotItem, StateVector } from '../src/index.ts';
import { ERROR_CODES, LIMITS } from '../src/index.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const ROOT_ID: ItemId = { replica: 'aaaaaaaaaaaaa' as ReplicaId, seq: 0 };

/** A replica id that is never the root's (all 'a'): the first character is drawn from the rest of the alphabet. */
export const arbReplica: fc.Arbitrary<ReplicaId> = fc
  .tuple(fc.constantFrom(...BASE32.slice(1)), fc.array(fc.constantFrom(...BASE32), { minLength: 12, maxLength: 12 }))
  .map(([head, tail]) => (head + tail.join('')) as ReplicaId);

/** A real item id: seq ≥ 1. Replicas are drawn from a small pool so ids collide often enough to exercise the self-reference rules. */
const arbPoolReplica: fc.Arbitrary<ReplicaId> = fc.constantFrom('bcdefghijklmn', 'cdefghijklmno', 'defghijklmnop').map((s) => s as ReplicaId);
export const arbItemId: fc.Arbitrary<ItemId> = fc.record({ replica: arbPoolReplica, seq: fc.integer({ min: 1, max: 1_000_000 }) });

/** Something an op may depend on: an item, or the root. */
const arbDependency: fc.Arbitrary<ItemId> = fc.oneof({ weight: 5, arbitrary: arbItemId }, { weight: 1, arbitrary: fc.constant(ROOT_ID) });

export const arbBlockAttrs: fc.Arbitrary<BlockAttrs> = fc.constantFrom<BlockAttrs>(
  { type: 'paragraph' },
  { type: 'heading', level: 1 },
  { type: 'heading', level: 2 },
  { type: 'heading', level: 3 },
  { type: 'bullet' },
  { type: 'quote' },
);

/** One code point: a BMP char or an astral one (a surrogate pair on the wire). */
export const arbCodePoint: fc.Arbitrary<string> = fc.oneof(fc.constantFrom('a', 'Z', ' ', '€', 'é', '中'), fc.constant('𝄞'), fc.constant('😀'));

const arbLamport = fc.integer({ min: 0, max: LIMITS.MAX_LAMPORT });

/** Content of an `ins` written by `author`: the block seed's replica is the author's. */
function arbContentBy(author: ReplicaId): fc.Arbitrary<Content> {
  return fc.oneof(
    { weight: 4, arbitrary: arbCodePoint.map((text) => ({ kind: 'char', text }) as Content) },
    { weight: 1, arbitrary: fc.record({ attrs: arbBlockAttrs, lamport: arbLamport }).map((r) => ({ kind: 'block', ...r, replica: author }) as Content) },
    { weight: 1, arbitrary: fc.constant({ kind: 'break' } as Content) },
  );
}

const arbMark = fc.constantFrom('bold', 'italic', 'code', 'link' as const);

function notSelf(own: ItemId): (dep: ItemId) => boolean {
  return (dep) => dep.replica !== own.replica || dep.seq !== own.seq;
}

export const arbOp: fc.Arbitrary<Op> = arbItemId.chain((id) =>
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .record({ parent: arbDependency.filter(notSelf(id)), side: fc.constantFrom('L', 'R' as const), content: arbContentBy(id.replica) })
        .map((r) => ({ t: 'ins', id, ...r, side: r.parent.seq === 0 ? 'R' : r.side }) as Op),
    },
    { weight: 2, arbitrary: arbItemId.filter(notSelf(id)).map((target) => ({ t: 'del', id, target }) as Op) },
    {
      weight: 1,
      arbitrary: fc
        .record({
          targets: fc.array(arbItemId.filter(notSelf(id)), { minLength: 1, maxLength: 8 }),
          mark: arbMark,
          active: fc.boolean(),
          lamport: arbLamport,
          href: fc.option(fc.webUrl(), { nil: undefined }),
        })
        // E28: an href travels only on a link.
        .map(({ href, ...rest }) => (href === undefined || rest.mark !== 'link' ? { t: 'fmt', id, ...rest } : { t: 'fmt', id, ...rest, href }) as Op),
    },
    { weight: 1, arbitrary: fc.record({ target: arbItemId.filter(notSelf(id)), attrs: arbBlockAttrs, lamport: arbLamport }).map((r) => ({ t: 'blk', id, ...r }) as Op) },
  ),
);

export const arbOps: fc.Arbitrary<Op[]> = fc.array(arbOp, { minLength: 1, maxLength: 40 });

export const arbStateVector: fc.Arbitrary<StateVector> = fc.dictionary(arbReplica, fc.nat({ max: 1_000_000 }), { maxKeys: 6 }).map((d) => d as StateVector);

const arbAnchor: fc.Arbitrary<ItemAnchor> = fc.record({ id: fc.option(arbDependency, { nil: null }), side: fc.constantFrom('before', 'after' as const) });

const arbName = fc.stringMatching(/^[A-Za-z0-9 ._-]{1,40}$/);
const arbHash = fc.stringMatching(/^[0-9a-f]{64}$/);

export const arbPresenceState: fc.Arbitrary<PresenceState> = fc
  .record({
    name: arbName,
    color: fc.integer({ min: 0, max: LIMITS.MAX_PRESENCE_COLOR }),
    cursor: fc.option(fc.record({ anchor: arbAnchor, head: arbAnchor }), { nil: undefined }),
    hash: fc.option(arbHash, { nil: undefined }),
    sv: fc.option(arbStateVector, { nil: undefined }),
  })
  .map(({ cursor, hash, sv, ...rest }) => ({ ...rest, ...(cursor === undefined ? {} : { cursor }), ...(hash === undefined ? {} : { hash }), ...(sv === undefined ? {} : { sv }) }));

const arbDocId = fc.stringMatching(/^[a-z0-9-]{8,64}$/);

export const arbClientMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({ doc: arbDocId, replica: arbReplica, sv: arbStateVector }).map((r) => ({ v: 1, t: 'hello', ...r }) as ClientMessage),
  arbOps.map((ops) => ({ v: 1, t: 'ops', ops }) as ClientMessage),
  fc.option(arbPresenceState, { nil: null }).map((state) => ({ v: 1, t: 'presence', state }) as ClientMessage),
  fc.constant({ v: 1, t: 'ping' } as ClientMessage),
);

/** A mark register; `link` marks may carry an href, others never do (E28). */
const arbMarkState: fc.Arbitrary<MarkState> = fc.record({ active: fc.boolean(), lamport: arbLamport, replica: arbReplica, seq: fc.integer({ min: 1, max: 1000 }) });
const arbLinkState: fc.Arbitrary<MarkState> = fc.tuple(arbMarkState, fc.option(fc.webUrl(), { nil: undefined })).map(([m, href]) => (href === undefined ? m : { ...m, href }));

/** Content as a snapshot item stores it; a deleted character travels with its text stripped, exactly as encodeSnapshot writes it. */
function arbItemContent(deleted: boolean): fc.Arbitrary<ItemContent> {
  return fc.oneof(
    { weight: 4, arbitrary: (deleted ? fc.constant('') : arbCodePoint).map((text) => ({ kind: 'char', text }) as ItemContent) },
    { weight: 1, arbitrary: fc.record({ attrs: arbBlockAttrs, lamport: arbLamport, replica: arbReplica, seq: fc.integer({ min: 1, max: 1000 }) }).map((r) => ({ kind: 'block', ...r }) as ItemContent) },
    { weight: 1, arbitrary: fc.constant({ kind: 'break' } as ItemContent) },
  );
}

const arbSnapshotItem: fc.Arbitrary<SnapshotItem> = fc.tuple(arbItemId, fc.boolean()).chain(([id, deleted]) =>
  fc
    .record({
      parent: arbDependency.filter(notSelf(id)),
      side: fc.constantFrom('L', 'R' as const),
      content: arbItemContent(deleted),
      marks: fc.option(fc.tuple(arbMarkState, arbLinkState), { nil: undefined }),
    })
    .map(({ marks, ...rest }) => ({ id, ...rest, deleted, marks: marks === undefined ? {} : { bold: marks[0], link: marks[1] } })),
);

const arbSnapshot: fc.Arbitrary<Snapshot> = fc
  .record({ sv: arbStateVector, formatLamport: arbLamport, items: fc.array(arbSnapshotItem, { maxLength: 10 }), pending: fc.array(arbOp, { maxLength: 3 }) })
  .map((r) => ({ v: 1, ...r }));

const arbErrorMessage: fc.Arbitrary<ServerMessage> = fc
  .record({
    code: fc.constantFrom(...ERROR_CODES),
    reason: fc.string({ maxLength: LIMITS.MAX_ERROR_REASON }),
    fatal: fc.boolean(),
    supported: fc.option(fc.array(fc.integer({ min: 1, max: 9 }), { maxLength: 3 }), { nil: undefined }),
  })
  .map(({ supported, ...rest }) => ({ v: 1, t: 'error', ...rest, ...(supported === undefined ? {} : { supported }) }) as ServerMessage);

export const arbServerMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({ sv: arbStateVector, snapshot: fc.option(arbSnapshot, { nil: undefined }) }).map(({ sv, snapshot }) => ({ v: 1, t: 'welcome', sv, ...(snapshot === undefined ? {} : { snapshot }) }) as ServerMessage),
  arbOps.map((ops) => ({ v: 1, t: 'ops', ops }) as ServerMessage),
  fc.record({ replica: arbReplica, seq: fc.integer({ min: 1, max: 1_000_000 }) }).map((r) => ({ v: 1, t: 'ack', ...r }) as ServerMessage),
  fc.record({ replica: arbReplica, state: fc.option(arbPresenceState, { nil: null }) }).map((r) => ({ v: 1, t: 'presence', ...r }) as ServerMessage),
  arbStateVector.map((sv) => ({ v: 1, t: 'quiet', sv }) as ServerMessage),
  arbErrorMessage,
  fc.constant({ v: 1, t: 'pong' } as ServerMessage),
);

/** Number of property-test cases: the LLD's 10 000 under CI, 1 000 locally. */
export function numRuns(): number {
  return process.env['CI'] ? 10_000 : 1_000;
}
