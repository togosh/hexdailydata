FROM postgres:17.11-bookworm@sha256:e8587c2065ad04a2798579d86275e12c85b73b164ed2cacaa46693d636340d08 AS pgtools
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Public lockfile and npm defaults only; no user/private npm configuration.
# Empty, distinct config files also prevent inherited global/user settings.
RUN mkdir -p /tmp/hdd-npm && touch /tmp/hdd-npm/user.conf /tmp/hdd-npm/global.conf
ENV NPM_CONFIG_USERCONFIG=/tmp/hdd-npm/user.conf NPM_CONFIG_GLOBALCONFIG=/tmp/hdd-npm/global.conf NPM_CONFIG_REGISTRY=https://registry.npmjs.org NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY scripts/openapi.mjs ./scripts/openapi.mjs
COPY config/limits.json ./config/limits.json
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends age util-linux libpq5 liblz4-1 libzstd1 && rm -rf /var/lib/apt/lists/*
COPY --from=pgtools /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump
WORKDIR /app
ARG HDD_V2_RELEASE=development
ENV HDD_V2_RELEASE=$HDD_V2_RELEASE
LABEL hdd.v2.project=$HDD_V2_RELEASE
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/config ./config
COPY --chown=node:node migrations ./migrations
COPY --chmod=755 deploy/init-volumes.sh /usr/local/bin/hdd-init-volumes
USER node
ENV NODE_ENV=production HDD_V2_MODE=production HDD_V2_ALLOW_LIVE_RPC=false HDD_V2_HTTP_HOST=0.0.0.0 HDD_V2_HTTP_PORT=4320
EXPOSE 4320
CMD ["node", "dist/api/main.js"]
