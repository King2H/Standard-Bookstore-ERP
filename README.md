# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations.

## Project Status

**Phase: Phase 1 In Progress — Slice 1 (Configuration & Settings) Complete**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | ✅ Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | ✅ Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | ✅ In Progress | `.kiro/specs/bookstore-management-system/tasks.md` |

---

## Implementation Progress

### Phase 0 — System Validation ✅ COMPLETE

**Task 0A — Bootstrap Minimal Infrastructure** ✅
- Monorepo: `apps/api` (Node.js 20 + TypeScript 5 + Express 5), `apps/web` (React 18 + Vite + Tailwind), `packages/shared`
- Docker Compose: API + PostgreSQL 16
- node-pg-migrate with `.cjs` migration files (required for ESM monorepo)
- DB migrations: `audit_logs`, `staff`, `staff_branch_roles`, `refresh_tokens`, `branches`
- Express middleware: JWT auth, RBAC (`requireRole`), branch context, request ID, structured JSON logging, error handler
- `GET /health` endpoint
- Vitest + Supertest integration test infrastructure (prefix-based cleanup — seed data never touched)

**Task 0B — Auth + Branch Management (First Vertical Slice)** ✅
- Full JWT authentication: login (branch dropdown), logout, token refresh
- 7-role RBAC: `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor`
- Staff management: create, deactivate, reactivate, branch-role assignment (full replace)
- Branch management: create, update, deactivate, reactivate, delete (with dependency guard)
- Audit log: all write actions recorded with staff, role, entity, branch context
- Audit Log viewer UI: real-time (3s polling), expandable details, entity filter
- Toast notifications for all CRUD actions
- Role-based UI: nav items and action buttons hidden based on JWT role

**UI Polish** ✅
- Dark / light mode with system preference detection and `localStorage` persistence
- Animated login page with glassmorphism card and gradient background
- Collapsible sidebar with icons, role-colored badges, dark mode toggle
- All pages fully dark-mode compatible (`dark:` Tailwind classes throughout)

**Seed credentials (local dev):**
- `superadmin` / `password` / Branch: Main Branch (role: Super_Admin)
- `admin` / `password` / Branch: Main Branch (role: Admin)

---

### Phase 1 — Core Business Foundation 🔄 IN PROGRESS

**Task 1 — Configuration & System Settings** ✅
- DB migration: `system_config` (key/value, system-wide) + `branch_config` (per-branch overrides)
- 21 system defaults seeded: currency, tax, discounts, inventory, procurement, returns, payments, loyalty, exchange, notifications
- `config.service.ts`: `getEffectiveConfig` (branch → system fallback), `setSystemConfig`, `setBranchConfig`, `deleteBranchConfig`
- 15 typed helper methods for use by future service modules (`getPOApprovalThreshold`, `getLoyaltyAccrualRate`, `isNegativeStockAllowed`, etc.)
- API routes: `GET/PUT /api/config/system`, `GET/PUT/DELETE /api/config/branches/:branchId/:key`
- RBAC: Super_Admin only for system config writes; Admin/Manager for branch overrides
- Settings UI: 9-tab page (General, Discounts, Inventory, Procurement, Returns, Payments, Loyalty, Exchange, Notifications) with side-by-side system defaults + branch overrides panels, inline editing, source badges
- 13 integration tests — all passing; seed data preserved

---

## Domain Coverage (17 Vertical Slices)

| Slice | Domain | Status |
|-------|--------|--------|
| 0 | Infrastructure | ✅ Done |
| 2+3 | Staff & Auth + Branch | ✅ Done |
| 1 | Configuration & System Settings | ✅ Done |
| 4 | Bank Account Management | ⬜ Next |
| 5 | Location Management | ⬜ Pending |
| 6 | Catalog Management | ⬜ Pending |
| 7 | Inventory Management | ⬜ Pending |
| 8–15 | Operations + Financial Flows | ⬜ Pending |
| 16–17 | Reporting + UI/Dashboard | ⬜ Pending |

---

## Folder Structure

