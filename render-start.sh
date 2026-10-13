#!/bin/sh
set -eu

# ==========================================
# LUME - RENDER PRODUCTION STARTUP
# Tailscale + PostgreSQL + Next.js
# ==========================================

: "${TAILSCALE_DB_HOST:?Missing TAILSCALE_DB_HOST}"
: "${DATABASE_URL:?Missing DATABASE_URL}"

KEY_FILE="/etc/secrets/tailscale-authkey"
TS_DIR="/tmp/lume-tailscale"
TS_SOCKET="$TS_DIR/tailscaled.sock"

SOCKS_PORT=1055
GATEWAY_PORT=15432
REMOTE_DB_PORT=5432

# ==========================================
# CHECK TAILSCALE AUTH KEY
# ==========================================

if [ ! -r "$KEY_FILE" ]; then
    echo "ERROR: Tailscale authentication key missing"
    exit 1
fi

mkdir -p "$TS_DIR"

# ==========================================
# START TAILSCALE DAEMON
# ==========================================

echo "Starting Tailscale..."

tailscaled \
    --tun=userspace-networking \
    --socket="$TS_SOCKET" \
    --state="$TS_DIR/state" \
    --socks5-server="127.0.0.1:$SOCKS_PORT" &

TS_PID=$!

# Wait for socket
i=0

until [ -S "$TS_SOCKET" ]; do
    i=$((i + 1))

    if [ "$i" -ge 30 ]; then
        echo "ERROR: Tailscale daemon failed to start"
        exit 1
    fi

    if ! kill -0 "$TS_PID" 2>/dev/null; then
        echo "ERROR: Tailscale daemon stopped"
        exit 1
    fi

    sleep 1
done

# ==========================================
# AUTHENTICATE TAILSCALE
# ==========================================

echo "Authenticating Tailscale..."

tailscale --socket="$TS_SOCKET" up \
    --auth-key="$(tr -d '\r\n' < "$KEY_FILE")" \
    --hostname=lume-render \
    --accept-dns=false

echo "Tailscale authenticated"

# ==========================================
# CHECK DATABASE NETWORK CONNECTION
# ==========================================

echo "Checking PostgreSQL through Tailscale..."

CONNECTED=false
ATTEMPT=1

while [ "$ATTEMPT" -le 5 ]; do

    echo "Database connection test $ATTEMPT/5"

    if ncat \
        --proxy "127.0.0.1:$SOCKS_PORT" \
        --proxy-type socks5 \
        --wait 10 \
        -z \
        "$TAILSCALE_DB_HOST" "$REMOTE_DB_PORT"
    then
        CONNECTED=true
        break
    fi

    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
done

if [ "$CONNECTED" != "true" ]; then
    echo "ERROR: PostgreSQL is unreachable through Tailscale"
    echo "Check Tailscale ACLs, Windows Tailscale Serve, and PostgreSQL"
    exit 1
fi

echo "PostgreSQL TCP connection successful"

# ==========================================
# START LOCAL POSTGRESQL GATEWAY
# ==========================================

echo "Starting PostgreSQL gateway..."

ncat \
    --listen 127.0.0.1 "$GATEWAY_PORT" \
    --keep-open \
    --sh-exec 'exec ncat --proxy 127.0.0.1:1055 --proxy-type socks5 "$TAILSCALE_DB_HOST" 5432' &

GATEWAY_PID=$!

sleep 2

if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "ERROR: PostgreSQL gateway failed to start"
    exit 1
fi

echo "PostgreSQL gateway listening on 127.0.0.1:$GATEWAY_PORT"

# ==========================================
# START LUME WEBSITE
# ==========================================

echo "Starting Lume web server..."

exec node server.js
# START LUME APPLICATION
# =====================================

echo "Starting Lume web server..."

exec node server.js
