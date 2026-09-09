# Weft — the 90-second demo

The impressive moment is **convergence, not typing**: two windows, partitioned offline, then
reconciled with both sentences intact and the Sync Inspector's per-replica hashes turning green
because the server said so — not because a timer fired. Then time-travel, to show the current session's
operations replayed over the document as opened. This is the script from [01-DESIGN.md §7](01-DESIGN.md#7-the-demo-90-seconds), rehearsable
as written.

## Setup (before the clock starts)

```powershell
cd D:\code\Weft
npm install
npm run dev            # relay on 127.0.0.1:4200 + client on 127.0.0.1:5173
```

- Open **`http://127.0.0.1:5173`** — it redirects to a fresh `/d/<id>`. Copy that URL.
- Open the **same** URL in a second window. Put them side by side. Call them **A** (left) and **B**
  (right).
- In each window, open the **Sync Inspector** (the panel toggle at the top-right, or **⌘K → Toggle
  Inspector**). Leave the Inspector visible in both — it is the proof panel: one lane per replica
  with its state-vector chips and content-hash pill.

Both pills read **`● Saved`**. Both Inspectors show two lanes, hashes matching (green).

## The 90 seconds

| Time | Do this | The audience sees |
|------|---------|-------------------|
| 0:00 | Type a line in **A**, then a line in **B**. | Two named carets, live text flowing both ways, both pills `● Saved`. Ordinary — on purpose. |
| 0:15 | In **A**, open **⌘K → Simulate offline** (or flip the switch in the Inspector's Chaos panel). It closes A's socket for real. In **A**, type a full sentence at the end of a paragraph. In **B**, type a *different* sentence at the **same** position. | A's pill goes amber: **`● Offline · N changes on this device`** (N = what you typed). B stays `● Saved`. The two Inspectors' state vectors visibly diverge. |
| 0:40 | In **B** (still live), bold a word A is also editing and delete a word A just typed. | B keeps working; A is dark and unaware. This is the concurrent-edit conflict that kills naive editors. |
| 0:55 | In **A**, turn **Simulate offline** back off. | **The moment.** Ops flow both ways in the Inspector; both documents **snap to the same text**, the two sentences intact and *not interleaved*. Both hashes turn **green because the server's `converged`/`quiet` message carried matching hashes**, not because a timer fired. A's inline strip reads *"Back online — N offline edits merged."* |
| 1:10 | While offline again, kill **A**'s tab mid-word (⌘K → Simulate offline, type, close the tab). Reopen the URL. | The half-typed word is still there — it was committed to this device before the tab died. Pill: `● Offline · N changes on this device`. Turn Simulate offline off: it syncs. |
| 1:25 | In the rail's **History** panel, drag the time-travel slider back, then forward. | The document replays operations applied since this tab opened over its opening state. `Show authors` tints each person's characters in their own hue. Reloading starts a new session; durable cross-session versions are outside v1. |

## The technical coda (optional, +10 s)

Run the CRDT property tests and read the invariant names out loud — the guarantees are named, not
asserted by hand:

```powershell
npm test -w @weft/crdt
```

Or prove convergence with no browser at all — two headless replicas over a real socket, printing both
texts and both content hashes landing equal:

```powershell
node packages\client\examples\two-headless.mjs
```

## If a beat misbehaves

- **Nothing syncs when A comes back online.** Check `npm run dev` still shows the relay on 4200; the
  pill will say `● Reconnecting…` or `● Can't connect · CODE` if not — that is honest degradation, not
  a frozen demo.
- **The hashes never match after convergence.** That is the divergence tripwire's job to catch: a red
  `● Diverged — report` pill and an alert with both hashes would appear. It never has outside the
  Inspector's deliberate **Force divergence** trigger, which is there to *show* the tripwire.
- **`⌘K` opens a link box instead of the palette.** You had a text selection — Ctrl+K formats a link
  when text is selected and opens the palette otherwise. Click to collapse the cursor first.
