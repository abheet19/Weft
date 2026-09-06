// errors.ts — the closed set of refusal codes and the close code each fatal one carries. This
// file exists so a sender can act on a refusal without reading its prose: the code is the
// contract, `reason` is for humans. It must never grow a code without a row in LLD §5.4, and
// the close codes below are the only ones a Weft server sends on its own initiative.

export type ErrorCode = 'BAD_SHAPE' | 'UNSUPPORTED_VERSION' | 'SEQ_GAP' | 'UNKNOWN_DEPENDENCY' | 'FOREIGN_REPLICA' | 'TOO_LARGE' | 'RATE_LIMITED' | 'PENDING_OVERFLOW' | 'INTERNAL';

/** The closed set as data, so a validator can check membership without a switch that a new code silently falls out of. */
export const ERROR_CODES: readonly ErrorCode[] = ['BAD_SHAPE', 'UNSUPPORTED_VERSION', 'SEQ_GAP', 'UNKNOWN_DEPENDENCY', 'FOREIGN_REPLICA', 'TOO_LARGE', 'RATE_LIMITED', 'PENDING_OVERFLOW', 'INTERNAL'];

/**
 * The WebSocket close code that follows a FATAL error of each kind (LLD §5.4). 1002 = protocol
 * error (the version), 1008 = policy violation (identity, rate, overflow, and a shape violation
 * severe enough to be fatal), 1011 = the server's own fault. Non-fatal errors never close.
 */
export const CLOSE_CODE: Readonly<Record<ErrorCode, number>> = {
  BAD_SHAPE: 1008,
  UNSUPPORTED_VERSION: 1002,
  SEQ_GAP: 1008,
  UNKNOWN_DEPENDENCY: 1008, // E21: an op depending on an id the server has not accepted; sent non-fatal, so this code is only the fallback
  FOREIGN_REPLICA: 1008,
  TOO_LARGE: 1008,
  RATE_LIMITED: 1008,
  PENDING_OVERFLOW: 1008,
  INTERNAL: 1011,
};
