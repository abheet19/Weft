# Weft — Design (Gate 1)

**Project:** Weft — a real-time collaborative editor built on a CRDT (offline-first, no lost edits)
**Gate:** §1 Design · **Status:** drafted 2026-09-05, awaiting owner approval
**Owner:** Abheet · **Host:** Windows 11 · Node 22 · PowerShell · `D:\code\Weft`
**Budget:** $0 · **Cadence:** solo, 8–10 h/week, interviewing in parallel

> This document is the argument, not the plan. The plan is [02-LLD.md](02-LLD.md). The
> surface design is [03-UI.md](03-UI.md) and its clickable prototype is
> [prototype/weft.html](prototype/weft.html). Every later document is bound by this one.

---

## In plain words

Two people open the same document. One is on a train; the wifi comes and goes. Both type,
delete, and reformat at once — sometimes in the same sentence. When the train comes out of the
tunnel, both screens end up showing *exactly* the same document, nobody's paragraph vanished, and
nobody was asked to "resolve a conflict".

The editor is the easy part. The hard part is the data structure that makes "exactly the same
document" a mathematical guarantee rather than a hope, and the protocol that gets a replica that
has been dark for an hour back in step without re-sending the world. Weft exists to build, test
and *defend* that part.

---

## 0. Assumptions in place of clarifying questions

The prompt asked me to ask before designing. The owner asked for the design and LLD to be
finished in one pass, so instead I record the questions and the answer I chose. **Each is a
decision the owner may reverse at approval; reversing any of them changes the LLD.**

| # | Question | Decision taken | Why |
|---|----------|----------------|-----|
| A1 | Rich text or plain text? | **Rich text, narrow:** paragraphs, headings 1–3, bullet items (flat), block quote; inline bold, italic, code, link. No tables, images, nested lists. | ProseMirror is pointless for plain text, and formatting is where CRDT-to-editor binding gets genuinely hard. Narrow enough to finish. |
| A2 | Multiple documents? | **Yes, trivially:** a document is a URL (`/d/<docId>`). No workspace, no listing beyond "recent on this device". | Needed for the demo to open two docs; anything more is scope creep (and Zeno territory). |
| A3 | Undo/redo? | **Local-only undo** as a late slice, explicitly scoped to the user's own operations. | A collaborative editor without undo feels broken, but cross-replica undo is a research topic. Local undo is the honest, standard answer (Yjs does the same). |
| A4 | Is the server trusted? | **Trusted relay + durable log.** No end-to-end encryption. | E2EE is a different project. The server never *reorders* or *rewrites* ops; it only stores and relays. |
| A5 | Which encoding first? | **JSON v1 on the wire and on disk; binary v2 designed for, not built.** | Debuggability beats bytes during the learning phase. The protocol carries a version so v2 can arrive without a flag day. |
| A6 | Where do tests run? | **Vitest** (dev-only) for every package, coverage thresholds that fail the build. | One runner across Node and jsdom. `node --test` cannot exercise ProseMirror in the DOM. |
| A7 | Deployment target? | **Local only:** `npm run dev` starts server + client on `127.0.0.1`. Optional free static hosting for the client is *not* designed in. | $0 and honest. |

---

## 1. The CRDT decision, argued

### 1.1 The candidates

Collaborative text has two families of answer.

**Operational Transformation (OT)** — every operation is expressed against a known document
version; when two operations are concurrent, one is *transformed* against the other so both sides
end in the same state. Google Docs, Wave, Etherpad, and ProseMirror's own `prosemirror-collab`
descend from this idea. In practice every production OT uses a **central server as the single
sequencer**, because peer-to-peer OT needs a transformation property (TP2) that is notoriously
hard to get right — several published algorithms were later shown to be wrong.

**Conflict-free Replicated Data Types (CRDTs)** — each character carries a globally unique
identity and enough metadata that *any* replica can merge *any* set of operations in *any* order
and land on the same state, with no central sequencer. For text ("sequence CRDTs") the family is:

