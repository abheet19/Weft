# Weft — current implementation context

> Evidence snapshot: 10 September 2026 IST. Canonical repository: `D:\Code\Weft`. The release candidate fixes command-palette focus restoration, adds a browser-level all-CTA/recovery matrix, and makes `/health` report the build's exact source SHA. `MEMORY.md` and the external sign-off evidence record the tested and deployed commit; this file does not hard-code its own commit hash because changing that text would create a different commit.
>
> Current source and executable tests win if an older design note disagrees. A dirty working tree is a candidate, a green local run proves only those bytes, and a configured URL is not deployment evidence. Public release proof requires `source SHA -> CI -> image/Fly release -> /health SHA -> browser smoke`.

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

`npm run docs:check` validates repository links. `npm run check` composes workspace type checks, ESLint plus dependency/purity boundaries, coverage-enforced unit/property/integration tests, the deterministic 100,000-operation benchmark, and Chromium Playwright. Husky runs lint and typecheck before a commit; GitHub CI repeats the full gate on Windows and Linux. The release workflow checks out the exact successful CI SHA, builds/pushes one container, and passes that SHA into the image as `WEFT_RELEASE_SHA`.

The container supervises the loopback WebSocket relay and Caddy as one process unit. `GET /health` returns JSON containing `status` and the exact `release` SHA injected at build time. Fly release proof must compare that value with the pushed commit and then exercise a real document through the public WebSocket path. The previous Fly image remains the rollback boundary; image rollback does not roll back document data.

## Current measured evidence

| Result | Evidence |
| --- | --- |
| 613 distinct Vitest cases passed: client 310, client latency 4, CRDT 164, protocol 52, server 83 | `npm run check`, 10 September 2026 |
| Coverage passed: client 96.44% statements / 94.02% branches / 92.60% functions; CRDT 99.61 / 96.50 / 100; protocol 100 / 99.19 / 100; server 95.29 / 92.83 / 97.53 | configured package coverage gates |
| Full browser matrix: 33 Chromium cases after the release CTA/recovery test was added | `packages/client/e2e`, real ephemeral relay + production Vite build |
| Focused release matrix: all 12 palette commands; every toolbar/block/link/notice/recovery CTA; collaboration/offline/reconnect/diagnostics; desktop and 320 px | `packages/client/e2e/release-cta.spec.ts` |
| 100k benchmark gate passed; measured connected replay 358.3 ms, concurrent replay 597.2 ms, index 142.3 ms, snapshot 426.0 ms, JSON 161.7 ms, sibling flood 523.0 ms, peak heap 207.7 MB | Node 22.22.0 on this Windows machine; bounded synthetic run |
| Earlier bounded Lighthouse mobile run measured 98 performance, 100 accessibility, 100 SEO, 2.0 s FCP/LCP, 0 ms TBT, and 0.012 CLS | retained lab evidence in `docs/VERIFICATION.md`; not field data |

The final external release record under `verification-work/portfolio-release-20260910` names the exact commit, workflow, image/release, `/health` response, and public browser smoke. Metrics above describe the named local run and are not public capacity or certification claims.

## Open limits

- The relay is one log writer: no horizontal document routing, broker, multi-region durability, backup/restore drill, or long-run compaction proof.
- Browser storage can be evicted; edits still only in memory can be lost before IndexedDB commit.
- The public demo has no identity, access control, privacy boundary, or end-to-end encryption. Do not use private documents.
- Benchmarks/Lighthouse are bounded local samples, not public capacity, field Core Web Vitals, or soak evidence.
- Local undo after remote concurrency can surprise users. Accessibility automation is not a full assistive-device matrix.

## Reading order

1. `CONTEXT.md` — current contract and trust boundaries
2. `MEMORY.md` — decisions, current evidence, release handoff, and open limits
3. `D:\Work\Weft Study Pack\01_Weft_Concepts_From_Zero.md` — CRDT/editor/network vocabulary
4. `docs/01-DESIGN.md; docs/02-LLD.md` — algorithm, invariants, protocol, slices, and attacks
5. `packages/crdt; packages/protocol` — pure and wire foundations
6. `packages/client/src/binding; packages/client/src/session; packages/server/src` — end-to-end operation path
7. `D:\Work\Weft Study Pack\03_Weft_System_Design_DSA_TypeScript_Walkthrough.md` — DSA/TypeScript/code-to-deploy walkthrough
8. `docs/SANITY.md; docs/VERIFICATION.md; docs/DEPLOY.md` — execute, evaluate, and release

Use `docs/SANITY.md` in the repository, or `09_SANITY_CHECK.md` in the Study Pack, before claiming that a new change works.

## Rules for the next coding agent

1. Never use wall clock or arrival order as a conflict tie-breaker; protect canonical serialization.
2. Keep semantic merge logic out of the relay and validation at the network boundary.
3. Preserve truthful save labels and add failure-path tests for persistence/acknowledgement changes.
4. Change editor binding and CRDT semantics with focused unit/property tests and user-visible paths with Playwright.
5. Keep base/live/candidate evidence separate; do not commit, push, or deploy without authorization.
