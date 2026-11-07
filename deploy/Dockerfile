# The on-premise images (#31). Built from the repository root:
#   docker build -f deploy/Dockerfile --target api .
#   docker build -f deploy/Dockerfile --target web .
# Everything installs from package-lock.json (npm ci).

# ── Dependencies from the lockfile ───────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Behind a proxy that inspects HTTPS, its certificate authority is passed in as
# a build secret (BMS_EXTRA_CA_FILE in .env); it never stays in an image.
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; npm ci

# ── The API, its migration step and the first-accounts step, compiled ──────
# Each is bundled into one file with @bms/shared; bcrypt (native) stays a
# package, installed for production below.
FROM deps AS api-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
ENV BUNDLE="--bundle --platform=node --format=esm --target=node24 --external:bcrypt --external:pg-native"
ENV BANNER="import { createRequire as __bmsCreateRequire } from 'node:module'; const require = __bmsCreateRequire(import.meta.url);"
# The version (#245) is the root package.json's: built into the API, and in
# /app/VERSION for the upgrade script to read from an image.
RUN VERSION=$(node -p "require('./package.json').version") \
 && npx tsc --noEmit -p apps/api \
 && npx esbuild apps/api/src/server.ts $BUNDLE --banner:js="$BANNER" --define:__BMS_VERSION__="\"$VERSION\"" --outfile=out/server.js \
 && npx esbuild apps/api/scripts/migrate.ts $BUNDLE --banner:js="$BANNER" --outfile=out/migrate.js \
 && npx esbuild apps/api/scripts/first-accounts.ts $BUNDLE --banner:js="$BANNER" --outfile=out/first-accounts.js \
 && npx esbuild apps/api/scripts/db-check.ts $BUNDLE --banner:js="$BANNER" --outfile=out/db-check.js \
 && npx esbuild apps/api/scripts/backup.ts $BUNDLE --banner:js="$BANNER" --outfile=backup/backup.js \
 && npx esbuild apps/api/scripts/import-v1.ts $BUNDLE --banner:js="$BANNER" --outfile=backup/import-v1.js \
 && echo "$VERSION" > out/VERSION

# ── Production packages only ────────────────────────────────────────────────
FROM node:24-alpine AS api-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --workspace=apps/api --include-workspace-root=false

# ── API image: compiled code, production packages, not root ─────────────────
FROM node:24-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps /src/node_modules ./node_modules
COPY --from=api-build /src/out/ ./
COPY apps/api/src/db/migrations ./migrations
USER node
EXPOSE 3000
# Ready (#32): the database answers and the API is not shutting down.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]

# ── Backup image: PostgreSQL's own pg_dump and pg_restore, and Node ────────
# (#244). It reads the database, the install's .env and the certificate
# authority, and writes encrypted backups to the folder chosen at install.
# It also reads a v1 shop's database into import files (import-v1.js, #246),
# in a throwaway container whose own PostgreSQL is the temporary database.
FROM node:24-alpine AS node-runtime
FROM postgres:18-alpine AS backup
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=api-build /src/backup/ ./
CMD ["node", "backup.js", "schedule"]

# ── The screens, built ───────────────────────────────────────────────────────
FROM deps AS web-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace=apps/web

# ── Web image: Caddy serves the screens, passes /api on, and gives HTTPS ────
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /src/apps/web/dist /srv
