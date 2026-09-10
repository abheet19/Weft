# Deploying Weft

## Current existing app — 2026-09-10

Routine releases target **`weft-abheet`** in `sin`; do not run first-install app/database/volume creation again. From this repository, after passing `npm run check` and `npm run docs:check`:

```powershell
$sha = git rev-parse HEAD
fly deploy --app weft-abheet --remote-only --depot=false --build-arg WEFT_RELEASE_SHA=$sha
fly status --app weft-abheet
fly checks list --app weft-abheet
fly logs --app weft-abheet --no-tail
```

The commands below this section describe bootstrap/self-hosting. GitHub release automation waits for successful CI on main and uses its exact `head_sha`; it does not deploy every unvalidated push. The pre-commit hook runs lint/typecheck; the full suite is a separate local/CI gate. See [current verification](VERIFICATION.md) for executed scope.

`fly.toml` polls `GET /health` every 15 seconds with a 3-second timeout after a 20-second grace period. Caddy returns `status` plus the `WEFT_RELEASE_SHA` injected into the image. `docker-entrypoint.sh` supervises the relay and Caddy as one process unit: if the relay exits, Caddy stops and the probe fails. Compare `/health.release` with the reviewed commit after every deploy. The probe cannot detect a relay that remains alive but stops making progress, so the public two-peer WebSocket smoke is still required. Run `WEFT_RELEASE_SHA=<full-sha> npm run smoke:live` after the health check; `WEFT_BASE_URL` overrides the default public origin.

For rollback, record the previous image reference before releasing and use `fly deploy --app weft-abheet --image <previous-image-reference>` if needed. Image rollback does not roll back persistent data/migrations. That recovery command was documented, not exercised. `fly secrets list` reveals names only; it cannot retrieve secret values.


Weft ships as **one container**: the static client and the relay behind a single [Caddy](https://caddyserver.com)
edge on one port. The relay binds only `127.0.0.1:4200` (a hard invariant of its type); Caddy is the
only thing on a public interface and reverse-proxies the WebSocket path `/ws` to that loopback relay.
The document id travels in-protocol (the `hello` frame), never in the URL, so a deep link is just
`/<edge>/d/<docId>`.

Caddy sends `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` on public responses. Weft is
a standalone editor, so it has no embedding contract; refusing frames also avoids clickjacking around
the anonymous editing surface.

Two build arguments are release-critical: **`VITE_WEFT_WS`** decides where the browser opens its socket and **`WEFT_RELEASE_SHA`** identifies the immutable source in `/health`. `VITE_WEFT_WS` is inlined into the bundle at
build time. It must be the *same origin* the page is served from, on the `/ws` path
(`ws://localhost:8080/ws` locally, `wss://<your-app>/ws` behind TLS). Change it and you must rebuild.

---

## A. Local / self-host — `docker compose`

```sh
docker compose up --build          # build the image and start the edge on :8080
```

Then:

1. Open <http://localhost:8080> — it redirects to a fresh `/d/<id>`.
2. Copy that URL into a **second tab** (same `/d/<id>`).
3. Type in either tab: edits converge live. The pill reads **Saved** once acknowledged.
4. Prove persistence:

   ```sh
   docker compose restart          # relay restarts; the /data volume is retained
   ```

   Reload both tabs — the document's text is still there. It was replayed from the relay's fsync'd
   append log on the named volume `weft_data`, not from the browsers.

Stop and clean up:

```sh
docker compose down                # keeps the volume (and your documents)
docker compose down -v             # ALSO deletes the volume — documents are gone
```

Notes:

- Only `8080` is published. The relay's `4200` is loopback-inside-the-container and unreachable from
  the host — every socket goes through Caddy.
- To serve on another port, change the `ports:` mapping **and** `PORT`, and rebuild with a matching
  `VITE_WEFT_WS` (e.g. `--build-arg VITE_WEFT_WS=ws://localhost:9000/ws`), because the URL is baked in.

---

## B. Go live on Fly.io

Fly terminates TLS and forces https, so the bundle must be built with the **wss** origin of your app.
`fly.toml` sets `app = "weft-abheet"`, `primary_region = "sin"` (Singapore), and
`VITE_WEFT_WS = "wss://weft-abheet.fly.dev/ws"` under `[build.args]`. If you pick a different app name,
change BOTH the `app` line and that host (and the `build-args` in `.github/workflows/release.yml`) to match.

Ordered, first deploy:

```sh
# 1. Create the app (reuses this fly.toml's name/region).
fly apps create weft-abheet

# 2. Create the volume the relay's logs live on (single, 1 GB, in the app's region).
fly volumes create weft_data -r sin -n 1 -s 1 -a weft-abheet

# 3. Deploy: builds the Dockerfile remotely and boots one machine.
fly deploy -a weft-abheet
```

Open the printed `https://<app>.fly.dev`, and repeat the two-tab convergence check from section A.
`min_machines_running = 1` and `auto_stop_machines = false` keep the relay up so it can fan out edits;
`force_https = true` upgrades the page and the socket to TLS.

### Enable automatic deploys from CI

`.github/workflows/release.yml` builds and pushes the image to `ghcr.io/abheet19/weft` after successful CI
on `main`, then deploys to Fly **only if** a `FLY_API_TOKEN` secret exists (until then the deploy job
is skipped cleanly — the image still publishes). To turn it on:

```sh
fly tokens create deploy          # prints a token
```

Add it as a repo secret named **`FLY_API_TOKEN`** (GitHub → Settings → Secrets and variables →
Actions → New repository secret). The next push to `main` deploys.

### Free-tier reality (honest)

Fly no longer offers a standing free allowance; a small always-on machine (`shared-cpu-1x`, 256 MB)
plus a 1 GB volume is a low-single-digit-dollars-per-month affair, and it is billed. Because a relay
must stay resident to fan out edits, the usual cost-saver — scale-to-zero — is off
(`auto_stop_machines = false`), so you are paying for one machine to stay up. If you only need the
self-host path, section A costs nothing beyond your own hardware. The GHCR image is public and free
to pull regardless.
