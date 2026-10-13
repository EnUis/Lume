FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-fund --no-audit

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build


# Production image
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Install required utilities
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      ncat && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --uid 1001 luma && \
    usermod -aG 1000 luma && \
    mkdir -p /app/data && \
    chown luma /app/data

# Install Tailscale binaries
COPY --from=docker.io/tailscale/tailscale:stable \
    /usr/local/bin/tailscale /usr/local/bin/tailscale

COPY --from=docker.io/tailscale/tailscale:stable \
    /usr/local/bin/tailscaled /usr/local/bin/tailscaled

# Copy Next.js production build
COPY --from=build --chown=luma \
    /app/.next/standalone ./

COPY --from=build --chown=luma \
    /app/.next/static ./.next/static

COPY --from=build --chown=luma \
    /app/public ./public

# Copy database and application utilities
COPY --from=build --chown=luma /app/db ./db
COPY --from=build --chown=luma /app/lib ./lib
COPY --from=build --chown=luma /app/scripts ./scripts

# Retain runtime dependencies for admin and worker tools
COPY --from=build --chown=luma \
    /app/node_modules ./node_modules

# Install startup script
COPY --chown=luma render-start.sh /app/render-start.sh

RUN chmod 755 /app/render-start.sh

USER luma

EXPOSE 3000

# Start Tailscale, PostgreSQL gateway and Lume
CMD ["sh", "/app/render-start.sh"]
