# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations.

## Project Status

**Phase: Spec Complete — Ready for Implementation**

All three spec documents are finalized and consistent. No code has been written yet.

| Document | Status | Location |
|----------|--------|----------|
| Requirements | ✅ Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | ✅ Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | ✅ Complete | `.kiro/specs/bookstore-management-system/tasks.md` |

---

## What's Been Specified

### Domain Coverage (17 Vertical Slices)

| Slice | Domain |
|-------|--------|
| 1 | Configuration & System Settings |
| 2 | Staff & Access Control |
| 3 | Branch Management |
| 4 | Bank Account Management & Reconciliation |
| 5 | Location Management |
| 6 | Catalog Management |
| 7 | Inventory Management |
| 8 | Supplier Management |
| 9 | Procurement & Purchase Orders |
| 10 | Customer Management |
| 11 | Point of Sale — Transactions |
| 12 | Returns & Refunds |
| 13 | Order Management |
| 14 | Payment Management & Installments |
| 15 | Merchant Exchange (In-Kind Trading) |
| 16 | Reporting & Analytics |
| 17 | UI & Data Presentation |

### Roles (7)

`Super_Admin` · `Admin` · `Manager` · `Finance_Officer` · `Stock_Clerk` · `Sales` · `Purchasor`

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| State / Data | TanStack Query + TanStack Table |
| Charts | Recharts |
| Forms | React Hook Form + Zod |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw `pg` driver) |
| Cache / Queue | Redis 7 + BullMQ |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Real-time | Server-Sent Events (SSE) for in-app notifications |
| Logging | Pino (structured JSON) |
| Metrics | Prometheus (prom-client) |
| Tracing | OpenTelemetry |
| Container | Docker + Docker Compose |
| Reverse Proxy | Nginx |

### Key Design Decisions

- **Modular monolith** — single deployment, domain-separated modules, outbox pattern for async decoupling
- **Vertical slicing** — each implementation task delivers DB → service → API → UI end-to-end
- **CQRS** — writes to primary PostgreSQL, reads (reports, dashboard) to read replica
- **Optimistic locking** on inventory; pessimistic locking on payments and order confirmation
- **Outbox pattern** — guaranteed audit log and event delivery without blocking writes
- **SSE** — real-time in-app notifications for approvals, alerts, and job completions
- **21 configurable business rules** — discounts, PO approval thresholds, return policies, loyalty rates, installment limits, and more

---

## Implementation Roadmap

Tasks are organized into 4 phases + hardening:

| Phase | Focus | Tasks |
|-------|-------|-------|
| Phase 0 | System validation (auth + branch working) | 0A, 0B |
| Phase 1 | Core master data (config, bank accounts, locations, catalog, inventory) | 1, 4–7 |
| Phase 2 | Operations (suppliers, procurement, customers, POS) | 8–11 |
| Phase 3 | Financial flows (returns, orders, payments, exchange) | 12–15 |
| Phase 4 | Reporting, UI, async infra, security, observability, CI/CD | 16–17, H1–H4 |

To start implementation, open `.kiro/specs/bookstore-management-system/tasks.md` and begin with **Task 0A**.
