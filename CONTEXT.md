# Weft — current implementation context

> Evidence snapshot updated 10 September 2026 IST. Canonical repository: `D:\Code\Weft`; local `main` carries implementation candidate `9de72a3cc7a325208aa081428595bec7664ee328` plus this documentation update and is two commits ahead of public `main` `55f20884c949f3273d131c8e128da9492b8c5ff6`. Retained deployment evidence maps Fly v18 to `599fd5a99b6e3cc35c00fae19070ee64d5ba355f`; a current anonymous `/health` request returned 200 but exposes no release SHA. The local candidate is not pushed or deployed.
>
> This is the short, AI-readable map. Current source and executable tests win if an older design note disagrees. A dirty working tree is a candidate, not a release; a configured URL is not proof that the candidate is deployed.

## Product contract

Weft is an offline-first collaborative rich-text editor. Two browser peers can edit one document, disconnect, continue locally, reconnect, and converge without a conflict dialog. A deterministic Fugue-style sequence CRDT carries text and rich-text operations; IndexedDB keeps the local log; a WebSocket relay validates, durably appends, acknowledges, and fans out operations. It has no accounts, document authorization, end-to-end encryption, tables/images/nested lists, or demonstrated multi-region scale.

## Architecture and end-to-end flow

```text
ProseMirror transaction -> binding/toOps -> local CRDT
  -> IndexedDB commit -> WebSocket protocol
  -> relay validation -> append + fsync -> acknowledgement/fanout
  -> peer CRDT -> binding/toTransaction -> peer editor
```

`packages/crdt` is pure convergence logic. `packages/protocol` owns validation and wire limits. `packages/client` owns ProseMirror binding, local persistence, session state, presence, history, and React UI. `packages/server` is a durable relay/log writer and must not import CRDT semantics. Reconnect exchanges state vectors and safely replays duplicates. “On device” means IndexedDB committed but not server-acknowledged; “Saved” means append, `fsync`, and acknowledgement completed.

## Code map

| Path | Responsibility |
| --- | --- |
| `packages/crdt/src` | operation identities, Fugue ordering, tombstones, formatting metadata, state vectors, snapshots, and canonical hash |
| `packages/protocol/src` | bounded wire codecs and validation |
| `packages/client/src/binding` | ProseMirror transaction/position/rich-text translation |
| `packages/client/src/session; packages/client/src/store` | connection state, acknowledgement semantics, IndexedDB, and preferences |
| `packages/client/src/history; packages/client/src/ui` | local inverse-op undo, historical view, toolbar, presence, diagnostics, and accessibility |
| `packages/server/src; packages/server/src/log/appendLog.ts` | WebSocket rooms, durable append, acknowledgement, fanout, and limits |
| `docs/01-DESIGN.md; docs/02-LLD.md; DESIGN.md` | normative algorithm, invariants, slices, and UX |
| `docs/VERIFICATION.md; docs/DEPLOY.md` | current reproducible gates and release operations |

## Invariants and trust boundaries

- Every inserted item has a permanent `(replica, counter)` identity; sibling placement and traversal are deterministic across arrival orders.
- Deletes create tombstones; replay cannot resurrect deleted content. Operations are idempotent and carry causal dependencies.
- Formatting resolves through logical metadata, never wall-clock arrival time. Equal logical state produces equal canonical bytes/hash.
- Undo emits new local inverse operations; it never rewinds global history.
- Unsafe link schemes are rejected before local persistence or replication.
- The server relays/persists operations but does not decide document meaning. Save copy must keep local-versus-durable states honest.

## User workflows to preserve

- Edit one `/d/{id}` from two peers, disconnect one, edit both, reconnect, and verify no-loss convergence plus durable save states.
- Use inline formatting, colors/highlights, links, headings, lists, checklist, quote, code block, divider, undo/redo, and invalid-link recovery.
- Inspect Outline navigation, People/presence/follow, Sync state vector/hash/diagnostics, History slider/authors/return-to-live, and the command palette.
- Change name/document title/theme/transparency/sidebar, create a new document, copy the state vector, simulate offline/drop messages, and use the 320 px editor path.

## Concepts this project teaches

