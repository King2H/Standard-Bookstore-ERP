#!/usr/bin/env bash
# Makes this Linux PC trust the shop's certificate authority, once (#31), so
# its browser opens the bookstore over HTTPS without a warning.
#   sudo bash trust-ca.sh <server name or address>
# Compare the fingerprint it shows with the one the installer printed.
set -euo pipefail
server=${1:?Usage: sudo bash trust-ca.sh <server name or address>}
[ "$(id -u)" = 0 ] || { echo 'Run as root (sudo).' >&2; exit 1; }

tmp=$(mktemp)
curl -fsS "http://$server/ca.crt" -o "$tmp"
openssl x509 -in "$tmp" -noout -subject -fingerprint -sha256
read -rp 'Does the SHA256 fingerprint match the one the installer printed? (yes/no) ' answer
[ "$answer" = yes ] || { echo 'Not trusted. Check the server address.'; rm -f "$tmp"; exit 1; }

if [ -d /usr/local/share/ca-certificates ]; then
  install -m 644 "$tmp" /usr/local/share/ca-certificates/bookstore-ca.crt && update-ca-certificates
elif [ -d /etc/pki/ca-trust/source/anchors ]; then
  install -m 644 "$tmp" /etc/pki/ca-trust/source/anchors/bookstore-ca.crt && update-ca-trust
else
  echo "Install $tmp as a trusted certificate authority by hand on this system." >&2; exit 1
fi
rm -f "$tmp"
echo 'Trusted. Firefox and Chrome on Linux may keep their own list: import deploy/bookstore-ca.crt there too (Settings → Certificates → Authorities).'
