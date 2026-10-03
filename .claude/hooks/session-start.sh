#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Gives every cloud session the same toolchain as local development
# (docs/development.md): Node.js from .nvmrc, project dependencies, and
# PostgreSQL 18 on localhost:5433 with the schema migrated, so lint,
# typecheck and the full test suite run immediately.
#
# Local machines are left alone: there, developers use nvm-windows and
# `docker compose up -d postgres`.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CACHE_DIR="${HOME}/.cache/bms-dev"
PG_PORT=5433
PG_PACKAGE_VERSION="18.4.0-beta.17"   # @embedded-postgres/linux-x64: official PostgreSQL 18.4 binaries
PG_HOME="/opt/bms-dev/postgres-18"   # outside $HOME: the postgres user must be able to read it
PG_DATA="/var/tmp/bms-pg18-data"
PG_LOG="/var/tmp/bms-pg18.log"
DATABASE_URL="postgres://bms:bms@localhost:${PG_PORT}/bms"

mkdir -p "$CACHE_DIR"

log() { echo "[session-start] $*" >&2; }

# Container images can't be pulled from this environment, but the npm registry
# is reachable, so both runtimes come from official binaries published there.
fetch_npm_tarball() {
  local spec="$1" dest="$2"
  local tmp
  tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack --silent "$spec" >/dev/null && tar xzf ./*.tgz)
  rm -rf "$dest"
  mv "$tmp/package" "$dest"
  rm -rf "$tmp"
}

# ── Node.js (major version from .nvmrc) ──────────────────────────────────────
NODE_MAJOR="$(tr -d '[:space:]' < "$PROJECT_DIR/.nvmrc")"
if [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v${NODE_MAJOR}" ]; then
  NODE_HOME="${CACHE_DIR}/node-${NODE_MAJOR}"
  if [ ! -x "${NODE_HOME}/bin/node" ]; then
    NODE_VERSION="$(npm view "node-linux-x64@^${NODE_MAJOR}" version --json | tr -d '[]" \n' | tr ',' '\n' | tail -1)"
    log "installing Node.js ${NODE_VERSION}"
    fetch_npm_tarball "node-linux-x64@${NODE_VERSION}" "$NODE_HOME"
  fi
  export PATH="${NODE_HOME}/bin:${PATH}"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"${NODE_HOME}/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi
log "node $(node -v)"

# ── Dependencies ─────────────────────────────────────────────────────────────
# npm install (not npm ci) so the cached container state is reused.
(cd "$PROJECT_DIR" && npm install --no-audit --no-fund)

# ── PostgreSQL 18 on localhost:5433 ──────────────────────────────────────────
if [ ! -x "${PG_HOME}/bin/postgres" ]; then
  log "installing PostgreSQL ${PG_PACKAGE_VERSION%%-*}"
  fetch_npm_tarball "@embedded-postgres/linux-x64@${PG_PACKAGE_VERSION}" "${CACHE_DIR}/pg-package"
  rm -rf "$PG_HOME"
  mkdir -p "$(dirname "$PG_HOME")"
  mv "${CACHE_DIR}/pg-package/native" "$PG_HOME"
  rm -rf "${CACHE_DIR}/pg-package"
  # The package lists its shared-library symlinks separately.
  (cd "$PG_HOME/.." && node -e '
    const fs = require("fs"), path = require("path");
    const home = process.argv[1];
    for (const { source, target } of JSON.parse(fs.readFileSync(path.join(home, "pg-symlinks.json")))) {
      const link = path.join(home, target.replace(/^native\//, ""));
      if (!fs.existsSync(link)) fs.symlinkSync(path.basename(source), link);
    }' "$PG_HOME")
  chmod +x "$PG_HOME"/bin/*
fi

# PostgreSQL refuses to run as root.
if ! id postgres >/dev/null 2>&1; then
  useradd --system --no-create-home postgres
fi
as_postgres() { su postgres -s /bin/sh -c "$*"; }

if [ ! -s "${PG_DATA}/PG_VERSION" ]; then
  log "initialising database cluster"
  mkdir -p "$PG_DATA"
  chown postgres "$PG_DATA"
  as_postgres "'${PG_HOME}/bin/initdb' -D '${PG_DATA}' -U postgres -A trust -E UTF8" >/dev/null
fi

if ! as_postgres "'${PG_HOME}/bin/pg_ctl' -D '${PG_DATA}' status" >/dev/null 2>&1; then
  touch "$PG_LOG" && chown postgres "$PG_LOG"
  as_postgres "'${PG_HOME}/bin/pg_ctl' -D '${PG_DATA}' -o '-p ${PG_PORT} -k /tmp' -l '${PG_LOG}' -w start" >/dev/null
fi

# The package has no psql client, so create the role and database through the
# project's own `pg` driver.
(cd "$PROJECT_DIR" && node -e '
  const { Client } = require("pg");
  (async () => {
    const c = new Client({ host: "/tmp", port: Number(process.argv[1]), user: "postgres", database: "postgres" });
    await c.connect();
    const has = async (sql) => (await c.query(sql)).rowCount > 0;
    if (!(await has("SELECT 1 FROM pg_roles WHERE rolname = \x27bms\x27")))
      await c.query("CREATE ROLE bms LOGIN PASSWORD \x27bms\x27 SUPERUSER");
    if (!(await has("SELECT 1 FROM pg_database WHERE datname = \x27bms\x27")))
      await c.query("CREATE DATABASE bms OWNER bms");
    await c.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
' "$PG_PORT")

# ── Schema ───────────────────────────────────────────────────────────────────
(cd "$PROJECT_DIR/apps/api" && DATABASE_URL="$DATABASE_URL" npx node-pg-migrate up \
  --database-url-var DATABASE_URL --migrations-dir src/db/migrations >/dev/null)

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export DATABASE_URL=\"${DATABASE_URL}\"" >> "$CLAUDE_ENV_FILE"
fi

PG_VERSION="$("${PG_HOME}/bin/postgres" --version | awk '{print $NF}')"
log "ready: node $(node -v), PostgreSQL ${PG_VERSION} on localhost:${PG_PORT}"
