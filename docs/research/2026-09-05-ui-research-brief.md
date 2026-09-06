# Weft — UI research brief

*Compiled 2026-09-05 from ~40 web searches and fetches by a research pass. Dated because research
briefs go stale; re-verify any link before quoting it in an interview. This informs
[../03-UI.md](../03-UI.md); where the two disagree, 03-UI.md wins.*

---

## 1. Best-in-class collaborative editor UIs

### Notion
- **Presence:** avatar stack top-right; avatars **fade to ~50% when the person isn't currently looking at the page**, full opacity when active. Hover shows name, email, "last seen" time. **Click an avatar to jump to the block they're on.** Avatars also appear next to the block being edited and follow the person block-to-block. ([Notion help](https://www.notion.com/help/collaborate-within-a-workspace))
- **Concurrency honesty:** Notion says plainly "the most recent change will be reflected" when two people edit one block — LWW, not CRDT merging. Weft *does* merge, so it should say so.
- **Offline (Aug 2025, v2.53):** per-page "Available offline" toggle; an **"Offline" pill at the top with a count of edits pending sync**. ([Notion release](https://www.notion.com/releases/2025-08-19))
- **Worth stealing:** faded-vs-solid avatar for "on page vs. elsewhere"; pending-edit count as a number, not a spinner.

### Linear (docs)
- Cursors shown when another user is editing or viewing; "last edited … by …". Agent-written text highlighted separately; authorship display is a toggle. ([Linear docs](https://linear.app/docs/documents))
- **Sync status:** the word **"Syncing" next to the workspace name, with a count of pending changes**. Linear openly documents that offline is "a failsafe and not a full-fledged feature" and *can overwrite teammates' changes*. ([Linear](https://linear.app/docs/get-the-app))
- **Worth stealing:** the "Syncing · 3" count; authorship as a toggle.

### Google Docs
- One colour per collaborator per session; anonymous users get "Anonymous Animal" names. Name flag appears above the caret on movement/hover.
- **History:** right sidebar, versions grouped by date; "Show changes" toggle; **additions highlighted in the editor's colour, deletions struck through**; named versions; "Restore this version". ([Google support](https://support.google.com/docs/answer/190843))
- **Anti-pattern:** "Saving…" / "All changes saved in Drive" conflates local-vs-server.

### Tiptap / Hocuspocus
- CollaborationCaret default CSS: caret is `1px solid` left+right borders, `pointer-events: none`; label `font-size: 12px; font-weight: 600; border-radius: 3px 3px 3px 0; top: -1.4em`, background = user colour. **No default fade/idle behaviour.** ([Tiptap](https://tiptap.dev/docs/editor/extensions/functionality/collaboration-caret))
- Provider exposes `onStatus` (connecting/connected/disconnected), `onSynced`, `onAwarenessUpdate`. Good model for Weft's session API. ([Hocuspocus](https://tiptap.dev/docs/hocuspocus/provider/events))

### Yjs / y-prosemirror
- `yCursorPlugin` reads `awareness.user = {name, color}`; `cursorBuilder` replaces the DOM. ([y-prosemirror](https://github.com/yjs/y-prosemirror))
- demos.yjs.dev has a **"ProseMirror with Version History"** demo: snapshot list + per-user coloured diff. ([demos](https://demos.yjs.dev/))

### Automerge
- `@automerge/prosemirror` playground; deliberately bare UI. ([Playground](https://automerge.org/automerge-prosemirror/))

### Liveblocks
- Cursor and avatar **share colour and name from the same identity object**; spring-animated cursors. ([examples](https://liveblocks.io/examples/browse/cursors))

### Zed
- Collaborators in the same project are coloured, others grey; click an avatar to *follow*; **a following pane is outlined in that person's cursor colour**; following stops as soon as you move or type. ([Zed](https://zed.dev/docs/collaboration/channels))

---

## 2. Apple "Liquid Glass" (WWDC25) and web implementation

### What it actually is
- **Lensing** is the defining trait: the material bends and concentrates light rather than diffusing it like a blur.
- **Specular/adaptive highlights** respond to geometry; on interaction the element "illuminates from within".
- **Adaptive tint:** tint only primary actions, never everything.
- **Adaptive shadow:** shadow opacity increases over text, decreases over plain backgrounds.
- **Regular vs Clear:** Regular is default; Clear only over bold media; never mixed.
- **Layering rules:** glass is for the **navigation layer** (toolbars, tab bars, menus, sidebars) floating above content — **"Keep it out of the content layer."** **"Always avoid glass on glass."**
- **Accessibility:** Reduce Transparency → frostier/opaque; Increase Contrast → contrasting borders; Reduce Motion → no elastic morph. ([WWDC25 219](https://developer.apple.com/videos/play/wwdc2025/219/), [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass))
- **Legibility critique:** independent audits measured text on glass as low as **1.5:1** vs the 4.5:1 WCAG floor. Fix: a semi-opaque scrim under text, or keep text on solid layers. ([Infinum](https://infinum.com/blog/apples-ios-26-liquid-glass-sleek-shiny-and-questionably-accessible/), [CSS-Tricks](https://css-tricks.com/getting-clarity-on-apples-liquid-glass/))

### Open-source web implementations
1. **LeonardSEO/liquid-glass-react**: `backdrop-filter: blur() url(#filter)` with `feDisplacementMap` driven by a pre-generated signed-distance-field PNG; negative scale = magnification; Chromium only; Safari/Firefox degrade to `blur() saturate()`. ([repo](https://github.com/LeonardSEO/liquid-glass-react))
2. **dpawlikowski/liquid-glass**: `feTurbulence + feDisplacementMap`; auto-pauses under `prefers-reduced-motion`; guidance: displacement 12–18, **one or two animated surfaces per page**. ([repo](https://github.com/dpawlikowski/liquid-glass))
3. **PallavAg/liquid-glass-web-react**, **samasante/liquid-glass**: filter the element (mirrored DOM) for Safari/Firefox support at the cost of duplicating content.
4. **glincker/glinui**: Radix+Tailwind components; feDisplacementMap in Chrome, blur+saturate elsewhere.
5. CodePen recipes for the cheap version — `backdrop-filter: blur(5px) saturate(1.5)`, gradient 1px border, inset white top highlight. ([roundup](https://freefrontend.com/css-liquid-glass/))

### Performance and fallbacks
- Cost scales with **blurred pixel area × radius**; stacked blur layers multiply. Chrome can flicker with large backdrop-filter regions.
- `prefers-reduced-transparency`: Chrome 118+, not Baseline — progressive enhancement plus a manual toggle. ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency))
- Minimal safe recipe:
  ```css
  .glass{background:oklch(20% 0 0/.55);backdrop-filter:blur(14px) saturate(1.4);
    box-shadow:inset 0 1px 0 oklch(100% 0 0/.18), 0 8px 24px oklch(0% 0 0/.35)}
  @supports not (backdrop-filter:blur(1px)){.glass{background:oklch(20% 0 0/.96)}}
  @media (prefers-reduced-transparency:reduce){.glass{backdrop-filter:none;background:var(--surface)}}
  ```

---

## 3. Modern UI standards 2025–2026
- **Type:** Geist Sans/Mono or Inter for UI; JetBrains Mono for op logs. Utopia fluid scale via `clamp()`. ([Geist](https://vercel.com/geist/typography), [Utopia](https://utopia.fyi/type/calculator/))
- **Tokens:** Design Tokens spec 2025.10 stable, OKLCH colour module. ([DTCG](https://www.designtokens.org/tr/drafts/color/))
- **Motion tokens:** ~150 ms hover, ~300 ms state change, ~500 ms view transition; encode intent.
- **Focus:** `:focus-visible { outline: 2px solid; outline-offset: 2px }`, ≥3:1 vs both element and background; WCAG 2.2 Focus Not Obscured.
- **States:** skeletons only for container content; empty state = one sentence + primary action; errors inline and persistent, **never auto-dismissing toasts**.
- **Command palette:** ⌘K/Ctrl+K, type immediately, grouped by category, real dialog for focus trap.

---

## 4. Honest status UX — exact copy and iconography
- **Figma:** "Your file has unsaved changes" / "This document contains unsaved changes. These changes are saved locally and will sync when Figma reconnects" / on reconnect "Offline changes synced" — "Dismiss" / "Review". ([Figma help](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma))
- **Obsidian Sync:** status-bar icon, four states with colour: **Synced (green)**, **Syncing (purple)**, **Paused (purple)** "paused, but still connected", **Disconnected (red)**. ([Obsidian](https://obsidian.md/help/sync/messages))
- **Linear:** "Syncing" + count; nothing shown when idle.
- **Notion:** "Offline" pill + pending-edit count; faded avatar = not viewing.
- **Pattern to copy:** Obsidian separates *paused-but-connected* from *disconnected*; Figma separates *saved locally* from *synced*. Nobody in this set separates "connected, alone" from "connected, N peers" — that is Weft's opening.

---

## 5. CRDT visualisation for a demo
- **AntidoteDB crdt-visualizer:** replicas as horizontal timelines, ops as nodes, merge = drag an arrow between timelines. ([repo](https://github.com/AntidoteDB/crdt-visualizer))
- **Peritext (Ink & Switch):** characters as tiles labelled with opIds like `9@B`, Alice/Bob colour-coded, step-by-step merge figures. ([Peritext](https://www.inkandswitch.com/peritext/))
- **Fugue (Weidner):** tree diagrams with nodes as (replica, counter), L/R children, in-order traversal = document. ([post](https://mattweidner.com/2022/10/21/basic-list-crdt.html), [paper](https://arxiv.org/pdf/2305.00583))
- **Kleppmann "CRDTs: The Hard Parts":** the canonical interleaving anomaly. ([talk](https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html))
- **Yjs version demo** and **Loro devtools** show that a *version DAG* view is now expected of serious CRDT libs.

---

## Recommendations for Weft (prioritised)

1. **One identity object drives everything.** `{name, color}` assigned once per replica from a fixed 8-hue OKLCH palette feeds avatar, caret, selection, history diff, and follow-frame.
2. **Status pill, four explicit states (Obsidian-style colour + word):** `● Saved` (green), `● Syncing · 3` (blue, count of unacked ops), `● Offline — N changes on this device` (amber), `● Reconnecting…` (amber). Never "Saving…" without saying *where*.
3. **Separate the peers indicator from the connection indicator.** Avatar stack shows `Only you` when connected-and-alone, `+3` when peers exist, and a ghost avatar with a slash when *disconnected* — so "no collaborators" never looks like "broken".
4. **Caret: 2 px bar + name flag that fades.** Flag on remote movement for 1.5 s and on hover; caret fades to 40% after 30 s idle.
5. **Selections at 25% alpha** of the user colour.
6. **Follow mode (Zed):** click avatar → viewport tracks their caret; editor gets a 2 px frame in their colour; any keystroke exits follow.
7. **Faded avatar = elsewhere**, tooltip "Last active 2 min ago".
8. **Reconnect banner is inline, not toast:** `Back online — 12 offline edits merged. Review`.
9. **Glass only on the navigation layer:** top bar, floating format bar, ⌘K dialog, status pill. **Editor surface and panels are opaque.** Never glass on glass. Cap at 2–3 glass regions.
10. **Glass recipe = blur 12–16 px + saturate 1.4 + inset 1 px top highlight + 1 px gradient border + adaptive scrim.** Displacement refraction only on the ⌘K dialog as a Chromium-only enhancement. Honour reduced transparency and motion.
11. **Text never sits on raw glass** — inner fill at ≥60% alpha under labels.
12. **Dark-first OKLCH tokens**; one accent hue; Geist Sans + JetBrains Mono.
13. **Motion tokens:** 120 / 220 / 400 ms; disabled under reduced motion.
14. **⌘K palette** with groups *Document / Collaboration / History / Debug*; "Simulate offline", "Toggle op log" so the demo is keyboard-driven.
15. **History panel (opaque):** per-author coloured insertions and struck deletions; time-travel.
16. **"Convergence" demo panel:** replica lanes, ops as chips `7@A`, live footer `A ≡ B ✓ converged` or `A ≠ B (2 ops in flight)`.
17. **States, not spinners:** skeleton lines for doc load only; connection errors inline in the pill's popover with the last error and a "Retry" button.
