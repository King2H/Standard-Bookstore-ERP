#!/bin/sh
# Startup script: run migrations then start the server
set -e

echo "Running database migrations..."
# As the database owner; the API itself works as its own user (#13).
/app/node_modules/.bin/node-pg-migrate up \
  --database-url "$MIGRATION_DATABASE_URL" \
  --migrations-dir /app/apps/api/src/db/migrations \
  --migrations-table pgmigrations

echo "Making sure the API's database user works..."
(cd /app/apps/api && /app/node_modules/.bin/tsx scripts/app-role.ts)

echo "Migrations complete. Starting server..."
exec /app/node_modules/.bin/tsx /app/apps/api/src/server.ts