| Algorithm | Position identity | Concurrent-insert rule | Interleaving anomaly¹ | Metadata / char | Tombstones |
|-----------|-------------------|------------------------|------------------------|-----------------|------------|
| **WOOT** (2006) | prev/next ids | order by ids, transitive | forward: **found** · backward: not found | 2 refs + id | forever |
| **Treedoc** (2009) | path in binary tree | path bits | yes (both) | path (grows) | forever, needs coordinated rebalancing |
| **Logoot / LSEQ** (2010/13) | dense position vector | compare vectors | **yes, arbitrary (both)** | vector (grows with depth) | none needed |
| **RGA** (2011) | id + *left* origin | siblings by timestamp, newer first | forward: **proven none** · backward: **yes** | 1 ref + id | forever |
| **YATA / Yjs** (2016) | id + left **and** right origin | origin-ordering rule, client id tiebreak | forward: proven none · backward: can occur² | 2 refs + id | ids kept, content GC'd |
| **Fugue** (2023) | id + parent + side | **tree**: right child of left, else left child of right; siblings by id | forward: **proven none** · backward: conjectured none | 1 ref + side + id | forever (ids) |
| **FugueMax** (2023) | Fugue + right origin on right children | Fugue, right siblings by reverse right-origin | **proven maximally non-interleaving** | 2 refs + side + id | forever (ids) |

¹ *Interleaving anomaly* (Kleppmann, Gomes, Mulligan, Beresford, PaPoC 2019): two users offline
each type a sentence at the same position; a bad algorithm merges them as `HeWlolrold` rather than
`Hello` + `World`. *Forward* = typed left-to-right. *Backward* = typed with the cursor moving left
(e.g. prepending). The 2019 paper showed Logoot/LSEQ interleave arbitrarily and RGA interleaves
in the backward case. The Fugue paper (v3, 2025) then showed the 2019 *definition* was
unsatisfiable, found forward interleaving in WOOT and Treedoc, defined **maximal
non-interleaving**, and proved FugueMax satisfies it. The table's verdicts are the Fugue paper's
Table 1; "conjectured" means exactly that.
² YATA's rule is proven forward-non-interleaving; the Fugue paper exhibits a backward,
multi-replica case where it can interleave. In practice this is rare and Yjs is excellent; I note
it because it is the one technical point where the algorithm I am choosing is at least as
strong as Yjs, not just simpler.

### 1.2 The choice: Fugue, implemented as an explicit tree

**Weft's CRDT is Fugue** (Weidner & Kleppmann, "The Art of the Fugue", 2023), implemented as a
literal tree of items and read through an in-order traversal.

Why Fugue and not the others:

- **One rule, explainable on a whiteboard.** "New item goes as the right child of its left
  neighbour; if that seat is taken, it goes as the left child of its right neighbour. Siblings on
  the same side sort by id." Everything — convergence, non-interleaving, determinism — falls out
  of that. In an interview I can *derive* the behaviour, not recite it.
- **It is the cleanest provable answer to interleaving**, and interleaving is exactly the anomaly
  an interviewer who knows CRDTs will ask about. Plain Fugue is proven forward-non-interleaving
  and conjectured backward; **FugueMax** (same paper) is proven *maximally* non-interleaving and
  differs from Fugue only when concurrent inserts share a left origin but have different right
  origins. Weft builds plain Fugue because the paper's own authors argue its simplicity wins in
  practice, and the LLD reserves a seam (`Item.rightOrigin`) so FugueMax is an upgrade, not a
  rewrite.
- **Constant metadata per character.** Unlike Logoot/Treedoc, ids never grow with document depth.
- **It maps cleanly onto Yjs's model** (Yjs items also have left/right origins), so everything I
  learn about Yjs's engineering — run-length merging, state vectors, delete sets — transfers.

Why not OT: OT is the *road not taken* and I will say so. It has genuinely better metadata and
tombstone behaviour, and with a central server it is simpler than any CRDT. But (a) the resume
line says CRDT and I want to earn it; (b) OT's correctness lives in transformation functions that
are hard to test exhaustively, while a CRDT's correctness is a *commutativity* property that
property-based tests hammer directly; (c) offline for an hour is OT's worst case (a long rebase
against every intervening op) and a CRDT's ordinary case. `prosemirror-collab` is the honest
comparison and it is discussed in §5.4.

### 1.3 The interview question: "Why not just use Yjs?"

The honest answer, verbatim:

> "Because I wanted to *understand* it, and you don't understand a CRDT until you have shipped one
> and watched a property test find a bug in your ordering rule. Yjs is what I would use at work.
> Weft's CRDT is worse than Yjs in five concrete ways, and I can tell you what each one is."

The five ways (this is the list I must be able to reproduce):

