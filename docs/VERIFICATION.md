# Weft verification and release evidence — 2026-09-10

Weft's release claim is narrow: anonymous collaborators can edit one document online and offline, reconnect without a conflict dialog, and see honest local-versus-durable save state. All checks use disposable data.

## Current candidate gate

`npm run docs:check` and `npm run check` are the reproducible release commands. On Node 22.22.0 for the current candidate they pass:

- 13 repository documents with every relative link resolved;
- TypeScript checks in all four workspaces;
- ESLint, package-direction checks, and purity checks across 34 pure source files;
- 613 distinct Vitest cases: client 310, client latency 4, CRDT 164, protocol 52, and server 83;
- coverage gates (client 96.44% statements / 94.02% branches / 92.60% functions; CRDT 99.61 / 96.50 / 100; protocol 100 / 99.19 / 100; server 95.29 / 92.83 / 97.53);
- 33 Chromium Playwright cases against a production Vite build and a real ephemeral relay.

The CRDT suite runs once with coverage and once without it; the repeated execution is not counted twice. The focused `release-cta.spec.ts` has five cases and covers every available release CTA at desktop and 320 px, plus corrupt-store recovery.

## User-flow coverage

| Flow | Executed evidence |
| --- | --- |
| Online collaboration | two independent contexts edit different and concurrent positions, converge, and reach **Saved** |
| Offline-first recovery | user-offline socket closure, concurrent edits, exact pending count, tab kill/reopen, reconnect/catch-up, no-loss convergence |
| Editor | undo/redo; all six inline marks; all text/highlight colours and reset; headings, paragraph, bullet, numbered, checklist, quote, code block, divider |
| Links | create, copy, open, edit, remove; unsafe create/edit rejected before CRDT dispatch while peers stay **Saved** |
| Collaboration UI | presence stack/dialog, remote caret, follow/exit-follow, Outline jump, People and Sync tabs |
| History | scrub to read-only history, author overlay, return to live editing |
| Command palette | all 12 commands inventoried; filtering, keyboard navigation, Escape focus return, and every stateful action exercised |
| Diagnostics | state vector copy, simulated message drop/repair, delay switch, divergence tripwire/report, status details, notice action and dismiss |
| Recovery states | empty document remains editable; a corrupt IndexedDB copy shows an alert; Retry reattempts; Start fresh opens a safe new document |
| Responsive/accessibility | the complete direct-control flow runs at 1280 px and 320 px; primary controls stay usable; semantic names/roles, focus paths, reduced motion/transparency, and live status/alert copy are preserved |

There is no import/export CTA in this version. Accounts, document authorization, E2EE, named versions/restore, tables/images, and horizontal/multi-region routing are also outside the implemented contract.

## Performance snapshot

The deterministic benchmark generated and replayed 100,000-operation connected, partitioned, and sibling-flood workloads. It measured connected replay 358.3 ms, concurrent replay 597.2 ms, index construction 142.3 ms, snapshot encode/decode 426.0 ms, JSON stringify/parse 161.7 ms, sibling flood 523.0 ms, and peak observed heap 207.7 MB. Every result met its direct target and the repository's enforced release ceiling.

Earlier mobile Lighthouse lab evidence for the same application path measured 98 performance, 100 accessibility, 100 SEO, 2.0 s FCP/LCP, 0 ms TBT, and 0.012 CLS. It is retained evidence, not a fresh field Core Web Vitals percentile. Automated accessibility checks do not constitute third-party WCAG certification or cover every browser, screen reader, switch device, zoom level, or OS combination.

## Release proof

The image takes `WEFT_RELEASE_SHA`; `/health` returns `{"status":"ok","release":"<sha>"}`. GitHub release automation uses the exact successful CI `head_sha` for its checkout, GHCR build, and Fly build. The external sign-off at `verification-work/portfolio-release-20260910/WEFT_RELEASE_SIGNOFF_20260910.md` records the pushed commit, workflow, image/Fly release, live health SHA, and public browser smoke for one immutable source.

A local Docker build was attempted, but Docker Desktop's Linux daemon was not running. No local image success is claimed. The real Playwright production build passed, and the remote Fly image build plus public smoke are required before sign-off.

## Limits

The deployment is one relay and one durable log writer. Browser storage may be evicted, and edits still only in memory can be lost before IndexedDB commits. The public demo has no identity, privacy, authorization, or encryption boundary; never use private documents. The benchmark and browser concurrency checks are bounded tests, not a soak, capacity guarantee, backup restoration drill, or adversarial security certification.
