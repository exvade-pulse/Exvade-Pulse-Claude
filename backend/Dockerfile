FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
# Workspace package.json files (not full source) are enough for npm to resolve
# the workspace graph and lockfile -- keeps this layer cacheable across source changes.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
COPY backend backend
RUN npm run build -w backend

FROM base AS runtime
ENV NODE_ENV=production
# Root node_modules is intentionally reused as-is (not pruned to backend-only)
# -- npm workspaces hoist shared deps there, and Node's module resolution
# walks up from /app/backend to find it, same as local dev.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY backend/package.json backend/package.json
COPY backend/drizzle backend/drizzle
COPY --from=build /app/backend/dist backend/dist

WORKDIR /app/backend
EXPOSE 3001
# Migrations run on every container start, not just via a host-specific
# pre-deploy hook (Fly's release_command, Render's paid-only Pre-Deploy
# Command) -- this way the image works the same everywhere. Safe to repeat:
# Drizzle's migrator tracks what's already applied and skips it.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
