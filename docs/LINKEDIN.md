> Draft — attach docs/media/weft-demo.gif and vantage-demo.gif as the post's media; not yet posted.

---

I shipped two projects I've wanted to build properly for years — both live, both with one hard idea I refused to hand-wave.

**Weft** is a real-time collaborative editor. The hard part isn't the cursors — it's that two people editing the same line offline must merge to the exact same document, with nothing lost. So I wrote a Fugue CRDT from scratch: every character has a permanent identity and hangs off the one it was typed after, which makes the merge a deterministic fact about a tree rather than a race. Offline-first, with a property test per invariant.
→ https://weft-abheet.fly.dev

**Vantage** lets you ask product questions in plain English and trust the number. The guardrail is structural, not a prompt: the model can only fill a typed spec, which a compiler turns into a parameterised, read-only SELECT run as a restricted role. The AI answers in English — but can never emit arbitrary SQL.
→ https://vantage-abheet.fly.dev

Short reels of each are attached. I'd genuinely love to hear how you'd have approached either problem — especially the CRDT merge.

#CRDT #DistributedSystems #TypeScript #LLM #SoftwareEngineering
