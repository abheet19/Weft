// limits.ts — every number an attacker will probe, in one place. This file exists so that the
// server, the client and the validators read the same bound for the same thing, and so a limit
// can be quoted in a test name by its constant. It must never hold behaviour, and no other file
// may spell one of these numbers inline: a second copy is the one that drifts.

export const LIMITS = {
  PROTO_VERSIONS: [1] as const,
  MAX_MESSAGE_BYTES: 262_144, // 256 KiB — a paste is ~ thousands of ops; a snapshot request is separate
  MAX_OPS_PER_MESSAGE: 512,
  MAX_FMT_TARGETS: 4_096, // ⟨D2⟩
  MAX_PRESENCE_NAME: 40, // code points, not UTF-16 units (E29)
  MAX_PENDING_PER_REPLICA: 10_000, // parked ops after catch-up before the client gives up on the session as PENDING_OVERFLOW (E21)
  RATE_OPS_PER_SEC: 2_000,
  RATE_MESSAGES_PER_SEC: 60,
  RATE_PRESENCE_PER_SEC: 10, // presence is fanned out to every member, so it is metered apart from ops (E30)
  QUIET_MS: 300, // ⟨D3⟩ server sends `quiet` after this silence
  PRESENCE_TTL_MS: 30_000, // used by S5's `presence/awareness.ts` (expirePeers); nothing in S2–S4 reads it
  // The LLD §5.2 schema constraints that are numbers live here too, for the same reason as the ones above.
  MAX_SV_KEYS: 1_000, // replicas one `hello` may claim to hold ops from
  MAX_ERROR_REASON: 200, // characters of `error.reason`
  MAX_PRESENCE_COLOR: 7, // palette indexes are 0..7
  MAX_LAMPORT: 2 ** 31 - 1, // formatting lamports; the same bound as @weft/crdt's so every language a port is written in can hold one
  MAX_HREF: 2_048, // characters of a link's `href`; browsers and servers agree on roughly this bound for a URL
  MAX_MARK_VALUE: 32, // characters of a colour mark's `value`; a `#rrggbb`/`#rrggbbaa` hex fits with room to spare (E56)
} as const;

/** The schemes a link may carry (LLD §8 S6, E28): anything else — `javascript:`, `data:`, `vbscript:` — is refused at validate time, not merely at render time. */
export const HREF_SCHEME_RE: RegExp = /^(?:https?|mailto):/i;

/** A colour mark's value (E56): a `#rrggbb` or `#rrggbbaa` hex, nothing else — refused at validate time so no attacker-chosen string ever reaches a `style` attribute at render. */
export const MARK_COLOR_RE: RegExp = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Document ids are URL path segments and file names on the server, so the alphabet is the safe intersection of both (LLD §5.2). */
export const DOC_ID_RE: RegExp = /^[a-z0-9-]{8,64}$/;

/** A replica id, duplicated from @weft/crdt on purpose: this package depends on nothing, and the wire contract must not change because the CRDT's did. */
export const REPLICA_ID_RE: RegExp = /^[a-z2-7]{13}$/;

/** A published content hash is SHA-256 as lowercase hex, nothing else (LLD §5.2). */
export const HASH_RE: RegExp = /^[0-9a-f]{64}$/;
