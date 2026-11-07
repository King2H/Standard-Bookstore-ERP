#!/usr/bin/env bash
# Brings the bookstore on this PC up to the version in this folder, or back
# to the one before (#245, owner decision 2a). Needs the install made by
# install.sh, and the new release in this folder (git checkout of the
# release's tag, or its ZIP extracted over the folder).
#   bash deploy/upgrade.sh             upgrade to the version in this folder
#   bash deploy/upgrade.sh --rollback  back to the version before the last
#                                      upgrade, with the data of then
# An upgrade first makes a backup and keeps the running version's images. If
# a step fails once the bookstore was stopped, it goes back to them, and to
# the data of the backup, by itself.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
STATE=.upgrade-state

command -v docker >/dev/null || fail 'Docker is not installed.'
docker info >/dev/null 2>&1 || fail 'Docker is not running, or this user may not use it (try with sudo).'
[ -f .env ] || fail 'No install here (deploy/.env is missing): install with install.sh first.'

images=$(docker compose config --images </dev/null | grep '^bookstore-' | sort -u)
api_image=$(grep '^bookstore-api:' <<<"$images" | head -1)
installed_version() { docker run --rm --entrypoint cat "$1" /app/VERSION 2>/dev/null || echo 'unknown'; }
folder_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p' ../package.json | head -1; }
# True when $1 is a later version than $2 (by their numbers: 2.0.10 after 2.0.9).
later() {
  local a=${1%%-*} b=${2%%-*}
  [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" = "$a" ]
}
state() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null; }

# The version the API answers with, once it is up.
served_version() {
  docker compose exec -T api node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => r.json()).then((b) => console.log(b.status === 'ok' ? (b.version ?? 'unknown') : 'down'), () => console.log('down'))" \
    </dev/null 2>/dev/null || echo 'down'
}
# The number of error rows the data check finds; empty when it cannot run.
data_errors() {
  local out
  out=$(docker compose run --rm --no-deps -T migrate node db-check.js </dev/null 2>&1) || true
  sed -n 's/.* rules: \([0-9]*\) error row(s).*/\1/p' <<<"$out"
}

# Back to the kept images and the backup's data. $1: the backup file. Called
# from an || list, where set -e does not apply: each step returns on failure.
put_back() {
  local backup=$1 image
  say "Putting back the database of $backup"
  docker compose stop api web backup </dev/null || true
  docker compose up -d --wait postgres </dev/null || return 1
  docker compose run --rm --no-deps -T backup node backup.js replace-database "/backups/$backup" </dev/null || return 1
  say 'Putting back the software'
  for image in $images; do docker tag "${image%:*}:previous" "$image" || return 1; done
  docker compose up -d --wait </dev/null || return 1
}
put_back_failed() {
  fail "Going back failed too (see above). Restore the backup made before the upgrade, $1, with restore.sh (docs/install.md, Restoring), and keep this output for support."
}

