#!/usr/bin/env bash
# Rebuilds the bookstore on this PC from one backup file (#244, owner
# decision 4a): the database, the install's .env and the shop's certificate
# authority, then checks the data. For a new PC, or this one after its
# install was removed. Needs Docker with the compose plugin and this folder.
#   bash deploy/restore.sh /path/to/bookstore-YYYYMMDD-HHMMSS.bmsbak
# It asks for the backup passphrase.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

file=${1:?Usage: bash deploy/restore.sh <backup file>}
[ -f "$file" ] || fail "No such file: $file"
file=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")
command -v docker >/dev/null || fail 'Docker is not installed.'
docker info >/dev/null 2>&1 || fail 'Docker is not running, or this user may not use it (try with sudo).'
[ -f .env ] && fail 'deploy/.env exists: this PC already has an install. Restore onto a clean PC, or remove the install first (docker compose down -v, then delete deploy/.env).'
volume="${COMPOSE_PROJECT_NAME:-bookstore}_pgdata18"
if docker volume inspect "$volume" >/dev/null 2>&1; then
  fail "A bookstore database already exists on this PC (volume $volume). Remove it first: docker compose down -v."
fi

read -rsp 'Backup passphrase: ' BMS_BACKUP_PASSPHRASE || fail 'No passphrase given.'; echo
export BMS_BACKUP_PASSPHRASE

say 'Opening the backup'
secret=()
[ -n "${BMS_EXTRA_CA_FILE:-}" ] && secret=(--secret "id=extra_ca,src=$BMS_EXTRA_CA_FILE")
docker build -q -f Dockerfile --target backup "${secret[@]}" -t bookstore-backup:local .. </dev/null >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docker run --rm -e BMS_BACKUP_PASSPHRASE -v "$(dirname "$file")":/in:ro -v "$work":/out bookstore-backup:local \
  node backup.js unpack "/in/$(basename "$file")" /out </dev/null
unset BMS_BACKUP_PASSPHRASE
cat "$work/manifest.json"; echo

say 'The install settings from the backup'
umask 077
cp "$work/install.env" .env
backup_dir=$(grep '^BMS_BACKUP_DIR=' .env | cut -d= -f2-)
mkdir -p "${backup_dir:-./backups}"

say 'Building the images'
docker compose build </dev/null

say 'Restoring the database'
docker compose up -d --wait postgres </dev/null
# The role the API works as is the cluster's, not the database's: made before the data that grants to it.
docker compose exec -T postgres psql -q -U bms -d bms -v ON_ERROR_STOP=1 \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bms_app') THEN CREATE ROLE bms_app NOLOGIN; END IF; END \$\$;" </dev/null
docker compose exec -T postgres pg_restore -U bms -d bms --exit-on-error < "$work/db.dump"

say "Restoring the shop's certificate authority"
docker compose run --rm --no-deps -T -v "$work":/restore:ro --entrypoint sh web -c 'tar -C /data -xf /restore/caddy-data.tar' </dev/null

say 'Bringing the database up to this version, and starting'
docker compose run --rm -T migrate </dev/null
docker compose up -d --wait </dev/null

say 'Checking the data'
docker compose run --rm --no-deps -T migrate node db-check.js </dev/null

first=$(grep '^BMS_SITE_ADDRESSES=' .env | cut -d= -f2- | cut -d, -f1 | sed 's/ //g')
cat <<EOF

Restored. Open https://$first. The counters keep trusting the same certificate authority.
Sign in with the passwords the shop had when the backup was made.
EOF
