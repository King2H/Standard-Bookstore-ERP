#!/usr/bin/env bash
# Reads a v1 shop's lists into the files of the Import / Export page (#246,
# owner decisions 1a–4a): catalog, opening stock, customers, customer
# balances and supplier balances, with summary.txt saying what came over.
# Import them on that page, in their numbered order, with its checks.
# Needs Docker and this folder; it changes no install.
#   bash deploy/import-v1.sh <v1 database address, or a copy of it> [folder]
# The address is the v1 database's external URL (postgres://...); a copy is a
# pg_dump file (custom, tar or SQL, or gzipped). The folder defaults to
# v1-import-<date and time> where it is run. It asks for the v1 key
# (COLUMN_ENCRYPTION_KEY of the v1 API), which opens the customers' phones
# and emails.
# The copy is loaded into a temporary database in a container that is
# removed at the end; v1 is only read.
set -euo pipefail
here=$(pwd)
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

source=${1:-}
[ -n "$source" ] || fail 'Usage: bash deploy/import-v1.sh <v1 database address, or a copy of it> [folder]'
folder=${2:-v1-import-$(date +%Y%m%d-%H%M%S)}
# Paths given are read from where the command was run.
case "$folder" in /*) ;; *) folder="$here/$folder" ;; esac
command -v docker >/dev/null || fail 'Docker is not installed.'
docker info >/dev/null 2>&1 || fail 'Docker is not running, or this user may not use it (try with sudo).'
mounts=()
case "$source" in
  postgres://*|postgresql://*) arg=$source ;;
  *)
    case "$source" in /*) ;; *) source="$here/$source" ;; esac
    [ -f "$source" ] || fail "No such file: $source"
    mounts=(-v "$(cd "$(dirname "$source")" && pwd):/in:ro")
    arg="/in/$(basename "$source")"
    ;;
esac
mkdir -p "$folder"
chmod 700 "$folder"
folder=$(cd "$folder" && pwd)

if [ -z "${BMS_V1_KEY:-}" ]; then
  echo 'The v1 key: COLUMN_ENCRYPTION_KEY of the v1 API (on Render: the API service, Environment).'
  read -rsp 'v1 key: ' BMS_V1_KEY || fail 'No key given.'; echo
fi
[[ "$BMS_V1_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || fail 'The v1 key is 64 hexadecimal characters (0-9, a-f).'
export BMS_V1_KEY

say 'Preparing the tools'
secret=()
[ -n "${BMS_EXTRA_CA_FILE:-}" ] && secret=(--secret "id=extra_ca,src=$BMS_EXTRA_CA_FILE")
docker build -q -f Dockerfile --target backup "${secret[@]}" -t bookstore-backup:local .. </dev/null >/dev/null

say 'Starting the temporary database'
name="bookstore-v1-import-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=v1 \
  "${mounts[@]}" -v "$folder":/out bookstore-backup:local postgres </dev/null >/dev/null
# It answers over TCP only once its first start is over.
for _ in $(seq 60); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d v1 </dev/null && break
  sleep 1
done
docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d v1 </dev/null || fail 'The temporary database did not start.'

say 'Reading the v1 shop'
status=0
# The address and the key go in the environment: a command line is seen by every user of the PC.
BMS_V1_SOURCE=$arg docker exec -e BMS_V1_KEY -e BMS_V1_SOURCE "$name" node import-v1.js /out </dev/null || status=$?
# The container wrote as root: the files are this user's.
docker exec "$name" chown -R "$(id -u):$(id -g)" /out </dev/null || true
[ "$status" -eq 0 ] || fail 'No files were written: see the message above.'

cat <<EOF

The files are in $folder (summary.txt says what came over).
They hold customers' phones and emails in clear: keep them private, and
delete the folder once imported. Import them on the Import / Export page, in
their numbered order.
EOF
