# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations.

## Project Status

**Phase: Phase 0 Complete — Implementation In Progress**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | ✅ Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | ✅ Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | ✅ Complete | `.kiro/specs/bookstore-management-system/tasks.md` |

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
- Vitest + Supertest integration test infrastructure

**Task 0B — Auth + Branch Management (First Vertical Slice)** ✅
- Full JWT authentication: login (branch dropdown), logout, token refresh
- 7-role RBAC: `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor`
- Staff management: create, deactivate, reactivate, branch-role assignment (full replace)
- Branch management: create, update, deactivate, reactivate, delete (with dependency guard)
- Audit log: all write actions recorded with staff, role, entity, branch context
- Audit Log viewer UI: real-time (3s polling), expandable details, entity filter
- Toast notifications for all CRUD actions
- Role-based UI: nav items and action buttons hidden based on JWT role

**Seed credentials (local dev):**
- `superadmin` / `password` / Branch: Main Branch (role: Super_Admin)
- `admin` / `password` / Branch: Main Branch (role: Admin)

---

## Domain Coverage (17 Vertical Slices)

| Slice | Domain | Status |
|-------|--------|--------|
| 0 | Infrastructure | ✅ Done |
| 2+3 | Staff & Auth + Branch | ✅ Done |
| 1 | Configuration & System Settings | ⬜ Next |
| 4 | Bank Account Management | ⬜ Pending |
| 5 | Location Management | ⬜ Pending |
| 6 | Catalog Management | ⬜ Pending |
| 7 | Inventory Management | ⬜ Pending |
| 8–15 | Operations + Financial Flows | ⬜ Pending |
| 16–17 | Reporting + UI/Dashboard | ⬜ Pending |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State / Data | TanStack Query + TanStack Table |
| Forms | React Hook Form + Zod |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw `pg` driver) |
| Cache / Queue | Redis 7 + BullMQ (Phase 4) |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Logging | Structured JSON (console → Pino in Phase 4) |
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

# 4. Start API dev server (from root)
npm run dev:api

# 5. Start web dev server (from root, separate terminal)
npm run dev:web
```

Open `http://localhost:5173` — login with `superadmin` / `password` / Main Branch.

## Running Tests

```bash
cd apps/api && npm test
```
