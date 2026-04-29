#!/bin/sh
# Startup script: run migrations then start the server
set -e

echo "Running database migrations..."
/app/node_modules/.bin/node-pg-migrate up \
  --database-url "$DATABASE_URL" \
  --migrations-dir /app/apps/api/src/db/migrations \
  --migrations-table pgmigrations

echo "Migrations complete. Starting server..."
exec /app/node_modules/.bin/tsx /app/apps/api/src/server.ts
