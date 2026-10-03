# ADR-0006: Configuration hierarchy: system → tenant → branch → user

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issues #24, #25, #27, ADR-0003, ADR-0010

## Context

v2 must serve different bookstores from one codebase. v1 already has 21 typed settings with
branch overrides, but no tenant level. Some behaviour is still hard-coded: currency, payment
methods, and modules switched off by commenting out code.

## Decision

1. **Principle:** differences between customers live in configuration and data, never in
   code branches or forks.
2. Settings resolve in this order, the most specific winning:
   **system default → tenant → branch → user** (user only for personal preferences such as
   language).
3. Each setting has a typed schema (zod) with a default and validation. Unknown or invalid
   values are rejected when saved.
4. Changes are audited (who, when, old value, new value). Only roles with the matching
   permission (Super_Admin/Admin) can change tenant-level settings.
5. Variable lists that differ per customer are **registries** (data plus a small adapter
   interface), not code: payment methods, document number series, notification channels.
6. Optional modules are switched on or off per tenant with **feature flags** that both the
   API and the web app respect.

## Consequences

**Positive**
- New customers are onboarded by configuration.
- Behaviour differences are visible and auditable in one place.

**Negative / costs**
- Settings must be resolved efficiently (cached per request or per tenant).
- Every new rule must decide whether it is configurable, and at which level.

## Alternatives considered

- **Per-customer code branches or forks:** unmaintainable after the second customer.
- **Environment variables for business settings:** cannot vary per tenant or branch, and
  require a restart to change.