| Concept | How it appears here |
| --- | --- |
| Conflict-free replicated data types | commutative/idempotent operations plus deterministic Fugue ordering produce convergence |
| Causality and state vectors | replica counters summarize known history and drive catch-up |
| Tombstones and snapshots | logical deletion preserves references; snapshots bound startup/replay work |
| Durability semantics | IndexedDB commit, socket send, append, `fsync`, and acknowledgement are different milestones |
| Editor binding | ProseMirror positions are translated to stable CRDT identities and back |
| Property-based testing | random arrival orders and operation sequences attack convergence, no-loss, and canonicalization |

## CI, packaging, deployment, and rollback

Run `npm run docs:check` and `npm run check`; the latter composes typecheck, lint/boundary checks, workspace tests, benchmarks, and Playwright. CI runs these gates. The Docker image builds the client and serves the relay/client through the checked topology. `.github/workflows/release.yml` can deploy Fly after successful `main` CI when the secret is present; the manual guide uses `fly deploy --app weft-abheet --remote-only --depot=false`.

Fly v18 is mapped to `599fd5a...`. Public `main` at `55f2088...` adds the first-load performance change but exposed a Saved-state correctness failure in CI. Local `9de72a3...` fixes the replacement-relay acknowledgement baseline and passed the exact CI-equivalent local gate; it remains unpublished. After review, rerun both gates on the final documentation tree, build/smoke the image, deploy with approval, record image/release/machine/source, and retain v18 for rollback.

## Current measured evidence

| Result | Evidence |
| --- | --- |
| Exact `9de72a3...` CI-equivalent gate passed: 612 distinct Vitest tests plus 28 Playwright cases; focused hardening passed 11/11 and E38 repeated 20/20 | `verification-work\portfolio-release-20260910\WEFT_RELAY_ACK_FIX_20260910.md` |
| Earlier bounded bench on the same CRDT implementation: 100k connected replay 250.7 ms; concurrent 365.5 ms; index 110.6 ms; sibling flood 415.5 ms | `verification-work\weft-final-check.log` |
| Independent 25 desktop + 6 phone scenarios and local Lighthouse 98 performance/100 accessibility/100 SEO | `D:\Code\Weft\docs\VERIFICATION.md` |
| Fly v18 maps to `599fd5a...`; public `55f2088...` is newer, and verified local fix `9de72a3...` is unpublished | `verification-work\portfolio-release-20260910\WEFT_RELAY_ACK_FIX_20260910.md; D:\Work\Weft Study Pack\08_TESTING_ARTIFACT.md` |

The evidence above belongs to the named local working-tree snapshot unless it explicitly names a release/image. It does not become live evidence merely because a deployment configuration exists.

## Open limits

- The relay is one log writer: no horizontal document routing, broker, multi-region durability, backup/restore drill, or long-run compaction proof.
- Browser storage can be evicted; edits still only in memory can be lost before IndexedDB commit.
- The public demo has no identity, access control, privacy boundary, or end-to-end encryption. Do not use private documents.
- Benchmarks/Lighthouse are bounded local samples, not public capacity, field Core Web Vitals, or soak evidence.
- Local undo after remote concurrency can surprise users. Accessibility automation is not a full assistive-device matrix.

## Reading order

1. `CONTEXT.md` — current contract and live/candidate boundary
2. `D:\Work\Weft Study Pack\01_Weft_Concepts_From_Zero.md` — CRDT/editor/network vocabulary
3. `docs/01-DESIGN.md; docs/02-LLD.md` — algorithm, invariants, protocol, slices, and attacks
4. `packages/crdt; packages/protocol` — pure and wire foundations
5. `packages/client/src/binding; packages/client/src/session; packages/server/src` — end-to-end operation path
6. `D:\Work\Weft Study Pack\03_Weft_System_Design_DSA_TypeScript_Walkthrough.md` — DSA/TypeScript/code-to-deploy walkthrough
7. `docs/SANITY.md; docs/VERIFICATION.md; docs/DEPLOY.md` — execute, evaluate, and release

Use `docs/SANITY.md` in the repository, or `09_SANITY_CHECK.md` in the Study Pack, before claiming that a new change works.

## Rules for the next coding agent

1. Never use wall clock or arrival order as a conflict tie-breaker; protect canonical serialization.
2. Keep semantic merge logic out of the relay and validation at the network boundary.
3. Preserve truthful save labels and add failure-path tests for persistence/acknowledgement changes.
4. Change editor binding and CRDT semantics with focused unit/property tests and user-visible paths with Playwright.
5. Keep base/live/candidate evidence separate; do not commit, push, or deploy without authorization.
