FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
ENV NODE_ENV=production HDD_V2_MODE=development HDD_V2_ALLOW_LIVE_RPC=false HDD_V2_HTTP_HOST=0.0.0.0 HDD_V2_HTTP_PORT=4320
EXPOSE 4320
CMD ["node", "dist/api/main.js"]
