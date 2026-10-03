# ADR-0010: Configurable tax per tenant, default 0%

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issue #26, ADR-0006, `docs/v2/vision.md` §3

## Context

v2 targets bookstores in Ethiopia. Their tax situation differs from business to business:
some are registered for VAT, some pay turnover tax, and smaller businesses pay an annual
estimated (presumptive) tax, with no tax charged on individual sales. Some current users with
high transaction volumes may move into a sales-tax regime later. v1 has only a single flat
`tax_rate` setting, and it is currently disabled.

## Decision

1. Tax is a **tenant-level setting**, editable only by Super_Admin and Admin.
2. The **default is off (0%)**. A tenant that charges no tax on sales needs no configuration.
3. When enabled, the tenant defines **tax rates as data**:
   - a name, for example "VAT" or "Turnover tax";
   - a percentage;
   - an effective-from date;
   - whether prices are tax-inclusive or tax-exclusive.

   No rate is hard-coded.
4. Every sale, return and exchange **stores the rate and amount that applied** at the time, so
   historic documents and reports remain correct after a rate changes.
5. Receipts and reports show tax only when it is enabled for the tenant.
6. The design leaves room for per-product tax categories later, without requiring them for
   v2.0.0.

## Consequences

**Positive**
- Serves businesses on presumptive tax and businesses registered for VAT or turnover tax with
  the same build.
- Rate changes by the authorities are a settings change, not a release.

**Negative / costs**
- Pricing, receipts, returns and reports must all read the stored tax data consistently.
- Statutory e-invoicing or fiscal-device integration, if required later, is a separate
  decision.

## Alternatives considered

- **Hard-coded rate (e.g. 15% VAT):** wrong for businesses not registered for VAT.
- **No tax support at all:** blocks customers who are, or will become, tax-registered.
