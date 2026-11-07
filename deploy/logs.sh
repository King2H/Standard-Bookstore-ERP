#!/usr/bin/env bash
# Saves the bookstore's logs of the last days into one file, to send for
# support (#32, owner decision 2a): every service (API, database, web, backup,
# migrations), with times. Docker keeps them in rotating files: at most about
# 50 MB a service. Passwords, keys and customer contacts are never in them.
#   bash deploy/logs.sh [days]     the last 3 days unless given
# The file is written where the command is run.
set -euo pipefail
here=$(pwd)
cd "$(dirname "$0")"

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

days=${1:-3}
[[ "$days" =~ ^[1-9][0-9]{0,2}$ ]] || fail 'Usage: bash deploy/logs.sh [days]   (a whole number of days, 1 to 999)'
command -v docker >/dev/null || fail 'Docker is not installed.'
docker info >/dev/null 2>&1 || fail 'Docker is not running, or this user may not use it (try with sudo).'
[ -f .env ] || fail 'No install in this folder (deploy/.env is missing).'

file="$here/bookstore-logs-$(date +%Y%m%d-%H%M%S).txt"
umask 077
{
  echo "Bookstore logs of the last $days day(s), saved $(date -u +%Y-%m-%dT%H:%MZ)"
  docker compose ps --all --format 'table {{.Service}}\t{{.Status}}' </dev/null
  echo
  docker compose logs --no-color --timestamps --since "$((days * 24))h" </dev/null
} > "$file" 2>&1
echo "Saved $(basename "$file") ($(( $(wc -c < "$file") / 1024 )) KB) in $here."
