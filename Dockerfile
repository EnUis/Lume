FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1001 luma && mkdir /app/data && chown luma /app/data
COPY --from=build --chown=luma /app/.next/standalone ./
COPY --from=build --chown=luma /app/.next/static ./.next/static
COPY --from=build --chown=luma /app/public ./public
COPY --from=build --chown=luma /app/db ./db
COPY --from=build --chown=luma /app/lib ./lib
COPY --from=build --chown=luma /app/scripts ./scripts
# Worker and administrator commands use tsx, so retain the locked runtime dependencies.
COPY --from=build --chown=luma /app/node_modules ./node_modules
USER luma
EXPOSE 3000
CMD ["node", "server.js"]
