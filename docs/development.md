# Local development (Windows)

The database runs in Docker. The API and the web app run natively on your machine,
for fast reloads and working debuggers.

| Component | Version | Runs in |
|---|---|---|
| PostgreSQL | 18 | Docker (`docker compose`), host port **5433** |
| Node.js | 24 LTS (pinned in `.nvmrc`) | natively |
| API | Express 5 on port 3000 | natively (`npm run dev:api`) |
| Web | Vite on port 5173 | natively (`npm run dev:web`) |

Commands below are for PowerShell in the VS Code terminal, run from the repository root.

## Prerequisites

- **Git**
- **Node.js 24 LTS** and npm. We recommend [nvm-windows](https://github.com/coreybutler/nvm-windows),
  which lets you switch versions per branch (`main` uses 24, `release/1.x` uses 20):
  ```powershell
  nvm install 24
  nvm use 24
  node -v   # v24.x
  ```
  After switching Node versions, run `npm install` again so native modules (`bcrypt`) match.
- **Docker Desktop**, running. Start it from the Start menu and wait for "Engine running".

A natively installed PostgreSQL is not needed. If you have one, it can keep port 5432;
the project's database uses 5433.

## One-time setup

**1. Install dependencies**

```powershell
npm install
```

**2. Create your `.env`**

```powershell
Copy-Item .env.example .env
```

Generate two secrets and paste each into `.env`, replacing the placeholder values:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # → JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"         # → COLUMN_ENCRYPTION_KEY
```

`COLUMN_ENCRYPTION_KEY` encrypts customer data in the database. If you change it later,
existing encrypted data can no longer be read, so treat it like a password and keep it out of Git.
`.env` is already ignored by Git.

**3. Start the database and create the schema**

```powershell
docker compose up -d postgres
npm run migrate
```

## Daily workflow

```powershell
docker compose up -d postgres   # if not already running
npm run dev:api                 # terminal 1 → http://localhost:3000/api/health
npm run dev:web                 # terminal 2 → http://localhost:5173
```

Log in as `superadmin` / `Admin@1234`. You will be asked to change the password at first login.

Stop the database when you are done (the data is kept):

```powershell
docker compose stop postgres
```

## Checks before opening a pull request

```powershell
npm run lint
npx tsc --noEmit -p apps/api
npx tsc --noEmit -p apps/web
npm test            # API integration tests (needs the database)
npm run test:web    # web component tests
```

**The tests use their own database.** `npm test` never touches your development database
`bms`: it runs against `bms_test` on the same server, which it creates and migrates
automatically. To use a different test database, set `TEST_DATABASE_URL`; its name must end
in `_test`, so the tests can never run against real data by mistake.

## Database tasks

**Open a SQL shell:**

```powershell
docker compose exec postgres psql -U bms -d bms
```

**Reset the test database.** Drop it; the next `npm test` recreates it.

```powershell
docker compose exec postgres psql -U bms -d postgres -c "DROP DATABASE bms_test"
```

**Reset to an empty database.** This deletes all local data, including the test database.
Use it when you want a clean start.

```powershell
docker compose down -v
docker compose up -d postgres
npm run migrate
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` | Docker Desktop is not running. Start it and wait for "Engine running". |
| `ECONNREFUSED 127.0.0.1:5433` from the API or tests | The database container is stopped. Run `docker compose up -d postgres`. |
| `password authentication failed for user "bms"` | `DATABASE_URL` in `.env` points at the wrong server, usually port 5432 (a native PostgreSQL) instead of 5433. |
| `Bind for 0.0.0.0:5433 failed: port is already allocated` | Another program uses 5433. Find it with `Get-NetTCPConnection -LocalPort 5433 -State Listen`. |
| Container exits with `Error: in 18+, these Docker images are configured to store database data in a format ...` | A data volume from an older PostgreSQL version is mounted. See "Upgrading from the PostgreSQL 16 setup" below. |
| `COLUMN_ENCRYPTION_KEY must be set to a 64-character hex string` | Generate the key as in step 2 and put it in `.env`. |
| `Unsafe configuration, refusing to start` | The API checks its settings at startup. The message lists each problem and how to fix it, usually a missing or example secret in `.env` (step 2). |
| Warning `... is a published example value` when starting the API | `.env` still has an example secret. It is allowed in development only; generate a real one as in step 2. |

## Upgrading from the PostgreSQL 16 setup

Earlier versions of `docker-compose.yml` ran PostgreSQL 16 on port 5432, with a volume
named `pgdata`. The PostgreSQL 18 setup uses a new volume (`pgdata18`), so the old one is
left untouched.

1. In `.env`, change the port in `DATABASE_URL` from `5432` to `5433`.
2. Start the new database and create the schema:
   ```powershell
   docker compose up -d postgres
   npm run migrate
   ```
3. Once you are sure you don't need the old data, remove the old volume:
   ```powershell
   docker volume ls                                   # find the name ending in _pgdata
   docker volume rm standard-bookstore-erp_pgdata
   ```

To keep data from the old database, export it **before** step 3. Start the old container
separately, then use `pg_dump` and `psql` to copy the data.
