# Scaffold-only image. Task01 pins a tested digest; task08 creates the release build.
FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV HDD_V2_MODE=scaffold HDD_V2_HTTP_HOST=0.0.0.0 HDD_V2_HTTP_PORT=4320
EXPOSE 4320
CMD ["node", "--experimental-strip-types", "src/api/main.ts"]
