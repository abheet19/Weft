// index.ts — the public surface of @weft/crdt, and nothing else. This file exists so the
// client (and tests) import one module and so an internal helper cannot become an accidental
// dependency: what is not re-exported here does not exist outside the package. It must never
// contain logic.

export { REPLICA_ID_RE, ROOT_REPLICA, compareIds, idKey, parseIdKey, isWellFormedId } from './ids.ts';
export type { ReplicaId, ItemId } from './ids.ts';

export { ROOT, ROOT_KEY, MARK_NAMES, BLOCK_TYPES, MAX_LAMPORT, isMarkName, isBlockAttrs, isContent, isCharText } from './item.ts';
export type { Side, MarkName, MarkState, MarkSet, BlockType, BlockAttrs, CharContent, BlockContent, BreakContent, Content, BlockRegister, ItemContent, Item } from './item.ts';

export { siblingArray, firstSibling, siblingAfter } from './siblings.ts';
export type { SiblingList } from './siblings.ts';

export { emptyDoc, getItem, pendingCount, childrenOf, unsatisfiablePending, dropPending } from './doc.ts';
export type { Doc, Children } from './doc.ts';

export { opDependencies } from './ops.ts';
export type { Op } from './ops.ts';

export { apply, applyAll } from './apply.ts';
export type { ApplyResult, RejectReason } from './apply.ts';

export { MAX_FMT_TARGETS, fuguePlace, localInsert, localDelete, localFormat, localSetBlock, localInsertAt, localDeleteAt, localSetBlockAt } from './local.ts';

export { visibleItems, traversalOrder, buildIndex, blockRangeAt, nextInTraversal, neighboursAt, ROOT_ATTRS } from './traverse.ts';
export type { PositionIndex, BlockRange } from './traverse.ts';

export { svGet, svSet, svDiff, svEqual, svMerge, opsSince } from './stateVector.ts';
export type { StateVector, OpLog } from './stateVector.ts';

export { canonicalBytes, canonicalString } from './canonical.ts';

export { encodeSnapshot, decodeSnapshot } from './snapshot.ts';
export type { Snapshot, SnapshotItem } from './snapshot.ts';
