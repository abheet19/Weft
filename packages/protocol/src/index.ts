// index.ts — the public surface of @weft/protocol, and nothing else. This file exists so the
// client and the server import one module, and so an internal helper cannot become an accidental
// dependency: what is not re-exported here does not exist outside the package. It must never
// contain logic.

export { LIMITS, DOC_ID_RE, REPLICA_ID_RE, HASH_RE, HREF_SCHEME_RE } from './limits.ts';
export { ERROR_CODES, CLOSE_CODE } from './errors.ts';
export type { ErrorCode } from './errors.ts';
export { negotiate } from './version.ts';
export type {
  ReplicaId,
  ItemId,
  Side,
  MarkName,
  BlockType,
  BlockAttrs,
  CharContent,
  BlockContent,
  BreakContent,
  Content,
  BlockRegister,
  ItemContent,
  Op,
  StateVector,
  MarkState,
  MarkSet,
  SnapshotItem,
  Snapshot,
  ItemAnchor,
  PresenceState,
  ClientMessage,
  ServerMessage,
} from './messages.ts';
export { validateClientMessage, validateServerMessage, validateOp } from './validate.ts';
export type { Valid } from './validate.ts';
export { decodeClient, decodeServer, encode } from './codec.ts';
