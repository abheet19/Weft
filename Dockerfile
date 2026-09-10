# Dockerfile — Weft as ONE hostable web app: the static Vite client and the relay behind a single
# Caddy edge on one public port. Nothing here edits relay/CRDT source.
#
# Two stages:
#   build   — npm ci, then build the client bundle with a SAME-ORIGIN wss URL baked in
#             (VITE_WEFT_WS is inlined by Vite at build time) and stage the relay's TypeScript.
#   runtime — Node 22 + the static Caddy binary. The relay runs straight from .ts (Node 22 strips
#             types, exactly as the repo runs it in `npm run dev:server` — there is no server
#             transpile step to reproduce). It binds ONLY 127.0.0.1:4200 (a string-literal type
#             it cannot widen); Caddy is the only thing on a public interface and reverse-proxies
#             the /ws path to that loopback relay.

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Manifests first so the dependency layer caches across source edits.
COPY package.json package-lock.json ./
COPY packages/crdt/package.json      packages/crdt/package.json
COPY packages/protocol/package.json  packages/protocol/package.json
COPY packages/server/package.json    packages/server/package.json
COPY packages/client/package.json    packages/client/package.json
RUN npm ci

# Sources (node_modules is excluded by .dockerignore), then build the client.
# VITE_WEFT_WS MUST be the same origin the browser loads from, on the proxied /ws path; it is
# inlined into the bundle here and cannot be changed afterwards without a rebuild.
COPY . .
ARG VITE_WEFT_WS=ws://localhost:8080/ws
RUN VITE_WEFT_WS="$VITE_WEFT_WS" npm run build -w @weft/client

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ARG WEFT_RELEASE_SHA=unknown
ENV NODE_ENV=production
ENV WEFT_RELEASE_SHA=$WEFT_RELEASE_SHA

# The static Caddy binary from the official image — no download step, no package manager. Caddy's
# release binaries are statically linked, so the alpine-built binary runs on this Debian slim base.
COPY --from=caddy:2-alpine /usr/bin/caddy /usr/bin/caddy

# The relay's runtime footprint: `ws` (its only npm dependency) and the pure @weft/protocol package
# (@weft/crdt is never imported — I14). @weft/protocol is reached through a node_modules symlink
# whose realpath is OUTSIDE node_modules, so Node's type-stripping applies to its .ts sources.
COPY --from=build /app/node_modules/ws                 /app/node_modules/ws
COPY --from=build /app/packages/protocol/package.json  /app/packages/protocol/package.json
COPY --from=build /app/packages/protocol/src           /app/packages/protocol/src
COPY --from=build /app/packages/server/package.json    /app/packages/server/package.json
COPY --from=build /app/packages/server/src             /app/packages/server/src
RUN mkdir -p /app/node_modules/@weft \
 && ln -s ../../packages/protocol /app/node_modules/@weft/protocol

# The built client, the edge config, and the entrypoint.
COPY --from=build /app/packages/client/dist   /srv/www
COPY Caddyfile                                /etc/caddy/Caddyfile
COPY docker-entrypoint.sh                     /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The relay's fsync'd per-document logs live here; mount a volume to persist them across restarts.
ENV WEFT_DATA_DIR=/data
VOLUME ["/data"]

# Caddy's public port (overridable). The relay's 4200 is loopback-internal and never published.
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