```
standard-book-store-erp/
├── apps/
│   ├── api/                          # Express API (Node.js 20 + TypeScript)
│   │   ├── scripts/
│   │   │   └── reseed.mjs            # Restores seed data if wiped (npm run reseed)
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   ├── index.ts          # pg.Pool singleton + checkDbConnection()
│   │   │   │   ├── database.json     # node-pg-migrate connection config
│   │   │   │   └── migrations/       # .cjs migration files (ESM-safe)
│   │   │   │       ├── 1700000001_create_audit_logs.cjs
│   │   │   │       ├── 1700000002_create_staff_auth.cjs
│   │   │   │       ├── 1700000003_create_branches.cjs
│   │   │   │       └── 1700000004_create_config.cjs   ← Slice 1
│   │   │   ├── lib/
│   │   │   │   └── errors.ts         # AppError class + error code constants
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT verify → req.staff
│   │   │   │   ├── rbac.ts           # requireRole(...roles) factory
│   │   │   │   ├── branchCtx.ts      # X-Branch-Id header validation
│   │   │   │   ├── errorHandler.ts   # Global error → { error, message, requestId }
│   │   │   │   ├── logger.ts         # Structured JSON request logging
│   │   │   │   └── requestId.ts      # UUID injection per request
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   │   ├── auth.service.ts   # login, logout, refresh, createStaff, assignRoles
│   │   │   │   │   └── auth.routes.ts    # POST /auth/login|logout|refresh, GET/POST /staff
│   │   │   │   ├── branch/
│   │   │   │   │   ├── branch.service.ts # create, update, deactivate, reactivate, delete
│   │   │   │   │   └── branch.routes.ts  # GET/POST/PUT/DELETE /branches
│   │   │   │   └── config/               ← Slice 1
│   │   │   │       ├── config.service.ts # getEffectiveConfig, set/delete system+branch config, typed helpers
│   │   │   │       └── config.routes.ts  # GET/PUT /config/system, GET/PUT/DELETE /config/branches/:id/:key
│   │   │   ├── routes/
│   │   │   │   └── auditLogs.ts      # GET /audit-logs (paginated, filtered)
│   │   │   ├── types/
│   │   │   │   └── express.d.ts      # req.staff type augmentation
│   │   │   ├── tests/
│   │   │   │   ├── auth.test.ts      # Auth + staff integration tests
│   │   │   │   ├── branch.test.ts    # Branch CRUD integration tests
│   │   │   │   ├── config.test.ts    # Config system + branch override tests  ← Slice 1
│   │   │   │   ├── health.test.ts    # Health endpoint test
│   │   │   │   ├── setup.ts          # Global test setup
│   │   │   │   └── helpers/
│   │   │   │       ├── testDb.ts     # Prefix-based cleanup (seed data preserved)
│   │   │   │       ├── testApp.ts    # Supertest app factory
│   │   │   │       └── seed.ts       # createTestStaff, createTestBranch
│   │   │   ├── app.ts                # Express app factory (middleware stack)
│   │   │   └── server.ts             # HTTP server entry point
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   │
│   └── web/                          # React SPA (Vite + Tailwind)
│       ├── src/
│       │   ├── components/
│       │   │   ├── Layout.tsx        # Collapsible sidebar + top bar + dark mode toggle
│       │   │   └── Toast.tsx         # Toast notification system (ToastProvider + useToast)
│       │   ├── lib/
│       │   │   ├── api.ts            # Typed fetch wrapper (auto-refresh on 401)
│       │   │   ├── auth.ts           # login(), logout(), token memory store
│       │   │   └── theme.tsx         # ThemeProvider + useTheme (dark/light, localStorage)
│       │   ├── pages/
│       │   │   ├── LoginPage.tsx     # Animated login with branch dropdown
│       │   │   ├── BranchesPage.tsx  # Branch CRUD table
│       │   │   ├── StaffPage.tsx     # Staff CRUD + inline role editor
│       │   │   ├── AuditLogPage.tsx  # Real-time audit log (3s polling)
│       │   │   └── SettingsPage.tsx  # Config settings (9 tabs, system + branch)  ← Slice 1
│       │   ├── App.tsx               # Root: ThemeProvider → Layout → pages
│       │   ├── main.tsx              # React entry point
│       │   └── index.css             # Tailwind base + dark mode scrollbar
│       ├── package.json
│       ├── tailwind.config.js        # darkMode: 'class' + custom animations
│       └── vite.config.ts            # Proxy /api → localhost:3000
│
├── packages/
│   └── shared/                       # Shared TypeScript types (future use)
│       └── src/index.ts
│
├── .kiro/specs/bookstore-management-system/
│   ├── requirements.md               # 27 functional requirements + NFRs
│   ├── design.md                     # 17 vertical slices, DB schema, API design
│   └── tasks.md                      # Phased implementation roadmap
│
├── docker-compose.yml                # API + PostgreSQL 16
├── .env                              # Local env vars (not committed)
├── .env.example                      # Template for required env vars
└── package.json                      # Workspace root (npm workspaces)
```

---

## Data Flow

Every request follows this path through the system:

