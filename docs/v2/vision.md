# Bookstore ERP v2: vision

Status: **accepted** by the owner on 2026-10-03 (issue #9); open for comments and updates
Owner: King2H · Last updated: 2026-10-03

## 1. Why v2

v1 (current release `v1.1.1`) is a working multi-branch bookstore ERP built for one customer
setting. It covers the full operational cycle (catalog, inventory, procurement, POS, orders,
returns, exchanges, payments, receivables, reports), and its domain logic is in good shape:
weighted-average costing, compensating returns, an audit log, idempotent payments, and about
550 integration tests.

What v1 is **not** yet is a *product*: one codebase that any bookstore can adopt, configure
and run reliably for years. The evaluation of v1.1.0 found the gaps:

- **Structure:** business rules, SQL and transactions are mixed inside service files of up to
  2,300 lines, so changes are risky and slow.
- **Scope and security:** branch isolation is enforced by hand in each endpoint, and some
  rules exist only in the browser (#12, #38).
- **Product fit:** currency, payment methods and modules are hard-coded, so serving a different
  customer means changing code.
- **Operations:** there is no CI, the production image runs from source as root, and there is
  no backup or upgrade procedure.

v2 closes these gaps without a rewrite. The existing behaviour and tests are the safety net,
and the code moves to the target architecture one module at a time.

## 2. Goals

1. **A standard product for any bookstore.** Differences between customers live in
   configuration and data, never in code branches or forks.
2. **Hybrid deployment.** The same build runs **on-premise** (one customer per installation,
   offline-capable) and later as **SaaS** (many customers in one installation) without another
   rewrite. On-premise ships first.
3. **Maintainable by design.** Clear layers with one responsibility each, so a change in one
   place doesn't ripple through the system, and new developers (or AI assistants) can work
   safely from written rules (`CLAUDE.md`, ADRs).
4. **Robust and secure by default.** Rules are enforced on the server; every multi-step
   business operation is all-or-nothing; the app refuses to start with unsafe configuration.
5. **Built to last.** Current long-term-support versions of the stack (Node.js 24 LTS,
   PostgreSQL 18), automated quality gates, and a predictable release process.

## 3. Target market

v2 targets **bookstores in Ethiopia**:

- **Currency:** Ethiopian Birr (ETB), with ETB formatting.
- **Language:** English and Amharic.
- **Tax:** businesses are taxed differently. Some are registered for VAT, some pay turnover
  tax, and smaller ones pay an annual estimated (presumptive) tax with no tax on individual
  sales. So tax is **fully configurable and can be switched off**:
  - each tenant chooses its tax setup in the settings;
  - the default is **0% (no tax on sales)**;
  - Super_Admin or Admin can enable it and set the rates, for example VAT or turnover tax,
    without code changes;
  - rates are data, never hard-coded.

Other countries are possible later through the same configuration mechanisms, but they are
not a v2.0.0 goal.

## 4. Non-goals for v2.0.0

- **No rewrite and no new stack.** Node.js, Express, PostgreSQL, React and Vite stay.
  Kysely is added for type-safe SQL; no ORM.
- **No new business modules** unless needed by the goals above. v2 is about structure,
  safety and productization, not new features.
- **No microservices.** v2 stays a modular monolith: one deployable API, with modules
  separated by clear boundaries inside it.
- **No mobile apps.** The web app stays responsive.

## 5. Quality targets

v2 is measured against widely used benchmarks rather than personal preference.

| Area | Benchmark | v2.0.0 target |
|---|---|---|
| Overall quality model | ISO/IEC 25010 | Maintainability, reliability, security, performance and portability are each addressed by a concrete practice below |
| Security | OWASP ASVS Level 2 | Server-side enforcement of all access rules; no default secrets; dependency scanning in CI; no known high or critical advisories |
| Deployment and configuration | 12-Factor App | Configuration only from the environment; the same image for every environment; migrations as a separate release step |
| Accessibility | WCAG 2.2 AA | New and refactored screens meet AA |
| API | OpenAPI 3.1 | A versioned, documented API (`/api/v1`) generated from the shared contracts |
| Delivery | DORA metrics | Every change goes through a PR with green CI; small PRs; releases tagged from `main` |
| Inventory accounting | IAS 2 | Weighted-average costing (already in v1) is preserved |

## 6. Principles

1. **Configuration over customization.** If two customers need different behaviour, it
   becomes a setting, a registry entry or a feature flag.
2. **The server is the source of truth.** The browser improves the experience; it never
   enforces a rule on its own.
3. **One way to do each thing.** One way to access data (repositories), one way to validate
   input (shared schemas), one way to run a transaction (Unit of Work).
4. **Behaviour stays the same while the structure changes.** Each refactor PR keeps the API
   unchanged, and the existing tests must pass unchanged.
5. **Small, reviewed steps.** One issue, one PR, one squash-merged commit; the owner reviews
   and merges every change.
6. **Decisions are written down.** Architecture decisions are recorded as ADRs (`docs/adr/`)
   and become the rules for code review.

## 7. Success criteria for v2.0.0

- Every API module follows the layered structure in [`architecture.md`](architecture.md).
- Tenant and branch scope are enforced by the data layer and covered by tests (#12, #13).
- CI runs lint, typecheck, unit, integration and E2E tests on every PR, and `main` is protected.
- A new customer can be installed on-premise from the documented bundle, with backups,
  without code changes.
- No open high or critical security findings.
- A tenant can run with tax switched off (0%) or with configured tax rates, chosen in settings.

## 8. Related documents

- [`architecture.md`](architecture.md): the target architecture (how the system is built).
- `docs/adr/`: architecture decision records (#10).
- `roadmap.md`: phases and milestones (#11).
- Progress tracker: issue #37.
