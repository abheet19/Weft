// messages.ts — the shapes that cross the wire, and nothing that does not. This file exists so
// both ends compile against one definition of every frame. The CRDT-flavoured types here
// (ReplicaId, ItemId, Op, StateVector, Snapshot) are DUPLICATES of @weft/crdt's on purpose: this
// package depends on nothing (LLD §1), and the wire contract is frozen by version, not by the
// CRDT's evolution; a type-level test in @weft/client pins the two as identical. It must never
// import from another package and never carry behaviour.

import type { ErrorCode } from './errors.ts';

/** 13 lowercase base32 chars [a-z2-7]. Same brand as @weft/crdt's so the two are one type to the compiler. */
export type ReplicaId = string & { readonly __brand: 'ReplicaId' };

/** Per-replica contiguous counter. Contiguity is what makes a state vector a complete description of "what I hold". */
export interface ItemId {
  readonly replica: ReplicaId;
  readonly seq: number;
}

export type Side = 'L' | 'R';
export type MarkName = 'bold' | 'italic' | 'code' | 'link' | 'underline' | 'strikethrough' | 'highlight' | 'textColor' | 'highlightColor';
export type BlockType = 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'check' | 'quote' | 'code' | 'divider';

export interface BlockAttrs {
  readonly type: BlockType;
  readonly level?: 1 | 2 | 3;
  /** A checklist item's tick, an LWW attribute on the boundary (only on `check`). */
  readonly checked?: boolean;
}

/** One character: exactly one Unicode code point, which may be two UTF-16 code units. */
export type CharContent = { readonly kind: 'char'; readonly text: string };
/** What an `ins` carries for a block boundary: the attrs plus the LWW seed; `replica` is the op's author. */
export type BlockContent = { readonly kind: 'block'; readonly attrs: BlockAttrs; readonly lamport: number; readonly replica: ReplicaId };
/** A soft break (hard_break / Shift+Enter, E52): inline, immutable, carries nothing but its kind. */
export type BreakContent = { readonly kind: 'break' };
/** Content as it travels in an `ins` op. */
export type Content = CharContent | BlockContent | BreakContent;
/** A boundary as STORED (and as a snapshot carries it): the seed plus the writing op's seq, so an LWW tie has a total order. */
export type BlockRegister = BlockContent & { readonly seq: number };
/** Content as it sits on an item. */
export type ItemContent = CharContent | BlockRegister | BreakContent;

export type Op =
  | { readonly t: 'ins'; readonly id: ItemId; readonly parent: ItemId; readonly side: Side; readonly content: Content }
  | { readonly t: 'del'; readonly id: ItemId; readonly target: ItemId }
  | { readonly t: 'fmt'; readonly id: ItemId; readonly targets: readonly ItemId[]; readonly mark: MarkName; readonly active: boolean; readonly lamport: number; readonly href?: string; readonly value?: string } // ⟨D2⟩ ≤ 4096 targets; `href` on a link, `value` on a colour
  | { readonly t: 'blk'; readonly id: ItemId; readonly target: ItemId; readonly attrs: BlockAttrs; readonly lamport: number };

export type StateVector = Readonly<Record<ReplicaId, number>>;

/** LWW register per mark, as it travels inside a snapshot item; `replica` and `seq` name the op that wrote it. */
export interface MarkState {
  readonly active: boolean;
  readonly lamport: number;
  readonly replica: ReplicaId;
  readonly seq: number;
  readonly href?: string;
  /** A colour mark's value (E56); only on `textColor` / `highlightColor`. */
  readonly value?: string;
}
export type MarkSet = Readonly<Partial<Record<MarkName, MarkState>>>;

export interface SnapshotItem {
  readonly id: ItemId;
  readonly parent: ItemId;
  readonly side: Side;
  readonly content: ItemContent;
  readonly deleted: boolean;
  readonly marks: MarkSet;
}

/** Serialised tree with tombstone text stripped, plus the SV it represents, the parked ops the SV already counts, and the formatting lamport. Decoding yields a Doc with identical canonicalBytes, sv, pending set and formatLamport (I12). */
export interface Snapshot {
  readonly v: 1;
  readonly sv: StateVector;
  readonly formatLamport: number;
  readonly items: readonly SnapshotItem[];
  readonly pending: readonly Op[];
}

/** A position that survives concurrent edits: the item it sits after (or before, at index 0). */
export interface ItemAnchor {
  id: ItemId | null;
  side: 'before' | 'after';
}

export interface PresenceState {
  name: string;
  color: number;
  cursor?: { anchor: ItemAnchor; head: ItemAnchor };
  /** SHA-256 of the publisher's canonical bytes, computed for the document whose state vector is `sv`. */
  hash?: string;
  /** The `quiet.sv` the hash was computed against (E27), so I13's "while the state vectors are equal" is a comparison a peer can make. */
  sv?: StateVector;
}

export type ClientMessage =
  | { v: 1; t: 'hello'; doc: string; replica: ReplicaId; sv: StateVector }
  | { v: 1; t: 'ops'; ops: Op[] }
  | { v: 1; t: 'presence'; state: PresenceState | null } // null = leaving
  | { v: 1; t: 'ping' };

export type ServerMessage =
  | { v: 1; t: 'welcome'; sv: StateVector; snapshot?: Snapshot } // snapshot only if client sv is empty and log length > SNAPSHOT_THRESHOLD — never sent in v1, see LLD extension E7
  | { v: 1; t: 'ops'; ops: Op[] }
  | { v: 1; t: 'ack'; replica: ReplicaId; seq: number } // THE source of "Saved" (I11); sent after fsync (I10)
  | { v: 1; t: 'presence'; replica: ReplicaId; state: PresenceState | null }
  | { v: 1; t: 'quiet'; sv: StateVector } // ⟨D3⟩
  | { v: 1; t: 'error'; code: ErrorCode; reason: string; fatal: boolean; supported?: number[] }
  | { v: 1; t: 'pong' };
