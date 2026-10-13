
#!/bin/sh
set -eu

: "${TAILSCALE_DB_HOST:?Missing TAILSCALE_DB_HOST}"

KEY_FILE=/etc/secrets/tailscale-authkey
TS_DIR=/tmp/lume-tailscale
TS_SOCKET="$TS_DIR/tailscaled.sock"

if [ ! -r "$KEY_FILE" ]; then
  echo "ERROR: Tailscale auth key file unavailable"
  exit 1
fi

mkdir -p "$TS_DIR"

echo "Starting Tailscale..."

tailscaled \
  --tun=userspace-networking \
  --socket="$TS_SOCKET" \
  --state="$TS_DIR/state" \
  --socks5-server=127.0.0.1:1055 &

i=0
until [ -S "$TS_SOCKET" ]; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "ERROR: Tailscale daemon did not start"
    exit 1
  fi
  sleep 1
done

tailscale --socket="$TS_SOCKET" up \
  --auth-key="$(tr -d '\r\n' < "$KEY_FILE")" \
  --hostname=lume-render \
  --accept-dns=false

echo "Tailscale authenticated"


socat \
  TCP-LISTEN:15432,bind=127.0.0.1,reuseaddr,fork \
  EXEC:"ncat --proxy 127.0.0.1:1055 --proxy-type socks5 ${TAILSCALE_DB_HOST} 5432" &
  

echo "PostgreSQL gateway configured on localhost:15432"

exec node server.js
