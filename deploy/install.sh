#!/usr/bin/env bash
# Installs the bookstore on this Linux PC, or brings an install up to date
# (#31). Needs Docker with the compose plugin. Run from anywhere:
#   bash deploy/install.sh
# The first run asks how the counters reach this PC and the passwords of the
# Super_Admin and Admin accounts, and writes deploy/.env with fresh secrets.
# Later runs keep .env as it is: it holds the key the customer data is
# encrypted with.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail 'Docker is not installed: https://docs.docker.com/engine/install/'
docker compose version >/dev/null 2>&1 || fail 'The Docker compose plugin is missing: https://docs.docker.com/compose/install/linux/'
docker info >/dev/null 2>&1 || fail 'Docker is not running, or this user may not use it (try with sudo).'

random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
random_b64url() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }

# Asks a secret twice, hidden; $2 is the least length.
ask() {
  local a b
  while true; do
    read -rsp "$1: " a || fail 'No password given.'; echo >&2
    read -rsp 'Again: ' b || fail 'No password given.'; echo >&2
    if [ "$a" != "$b" ] || [ -z "$a" ]; then echo 'They differ, or are empty. Try again.' >&2
    elif [ "${#a}" -lt "${2:-1}" ]; then echo "At least $2 characters. Try again." >&2
    elif [[ "$a" == *"'"* ]]; then echo "Without a ' (single quote). Try again." >&2
    else printf '%s' "$a"; return
    fi
  done
}

first_install=false
if [ ! -f .env ]; then
  first_install=true
  say 'How the counters reach this PC'
  ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | paste -sd, - | sed 's/,/, /g' || true)
  default="$(hostname)${ips:+, $ips}, localhost"
  echo "Names and addresses, separated by commas. Press Enter for: $default"
  read -r addresses
  addresses=${addresses:-$default}
  origins=$(echo "$addresses" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sed 's#^#https://#' | paste -sd, -)

  umask 077
  cat > .env <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%MZ). Keep a copy somewhere safe and private:
# without BMS_COLUMN_ENCRYPTION_KEY, customer names, phones and emails cannot be read.
BMS_SITE_ADDRESSES=$addresses
BMS_ORIGINS=$origins
BMS_DB_OWNER_PASSWORD=$(random_hex 24)
BMS_DB_API_PASSWORD=$(random_hex 24)
BMS_JWT_SECRET=$(random_b64url 48)
BMS_COLUMN_ENCRYPTION_KEY=$(random_hex 32)
EOF
  echo 'Wrote deploy/.env with new secrets (readable by this user only).'
fi

# Backups (#244): asked once, also on an install made before backups existed.
if ! grep -q '^BMS_BACKUP_PASSPHRASE=' .env; then
  say 'Backups'
  echo 'Each night (and at start when the last one is older than a day) the bookstore writes an encrypted backup.'
  echo 'Choose a folder on ANOTHER disk, a USB drive or a network share: a backup on the same disk is lost with it.'
  read -rp 'Backup folder (Enter for deploy/backups, on this disk): ' backup_dir || backup_dir=''
  backup_dir=${backup_dir:-./backups}
  echo 'The backup passphrase opens the backups: without it they cannot be restored. Write it down and keep it apart from the PC.'
  passphrase=$(ask 'Backup passphrase (at least 12 characters)' 12)
  umask 077
  printf "BMS_BACKUP_DIR=%s\nBMS_BACKUP_PASSPHRASE='%s'\n" "$backup_dir" "$passphrase" >> .env
  unset passphrase
fi
backup_dir=$(grep '^BMS_BACKUP_DIR=' .env | cut -d= -f2-)
mkdir -p "${backup_dir:-./backups}"

say 'Building the images (a few minutes the first time)'
docker compose build </dev/null

say 'Starting the database and applying the migrations'
docker compose up -d postgres </dev/null
# -T and </dev/null: the steps read nothing, so none may take the answers typed for this script.
docker compose run --rm -T migrate </dev/null

if [ "$first_install" = true ] || [ "${BMS_SET_PASSWORDS:-}" = 1 ]; then
  say 'The first accounts'
  echo 'Passwords: at least 10 characters, with upper- and lower-case letters, a digit and another character.'
  BMS_SUPERADMIN_PASSWORD=$(ask 'Password for superadmin (the shop owner)')
  BMS_ADMIN_PASSWORD=$(ask 'Password for admin (day-to-day administration)')
  export BMS_SUPERADMIN_PASSWORD BMS_ADMIN_PASSWORD
  until docker compose run --rm --no-deps -T -e BMS_SUPERADMIN_PASSWORD -e BMS_ADMIN_PASSWORD migrate node first-accounts.js </dev/null; do
    echo 'Choose the passwords again.'
    BMS_SUPERADMIN_PASSWORD=$(ask 'Password for superadmin (the shop owner)')
    BMS_ADMIN_PASSWORD=$(ask 'Password for admin (day-to-day administration)')
  done
  unset BMS_SUPERADMIN_PASSWORD BMS_ADMIN_PASSWORD
fi

say 'Starting the bookstore'
docker compose up -d --wait </dev/null

say "The shop's certificate authority"
for _ in $(seq 1 30); do
  docker compose exec -T web test -f /data/caddy/pki/authorities/local/root.crt </dev/null 2>/dev/null && break
  # Caddy makes it when it first serves HTTPS.
  curl -sk -o /dev/null "https://localhost/" </dev/null || true
  sleep 1
done
docker compose exec -T web cat /data/caddy/pki/authorities/local/root.crt </dev/null > bookstore-ca.crt
fingerprint=$(docker compose run --rm --no-deps -T migrate node -e \
  "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(new (require('node:crypto').X509Certificate)(s).fingerprint256))" < bookstore-ca.crt)

first=$(echo "${BMS_SITE_ADDRESSES:-$(grep '^BMS_SITE_ADDRESSES=' .env | cut -d= -f2-)}" | cut -d, -f1 | sed 's/ //g')
cat <<EOF

Done. Open https://$first on this PC or any counter.

Each counter PC trusts this shop's certificate authority once:
  Windows: deploy\\trust-ca.ps1 -Server $first   (as administrator)
  Linux:   sudo bash deploy/trust-ca.sh $first
Check that it shows this fingerprint:
  $fingerprint
The certificate is also in deploy/bookstore-ca.crt.

Backups go to: ${backup_dir:-./backups} (the first one runs now).
Keep a copy of deploy/.env and the backup passphrase somewhere safe and private.
EOF
