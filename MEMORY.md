# Weft release memory

## Purpose

This is the durable handoff for the Weft production sign-off completed on 10 September 2026. Read `CONTEXT.md` first for the compact architecture map, then this file for decisions and evidence. Source and executable tests override stale dated notes.

## Product and architecture

Weft is an anonymous, offline-first collaborative rich-text editor. A Fugue-style sequence CRDT gives each inserted item a permanent replica/counter identity; tombstones, logical clocks, state vectors, and canonical serialization make delivery order irrelevant. ProseMirror transactions become CRDT operations, IndexedDB commits local operations before they are sent, and a WebSocket relay appends plus `fsync`s operations before acknowledgement. The relay never imports CRDT semantics.

The save labels are contractual: **On device** means committed locally but unacknowledged, and **Saved** means the relay durably appended and acknowledged. Reconnect exchanges state vectors and replays duplicates safely. Undo emits new inverse operations for the local author's changes; it never rewinds global history.

## Release decisions and fixes

- The command palette now closes its native `<dialog>` before running a command. Native dialog close restores focus; closing after `Rename via heading` focused the editor stole focus back. The new order preserves the command's chosen focus.
- `release-cta.spec.ts` is the release inventory: all 12 palette commands, toolbar marks and colour choices, every block control, link create/open/edit/remove, notices, presence/follow, sidebar tabs, history, sync/chaos controls, empty state, corrupt-store Retry/Start-fresh recovery, collaboration, offline/reconnect, desktop, and 320 px.
- The container accepts `WEFT_RELEASE_SHA`; `/health` returns it as JSON. GitHub's release workflow passes `workflow_run.head_sha` to both GHCR and Fly builds, so a public deployment can prove its source instead of inferring it from timestamps.
- Import/export, accounts/authorization, E2EE, named versions/restore, tables/images, and multi-region routing are not implemented. No hidden or disabled control claims otherwise.

## Verification snapshot

The final candidate gate runs `npm run docs:check` and `npm run check` on Node 22.22.0. The final gate passed 13 linked documents, workspace typecheck, ESLint/dependency/purity checks, 613 distinct Vitest cases, the 100,000-operation benchmark, and 33 Chromium Playwright cases. `packages/client/e2e/release-cta.spec.ts` independently passes its five focused release cases.

Measured benchmark sample: connected replay 358.3 ms; concurrent replay 597.2 ms; index 142.3 ms; snapshot encode/decode 426.0 ms; JSON stringify/parse 161.7 ms; sibling flood 523.0 ms; peak observed heap 207.7 MB. Every measured value met its direct target and the enforced release ceiling. These are bounded local samples, not field percentiles or public capacity.

The browser matrix covers real ephemeral relay connections and a production Vite build. A previous mobile Lighthouse lab run measured 98 performance, 100 accessibility, 100 SEO, 2.0 s FCP/LCP, 0 ms blocking time, and 0.012 CLS. Semantic roles, keyboard paths, focus return, reduced-motion/transparency CSS, unsafe-link rejection, and 320 px layout are automated. This is strong WCAG-oriented evidence, not third-party WCAG certification or a complete assistive-technology/device matrix.

Docker Desktop's Linux daemon was not running during the local image attempt, so no local Docker-image pass is claimed. The Playwright production build passed; the Fly remote build and public smoke are the container proof for the released commit.

## Usage and test order

1. `npm ci`, then `npm run docs:check` and `npm run check`.
2. Open one disposable `/d/<id>` in two independent browser contexts; edit both online, take one offline, edit both, reconnect, and wait for identical content plus **Saved**.
3. Exercise formatting, links, Outline, People/follow, Sync diagnostics, History, palette actions, and the 320 px layout. Use synthetic content only; the public demo has no privacy boundary.
4. Build with `WEFT_RELEASE_SHA=<40-character commit>`, deploy, compare `/health.release` with that commit, then repeat the two-peer/offline/mobile public smoke.
5. Retain the previous image until rollback and log/data compatibility are understood.

## Release handoff

The canonical external sign-off is `C:\Users\abhee\OneDrive\Documents\ChatGPT\code\verification-work\portfolio-release-20260910\WEFT_RELEASE_SIGNOFF_20260910.md`. It records the immutable commit, push, CI/release status, Fly image/release, exact `/health` response, public browser result, and any provider limitation. Do not call the candidate deployed unless that chain names the same SHA end to end.
