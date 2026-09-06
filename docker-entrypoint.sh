#!/bin/sh
# docker-entrypoint.sh — start the relay bound to 127.0.0.1:4200 in the background, then run Caddy in
# the foreground as PID 1 on the public port. The relay's bind is fixed (127.0.0.1, a string-literal
# type); only Caddy faces the network. If the relay exits, bring the whole container down so the
# platform restarts it — a Weft edge with a dead relay is not healthy.
set -eu

: "${PORT:=8080}"
: "${WEFT_DATA_DIR:=/data}"
export PORT WEFT_DATA_DIR
export WEFT_PORT=4200

mkdir -p "$WEFT_DATA_DIR"

# The relay takes an exclusive pid-keyed lock in the data dir so two relays never share one log. That
# guard is for many processes on a host; here exactly ONE relay ever runs per data dir — this
# container's. Across a `restart`, the container recycles pids, so the previous run's lock can name a
# pid that now belongs to an unrelated live process and the relay would refuse to start. A lock
# present at container boot is therefore always stale (the prior relay is gone with the prior
# container process), so clear it before starting. Relay source is untouched.
rm -f "$WEFT_DATA_DIR/.weft-server.lock"

node /app/packages/server/src/main.ts &
relay=$!

# One unit: a SIGTERM/SIGINT to the container stops the relay too, and if the relay dies on its own
# we signal PID 1 (Caddy, after the exec below) so the container exits and the platform restarts it.
trap 'kill "$relay" 2>/dev/null || true' TERM INT
( wait "$relay"; echo "weft: relay exited, stopping edge" >&2; kill 1 2>/dev/null || true ) &

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
