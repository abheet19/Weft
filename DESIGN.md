# Weft — the CRDT decision, and its trade-offs

This is the interview brief: the one hard design choice in Weft, argued, and the ways it is
deliberately worse than the tool I would reach for at work. It is a tightened, self-contained cut of
[docs/01-DESIGN.md §1](docs/01-DESIGN.md#1-the-crdt-decision-argued); the design document has the
full version, the data model, the sync protocol, and the sources. Nothing here is a measurement.

## The problem this is choosing between

Two people edit the same paragraph at the same time; one is offline for an hour. When they merge, no
edit may be lost, no one may be shown a "resolve conflict" dialog, and every device must end on the
**same** text without a central referee making a decision. There are two families of answer.

**Operational Transformation (OT).** Each edit is expressed against a document version; concurrent
edits are *transformed* against each other. Google Docs, Etherpad and ProseMirror's own
`prosemirror-collab` are OT. Every production OT uses a **central server as the single sequencer**,
because peer-to-peer OT needs a transformation property (TP2) that is famously hard to get right —
several published algorithms were later shown wrong.

**Conflict-free Replicated Data Types (CRDTs).** Each character carries a globally unique identity
and enough structure that *any* replica can merge *any* set of edits in *any* order and land on the
same state, with no sequencer. For text the family is WOOT, Treedoc, Logoot/LSEQ, RGA, YATA/Yjs, and
Fugue.

## The candidates, and where each interleaves

The anomaly an interviewer who knows CRDTs will ask about is **interleaving** (Kleppmann, Gomes,
Mulligan, Beresford, PaPoC 2019): two people offline each type a sentence at the same spot, and a bad
algorithm merges them as `HeWlolrold` instead of `Hello`+`World`. *Forward* = typed left-to-right;
*backward* = typed with the cursor moving left. Verdicts below are from the Fugue paper's Table 1 (it
showed the 2019 *definition* was unsatisfiable, defined **maximal** non-interleaving, and proved
FugueMax meets it); "conjectured" means exactly that.

| Algorithm | Position identity | Interleaving | Metadata / char | Tombstones |
|-----------|-------------------|--------------|-----------------|------------|
| WOOT (2006) | prev/next ids | forward: **found** | 2 refs + id | forever |
| Treedoc (2009) | path in binary tree | both | path (grows) | forever, needs rebalancing |
| Logoot / LSEQ (2010/13) | dense position vector | **arbitrary (both)** | vector (grows with depth) | none |
| RGA (2011) | id + left origin | forward: none · backward: **yes** | 1 ref + id | forever |
| YATA / Yjs (2016) | id + left **and** right origin | forward: none · backward: can occur¹ | 2 refs + id | ids kept, content GC'd |
| **Fugue (2023)** | id + parent + side | forward: **proven none** · backward: conjectured none | 1 ref + side + id | forever (ids) |
| FugueMax (2023) | Fugue + right origin | **proven maximally non-interleaving** | 2 refs + side + id | forever (ids) |

¹ YATA is proven forward-non-interleaving; the Fugue paper exhibits a backward, multi-replica case
where it can interleave. In practice this is rare and Yjs is excellent — it is the one point where
the algorithm Weft chose is at least as strong as Yjs, not merely simpler.

## The choice: Fugue, as an explicit tree

**Weft's CRDT is Fugue** (Weidner & Kleppmann, "The Art of the Fugue", 2023), built as a literal tree
of items read through an in-order traversal. The whole rule fits on a whiteboard:

```
insert between LEFT and RIGHT:
  if LEFT has no right children → new item is the RIGHT child of LEFT
  else                          → new item is the LEFT  child of RIGHT
siblings on the same side sort by id.  the document = in-order traversal.
```

Why Fugue over the rest:

- **One rule, derivable in an interview.** Convergence, causality, determinism and non-interleaving
  all fall out of that rule — I can derive the behaviour on a board, not recite it.
- **The cleanest provable answer to interleaving**, which is the anomaly that gets asked about. Plain
  Fugue is proven forward-non-interleaving; FugueMax is proven *maximally* non-interleaving and
  differs only when concurrent inserts share a left origin but differ on the right. Weft builds plain
  Fugue (its authors argue simplicity wins) and reserves a seam — `Item.rightOrigin` — so FugueMax is
  an upgrade, not a rewrite.
