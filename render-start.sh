
#!/bin/sh
set -eu

# ==========================================
# LUME - RENDER STARTUP
# Tailscale TCP Gateway + PostgreSQL + Web
# ==========================================

: "${TAILSCALE_DB_HOST:?TAILSCALE_DB_HOST is missing}"
: "${DATABASE_URL:?DATABASE_URL is missing}"

KEY_FILE="/etc/secrets/tailscale-authkey"
TS_DIR="/tmp/lume-tailscale"
TS_SOCKET="$TS_DIR/tailscaled.sock"

GATEWAY_PORT=15432
REMOTE_DB_PORT=5432

# ==========================================
# VALIDATE SETTINGS
# ==========================================

echo "Validating database configuration..."

node - <<'JS'
const url = new URL(process.env.DATABASE_URL);

if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "15432" ||
  url.pathname !== "/lume_pc"
) {
  console.error(
    "ERROR: DATABASE_URL must point to 127.0.0.1:15432/lume_pc"
  );
  process.exit(1);
}

console.log("Database URL configuration valid");
JS

if [ ! -r "$KEY_FILE" ]; then
    echo "ERROR: Tailscale auth key file missing"
    exit 1
fi

mkdir -p "$TS_DIR"

# ==========================================
# START TAILSCALE
# ==========================================

echo "Starting Tailscale..."

tailscaled \
    --tun=userspace-networking \
    --socket="$TS_SOCKET" \
    --state="$TS_DIR/state" &

TS_PID=$!

i=0
until [ -S "$TS_SOCKET" ]; do
    i=$((i + 1))

    if [ "$i" -ge 30 ]; then
        echo "ERROR: Tailscale socket not ready"
        exit 1
    fi

    if ! kill -0 "$TS_PID" 2>/dev/null; then
        echo "ERROR: Tailscale daemon stopped"
        exit 1
    fi

    sleep 1
done

# ==========================================
# AUTHENTICATE
# ==========================================

echo "Authenticating Tailscale..."

tailscale --socket="$TS_SOCKET" up \
    --auth-key="$(tr -d '\r\n' < "$KEY_FILE")" \
    --hostname=lume-render \
    --accept-dns=false

echo "Tailscale authenticated"

# ==========================================
# START TCP DATABASE GATEWAY
# Uses Tailscale native nc, not SOCKS5
# ==========================================

echo "Starting Tailscale PostgreSQL gateway..."

ncat \
    --listen 127.0.0.1 "$GATEWAY_PORT" \
    --keep-open \
    --sh-exec "exec tailscale --socket=$TS_SOCKET nc $TAILSCALE_DB_HOST $REMOTE_DB_PORT" &

GATEWAY_PID=$!

sleep 1

if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "ERROR: Database gateway failed to start"
    exit 1
fi

echo "Database gateway process started"

# ==========================================
# VERIFY ACTUAL POSTGRESQL CONNECTION
# ==========================================

echo "Testing real PostgreSQL authentication..."

node - <<'JS'
const { Client } = require("pg");

async function verifyDatabase() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 12000
    });

    try {
      await client.connect();

      const result = await client.query(`
        SELECT
          current_database() AS database,
          COUNT(*)::integer AS tables
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
      `);

      const row = result.rows[0];

      console.log("Connected to database:", row.database);
      console.log("Visible tables:", row.tables);

      if (row.database !== "lume_pc" || row.tables === 0) {
        throw new Error(
          "Wrong database or no application tables"
        );
      }

      await client.end();

      console.log("PostgreSQL connection verified");
      return;
    } catch (error) {
      console.error(
        `Database test ${attempt}/3 failed:`,
        error.message
      );

      try {
        await client.end();
      } catch (_) {}

      if (attempt < 3) {
        await new Promise(resolve =>
          setTimeout(resolve, 2000)
        );
      }
    }
  }

  console.error(
    "ERROR: Could not establish PostgreSQL connection"
  );
  process.exitCode = 1;
}

verifyDatabase();
JS

# ==========================================
# START LUME
# ==========================================

echo "Database check passed"
echo "Starting Lume web server..."

exec node server.js
