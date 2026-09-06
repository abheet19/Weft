// awareness.ts — the peer table and the pure views the presence UI draws from it (LLD §1.3,
// §2.3). Awareness is EPHEMERAL: a peer exists only while its presence frames keep arriving, and a
// peer that has gone dark is REMOVED at PRESENCE_TTL_MS, never persisted and never logged. This
// file is PURE and every "now" is a parameter, so the same table given the same clock yields the
// same carets — the honest-degradation rule (03-UI §4.2) is a pure function here: "connected and
// alone" and "disconnected, peers unknown" are two different values, never the same empty map.
//
// Two timestamps per peer earn their keep. `seenAt` advances on every frame (a heartbeat included)
// and drives the TTL, so a still-but-present peer is kept alive; `movedAt` advances only when the
// cursor actually changes and drives the caret's flag (1.5 s) and idle fade (30 s / 60 s), so a peer
// that stops typing fades on its own without vanishing. It must never read a clock, mutate the table
// it is given, or trust a `color` outside the palette (the renderer clamps; here it is carried as-is).

import type { ReplicaId } from '@weft/crdt';
import type { ItemAnchor, PresenceState } from '@weft/protocol';
import { AVATAR_IDLE_MS, CARET_IDLE_MS, PRESENCE_FLAG_MS } from './constants.ts';

/** One known peer: what it published, when a frame last arrived (TTL), and when its cursor last moved (flag/idle). */
export interface Peer {
  readonly state: PresenceState;
  readonly seenAt: number;
  readonly movedAt: number;
}

/** replica id → peer. Immutable from the outside; every update returns a new map. */
export type PeerTable = ReadonlyMap<ReplicaId, Peer>;

/** The empty table — a shared constant so callers never invent a second "no peers yet". */
export const emptyPeers: PeerTable = new Map();

function anchorEqual(a: ItemAnchor | undefined, b: ItemAnchor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.side !== b.side) return false;
  if (a.id === null || b.id === null) return a.id === b.id;
  return a.id.replica === b.id.replica && a.id.seq === b.id.seq;
}

/** Two cursors are the same position when both anchors match; a hash-only or name-only update is not a move. */
function cursorEqual(a: PresenceState['cursor'], b: PresenceState['cursor']): boolean {
  if (a === undefined || b === undefined) return a === b;
  return anchorEqual(a.anchor, b.anchor) && anchorEqual(a.head, b.head);
}

/**
 * Record a peer's latest presence, or remove it when `state` is null (a clean goodbye). `movedAt`
 * carries forward when the cursor is unchanged, so a heartbeat refreshes the TTL without resetting
 * the idle fade — the distinction that lets an idle caret fade while a live one stays solid.
 */
export function upsertPeer(table: PeerTable, replica: ReplicaId, state: PresenceState | null, now: number): PeerTable {
  const next = new Map(table);
  if (state === null) {
    next.delete(replica);
    return next;
  }
  const prev = table.get(replica);
  const moved = prev === undefined || !cursorEqual(prev.state.cursor, state.cursor);
  next.set(replica, { state, seenAt: now, movedAt: moved ? now : prev.movedAt });
  return next;
}

/** Drop every peer whose last frame is older than `ttlMs` — the awareness timeout (03-UI §4.3). A peer removed exactly AT the TTL is gone; strictly-greater keeps the boundary peer one more sweep, which is why the test asserts `now === seenAt + ttlMs` expires. */
export function expirePeers(table: PeerTable, now: number, ttlMs: number): PeerTable {
  let changed = false;
  const next = new Map<ReplicaId, Peer>();
  for (const [replica, peer] of table) {
    if (now - peer.seenAt >= ttlMs) changed = true;
    else next.set(replica, peer);
  }
  return changed ? next : table;
}

/** What the avatar stack shows (03-UI §4.2), as three distinct values so "alone" and "unknown" never render the same. */
export type PresenceView =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alone' }
  | { readonly kind: 'peers'; readonly peers: readonly PeerAvatar[] };

/** One avatar in the stack: its hue, its initials, and whether it is faded for being idle. */
export interface PeerAvatar {
  readonly replica: ReplicaId;
  readonly name: string;
  readonly color: number;
  readonly idle: boolean;
}

/** Initials for an avatar: the first code point of each of the first two whitespace-separated words, or the first two code points of a single word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return [...(words[0] as string)].slice(0, 2).join('').toUpperCase();
  return [...(words[0] as string)][0]! + [...(words[1] as string)][0]!;
}

/**
 * The avatar-stack model. `connected` is the honest-degradation switch: with no socket the peer
 * table is stale and its absence means "unknown", never "alone". With a socket, an empty table is
 * genuinely "only you". Peers are ordered by replica id so the stack is stable across renders.
 */
export function presenceView(table: PeerTable, connected: boolean, now: number): PresenceView {
  if (!connected) return { kind: 'unknown' };
  const peers = sortedPeers(table).map((entry) => avatarOf(entry, now));
  return peers.length === 0 ? { kind: 'alone' } : { kind: 'peers', peers };
}

function avatarOf([replica, peer]: readonly [ReplicaId, Peer], now: number): PeerAvatar {
  return { replica, name: peer.state.name, color: peer.state.color, idle: now - peer.movedAt >= AVATAR_IDLE_MS };
}

/** One remote caret to draw (03-UI §4.3): only peers whose presence carries a cursor. */
export interface CaretView {
  readonly replica: ReplicaId;
  readonly name: string;
  readonly color: number;
  readonly cursor: NonNullable<PresenceState['cursor']>;
  /** The name flag is up for 1.5 s after a move (and on hover, which the CSS adds). */
  readonly flag: boolean;
  /** Faded to 40% after 30 s with no move. */
  readonly idle: boolean;
}

/** The carets to render, ordered by replica id. A peer without a cursor (name/hash only) contributes an avatar but no caret. */
export function caretViews(table: PeerTable, now: number): readonly CaretView[] {
  const out: CaretView[] = [];
  for (const [replica, peer] of sortedPeers(table)) {
    const { cursor } = peer.state;
    if (cursor === undefined) continue;
    out.push({ replica, name: peer.state.name, color: peer.state.color, cursor, flag: now - peer.movedAt < PRESENCE_FLAG_MS, idle: now - peer.movedAt >= CARET_IDLE_MS });
  }
  return out;
}

function sortedPeers(table: PeerTable): readonly (readonly [ReplicaId, Peer])[] {
  return [...table.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
