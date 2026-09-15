# Weft sanity, usage, and release plan

> Snapshot updated 15 September 2026 IST. Use disposable document IDs and synthetic content. Public Weft has no account, permission, privacy, or E2EE boundary. Live revision `8cee8ee24f9c8cf969ce3fe93eabd65658b8385a` passed its complete 39-test browser suite; the local candidate adds a missing Documents `main` landmark and three viewport checks and is not yet deployed.

## Automated gate

```powershell
Set-Location 'D:\Code\Weft'
npm ci
npm run docs:check
npm run check
```

The current candidate matrix expects 14 documentation checks, 647 distinct Vitest cases, the deterministic 100,000-operation benchmark, and 42 Chromium Playwright cases. Husky runs lint and typecheck before commit; GitHub CI repeats the full gate on Windows and Linux.

## Product walkthrough

1. Open `/d/<disposable-id>` in two independent browser contexts. Type in both and wait until their text is identical and both pills read **Saved**.
2. In one context, open **Sync**, enable **Simulate offline**, and edit in both contexts. Confirm the offline pill counts local changes while the online peer remains Saved. Reconnect, confirm the merge notice, identical content, and both Saved.
3. Exercise undo/redo, every mark, colour/reset, heading and block type, checklist tick, divider, and link create/copy/open/edit/remove. Try a `javascript:` or `data:` link and confirm it is rejected without changing shared state.
4. Exercise Outline jump, People/presence/follow, Sync diagnostics, History scrub/authors/return-live, all 16 command-palette actions (including the four screen-navigation entries), message drop/delay, the divergence report, notice actions, and status details.
5. Repeat the direct-control path at 320 px. Check keyboard focus, visible names, no trapped dialog, reduced-motion behaviour, and readable opaque content surfaces.
6. Corrupt only a disposable browser database and verify the error card's **Retry** and **Start fresh** paths. Never do this with real content.

There is no import/export workflow in this release. Named restore, accounts, authorization, E2EE, tables/images, multi-region routing, backup restore, and long soak remain outside the product contract.

## Deployment proof

Build and deploy one reviewed commit with `WEFT_RELEASE_SHA=<full commit SHA>`, then run `WEFT_RELEASE_SHA=<full commit SHA> npm run smoke:live` against the default public origin (or set `WEFT_BASE_URL`). A release is complete only when CI passes, the Fly image is healthy, `/health.release` equals that commit, and a public two-peer/offline/mobile smoke passes with no page errors. Record all four links/identifiers in the external sign-off and retain the prior image for rollback.
