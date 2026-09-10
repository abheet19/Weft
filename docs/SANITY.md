# Weft — sanity, acceptance, and release guide

> Snapshot: 10 September 2026 IST. Run this against disposable or synthetic data. Save the branch, commit, complete dirty-path list, command, exit code, environment, and artifact hashes with every result.

## Before running

Use a disposable document ID and isolated browser contexts. Never place private content in the public demo. The repository gate starts local services for Playwright; do not infer a live release from that run.

```powershell
Set-Location 'D:\Code\Weft'
npm ci
npm run docs:check
npm run check
```

## Product sanity checklist

- [ ] Two peers converge after simultaneous online edits.
- [ ] One peer goes truly offline, both continue editing, reconnect catches up, and both reach the same canonical hash/content.
- [ ] Syncing / On device / Saved labels correspond to memory, IndexedDB, and durable server acknowledgement.
- [ ] All formatting/link/block/undo controls work; unsafe links fail before shared state changes.
- [ ] Outline, People/follow, Sync diagnostics, History/return-live, command palette, themes, rename/new-doc, and sidebar controls work by keyboard.
- [ ] 320/390 px layout exposes primary editor and actions without page overflow or focus trap.
- [ ] Relay restart/reconnect, duplicate/out-of-order delivery, message drops, malformed/oversized frames, and pending-overflow states fail visibly.

## Retained evidence for the current candidate

- `verification-work/weft-final-check.log` SHA-256 `8E071062…3EC2`: 612 distinct Vitest + 28 Playwright, all passing.
- `docs/VERIFICATION.md`: 13 docs checks, independent desktop/mobile probes, Lighthouse, and explicit limits.
- Fly v17 is mapped to base `45836e8...`; branding commit `8258d59` remains local.

## Release sequence

1. Review branding commit `8258d59` and freeze the accompanying documentation commit.
2. Rerun docs/check, image build, health, two-peer/offline/mobile, and benchmark gates at that commit.
3. Deploy with explicit approval; record source, CI, Fly image/release/machine, and post-deploy smoke.
4. Retain v17 and verify rollback plus log/data compatibility before removing the candidate.

## Claims this guide does not establish

- No accounts, permissions, E2EE, private-document guarantee, rich-table/image support, multi-region durability, or recovery drill.
- No public soak or field performance evidence; branding commit `8258d59` is not deployed in Fly v17.

A green local run is evidence for the exact tested tree. Call a feature deployed only after recording `source commit -> CI run -> image/release -> post-deploy smoke` for the same bytes.
