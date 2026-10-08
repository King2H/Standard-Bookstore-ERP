# API error codes

Every API error uses one envelope (ADR-0004), defined by `ErrorResponseSchema` in
`packages/shared/src/common.ts`:

```json
{
  "error": "INSUFFICIENT_STOCK",
  "message": "Only 2 copies left in this location",
  "details": {},
  "requestId": "3f2c9d1e-…",
  "timestamp": "2026-10-04T16:30:00.000Z"
}
```

- `error` is a stable code from this page. Clients branch on it.
- `message` is for people. It may change wording at any time; never parse it.
- `details` is always an object. For `VALIDATION_ERROR` it holds `issues`, each with a
  `path` such as `["body", "price"]` and a `message`.
- `requestId` is also in the server logs, so a support request can be traced.

Codes are part of the API contract: a code is never renamed or reused for a different
meaning. A new code is added to this page in the same pull request that introduces it;
a test fails if one is missing.

## General codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | The request does not match its schema; see `details.issues`. |
| 400 | `INVALID_ID` | A route parameter is not a valid id. |
| 401 | see "Authentication" | Not signed in, or the session is no longer valid. |
| 403 | `FORBIDDEN` | Signed in, but not allowed to do this. |
| 403 | `PERMISSION_DENIED` | The role lacks a required permission; `details.missing` lists it. |
| 403 | `BRANCH_ACCESS_DENIED` | The request names a branch other than the session's branch, and the staff member does not have access to all branches; `details.branchId` is that branch. Switch branch to work there. (At login, the same code is a 401.) |
| 403 | `PASSWORD_CHANGE_REQUIRED` | The staff member must change their password first (after an admin reset, or on a default password). Only the profile, change password, branch list, refresh and logout answer until then. |
| 403 | `CSRF_INVALID` | The CSRF token is missing or does not match. |
| 404 | `NOT_FOUND` | The route or the requested record does not exist. |
| 409 | see "Conflicts" | The request conflicts with the current state of the data. |
| 410 | `DEPRECATED` | The endpoint has been retired; use the replacement named in `message`. |
| 422 | see "Business rules" | The request is valid but a business rule forbids it. |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many attempts; retry after `Retry-After` seconds. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected server error; details are only in the logs. |
| 503 | `SERVICE_UNAVAILABLE` | A dependency (e.g. the database) is temporarily unavailable. |

## Authentication (401)

- `ACCOUNT_INACTIVE`
- `ACCOUNT_LOCKED`
- `BRANCH_ACCESS_DENIED`
- `INVALID_CREDENTIALS`
- `INVALID_TOKEN`
- `MISSING_REFRESH_TOKEN`
- `MISSING_TOKEN`
- `SERVER_ERROR`
- `TOKEN_EXPIRED`
- `TOKEN_REVOKED`

## Conflicts (409)

- `ALREADY_CLEARED`
- `AUTHOR_IN_USE`
- `BOOK_IN_USE`
- `CATEGORY_IN_USE`
- `DEPENDENCY_CONFLICT`
- `DUPLICATE_AUTHOR`
- `DUPLICATE_BRANCH_NAME`
- `DUPLICATE_CATEGORY`
- `DUPLICATE_CONTACT`
- `DUPLICATE_ISBN`
- `DUPLICATE_LOCATION_NAME`
- `DUPLICATE_PUBLISHER`
- `DUPLICATE_SUPPLIER_NAME`
- `DUPLICATE_USERNAME`
- `IDEMPOTENCY_CONFLICT`
- `PUBLISHER_IN_USE`
- `VERSION_CONFLICT`

## Business rules (422)

- `ALREADY_CANCELLED`
- `ALREADY_COMPLETED`
- `ALREADY_PAID`
- `ALREADY_REJECTED`
- `ALREADY_VOIDED`
- `APPROVAL_REQUIRED`
- `BOOK_INACTIVE`
- `BRANCH_INACTIVE`
- `CANNOT_CANCEL_WITH_RECEIPTS`
- `CANNOT_DEACTIVATE_LAST_SUPER_ADMIN`
- `CANNOT_DEACTIVATE_SELF`
- `CASH_ORDER_ALREADY_PAID`
- `CREDIT_REQUIRES_CUSTOMER`
- `CUSTOMER_INACTIVE`
- `CUSTOMER_REQUIRED_FOR_SETTLEMENT`
- `DEPOSIT_TOO_LOW`
- `DISCOUNT_EXCEEDS_LIMIT`
- `EXCEEDS_INSTALLMENT_AMOUNT`
- `EXCEEDS_MAX_INSTALLMENTS`
- `EXCEEDS_ORDER_TOTAL`
- `EXCEEDS_OUTSTANDING`
- `EXCEEDS_PAYMENT_AMOUNT`
- `EXCHANGE_NOT_CANCELLABLE`
- `INSUFFICIENT_LOYALTY_POINTS`
- `INSUFFICIENT_STOCK`
- `INSUFFICIENT_STORE_CREDIT`
- `INVALID_BANK_ACCOUNT`
- `INVALID_CURRENT_PASSWORD`
- `INVALID_LIFECYCLE_TRANSITION`
- `INVALID_STATE`
- `LINE_ITEM_MISMATCH`
- `LOYALTY_REQUIRES_CUSTOMER`
- `MISSING_TRANSACTION_REFERENCE`
- `ORDER_ALREADY_FULFILLED`
- `ORDER_ALREADY_PAID`
- `ORDER_CANCELLED`
- `ORDER_HAS_DEPENDENCIES`
- `ORDER_INVALID`
- `ORDER_NOT_ELIGIBLE`
- `OVER_RECEIPT`
- `OVER_RETURN`
- `PAYMENT_EXCEEDS_DUE`
- `PAYMENT_EXCEEDS_TOTAL`
- `PAYMENT_FAILED`
- `PAYMENT_SUM_MISMATCH`
- `PLAN_EXISTS`
- `PO_INVALID_STATUS`
- `PO_NOT_CREDITABLE`
- `PO_NOT_EDITABLE`
- `PO_NOT_PAYABLE`
- `PRICE_NOT_SET`
- `PUBLISHER_ID_NOT_ALLOWED`
- `PUBLISHER_ID_REQUIRED`
- `RECEIVABLE_ALREADY_SETTLED`
- `RECEIVABLE_NOT_FOUND`
- `REFUND_EXCEEDS_PAID`
- `REFUND_METHOD_NOT_ALLOWED_AFTER_WINDOW`
- `SETTLEMENT_UNBALANCED`
- `STAFF_NOT_FOUND`
- `STORE_CREDIT_REQUIRES_CUSTOMER`
- `SUPPLIER_BLACKLISTED`
- `SUPPLIER_INACTIVE`
- `TRANSACTION_VOIDED`