upgrade() {
  local installed available before after backup out
  installed=$(installed_version "$api_image")
  available=$(folder_version)
  [ -n "$available" ] || fail 'No version in package.json: this folder does not hold a release of the bookstore.'
  if [ "$installed" = "$available" ]; then echo "The bookstore is already at $available: nothing to do."; return; fi
  if [ "$installed" != unknown ] && later "$installed" "$available"; then
    fail "This folder holds $available, older than the installed $installed. To go back after an upgrade: bash deploy/upgrade.sh --rollback."
  fi
  say "Upgrading the bookstore from $installed to $available"

  say 'Checking the bookstore as it is'
  docker compose up -d --wait </dev/null || fail 'The bookstore does not start as it is: see docker compose -f deploy/compose.yaml logs api.'
  before=$(data_errors)
  [ -n "$before" ] || fail 'The data check does not run: see the output of docker compose -f deploy/compose.yaml run --rm migrate node db-check.js.'
  echo "Data check: $before error row(s)."

  say 'A backup first'
  out=$(docker compose run --rm --no-deps -T backup node backup.js run </dev/null 2>&1) || { echo "$out"; fail 'The backup failed: an upgrade needs one. Check the backup folder (docs/install.md, Backups).'; }
  echo "$out"
  backup=$(sed -n 's/^Backup written: \([^ ]*\).*/\1/p' <<<"$out")

  say "Keeping $installed for a rollback"
  for image in $images; do docker tag "$image" "${image%:*}:previous"; done
  umask 077
  printf 'from=%s\nto=%s\nbackup=%s\nat=%s\n' "$installed" "$available" "$backup" "$(date +"%Y-%m-%d %H:%M")" > "$STATE"

  say "Building $available (a few minutes)"
  if ! docker compose build </dev/null; then
    for image in $images; do docker tag "${image%:*}:previous" "$image"; done
    rm -f "$STATE"
    fail "The build failed (see above): nothing was changed, $installed still runs."
  fi

  local reason=''
  say 'Stopping the bookstore, bringing the database up to the new version, starting'
  if ! { docker compose stop api web backup </dev/null && docker compose run --rm --no-deps -T migrate </dev/null; }; then
    reason='the database could not be brought up to the new version'
  elif ! docker compose up -d --wait </dev/null; then
    reason='the new version does not start'
  elif [ "$(served_version)" != "$available" ]; then
    reason="the bookstore does not answer as $available"
  else
    after=$(data_errors)
    if [ -z "$after" ]; then reason='the data check does not run'
    elif [ "$after" -gt "$before" ]; then reason="the data check finds $after error row(s), against $before before"
    fi
  fi
  if [ -n "$reason" ]; then
    printf '\nThe upgrade failed: %s. Going back to %s.\n' "$reason" "$installed" >&2
    put_back "$backup" || put_back_failed "$backup"
    rm -f "$STATE"
    fail "The upgrade to $available failed ($reason). $installed runs again, with its data as it was before the upgrade. See docker compose -f deploy/compose.yaml logs, and keep this output for support."
  fi
  echo "Data check: $after error row(s)."

  cat <<MSG

Upgraded from $installed to $available. Open the bookstore and check it.
Each counter reloads the page once (Ctrl+F5) to get the new screens.
If something is wrong: bash deploy/upgrade.sh --rollback puts back $installed
with the data of the backup made before the upgrade ($backup).
MSG
}

rollback() {
  [ -f "$STATE" ] || fail 'There is no upgrade to go back from.'
  local from to backup at answer now out
  from=$(state from); to=$(state to); backup=$(state backup); at=$(state at)
  for image in $images; do
    docker image inspect "${image%:*}:previous" >/dev/null 2>&1 || fail "The images of $from are no longer on this PC: restore a backup instead (docs/install.md, Restoring)."
  done
  cat <<MSG

This puts back $from, and the data as it was before the upgrade to $to ($at):
everything entered since then (sales, payments, stock, customers) is lost
from the bookstore. A backup of the data as it is now is made first, so it can
still be restored later.
MSG
  read -rp 'Type ROLLBACK to go on: ' answer || answer=''
  [ "$answer" = ROLLBACK ] || fail 'Nothing was changed.'

  say 'A backup of the data as it is now'
  out=$(docker compose run --rm --no-deps -T backup node backup.js run </dev/null 2>&1) || { echo "$out"; fail 'The backup failed, so nothing was changed. Check the backup folder (docs/install.md, Backups).'; }
  echo "$out"
  now=$(sed -n 's/^Backup written: \([^ ]*\).*/\1/p' <<<"$out")
  put_back "$backup" || put_back_failed "$backup"
  rm -f "$STATE"
  [ "$(served_version)" = "$from" ] || fail "The bookstore does not answer as $from after the rollback: see docker compose -f deploy/compose.yaml logs api."
  cat <<MSG

Back on $from, with the data of $at. The data as it was on $to is in $now.
This folder still holds $to: put back the $from release in the folder before
running install.sh or this script again.
MSG
}

case "${1:-}" in
  '') upgrade ;;
  --rollback) rollback ;;
  *) fail 'Usage: bash deploy/upgrade.sh [--rollback]' ;;
esac
