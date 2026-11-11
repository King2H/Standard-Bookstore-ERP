#!/usr/bin/env bash
# Starts a test shop from the production images (#33, owner decision 1a): the
# steps of deploy/install.sh without its questions, with throwaway secrets and
# known passwords for the journeys. For CI, and to run the journeys locally:
#   bash e2e/start-shop.sh && E2E_BASE_URL=https://localhost E2E_ADMIN_PASSWORD='E2e#Admin-2026' \
#     npx playwright test -c e2e/playwright.config.ts; bash e2e/stop-shop.sh
# Its own Docker project (bookstore-e2e): an install on the same PC is left
# alone, but ports 80 and 443 must be free.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
export COMPOSE_PROJECT_NAME=bookstore-e2e

say() { printf '\n== %s\n' "$*"; }
# A test shop's own settings are written again; an install's are never touched.
if [ -f .env ] && ! grep -q '^# A test shop for the E2E journeys' .env; then
  echo 'deploy/.env exists: this folder holds an install, not a test shop. Use a separate checkout.' >&2
  exit 1
fi

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
umask 077
cat > .env <<ENV
# A test shop for the E2E journeys (e2e/start-shop.sh): throwaway secrets, removed by e2e/stop-shop.sh.
BMS_SITE_ADDRESSES=localhost
BMS_ORIGINS=https://localhost
BMS_DB_OWNER_PASSWORD=$(hex 24)
BMS_DB_API_PASSWORD=$(hex 24)
BMS_JWT_SECRET=$(hex 48)
BMS_COLUMN_ENCRYPTION_KEY=$(hex 32)
BMS_BACKUP_DIR=./backups-e2e
BMS_BACKUP_PASSPHRASE='e2e-test-backup-passphrase'
ENV
mkdir -p backups-e2e

say 'Building the images'
docker compose build </dev/null
say 'Starting the database and applying the migrations'
docker compose up -d --wait postgres </dev/null
docker compose run --rm -T migrate </dev/null
say 'The first accounts'
BMS_SUPERADMIN_PASSWORD=${E2E_SUPERADMIN_PASSWORD:-E2e#Owner-2026} BMS_ADMIN_PASSWORD=${E2E_ADMIN_PASSWORD:-E2e#Admin-2026} \
  docker compose run --rm --no-deps -T -e BMS_SUPERADMIN_PASSWORD -e BMS_ADMIN_PASSWORD migrate node first-accounts.js </dev/null
say 'Starting the bookstore'
docker compose up -d --wait </dev/null
for _ in $(seq 1 30); do
  curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' https://localhost/api/v1/health/ready </dev/null | grep -q 200 && break
  sleep 1
done
echo "Ready: https://localhost ($(curl -sk --noproxy '*' https://localhost/api/v1/health/live </dev/null))"
