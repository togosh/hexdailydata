FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /lab
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build
USER node
CMD ["node","dist/server/main.js"]
