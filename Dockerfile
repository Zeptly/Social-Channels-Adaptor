# One image, two Railway services (see docs/RAILWAY.md):
#   API:     node apps/api/dist/main.js      (pre-deploy: node apps/api/dist/migrate.js)
#   Worker:  node apps/worker/dist/main.js
# Workspace packages are bundled into the dist entrypoints; the runtime stage
# installs only third-party production dependencies.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /app

# Manifests only (layer-cached dependency install).
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/capability-registry/package.json packages/capability-registry/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/provider-contract/package.json packages/provider-contract/
COPY packages/provider-outstand/package.json packages/provider-outstand/
COPY packages/test-utils/package.json packages/test-utils/

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM manifests AS prod-deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app ./
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
