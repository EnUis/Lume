#!/bin/sh
set -eu

# =====================================
# LUME — RENDER STARTUP
# Tailscale + PostgreSQL + Next.js
# =====================================

: "${TAILSCALE_DB_HOST:?Missing TAILSCALE_DB_HOST}"

KEY_FILE="/etc/secrets/tailscale-authkey"
TS_DIR="/tmp/lume-tailscale"
TS_SOCKET="$TS_DIR/tailscaled.sock"

SOCKS_PORT=1055
GATEWAY_PORT=15432
REMOTE_DB_PORT=5432

# =====================================
# CHECK TAILSCALE AUTHENTICATION KEY
# =====================================

if [ ! -r "$KEY_FILE" ]; then
    echo "ERROR: Tailscale authentication key missing"
    exit 1
fi

mkdir -p "$TS_DIR"

# =====================================
# START TAILSCALE
# =====================================

echo "Starting Tailscale..."

tailscaled \
    --tun=userspace-networking \
    --socket="$TS_SOCKET" \
    --state="$TS_DIR/state" \
    --socks5-server="127.0.0.1:$SOCKS_PORT" &

# Wait for Tailscale socket
i=0

until [ -S "$TS_SOCKET" ]; do
    i=$((i + 1))

    if [ "$i" -ge 30 ]; then
        echo "ERROR: Tailscale daemon failed to start"
        exit 1
    fi

    sleep 1
done

# =====================================
# AUTHENTICATE TAILSCALE
# =====================================

echo "Authenticating Tailscale..."

tailscale --socket="$TS_SOCKET" up \
    --auth-key="$(tr -d '\r\n' < "$KEY_FILE")" \
    --hostname=lume-render \
    --accept-dns=false

echo "Tailscale authenticated"

# =====================================
# TEST REMOTE POSTGRESQL CONNECTION
# =====================================

echo "Checking PostgreSQL reachability through Tailscale..."

if ncat \
    --proxy "127.0.0.1:$SOCKS_PORT" \
    --proxy-type socks5 \
    --wait 12 \
    --zero \
    "$TAILSCALE_DB_HOST" "$REMOTE_DB_PORT"
then
    echo "PostgreSQL TCP connection through Tailscale successful"
else
    echo "ERROR: Cannot reach PostgreSQL through Tailscale"
    echo "Check Tailscale access rules and PC database availability"
    exit 1
fi

# =====================================
# START POSTGRESQL LOCAL TCP GATEWAY
# =====================================

echo "Starting PostgreSQL TCP gateway..."

ncat \
    --listen 127.0.0.1 "$GATEWAY_PORT" \
    --keep-open \
    --sh-exec 'exec ncat --proxy 127.0.0.1:1055 --proxy-type socks5 "$TAILSCALE_DB_HOST" 5432' &

GATEWAY_PID=$!

sleep 1

if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "ERROR: PostgreSQL gateway process failed"
    exit 1
fi

echo "PostgreSQL gateway listening on localhost:$GATEWAY_PORT"

# =====================================
# START LUME APPLICATION
# =====================================

echo "Starting Lume web server..."

exec node server.js