1. **No run-length item merging.** Yjs merges consecutive characters typed by one client into one
   `Item`, so a 10 000-word document is a few thousand items. Weft v1 stores one item per
   character in memory; a 60 000-character document is 60 000 tree nodes. This is the biggest gap,
   and the LLD leaves a seam for it (§LLD 2.1 `Item.content` is already a string, not a char).
2. **No compact binary encoding.** Yjs's v2 update format is dense and varint-packed; Weft v1 is
   JSON. Ten to twenty times larger on the wire and on disk.
3. **Weaker garbage collection.** Yjs drops deleted content and keeps only compressed id ranges.
   Weft keeps tombstone *ids* forever (they are tree nodes other items hang from) and drops content
   only at snapshot time.
4. **No ecosystem.** No `y-prosemirror` battle-tested across thousands of schemas, no awareness
   library, no undo manager, no subdocuments. Weft writes small versions of the first three.
5. **Years of performance work.** Yjs has been profiled on real workloads since 2016. Weft has a
   benchmark test and a budget (§LLD 6.4).

Where Weft is *not* worse: the interleaving guarantee (§1.1 note ²), the readability of the
core (one file, one rule), and the fact that every invariant has a numbered property test.

### 1.4 Trade-offs I am accepting

- **Tombstones accumulate.** A document that has had 100 000 characters typed and deleted keeps
  100 000 ids. Mitigation: snapshots strip content from tombstones, and a `Item` is 5 fields. The
  100k-op benchmark in the LLD's adversarial plan is the early warning.
- **Formatting is per-character last-writer-wins.** Bold applied to a range becomes a mark set on
  each character. Two users concurrently formatting the same range converge (LWW on a Lamport
  clock) but may not both get what they wanted. Peritext-style span semantics (Ink & Switch 2021)
  are the correct answer and are **explicitly out of scope**; this is the second-most-likely
  interview follow-up and the answer is "I know, here is why I stopped short".
- **Block structure is flat.** Paragraph breaks are items in the same sequence as characters (a
  *boundary item* carrying block attributes). This makes Enter and Backspace-at-start ordinary
  inserts and deletes, so concurrent edits inside a paragraph survive a split or a merge. It means
  nested lists and tables have no natural home — which is why they are out of scope.

---

## 2. The data model

### 2.1 Identity

```ts
/** A replica is one browser tab's editing identity for one document. Random 64-bit, base32. */
type ReplicaId = string;                       // e.g. "k7m2p9qa"

/** Every item is named once, forever, by who created it and their local counter. */
interface ItemId { replica: ReplicaId; seq: number }   // seq is contiguous per replica: 1, 2, 3 …
```

Item ids are **Lamport-free**: `seq` is a per-replica counter, not a global clock. Ordering between
replicas is decided by the tree, never by time. Wall clocks appear nowhere in the algorithm
(see §3.6 on wrong clocks).

Contiguity of `seq` is load-bearing: it is what lets a state vector (`replica → highest seq seen`)
describe *exactly* which operations a replica holds, and what makes "send me everything after
`seq` 412" a complete catch-up (§3).

### 2.2 The item

```ts
type Side = 'L' | 'R';

interface Item {
  id: ItemId;
  parent: ItemId | null;   // the Fugue origin; null only for the root sentinel
  side: Side;              // which side of the parent this item hangs on
  content: Char | BlockBoundary;
  deleted: boolean;        // tombstone flag — the node stays in the tree forever
  marks: MarkSet;          // per-character formatting, LWW (see 2.5)
}

/** One character. (A string, so run-length merging can arrive later without changing the type.) */
type Char = { kind: 'char'; text: string };

/** The end of a block. The block's attributes live here; the block's text is everything since the previous boundary. */
type BlockBoundary = { kind: 'block'; attrs: BlockAttrs };

interface BlockAttrs { type: 'paragraph' | 'heading' | 'bullet' | 'quote'; level?: 1 | 2 | 3 }
```

The document is a single flat sequence: `[c, c, c, ▮, c, c, ▮, …]` where `▮` is a boundary that
*closes* the block before it. A document always ends in a boundary (the root sentinel guarantees
one exists).

### 2.3 Ordering: the Fugue tree

The visible sequence is the **in-order traversal** of a tree whose root is a sentinel item:

```
traverse(node):
  for child in node.leftChildren  sorted by id ascending:  traverse(child)
  if not node.deleted: emit(node)      // tombstones are walked but not emitted
  for child in node.rightChildren sorted by id ascending: traverse(child)
```

`id ascending` means: compare `replica` as a string, then `seq` as a number. Any total order works
as long as every replica uses the same one.

