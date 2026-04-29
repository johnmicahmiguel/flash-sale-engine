# syntax=docker/dockerfile:1.7

# ---------- Build stage ----------
FROM node:24-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Copy workspace manifests first for better layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/

# Install ALL deps for the api workspace (incl. dev — needed for `nest build`)
RUN pnpm install --frozen-lockfile --filter @flash-sale/api...

# Copy sources and build
COPY apps/api ./apps/api
COPY packages/shared-types ./packages/shared-types
RUN pnpm --filter @flash-sale/api build

# Produce a self-contained prod-only deployment of the api package
RUN pnpm --filter @flash-sale/api deploy --prod --legacy /out

# ---------- Runtime stage ----------
FROM node:24-alpine AS runtime
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /out/node_modules ./node_modules
COPY --from=builder --chown=app:app /repo/apps/api/dist ./dist
COPY --from=builder --chown=app:app /repo/apps/api/package.json ./package.json

USER app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/main"]