```
Browser (React)
    │
    │  HTTP request (fetch via api.ts)
    │  Authorization: Bearer <accessToken>
    │  X-Branch-Id: <branchId>
    ▼
Vite Dev Server (:5173)
    │
    │  /api/* proxied to localhost:3000
    ▼
Express API (:3000)
    │
    ├─ requestId middleware     → injects X-Request-Id UUID
    ├─ logger middleware        → logs method + path + requestId
    ├─ auth middleware          → verifies JWT → populates req.staff
    ├─ branchCtx middleware     → validates X-Branch-Id ∈ staff's branches
    ├─ rbac middleware          → requireRole(...) → 403 if role mismatch
    │
    ├─ Route handler            → validates request body (Zod)
    │
    ├─ Service layer            → business logic
    │   ├─ DB queries           → pg.Pool (parameterized SQL, no ORM)
    │   ├─ Audit log insert     → INSERT INTO audit_logs (staff_id, role, action, entity_type, entity_id, branch_id, meta)
    │   └─ Returns result
    │
    ├─ errorHandler middleware  → catches AppError → { error, message, requestId, timestamp }
    │
    └─ JSON response
    │
    ▼
TanStack Query (React)
    │
    ├─ Caches response
    ├─ Auto-refetches on mutation (invalidateQueries)
    └─ Renders UI
```

### Auth Token Flow

```
Login → POST /api/auth/login
    → API returns { accessToken } (15 min JWT)
    → API sets httpOnly cookie: refresh_token (7 days)
    → accessToken stored in memory (api.ts module variable)

401 on any request
    → api.ts intercepts → POST /api/auth/refresh (sends cookie)
    → New accessToken stored in memory
    → Original request retried

Logout → POST /api/auth/logout
    → Refresh token revoked in DB
    → Cookie cleared
    → accessToken cleared from memory
```

### Config Lookup Flow (Slice 1)

```
Any service needing a business rule
    │
    ├─ getEffectiveConfig(branchId, key)
    │   ├─ SELECT FROM branch_config WHERE branch_id = $1 AND key = $2
    │   │   → found: return branch override value
    │   └─ fallback: SELECT FROM system_config WHERE key = $1
    │       → return system default
    │
    └─ Typed helpers (e.g. getPOApprovalThreshold, getLoyaltyAccrualRate)
        → parse and return typed value for use in business logic
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (dark mode: class strategy) |
| State / Data | TanStack Query |
| Forms | React Hook Form + Zod |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw `pg` driver) |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Logging | Structured JSON (console) |
| Container | Docker + Docker Compose |

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (Docker)
docker compose up -d postgres

# 3. Run migrations (from apps/api)
cd apps/api && npm run migrate

# 4. Start API dev server (from root, terminal 1)
npm run dev:api

# 5. Start web dev server (from root, terminal 2)
npm run dev:web
```

Open `http://localhost:5173` — login with `superadmin` / `password` / Main Branch.

## Running Tests

```bash
cd apps/api && npm test
```

> Tests use prefix-based cleanup (`auth_test_*`, `branch_test_*`, etc.) — seed data (Main Branch, superadmin, admin) is never touched.

## Restoring Seed Data

If seed data is ever lost (e.g. after a DB reset):

```bash
cd apps/api && npm run reseed
```

This restores Main Branch, superadmin, admin, and all 21 system_config defaults.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://bms:bms@localhost:5432/bms` |
| `JWT_SECRET` | Secret for signing JWTs | any long random string |
| `NODE_ENV` | Environment | `development` |
| `PORT` | API port (optional) | `3000` |

---

## API Reference (Implemented Endpoints)

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | None | Login; returns accessToken + sets refresh cookie |
| POST | `/api/auth/logout` | Bearer | Revoke refresh token |
| POST | `/api/auth/refresh` | Cookie | Issue new accessToken |

### Staff
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/staff` | Admin+ | List staff with branch-role assignments |
| POST | `/api/staff` | Admin+ | Create staff account |
| PUT | `/api/staff/:id` | Admin+ | Update full name |
| POST | `/api/staff/:id/deactivate` | Admin+ | Deactivate (revokes tokens) |
| POST | `/api/staff/:id/reactivate` | Admin+ | Reactivate |
| PUT | `/api/staff/:id/roles` | Admin+ | Full replace branch-role assignments |

### Branches
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/branches/public` | None | Active branches for login dropdown |
| GET | `/api/branches` | Any | Paginated branch list |
| POST | `/api/branches` | Admin+ | Create branch |
| PUT | `/api/branches/:id` | Admin+ | Update branch |
| POST | `/api/branches/:id/deactivate` | Admin+ | Deactivate |
| POST | `/api/branches/:id/reactivate` | Admin+ | Reactivate |
| DELETE | `/api/branches/:id` | Admin+ | Delete (409 if dependencies exist) |

### Configuration (Slice 1)
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/config/system` | Admin+ | All 21 system config keys |
| PUT | `/api/config/system/:key` | Super_Admin | Update system default |
| GET | `/api/config/branches/:branchId` | Admin+ | Merged effective config with source labels |
| PUT | `/api/config/branches/:branchId/:key` | Admin+ | Set branch override |
| DELETE | `/api/config/branches/:branchId/:key` | Admin+ | Remove branch override (restores system default) |

### Audit Log
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/audit-logs` | Admin+ | Paginated audit log; filter by entityType |
