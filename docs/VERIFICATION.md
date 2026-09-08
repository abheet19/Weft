# Weft — verification companion, 2026-09-08

Offline collaborative writing: contributors edit the same document during a connection loss, then merge their work and see where it is durably stored.

Release candidate: `4e90a19` plus the focused changes listed below. The exact final deployed commit and live smoke results are recorded in the Study Pack's `08_TESTING_ARTIFACT.md` release ledger.

**Configured release check:** `npm run check` passed on Windows. 612 distinct Vitest cases (309 client + 4 latency + 164 CRDT + 52 protocol + 83 server), plus 26 Playwright cases across 10 spec files. The CRDT cases run twice, with and without coverage; those repeated executions are not extra distinct tests.

**Changes verified:** Divider insertion at the end of a paragraph now preserves its missing explicit boundary. Conversions to/from divider atoms replace a whole node safely. Undo/redo retains color values and checklist checked state.

**Independent exploration:** 25 passed scenarios, zero page errors. Source script and raw result files are in the local workspace under `job-search-context/project-verification-2026-09-08/Weft/`.

## How to read the evidence

The release checks below executed against local production builds and disposable fixtures. The independent browser checks used new Playwright contexts and observed rendered state after each action; they are scripted exploratory checks, not human hand-clicking. A passing local fixture, HTTP health response, and live-provider evaluation are different claims.

The original [Claude Weft/Vantage plan](https://claude.ai/code/artifact/7a18edf9-1ba9-48ae-b9c2-d5a63e60086a) was not freshly accessible and was not edited or republished. This file is a local companion with a reproducible test order. Earlier W-1–W-9/V-1–V-13 names remain historical references; no exact one-to-one original-item completion is invented.

## Test order and observed results

Run the existing suite first, then the independent browser sequence below against isolated data, then a small deployed smoke check. Do not turn these local probes into production load tests.

| Order | Steps / expected behavior | Observed |
|---|---|---|
| 1 | CTA inventory and initial desktop render | PASS — 29 observed controls |
| 2 | two independent clients: edit, disconnect, concurrent offline text, reconnect | PASS — {"a": "Incident notes: offline observation. server healthy. ", "b": "Incident notes: offline observation. server healthy. "} |
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
| 22 | invalid link is rejected without breaking sync | PASS — Weft Weft explore-invalid-link-1788887148817-21 GA Only you K Paragraph B I U S A  unsafe reference  2 words · Fugue CRDT Outline People Sync  ON THIS PAGE  No headings yet  HISTORY 16 / 16 Live — editing Show authors  The page re-renders fold(apply, ∅, ops[0..n]). Named versions and restore are not in v1.  Saved |
| 23 | history scrub, authors overlay and return to live | PASS — {"max": "7"} |
| 24 | sidebar tabs and command palette theme/opacity/offline | PASS — ["Rename via heading", "New document", "ThemeDark", "Reduce transparencyOff", "Set my nameh52czf", "Follow…", "Time-travel", "Show authorsOff", "Simulate offlineOff", "Drop next NN = 3", "Toggle Inspector", "Copy state vector"] |
| 25 | bounded local browser concurrency: 6 independent clients, 10 edit rounds | PASS — {"clients": 6, "rounds": 10, "insertions": 60, "characters": 300, "p50_ms": 1116, "p95_ms": 1857, "latencies_ms": [1636, 1786, 1093, 958, 1116, 1857, 1099, 1108, 1246, 1227]} |

## Scope and limits

One relay process and one durable log writer. No accounts, document permissions, end-to-end encryption, nested lists, tables, images, server snapshot fast-path, or horizontal room routing. This public demonstration is unsuitable for private documents. Undo reinserted text remains plain by the documented v1 rule; formatting undo itself now retains color values.

The six-client probe made 60 inserts over 10 rounds (300 characters); end-to-end scripted round latency p50 1,116 ms, p95 1,857 ms. These include browser focus, typing and assertion overhead, not just server response time. The configured local benchmark passed, including 100k connected replay 276.3 ms, concurrent replay 519.1 ms, index build 137.1 ms and snapshot roundtrip 408.3 ms. This is a short local concurrency/performance check, not a long soak or public capacity guarantee.

An initial direct root-level Vitest invocation picked a default 5-second timeout and timed out two large binding tests; the repository-configured latency runner subsequently passed with its intended setup. The initial divider/color failures were real product regressions and are covered by added tests; early synchronization/history assertions in the exploratory harness were corrected to wait for actual state.

Not newly verified: every browser/OS/device combination, real-provider semantic accuracy, an authenticated Claude Desktop session, long-running soak, backup restoration, or adversarial security certification. Existing automated cases cover additional failure paths; their execution is not described as hand testing.
