# Weft — CRDT and collaborative-editing literature brief

*Compiled 2026-09-05 from 40+ primary-source fetches (arXiv PDFs, library READMEs and source, MDN,
WebKit) by a research pass. Anything not confirmed directly is marked **[unverified]**. Dated:
re-verify before quoting. This informs [../01-DESIGN.md](../01-DESIGN.md) §1–§4; the design wins
where they disagree.*

---

## 1. Sequence CRDTs — ordering rule · interleaving · tombstones · metadata · trade-off

**RGA** — Roh, Jeon, Kim, Lee, JPDC 71(3), 2011. https://doi.org/10.1016/j.jpdc.2010.12.006
- Insert anchored to the *left* reference; concurrent inserts with the same anchor sorted **newer timestamp first**.
- Forward non-interleaving **proven** (Isabelle, Gomes et al. 2017); **backward** anomaly exists (PaPoC'19 §3; Fugue Table 1).
- Tombstones required. Metadata: id + timestamp + left link. Automerge's text is RGA-based.

**Logoot / LSEQ** — Weiss, Urso, Molli, ICDCS 2009; Nédelec et al., DocEng 2013.
- Dense totally ordered position identifiers; list = sort by id. Interleaving **in both directions** in practice. No tombstones; ids grow at hot spots.

**WOOT** — Oster, Urso, Molli, Imine, CSCW 2006. Prev/next ids; Fugue Table 1 found **forward interleaving**. Tombstones permanent.

**Treedoc** — Preguiça, Marquès, Shapiro, Letia, ICDCS 2009. Binary-tree paths with disambiguators; interleaves both ways; needs coordinated rebalance.

**YATA / Yjs** — Nicolaescu et al., CSCW 2016. Internals: https://github.com/yjs/yjs/blob/main/INTERNALS.md
- `Item`: `id={client, clock}`, `left`, `right`, `origin`, `rightOrigin`, `parent`, `parentSub`, `content`, `deleted`. `integrate()` walks from `origin` toward `rightOrigin`, `clientID` as final tiebreak.
- `StructStore` per client; `DeleteSet` of compressed id ranges (no timestamps); **state vector** `Map<client, nextClock>`.
- Run-length merge of adjacent same-client items. GC: deleted items become `GC` structs (id + length) when `doc.gc = true`; DeleteSet ids kept forever.
- Encoding v1 vs **v2** (columnar/RLE; community report 8.9 MB → 452 KB). https://docs.yjs.dev/api/document-updates
- Forward non-interleaving proven; backward multi-replica interleaving can occur. YATA paper pseudocode contains errors; `lean-yjs` proves the actual rule.

**Fugue / FugueMax** — Weidner & Kleppmann, arXiv:2305.00583 v3 (Oct 2025). https://arxiv.org/abs/2305.00583
- Tree; node `(id, value, parent, side ∈ {L,R})`. Order = in-order traversal; same-side siblings by lexicographic id.
- Insert: `leftOrigin` = node at i−1; `rightOrigin` = next node in traversal **including tombstones**. If `leftOrigin` has no right children → right child of it; else → **left child of `rightOrigin`**. Satisfies Attiya et al.'s strong list spec (Thm 1).
- FugueMax adds `rightOrigin` on right children, orders right siblings by reverse right origin, ties by id (credited to Gentle's "YjsMod"). Differs from Fugue only when concurrent elements share a left origin with different right origins.
- Tombstones required ("may be an ancestor to non-deleted nodes"). Fugue: forward proven, backward conjectured; **FugueMax proven maximally non-interleaving**. Performance comparable to Yjs.

**Peritext** — Litt, Lim, Kleppmann, van Hardenberg, Ink & Switch 2021 / CSCW 2022. https://www.inkandswitch.com/peritext/
- RGA-ordered characters with `opId = counter@nodeId`; formatting as a separate log of **mark operations** anchored `before`/`after` character ids (encodes expand behaviour). Inline marks only — no block structure.

**Eg-walker** — Gentle & Kleppmann, EuroSys 2025. https://arxiv.org/abs/2409.14252
- Stores the **event graph** of original index-based ops; CRDT state is temporary and discarded. Uses a YATA variant internally. Orders of magnitude less steady-state memory than CRDTs; merges concurrent branches in O(n log n).

**Diamond types** — Gentle. https://josephg.com/blog/crdts-go-brrr/ — YATA-style ordering chosen over RGA to avoid prepend interleaving; range tree + RLE.

**Loro** — https://github.com/loro-dev/loro — text uses **Fugue**; movable list/tree; shallow snapshots; columnar encoding.

**Automerge** — https://automerge.org/docs/reference/under-the-hood/merge-rules/ — RGA text; columnar RLE + delta encoding; documents always carry history.

## 2. Interleaving anomalies
- PaPoC 2019 definition; Logoot/LSEQ interleave in practice; RGA's "lesser anomaly" when typing backwards.
- Fugue paper corrections: the 2019 definition is **unsatisfiable**; the 2019 "fixed RGA" **does not converge**; WOOT and Treedoc interleave forward; OT algorithms interleave too.
- **Maximal non-interleaving** (Def. 4): forward — if A is B's left origin and A precedes every other element with left origin A, then A,B are consecutive; backward — mirror with right origins except where Lemma 5 forces forward to win; same origins → lower id first.

## 3. OT vs CRDT
- OT: index-based ops transformed under a central total order; simple, metadata-free; merging n-vs-n divergent ops is O(n²)+; TP2 correctness failures in published algorithms **[Imine et al. 2003 from memory, unverified]**.
- CRDT costs: per-char ids, tombstones, DeleteSet growth, GC needs coordination; "easy to implement badly" (Kleppmann, *CRDTs: The Hard Parts*).
- Haverbeke, *Collaborative Editing in ProseMirror*: rejects classic OT and CRDTs; central authority linearises steps; clients **rebase** unconfirmed steps via position `Mapping`s; concedes it does not suit offline/branching. https://marijnhaverbeke.nl/blog/collaborative-editing.html · guide https://prosemirror.net/docs/guide/#collab

## 4. Binding a CRDT to ProseMirror
- **y-prosemirror**: `ySyncPlugin`, `yCursorPlugin` (relative positions), `yUndoPlugin` (**local-scope undo only**); `tr.setMeta('addToHistory', false)`. Relative ↔ absolute position API; deleted content resolves to `null`.
- Hard problems: schema mismatch (normalise on load); tag remote transactions to avoid loops; marks as attributes approximate Peritext; **moves** are delete+reinsert — Kleppmann, *Moving Elements in List CRDTs*, PaPoC 2020; nesting is structural.
- Road not taken: `prosemirror-collab` step rebasing — exact PM semantics, no metadata, requires an online authority.

## 5. Sync protocol prior art
- **y-protocols**: `SyncStep1` = state vector; `SyncStep2` = diff update; `Update` incremental. Awareness `Map<clientID, {clock, state}>`, dropped after **30 s**.
- **y-websocket**: backoff `2^n × 100 ms` capped at 2500 ms by default.
- **Hocuspocus**: hooks `onAuthenticate`, `onLoadDocument`, `onChange`, `onStoreDocument` (debounced); stores update history.
- **Automerge sync**: heads + Bloom filter of change hashes; loop until null.
- Delta vs snapshot: `Y.mergeUpdates` does not GC; compaction = load + `encodeStateAsUpdate`.

## 6. Offline persistence in the browser
- **y-indexeddb**: stores `updates` + `custom`; writes debounced 1000 ms; trims to one full state at **500** updates.
- **Durability** (MDN): `strict` survives power loss; `relaxed` survives process/tab crash; `default` = browser choice (Chrome relaxed **[unverified]**). Committed transactions survive a tab kill either way.
- **Eviction**: best-effort storage LRU-evicted **whole-origin**; `navigator.storage.persist()` — Firefox prompts, Chrome/Safari decide silently.
- **Safari ITP 7-day cap**: all script-writable storage deleted after 7 days of Safari use without interaction on the site. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/

## 7. Property-based testing for CRDTs
- **fast-check**: `fc.property`, `fc.assert` (seed, path, counterexample); model-based `fc.commands` + `fc.modelRun`; `replayPath`. https://fast-check.dev/docs/core-blocks/properties/
- **Yjs test harness**: `TestConnector` with per-peer queues; `flushRandomMessage`, `disconnectRandom/reconnectRandom`; `compare()` asserts all peers equal and equal to a fresh doc from merged updates, plus state vectors, DeleteSets and struct stores.
- Formal: Gomes et al., *Verifying Strong Eventual Consistency*, OOPSLA 2017. https://arxiv.org/abs/1707.01747
- **Best single property**: pairwise convergence under random partitions — 3–4 replicas, random ops, random partition/heal schedule with random delivery order and duplicates; assert (a) all equal, (b) equal to replay-from-merged-log, (c) idempotence, (d) encode→decode round trip. Plus a targeted non-interleaving property.

## 8. Metadata and GC
- Yjs keeps DeleteSet ids forever; Automerge keeps history; Eg-walker/Loro truncate only past a version every peer has.
- **Honest statement**: identities a not-yet-seen concurrent op might reference cannot be discarded without an agreed **stability frontier** obtained by coordination. Without it, GC is limited to content bytes and compression, never ids.

## README research (kept here so the citation trail is in one place)
- Surveyed READMEs (shadcn/ui, Hono, Drizzle, tldraw, Bun, Zustand, Astro, Excalidraw, PostHog, Yjs, Loro): centred hero → one-sentence tagline → 3–5 **live** badges → nav row. None use tech-stack pills; pills are a portfolio convention and should be one uniform row separated from live badges. Demo media directly under the hero. Nobody hand-writes test counts.
- Shields static badge: `https://img.shields.io/badge/<label>-<message>-<color>?style=for-the-badge&logo=<slug>&logoColor=white`; `_`→space, `--`→`-`. Verified simple-icons slugs: `typescript`, `nodedotjs`, `react`, `nestjs`, `postgresql`, `sqlite`, `duckdb`, `prosemirror`, `vitest`, `githubactions`, `modelcontextprotocol`, `vite`, `eslint`. **Not present**: `websocket`, `yjs`, `tiptap`.
- Real CI badge: `https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg?branch=main` or shields `github/actions/workflow/status/OWNER/REPO/ci.yml?branch=main&style=for-the-badge`.
- GitHub alerts: one or two per document, never consecutive. `<details>` needs blank lines. Mermaid fences render natively; flowchart/sequence/state/ER widely reported to work.
