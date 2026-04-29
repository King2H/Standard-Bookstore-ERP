FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install ALL dependencies (including devDeps — tsc is needed to build)
RUN npm install --workspace=apps/api --workspace=packages/shared

# Copy source files
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Compile TypeScript → JavaScript
WORKDIR /app/apps/api
RUN npx tsc

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install production dependencies only
RUN npm install --workspace=apps/api --workspace=packages/shared --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared ./packages/shared

# Copy migrations (needed at runtime for npm run migrate)
COPY apps/api/src/db/migrations ./apps/api/src/db/migrations
COPY apps/api/src/db/database.json ./apps/api/src/db/database.json

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["node", "dist/server.js"]