- **Constant metadata per character.** Unlike Logoot/Treedoc, ids never grow with document depth.
- **It maps onto Yjs's model** (Yjs items also carry left/right origins), so what I learn about Yjs's
  engineering — run-length merging, state vectors, delete sets — transfers.

**Why not OT.** It has genuinely better metadata and tombstone behaviour, and with a central server
it is simpler than any CRDT. But (a) the resume line says CRDT and I wanted to earn it; (b) OT's
correctness lives in transformation functions that are hard to test exhaustively, whereas a CRDT's
correctness is a **commutativity property** that property-based tests hammer directly; (c) an hour
offline is OT's worst case (a long rebase against every intervening op) and a CRDT's ordinary case.

## "Why not just use Yjs?"

> Because I wanted to *understand* it, and you don't understand a CRDT until you have shipped one and
> watched a property test find a bug in your ordering rule. Yjs is what I would use at work. Weft's
> CRDT is worse than Yjs in five concrete ways, and I can tell you what each one is.

1. **No run-length item merging.** Yjs merges consecutive characters from one client into one item; a
   10 000-word document is a few thousand items. Weft v1 stores one item per character, so a document
   of *N* characters is *N* tree nodes. This is the biggest gap; the LLD leaves a seam for it
   (`Item.content` is already a string, not a char).
2. **No compact binary encoding.** Yjs's v2 update format is dense and varint-packed; Weft v1 is
   JSON — many times larger on the wire and on disk.
3. **Weaker garbage collection.** Yjs drops deleted content and keeps only compressed id ranges. Weft
   keeps tombstone *ids* forever (they are tree nodes other items hang from) and strips content only
   at snapshot time.
4. **No ecosystem.** No battle-tested `y-prosemirror`, no awareness library, no undo manager, no
   subdocuments. Weft writes small versions of the first three.
5. **Years of performance work.** Yjs has been profiled on real workloads since 2016. Weft has a
   benchmark with a budget and nothing more.

Where Weft is **not** worse: the interleaving guarantee (note ¹), the readability of the core (one
file, one rule), and a numbered property test behind every invariant.

## Trade-offs accepted on purpose

- **Tombstones accumulate.** A document that has had 100 000 characters typed and deleted keeps
  100 000 ids. Mitigation: snapshots strip content from tombstones, and an item is a handful of
  fields. The 100k-op benchmark is the early-warning line.
- **Formatting is per-character last-writer-wins.** Bold over a range is a mark set on each character.
  Two people formatting the same range concurrently converge (LWW on a Lamport clock) but may not
  both get what they wanted. Peritext-style span semantics (Ink & Switch, 2021) are the correct
  answer and are **explicitly out of scope** — the second-most-likely follow-up, and the answer is "I
  know, and here is why I stopped short."
- **Block structure is flat.** A paragraph break is an item in the same sequence as characters (a
  *boundary item* carrying block attributes), so Enter and Backspace-at-start are ordinary inserts
  and deletes and concurrent edits survive a split or a merge. The cost is that nested lists and
  tables have no natural home — which is why they are out of scope.

## What this buys the product

Because the merge is a fact about the tree rather than a decision, "no lost edits" is defensible in a
precise form: an edit is applied on screen, then committed to this device (IndexedDB), then
acknowledged as durable by the server — three states Weft's status pill keeps **visibly** distinct,
so "no collaborators" and "cannot reach the server" never render the same. The convergence itself is
the demo: two windows partitioned offline, then reconciled with sentences intact and the Sync
Inspector's per-replica hashes turning green off the server's `converged` message — not a timer. See
[docs/DEMO.md](docs/DEMO.md).

---

<sub>Full design, data model, protocol and sources:
[docs/01-DESIGN.md](docs/01-DESIGN.md). Sources cited in
[§9](docs/01-DESIGN.md#9-sources-i-will-cite-in-an-interview): Fugue (Weidner & Kleppmann),
interleaving anomalies (Kleppmann et al.), YATA/Yjs, RGA, Peritext.</sub>
