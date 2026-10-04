# Bookstore ERP: guidance for Claude Code

Multi-branch bookstore ERP. Monorepo with npm workspaces:

- `apps/api`: Node 24 LTS (`.nvmrc`), TypeScript (strict), Express 5, PostgreSQL 18 via `pg`, migrations with `node-pg-migrate`
- `apps/web`: React 18, Vite, TanStack Query, react-hook-form + zod, Tailwind
- `packages/shared`: types shared by the API and the web app

v1 is maintained on `release/1.x`. `main` is the v2.0.0 line: an incremental move to a layered architecture.
The plan is tracked in GitHub issues #2–#33 (epics #2–#6).

## Collaboration rules (the repository owner decides; follow these exactly)

The owner (King2H) owns the architecture, project decisions, code review and release management.
Claude is the implementer.

- **Never commit or push unless the owner explicitly asks** in the current conversation.
- **Commit identity:** commits are authored as `King2H <neg2htt@gmail.com>`.
  Before every commit, run `git config user.name` and `git config user.email`
  (or `git var GIT_AUTHOR_IDENT`). If they show anything else, stop and ask.
  Never change the identity without the owner's permission.
- **No AI attribution in Git history:** no `Co-Authored-By` trailers and no session links in commit messages.
  No attribution footers in PR descriptions.
- **Never rewrite history** on `main` or `release/1.x` (no rebase, amend or force-push) without explicit permission.
- **Merging is done by the owner in the GitHub web UI:**
  - feature PRs into `main`: **Squash and merge**. The result is one GitHub-signed (Verified) commit per PR.
  - `release/1.x` into `main`: **Create a merge commit**, so shared fixes keep the same commit ID on both branches.
- **Releases:** the owner tags and publishes them. v1 fixes go to `release/1.x` (v1.1.x) and are then merged into `main`.
- Keep each PR small and tied to one issue (`Closes #N`). Explain what changed and how it was verified.

## Commands

Run from the repository root. The API and its tests need PostgreSQL and a `.env` (copy `.env.example`).
Full setup guide (Windows): `docs/development.md`.
In Claude Code on the web, `.claude/hooks/session-start.sh` prepares all of this automatically at session start:
Node from `.nvmrc`, dependencies, and PostgreSQL 18 on `localhost:5433` with migrations applied (`DATABASE_URL` is exported).

```bash
npm install                      # install all workspaces
docker compose up -d postgres    # start only PostgreSQL 18 (host port 5433)
npm run migrate                  # apply database migrations
npm run db:types                 # regenerate Kysely types after a migration (CI checks them)
npm run dev:api                  # API on :3000
npm run dev:web                  # web on :5173 (proxies /api)
npm run lint                     # ESLint for api, web, shared
npx tsc --noEmit -p apps/api     # typecheck API
npx tsc --noEmit -p apps/web     # typecheck web
npm test                         # API integration tests (real database, sequential)
npm run test:web                 # web component tests (jsdom)
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, a dependency audit, web tests and build, and the API tests on
PostgreSQL 18 for every PR to `main`. Run the same checks locally before asking for a merge.

The Bank Accounts module is off unless `FEATURE_BANK_ACCOUNTS=true` (interim switch until feature flags, #27).

`npm test` runs against its own database (`bms_test`, derived from `DATABASE_URL`, or `TEST_DATABASE_URL`),
which it creates and migrates automatically. Its name must end in `_test`.

## Architecture

### Current (v1) layout

`apps/api/src/modules/<domain>/<domain>.routes.ts` and `<domain>.service.ts`.
Routes parse the request and call services. Services currently mix business rules, SQL and transactions.
Cross-cutting middleware lives in `apps/api/src/middleware`. Errors are `AppError` subclasses from `lib/errors.ts`.

### Target (v2) rules: apply to every new or refactored module

Layers, top to bottom. Each layer calls only the layer below it.

1. **Routes**: URL, middleware and a controller only.
2. **Controller**: request → validated DTO → service → response. No business logic, no SQL.
3. **Service**: one function per use case; owns the transaction boundary. Never touches `req`/`res`.
4. **Domain / policy**: pure functions (state machines, pricing, costing, allowed actions). Unit-tested.
5. **Repository**: the only code that runs SQL (Kysely). Takes a `Queryable` (transaction or db) as its first argument.
   Branch-owned and tenant-owned queries require scope parameters.
6. **Database**: migrations are the only source of schema truth. No DDL or schema checks at runtime.
   `apps/api/src/db/types.generated.ts` is generated from them (`npm run db:types`); never edit it by hand.

Contracts (request/response schemas) live in `packages/shared` as zod schemas, used by API validation, web forms and types.

Frontend: pages compose feature components. Data access goes through `features/<domain>/{api,queries}`.
Pages never call `fetch` directly.

The full design is in `docs/v2/architecture.md` and the decisions in `docs/adr/` (ADR-0001 to ADR-0011). They take precedence over this summary.

## Conventions

- TypeScript strict; avoid `any`.
- SQL is always parameterized. Never interpolate user input.
- Money is stored as Postgres `numeric`. Never compare money with floating-point equality.
- Business errors throw `AppError` subclasses (`ValidationError`, `BusinessError`, `NotFoundError`, …).
- Never trust client-supplied scope: branch and tenant come from the authenticated context.
- Every bug fix comes with a regression test that fails before the fix.
- Match the style of surrounding code; keep comments for *why*, not *what*.
