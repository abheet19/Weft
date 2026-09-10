# Weft — verification companion, 2026-09-09

Offline collaborative writing: contributors edit the same document during a connection loss, then merge their work and see where it is durably stored.

A release can lag the source checkout. The Study Pack's release ledger records the exact pushed SHA, Fly image, health check, and post-deploy browser evidence; this source companion records the reproducible checks without claiming that an uncommitted checkout is live.

**Configured release check:** `npm run check` passed again on Windows on 2026-09-09. It ran 612 distinct Vitest cases (309 client + 4 latency + 164 CRDT + 52 protocol + 83 server), plus 28 Playwright cases across 11 spec files. The CRDT cases run twice, with and without coverage; those repeated executions are not extra distinct tests. `npm run docs:check` separately passed all 13 documents.

**Changes verified:** Divider insertion at the end of a paragraph preserves its missing explicit boundary. Conversions to/from divider atoms replace a whole node safely. Undo/redo retains color values and checklist checked state. Link creation and editing reject a protocol-invalid URL before dispatch, so a rejected local operation cannot block sync. At 320 and 390 px, the top-bar controls stay inside the viewport, editing/formatting/palette/sidebar flows remain usable, and the save pill clears the sidebar tabs. The Caddy edge sends framing and MIME-sniffing protections and exposes the supervised process-unit health probe.

**Independent exploration:** 25 desktop scenarios passed with zero page errors at `2026-09-09T16:43:57.345Z`; a separate phone audit passed 6 checks at 320 and 390 px with zero page errors at `2026-09-09T17:01:11.914Z`. Source scripts, screenshots, and raw JSON remain in the local verification workspace; those files are evidence, not part of the product bundle.

**Bounded Lighthouse check:** Chrome's mobile profile against a stable `/d/<id>` on the local production build measured 98 performance, 100 accessibility, 100 SEO, 2.0 s FCP/LCP, 0 ms TBT, and 0.012 CLS. The stable toolbar slot removes the loading-to-editor page jump; readable helper/status text uses the existing secondary-text token; fonts no longer block first paint. This is one synthetic run on this machine, not a field-data or device-fleet claim.

## How to read the evidence

The release checks below executed against local production builds and disposable fixtures. The independent browser checks used new Playwright contexts and observed rendered state after each action; they are scripted exploratory checks, not human hand-clicking. A passing local fixture, HTTP health response, and live-provider evaluation are different claims.

The original [Claude Weft/Vantage plan](https://claude.ai/code/artifact/7a18edf9-1ba9-48ae-b9c2-d5a63e60086a) was not freshly accessible and was not edited or republished. This file is a local companion with a reproducible test order. Earlier W-1–W-9/V-1–V-13 names remain historical references; no exact one-to-one original-item completion is invented.

## Test order and observed results

Run the existing suite first, then the independent browser sequence below against isolated data, then a small deployed smoke check. Do not turn these local probes into production load tests.

| Order | Steps / expected behavior | Observed |
|---|---|---|
| 1 | CTA inventory and initial desktop render | PASS — 29 observed controls |
| 2 | two independent clients: edit, disconnect, concurrent offline text, reconnect | PASS — both clients converged to `Incident notes: server healthy. offline observation.` |
| 3 | format on/off: Bold (Ctrl+B) | PASS — toggle reflected in document and acknowledged |
| 4 | format on/off: Italic (Ctrl+I) | PASS — toggle reflected in document and acknowledged |
| 5 | format on/off: Underline (Ctrl+U) | PASS — toggle reflected in document and acknowledged |
| 6 | format on/off: Strikethrough (Ctrl+Shift+S) | PASS — toggle reflected in document and acknowledged |
| 7 | format on/off: Highlight (Ctrl+Shift+H) | PASS — toggle reflected in document and acknowledged |
| 8 | format on/off: Inline code (Ctrl+E) | PASS — toggle reflected in document and acknowledged |
| 9 | block: Bullet list | PASS — document block changed |
| 10 | block: Numbered list | PASS — document block changed |
| 11 | block: Checklist | PASS — document block changed |
| 12 | block: Quote | PASS — document block changed |
| 13 | block: Code block | PASS — document block changed |
| 14 | block menu: Heading 1 | PASS — h1 |
| 15 | block menu: Heading 2 | PASS — h2 |
| 16 | block menu: Heading 3 | PASS — h3 |
| 17 | block menu: Paragraph | PASS — p |
| 18 | Text colour | PASS — {"options": ["", "", "", "", "", "", "", "", "Default"], "undoRedo": "exact formatting restored"} |
| 19 | Highlight colour | PASS — {"options": ["", "", "", "", "", "", "None"], "undoRedo": "exact formatting restored"} |
| 20 | divider and undo/redo buttons | PASS — divider removal/reappearance observed |
| 21 | link create, copy, edit, remove | PASS — all link actions completed |
| 22 | invalid link is rejected without breaking sync | A live audit of `948efe6` exposed a false pass: `javascript:` rendered locally as an inert `#` link while its rejected op left that client at `Syncing · 1`. The fix rejects it before dispatch, leaves the input open with an error, keeps both peers Saved, and permits following valid links to sync; a two-client Chromium regression covers both create and edit paths. |
| 23 | history scrub, authors overlay and return to live | PASS — {"max": "7"} |
| 24 | sidebar tabs and command palette theme/opacity/offline | PASS — all three rail tabs, rail hide/show, theme, transparency, simulated offline, time-travel, author overlay, diagnostics and state-vector actions were inventoried or exercised |
| 25 | bounded local browser concurrency: 6 independent clients, 10 edit rounds | PASS — 60 insertions / 300 characters; all peers converged each round; p50 787 ms, p95 1,402 ms |

## Scope and limits

One relay process and one durable log writer. No accounts, document permissions, end-to-end encryption, nested lists, tables, images, server snapshot fast-path, or horizontal room routing. This public demonstration is unsuitable for private documents. Undo reinserted text remains plain by the documented v1 rule; formatting undo itself now retains color values.

The current six-client probe made 60 inserts over 10 rounds (300 characters); end-to-end scripted round latency was p50 787 ms and p95 1,402 ms. These include browser focus, typing and assertion overhead, not just server response time. The final configured benchmark passed its release rule: 100k connected replay 378.0 ms, concurrent replay 510.7 ms, index build 153.5 ms, snapshot encode/decode 454.7 ms, sibling flood 544.9 ms and peak observed heap 206.9 MB. `buildIndex` exceeded its 150 ms target and was reported as a warning, but remained inside the repository's explicit 2× release ceiling. This is a short local concurrency/performance check, not a long soak or public capacity guarantee.

An initial direct root-level Vitest invocation picked a default 5-second timeout and timed out two large binding tests; the repository-configured latency runner subsequently passed with its intended setup. The initial divider/color failures were real product regressions and are covered by added tests; early synchronization/history assertions in the exploratory harness were corrected to wait for actual state.

Not newly verified: every browser/OS/device combination, real-provider semantic accuracy, an authenticated Claude Desktop session, long-running soak, backup restoration, or adversarial security certification. Existing automated cases cover additional failure paths; their execution is not described as hand testing.
