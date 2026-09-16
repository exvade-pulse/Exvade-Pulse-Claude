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
CMD ["node", "dist/index.js"]
