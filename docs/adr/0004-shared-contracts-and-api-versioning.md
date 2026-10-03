# ADR-0004: Shared zod contracts, OpenAPI and `/api/v1`

- **Status:** Accepted
- **Date:** 2026-10-03
- **Decision owner:** King2H
- **Related:** issue #15, `docs/v2/architecture.md` §7

## Context

In v1, `packages/shared` contains 26 lines and the web app does not import it. Request and
response shapes are re-declared in pages (up to 18 types per page). Validation exists in only
7 of 20 route files and is duplicated inside services. The API and the UI can drift apart
silently.

## Decision

1. Every request and response shape is a **zod schema in `packages/shared/src/<domain>.ts`**,
   with TypeScript types inferred from it.
2. The same schema is used in three places: API request validation (`validate(schema)`
   middleware), web forms (`zodResolver`) and TypeScript types on both sides.
3. The API is versioned under **`/api/v1`**. Breaking changes require a new version; additive
   changes do not.
4. An **OpenAPI 3.1** document is generated from the schemas and published with each release.
5. All errors use one envelope: `{ error, message, details, requestId, timestamp }`, with
   stable, documented error codes.

## Consequences

**Positive**
- One definition per contract: API, UI and documentation cannot disagree.
- Validation happens once, at the edge; services receive already-valid data.
- External integrations get a documented, versioned API.

**Negative / costs**
- `packages/shared` must be built and versioned with care, because both apps depend on it.
- Existing endpoints move to `/api/v1` with a transition period for the web app.

## Alternatives considered

- **Separate types per app:** the v1 situation; it drifts.
- **OpenAPI-first with code generation:** strong, but heavier tooling. Generating OpenAPI
  from zod keeps one source of truth with less machinery.
- **tRPC:** ties the API to TypeScript clients; external integrations need plain HTTP/JSON.