**Insert rule.** A user inserts between `left` (the visible item before the cursor) and `right`
(the **next item in traversal order, tombstones included** — this detail is from the paper and
matters for convergence). Either may be the sentinel/end:

```
if left has no right children:   new.parent = left,  new.side = 'R'
else:                            new.parent = right, new.side = 'L'
```

That is the whole algorithm. Two consequences to be able to explain:

- **Typing forwards** makes a right-leaning chain: each new character is the right child of the
  previous one. Two users typing sentences concurrently at the same spot create two *chains*
  hanging from the same parent; siblings sort by id, so one whole sentence precedes the other.
  That is why forward interleaving cannot happen.
- **Typing backwards** (cursor at the start of the other user's text) uses the `else` branch and
  makes a left-leaning chain under the *right* neighbour. The Fugue paper proves this also cannot
  interleave with a concurrent chain. RGA, which only has a left origin, cannot express "I belong
  to the right neighbour" and interleaves here.

### 2.4 Deletion

`delete(id)` sets `deleted = true`. Nothing is unlinked. The item remains a legal parent for any
concurrent insert that used it as an origin — this is why tombstones are required, not a
laziness. The **delete operation carries no position**, only the target id, so it commutes with
every insert.

A tombstone's `content.text` may be dropped at snapshot time (§4.3). Its `id`, `parent` and `side`
may not.

### 2.5 Formatting

```ts
/** For each mark name, the last write wins, decided by a Lamport stamp then replica id. */
type MarkSet = Record<MarkName, { active: boolean; lamport: number; replica: ReplicaId }>;
type MarkName = 'bold' | 'italic' | 'code' | 'link';   // link carries `href` in a sibling field
```

A `format` operation names a *set of item ids* and a mark write. Converges because each cell is an
LWW register. This is the deliberately-simple choice discussed in §1.4; its anomaly is: user A
bolds "Hello", user B concurrently types "!" after "o" — B's "!" is not bold, even though a user
who bolded "Hello" and then typed "!" would expect it to be. Weft accepts this in v1 and the
demo does not hide it.

Block attributes (`BlockAttrs`) on a boundary item are one LWW register in the same way.

### 2.6 Operations

Everything that changes a document is one of four ops. Each carries the id of the replica that
generated it and its `seq`, so **the op id and the item id coincide for inserts**:

```ts
type Op =
  | { t: 'ins'; id: ItemId; parent: ItemId | null; side: Side; content: Char | BlockBoundary }
  | { t: 'del'; id: ItemId; target: ItemId }
  | { t: 'fmt'; id: ItemId; targets: ItemId[]; mark: MarkName; active: boolean; href?: string }
  | { t: 'blk'; id: ItemId; target: ItemId; attrs: BlockAttrs };
```

`del`, `fmt` and `blk` also consume a `seq` from the generating replica. This keeps "one contiguous
counter per replica" true for every op type, so a single state vector covers all of them.

**Causal dependency** is minimal and explicit: `ins` depends on `parent` existing; `del`/`fmt`/`blk`
depend on their `target`(s) existing. An op that arrives before its dependency is parked (§3.4).
There is no vector clock; contiguous per-replica `seq` plus explicit dependencies is sufficient
for a sequence CRDT and far cheaper.

### 2.7 Determinism of concurrent inserts at the same position — worked example

Replicas `a` and `b` both hold `[H, i]` and are offline. `a` types ` there` after `i`; `b` types
`!` after `i`.

- `a`: ` ` → right child of `i` (i had no right children). Then `t` → right child of ` `, etc.
- `b`: `!` → right child of `i` (from *b*'s view, `i` had no right children either).

On merge, `i` has two right children: `a:3` (the space) and `b:3` (`!`). Siblings sort by id:
`"a" < "b"`, so the traversal yields `Hi there!`. Both replicas compute the same traversal because
both hold the same tree. If `b`'s replica id had sorted first, both would show `Hi! there` — also
identical on both sides, which is the only guarantee a CRDT makes. Whose text comes first is
arbitrary; that both agree is not.

---

## 3. The sync protocol

### 3.1 Shape

```
Client A ──ws──▶ Server (relay + durable log) ◀──ws── Client B
```

The server is dumb on purpose: it **never interprets ops**. It appends them to a per-document
durable log, acknowledges once they are fsync'd, and forwards them to every other connected
replica of that document. All CRDT logic runs in clients. (The server *does* validate shape and
sequencing — §3.7 — because a hostile client is a real threat.)

### 3.2 State vectors

```ts
type StateVector = Record<ReplicaId, number>;   // highest contiguous seq held, per replica
```

Because seqs are contiguous, a state vector is a complete description of "what I have". The diff
between two state vectors is exactly the set of ops one side is missing. This is the same idea as
Yjs's sync protocol and it is the reason the whole document is never re-sent.

### 3.3 Messages (v1, JSON)

| Direction | Message | Purpose |
|-----------|---------|---------|
| C→S | `hello { proto: 1, doc, replica, sv }` | Identify and announce what I hold. |
| S→C | `welcome { proto: 1, sv, snapshot? }` | Server's state vector; a snapshot only if the client has *nothing* (fresh replica) and the log is long. |
| C→S | `ops { ops: Op[] }` | New local operations, in seq order. |
| S→C | `ops { ops: Op[] }` | Ops from other replicas (live) or missing ops (catch-up). |
| S→C | `ack { replica, seq }` | "Everything from you up to `seq` is fsync'd." **The only source of the Saved indicator.** |
| C→S / S→C | `presence { replica, cursor?, name, color }` | Ephemeral. Never logged. Dropped on disconnect. |
| S→C | `converged { sv, hash }` | Server's view after a quiet period; lets clients draw the convergence proof (§7). |
| S→C | `error { code, reason, fatal }` | Structured refusal; see wire format in the LLD. |

### 3.4 Reconnect after an hour offline

1. Client connects, sends `hello` with its state vector `svC`.
2. Server replies `welcome` with `svS`.
3. Client computes `ops_i_have_that_server_lacks = diff(svC, svS)` and sends them as `ops`.
4. Server computes `diff(svS, svC)` and streams the client's missing ops.
5. Both sides apply; ops whose dependency has not arrived yet wait in a **pending map** keyed by
   the missing id, and are drained the moment it lands (Yjs calls this "pending structs").
6. Server `ack`s the client's ops as they are fsync'd. Client marks them synced in IndexedDB.

Nothing above depends on message order between steps 3 and 4 — both directions run concurrently.

### 3.5 Knowing two replicas have converged

Equal state vectors ⇒ same set of ops ⇒ (by the CRDT's convergence invariant) same document. That
is the *proof*. For the demo, and as a runtime tripwire, the client also computes a
**content hash**: SHA-256 over the visible sequence (characters, boundaries, active marks, block
attrs). Two replicas with equal state vectors and different hashes have found a bug, and the UI
says so in red rather than pretending — that is the "honest degradation" rule applied to the
algorithm itself.

### 3.6 Failure modes, named

| Failure | Effect | Why it is safe |
|---------|--------|----------------|
| **Dropped** message | A replica lacks some ops. | The next `hello`/state-vector exchange repairs it. Live ops also carry seq, so a gap (`seq` 41 then 43) triggers an immediate targeted request. |
| **Duplicated** message | Same op arrives twice. | `apply` is idempotent: an item id already in the tree is ignored; a `del` on a tombstone is a no-op. |
| **Reordered / out-of-order** delivery | A child arrives before its parent. | Pending map (§3.4). Ops are applied only when their dependency exists; never dropped. |
| **Wrong clock** on a client | — | **Nothing in the algorithm reads a clock.** Ordering is by tree + id; identity is by counter. Wall time is used only to display "edited 3 min ago" and is labelled as client-reported. |
| **Replica reuses a seq** (bug or hostile) | Two different ops claim `a:7`. | Server rejects any op whose `seq` is not exactly `known + 1` for that replica; the client receives `error { code: 'SEQ_GAP' }` and must re-`hello`. Clients apply the same rule to the server. |
| **Server loses its log** | Server SV goes to zero. | Clients hold the full op log; the next `hello` re-uploads everything. The server is a cache with an fsync, not the source of truth. |

### 3.7 What the server validates (and why a dumb relay still validates)

Shape (schema), `proto` version, op `seq` contiguity per replica, that a replica only sends ops
*it* generated, size limits per message and per op, and rate limits per connection. It does
**not** validate that `parent` exists — it cannot without running the CRDT, and a dangling parent
is harmless (the op parks forever in the recipient's pending map and is bounded by §LLD 8).

---

## 4. The offline story

### 4.1 What is persisted, where

IndexedDB, one database per document (`weft:<docId>`), three object stores:

| Store | Key | Value | Written when |
|-------|-----|-------|--------------|
| `ops` | `[replica, seq]` | the `Op` | **Before** the op is sent to the server, in the same task as it is applied locally. |
| `meta` | `'me'`, `'synced'` | my `ReplicaId`; the server-acknowledged state vector | On replica creation; on every `ack`. |
| `snapshot` | `'latest'` | serialised tree with tombstone content stripped + the SV it represents | Every N ops or on idle, replacing the previous snapshot; old `ops` covered by the snapshot are pruned. |

### 4.2 The write path for one keystroke

```
keystroke → ProseMirror transaction → CRDT.localInsert → Op
   → apply to tree (memory)                 [document shows the character]
   → idb.ops.put(op)  (transaction commits) [durable on this device]
   → ws.send(ops)                           [in flight]
   → server fsync → ack                     [durable on server]  → "Saved" indicator
```

The UI shows three distinct states drawn from three distinct facts:
**pending** (in memory only), **on this device** (IndexedDB commit fired), **saved** (server ack).

### 4.3 What is lost in the worst case — the honest statement

The claim the resume line makes is *no lost edits*. Its precise, defensible form is:

> **No edit that has reached IndexedDB is ever lost, and no acknowledged edit is ever lost. An
> edit can be lost only if the browser process dies in the milliseconds between the keystroke and
> the IndexedDB commit, or if the browser evicts the origin's storage before the device is next
> online.**

Enumerated:

1. **Tab closed / browser crash mid-edit:** at most the ops whose IndexedDB transaction had not yet
   committed — in practice zero or one keystroke. On reopen, the tree is rebuilt from
   snapshot + ops and unsynced ops are re-sent.
2. **Machine power loss:** IndexedDB's default durability in Chromium is *relaxed* (data reaches
   the OS, not necessarily the platter). Same bound as (1) plus whatever the OS had not flushed.
   Weft does not use `durability: 'strict'` by default because it costs a fsync per keystroke; the
   LLD exposes it as a setting.
3. **Storage eviction:** browsers may evict an origin's data under disk pressure, and Safari
   deletes script-writable storage after 7 days without interaction. Weft calls
   `navigator.storage.persist()` and shows the result, and the status pill always shows the count
   of unsynced changes so the user knows what is at risk.
4. **Server disk loss:** nothing — clients re-upload (§3.6).
5. **A tombstoned character's text after snapshot:** intentionally dropped; it is not an edit.

Anything stronger than this would be a lie, and the README says exactly this.

**Observed 2026-09-05** (S4, `packages/client/test/store/tabKill.test.ts`, fake-indexeddb, seed
257000 — labelled *measured*, not a guarantee): 1 000 scripted tab kills at random points between
the keystroke and the IndexedDB `complete`, 1 949 keystrokes in all. **0 committed ops lost, 0
acknowledged ops lost, never a hole in the sequence.** 489 keystrokes were lost in total, all of them
ops whose transaction was still in flight at the kill; the worst single kill lost **3 keystrokes**,
which is exactly how many the script had fired without waiting for the previous commit (up to 3 in
flight at once). So statement (1) above holds as written — "at most the ops whose IndexedDB
transaction had not yet committed" — and its "in practice zero or one keystroke" is the human-speed
case: one transaction per keystroke, and a keystroke every ≥ 30 ms outlasts a commit; a burst
faster than the commit puts as many keystrokes at risk as the burst had in flight.

---

## 5. The architecture

### 5.1 Packages (one repo, npm workspaces, no shared code with any other project)

```
packages/
  crdt/       PURE  — Fugue tree, ops, apply, traversal, state vectors, content hash. Zero deps. No IO, no clock, no randomness (ids are passed in).
  protocol/   PURE  — message schemas, validation, versioning, JSON codec. Zero deps.
  client/     IO    — ProseMirror binding, IndexedDB store, WebSocket session state machine, presence, React shell.
  server/     IO    — WebSocket relay, per-document durable log, validation, rate limits.
```

Dependency direction: `client → crdt, protocol` · `server → protocol` · `crdt`/`protocol` depend
on nothing. The server never imports `crdt` — that is a design constraint, not an accident; it
keeps the server incapable of "helpfully" interpreting documents.

### 5.2 Where the CRDT lives and why it is pure

All merge logic runs in the client's `crdt` package. It is a pure function of (tree, op) → tree,
with ids and the "who typed what" supplied by the caller. That is what makes it:

- **property-testable**: generate random op sequences, apply in random orders, compare hashes;
- **replayable**: the demo's time-travel slider is `fold(apply, openedDocument, sessionOps.slice(0, n))`; position 0 is the state this tab opened, because compaction means v1 does not retain a complete cross-session log;
- **portable**: the same package runs in the browser and in a Node test with no shim.

### 5.3 The ProseMirror binding (the genuinely hard part)

ProseMirror holds a **tree of nodes** and emits **Steps** on a transaction. Weft holds a **flat
sequence of items**. The binding maintains a bidirectional map between the two:

- **Local edit:** for each `ReplaceStep`, resolve the affected range to item ids via a position
  index (`visibleIndex → ItemId`, rebuilt incrementally), emit `del`/`ins` ops, apply them, and let
  the transaction through unchanged.
- **Remote op:** apply to the tree, compute the minimal PM transaction (`insertText`, `delete`,
  `addMark`, `setBlockType`) from the diff of the traversal, dispatch it with a metadata flag so
  the binding does not treat it as a local edit.
- **Selections and cursors** are stored as **item anchors** (`ItemId` + side), not offsets, so
  they survive concurrent edits. Presence broadcasts anchors; the receiver maps them to positions.

The known hard problems, written down so the LLD can plan for them: schema mismatch (the CRDT
can express a document PM's schema rejects — e.g. a heading inside a quote — so the binding
normalises); undo (§0 A3); and *transactions that are not simple text edits* (paste of rich
content becomes many ops; drag-and-drop is disabled in v1).

`prosemirror-collab` — the road not taken — solves the same binding problem with a central
authority that rebases Steps. It is the right choice for a product with a server that must be
trusted anyway; it is the wrong choice for learning CRDTs, and it does not have a good offline
story.

### 5.4 Presence and cursors

An ephemeral **awareness** channel, separate from the op log: each replica broadcasts
`{ name, color, cursor: { anchor: ItemAnchor, head: ItemAnchor } }` on change, throttled. The
server fans it out and forgets it. A replica's presence disappears after a 30 s silence or on
socket close. Colour is assigned deterministically from the replica id so it is stable across
reconnects and identical on every screen.

---

## 6. What I am not building

Out, decided now, so it cannot creep back:

- Authentication, authorisation, sharing permissions, user accounts. (Anyone with the URL edits.)
- Comments, suggestions, track changes.
- Rich media: images, embeds, tables, nested lists, code blocks with highlighting.
- Peritext-style formatting semantics (§1.4).
- Cross-replica or collaborative undo. Local-only undo is a late slice.
- Multi-document workspaces, folders, search, titles beyond the first heading.
- End-to-end encryption; a distrusted server.
- Mobile apps; PWA install (service worker) — IndexedDB gives the offline *data* story; an
  installable shell is a separate concern.
- Binary wire/disk encoding (designed for, §0 A5; not built).
- Horizontal server scaling, multiple server nodes, pub/sub between servers.
- Anything that belongs to Zeno: approvals, policy, governed memory, agents, device pairing,
  a shared design system. Weft has its own tokens and shares nothing.

---

## 7. The demo (90 seconds)

Two browser windows side by side, one server, plus Weft's built-in **Sync Inspector** panel (state
vectors and content hash per replica, drawn from real data). The impressive moment is at 0:55.

| Time | Action | What the audience sees |
|------|--------|------------------------|
| 0:00 | Open the same doc in both windows. Type a line in each. | Two named cursors, live text, "Saved" pills. Ordinary. |
| 0:15 | Flip **Simulate offline** on window A (it closes the socket for real). Type a full sentence at the end of paragraph 2 in A. In B, type a *different* sentence at the *same* position. | A's pill: **"Offline · 31 changes on this device"**. B's pill: Saved. Inspector shows the two state vectors diverging. |
| 0:40 | In B, bold a word A is also editing and delete a word A just typed. | B is live; A is still dark and unaware. |
| 0:55 | Flip A back online. | Ops flow both ways in the Inspector. Both documents **snap to the same text**, sentences intact and not interleaved. Both hashes turn green **because the server's `converged` message carried matching hashes**, not because a timer fired. |
| 1:10 | Kill A's tab mid-word while offline (repeat the flip, type, close the tab). Reopen the URL. | The half-typed word is there. Pill: "Offline · 7 changes on this device". Go online: it syncs. |
| 1:25 | Drag the **time-travel** slider back 40 ops and forward. | The document replays operations applied since this tab opened, over the state it opened with. |

Optional 10-second coda for a technical audience: run the property test in a terminal
(`npm test -w @weft/crdt -- --reporter verbose`) and read the invariant names.

---

## 8. The risk list

| # | Risk | Early warning sign | Mitigation |
|---|------|--------------------|------------|
| R1 | **ProseMirror ↔ sequence mapping is subtly wrong** (positions drift after remote edits; the classic binding bug). | The `docMatchesTree` assertion (LLD invariant I7) fails in dev mode; cursor jumps one character after a remote insert before it. | Slice 3 exists solely to prove this. Assertion runs after every transaction in dev. |
| R2 | **Interleaving or ordering bug in the tree.** | The pairwise-convergence property test fails and shrinks to a small counter-example. | Fugue built first, alone, in slice 1 with the property suite; nothing else starts until it is green for 10 000 runs. |
| R3 | **Tombstone/metadata growth makes a long session sluggish.** | The 100k-op benchmark exceeds its budget (LLD 6.4); traversal is rebuilt from scratch per keystroke. | Incremental position index; snapshot with content stripping; run-length merging as the named v2 seam. |
| R4 | **IndexedDB semantics on a killed tab** are not what I assume. | Reopen test after `chrome://crash`-style kill shows missing ops. | Slice 4 has an interrupted-path test with `fake-indexeddb` and a manual kill script; the honest claim in §4.3 is written from what is *observed*. |
| R5 | **Enter / Backspace at block edges** produce wrong block structure under concurrency. | Property test with boundary items in the alphabet fails; PM schema rejects a normalised doc. | Boundary items are in the property-test alphabet from slice 1; normalisation rules are written in the LLD before the binding is coded. |
| R6 | **Scope creep** toward a "real editor" (tables, images, comments). | A slice's PR touches PM schema beyond §0 A1. | §6 is binding; every slice review checks it. |
| R7 | **Time.** 8–10 h/week and interviews. | A slice runs past its LLD estimate by 50 %. | Slices are ordered so that slices 1–3 alone are a complete, demoable, defensible artefact. Everything after is additive. |
| R8 | **Formatting anomaly (§2.5) gets called a bug in an interview.** | — | It is documented, demonstrated deliberately in the demo script's coda, and paired with the Peritext citation. Knowing the limitation *is* the point. |

---

## 9. Sources I will cite in an interview

- Weidner & Kleppmann, *The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing*, arXiv:2305.00583 (v3, 2025). https://arxiv.org/abs/2305.00583
- Kleppmann, Gomes, Mulligan, Beresford, *Interleaving anomalies in collaborative text editors*, PaPoC 2019. https://martin.kleppmann.com/papers/interleaving-papoc19.pdf
- Nicolaescu, Jahns, Derntl, Klamma, *Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types* (YATA / Yjs), CSCW 2016.
- Roh, Jeon, Kim, Lee, *Replicated abstract data types: Building blocks for collaborative applications* (RGA), JPDC 2011.
- Litt, Lim, Kleppmann, van Hardenberg, *Peritext: A CRDT for Collaborative Rich Text Editing*, Ink & Switch 2021 / CSCW 2022. https://www.inkandswitch.com/peritext/
- Gentle & Kleppmann, *Collaborative Text Editing with Eg-walker: Better, Faster, Smaller*, EuroSys 2025. https://arxiv.org/abs/2409.14252 — the "what comes after CRDT-or-OT" answer.
- Kleppmann, *Moving Elements in List CRDTs*, PaPoC 2020 — why moves are out of scope.
- Gomes, Kleppmann, Mulligan, Beresford, *Verifying Strong Eventual Consistency in Distributed Systems*, OOPSLA 2017 — why "proven" matters and what a property test approximates.
- Haverbeke, *Collaborative Editing in ProseMirror*. https://marijnhaverbeke.nl/blog/collaborative-editing.html — the central-authority argument, and the road not taken.
- Yjs `INTERNALS.md`, `y-protocols`, `y-indexeddb` — the engineering reference for state vectors, pending structs, and the 500-update snapshot trim.

The dated research briefs behind this document are in [research/](research/); the UI brief is
summarised in [03-UI.md](03-UI.md).

---

**STOP.** This is the end of Gate 1. Nothing in [02-LLD.md](02-LLD.md) is valid until the owner
writes "approved" against this document or names what changes.
