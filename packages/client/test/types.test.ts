// types.test.ts — the protocol duplicates the CRDT's wire-facing types so it can depend on
// nothing; this pins the two as IDENTICAL at the type level, so a drift in either package fails
// `tsc` in the one package that imports both. The runtime body is empty on purpose: vitest's
// expectTypeOf is checked by the compiler, and `npm run typecheck` includes test files.
import { expectTypeOf, it } from 'vitest';
import type {
  BlockAttrs as CrdtBlockAttrs,
  BlockRegister as CrdtBlockRegister,
  Content as CrdtContent,
  ItemContent as CrdtItemContent,
  ItemId as CrdtItemId,
  MarkName as CrdtMarkName,
  MarkState as CrdtMarkState,
  Op as CrdtOp,
  ReplicaId as CrdtReplicaId,
  Side as CrdtSide,
  Snapshot as CrdtSnapshot,
  SnapshotItem as CrdtSnapshotItem,
  StateVector as CrdtStateVector,
} from '@weft/crdt';
import type { BlockAttrs, BlockRegister, Content, ItemContent, ItemId, MarkName, MarkState, Op, ReplicaId, Side, Snapshot, SnapshotItem, StateVector } from '@weft/protocol';

it('the wire types of @weft/protocol are exactly the CRDT types of @weft/crdt', () => {
  expectTypeOf<ReplicaId>().toEqualTypeOf<CrdtReplicaId>();
  expectTypeOf<ItemId>().toEqualTypeOf<CrdtItemId>();
  expectTypeOf<Side>().toEqualTypeOf<CrdtSide>();
  expectTypeOf<MarkName>().toEqualTypeOf<CrdtMarkName>();
  expectTypeOf<BlockAttrs>().toEqualTypeOf<CrdtBlockAttrs>();
  expectTypeOf<Content>().toEqualTypeOf<CrdtContent>();
  expectTypeOf<BlockRegister>().toEqualTypeOf<CrdtBlockRegister>();
  expectTypeOf<ItemContent>().toEqualTypeOf<CrdtItemContent>();
  expectTypeOf<MarkState>().toEqualTypeOf<CrdtMarkState>();
  expectTypeOf<Op>().toEqualTypeOf<CrdtOp>();
  expectTypeOf<StateVector>().toEqualTypeOf<CrdtStateVector>();
  expectTypeOf<SnapshotItem>().toEqualTypeOf<CrdtSnapshotItem>();
  expectTypeOf<Snapshot>().toEqualTypeOf<CrdtSnapshot>();
});
