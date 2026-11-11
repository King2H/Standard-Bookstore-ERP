#!/usr/bin/env bash
# Removes the test shop of e2e/start-shop.sh: its containers, data and settings.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
export COMPOSE_PROJECT_NAME=bookstore-e2e
if [ -f .env ] && grep -q '^# A test shop for the E2E journeys' .env; then
  docker compose down -v --remove-orphans </dev/null
  rm -rf .env backups-e2e
else
  echo 'deploy/.env is not a test shop: nothing removed.' >&2
fi
