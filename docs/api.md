# API reference (v1)

Base URL: `/api/v1`. All requests and responses are JSON unless noted.

```jsonc
// Success
{ "success": true, "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 134, "totalPages": 7 } }
// Failure
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "path": "phone", "message": "…" }], "requestId": "…" } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Schema validation failed |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | Missing, invalid or expired token; revoked session |
| 403 | `FORBIDDEN` / `CSRF` | Missing permission, inactive membership, bad CSRF token |
| 404 | `NOT_FOUND` | Missing **or not visible to you** (other tenant or project) |
| 409 | `CONFLICT` / `IDEMPOTENCY_CONFLICT` | Duplicate unique value, plot already booked, request in flight |
| 422 | `BUSINESS_RULE` / `IDEMPOTENCY_CONFLICT` | Rule violation (e.g. overpayment rejected); key reused with a different body |
| 429 | `RATE_LIMITED` | Too many requests |

**Conventions**
- Money is integer **paise**, percentages are **basis points**, and areas are **hundredths of a sq ft**.
- Calendar dates are `YYYY-MM-DD`. Timestamps are ISO-8601 UTC.
- List endpoints accept `page`, `pageSize` (≤100), `sort` (`field` or `-field`, allow-listed) and `q`.
- `Authorization: Bearer <accessToken>` is required everywhere except the public `/auth/*` routes.
- Endpoints marked 🔑 require an `Idempotency-Key` header (8–100 chars, e.g. a UUID).

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | `{name,email,password,companyName}`. Creates the user, the company (roles and chart of accounts) and the owner membership. Sets cookies |
| POST | `/auth/login` | `{email,password}`. Returns `accessToken` plus auth context. Sets `erp_rt` (HttpOnly) and `erp_csrf` |
| POST | `/auth/refresh` | Cookie plus `x-csrf-token` header. Rotates the refresh token |
| POST | `/auth/logout` | Cookie plus CSRF. Revokes the session |
| GET | `/auth/me` | User, companies, active company with permissions and project access |
| POST | `/auth/select-company` | `{companyId}`. Membership verified server-side |
| GET / DELETE | `/auth/sessions[/:id]` | List and revoke your own sessions |
| POST | `/auth/change-password` | Revokes your other sessions |
| POST | `/auth/forgot-password`, `/auth/reset-password` | Single-use token, 1 h |
| POST | `/auth/verify-email`, `/auth/resend-verification` | Single-use token, 48 h |
| GET | `/auth/invitations/:token` | Public invitation details |
| POST | `/auth/accept-invite` | New user `{token,name,password}`; existing user signed in `{token}` |

## Company, users, roles, audit, notifications

| Method | Path | Permission |
| --- | --- | --- |
| GET / PATCH | `/company` | `company.read` / `company.update` |
| GET | `/users` | `users.read` (memberships with user and role) |
| PATCH | `/users/:membershipId` | `users.update` (status changes also need `users.deactivate`; last-owner and self protections apply) |
| GET / POST / DELETE | `/invitations[/:id]` | `users.read` / `users.create` |
| GET | `/permissions` | any member (catalog) |
| GET / POST / PATCH / DELETE | `/roles[/:id]` | `roles.*` |
| GET | `/audit-logs?entityType&entityId&actorId&action&from&to` | `audit.read` |
| GET | `/notifications?unread=true` · POST `/notifications/:id/read` · POST `/notifications/read-all` | own notifications |
| GET | `/members` | any member: active users' names, for owner/assignee pickers |

## Projects and inventory

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST | `/projects` | `projects.read` / `projects.create` |
| GET / PATCH | `/projects/:id` | `projects.read` / `projects.update` |
| POST | `/projects/:id/archive` | `projects.archive` (blocked while plots are reserved or booked) |
| POST / PATCH / DELETE | `/projects/:id/phases[/:phaseId]`, `/projects/:id/blocks[/:blockId]` | `projects.update` |
| GET | `/projects/:id/plots?status&blockId&phaseId&category&q&sort` | `inventory.read` |
| POST | `/projects/:id/plots` · `/projects/:id/plots/bulk` | `inventory.create` |
| GET / PATCH / DELETE | `/projects/:id/plots/:plotId` | `inventory.read` / `.update` / `.delete` |
| POST | `/projects/:id/plots/:plotId/status` | `inventory.status`: `{status, reason}`; manual transitions only (block, unblock, sold) |
| GET | `/projects/:id/plots.xlsx` | `inventory.read` + `reports.export` |
| GET | `/projects/:id/map` | `map.read`: map config, per-status summary, plot shapes |
| PUT | `/projects/:id/map` · `/projects/:id/map/shapes` | `map.edit` |

## Sales

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST | `/customers` | `customers.read` / `.create` |
| GET / PATCH / DELETE | `/customers/:id` | `customers.*` (delete is soft and blocked if bookings exist) |
| GET | `/customers/:id/ledger` | `customers.read` + `payments.read` |
| GET / POST / PUT | `/payment-plans[/:id]?projectId` | `paymentPlans.*` |
| POST | `/bookings/quote` | `bookings.read`: pricing and schedule preview, nothing is held |
| GET | `/bookings?projectId&status&customerId&q` · `/bookings/export.xlsx` | `bookings.read` |
| POST 🔑 | `/bookings` | `bookings.create` (+ `bookings.discount` when discounting) |
| GET | `/bookings/:id` · `/bookings/:id/allotment.pdf` | `bookings.read` |
| POST | `/bookings/:id/confirm` | `bookings.confirm` |
| POST | `/bookings/:id/cancel` | `bookings.cancel`: `{reason, cancellationChargePaise}` |
| POST 🔑 | `/bookings/:id/refunds` | `payments.refund` |
| GET | `/payments?projectId&bookingId&customerId&kind&from&to&q` · `/payments/export.xlsx` | `payments.read` |
| POST 🔑 | `/payments` | `payments.create`: `{bookingId, amountPaise, mode, receivedOn, reference?, depositAccountId?}` |
| GET | `/payments/:id` · `/payments/:id/receipt.pdf` | `payments.read` |
| POST | `/payments/:id/reverse` | `payments.reverse`: `{reason}` |

## Land acquisition

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/land?status&projectId&q&sort` · `/land/summary` | `land.read` |
| POST | `/land` | `land.create` |
| GET / PATCH / DELETE | `/land/:id` | `land.read` / `.update` / `.delete` (soft delete; blocked once payments exist; agreed cost cannot drop below the amount paid) |
| POST | `/land/:id/status` | `land.update`: `{status, date?, note?}`; negotiation → agreement → registered → converted; dropped from negotiation or agreement, only while nothing has been paid |
| POST 🔑 | `/land/:id/payments` | `land.pay`: `{amountPaise, paidOn, mode, payee?, reference?, remarks?, fromAccountId?}`. Not allowed in negotiation or when dropped; capped at the agreed cost |

## CRM

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/leads?status&source&projectId&assignedTo=me\|unassigned\|<id>&followUp=due\|upcoming&q&sort` · `/leads/summary` | `crm.read` (restricted users see leads in their projects, assigned to them, or created by them) |
| POST | `/leads` | `crm.create` |
| GET / PATCH / DELETE | `/leads/:id` | `crm.read` / `.update` / `.delete` |
| POST | `/leads/:id/status` | `crm.update`: `{status, lostReason?}` (`lostReason` required for `lost`) |
| POST | `/leads/:id/activities` | `crm.update`: `{type, summary, outcome?, nextFollowUpAt?}`; calls and visits advance the status |
| POST | `/leads/:id/assign` | `crm.assign`: `{assignedTo \| null}` |
| POST | `/leads/:id/convert` | `crm.update` + `customers.create`: creates or links a customer (matched by phone) and marks the lead won |

## Brokers

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST | `/brokers` | `brokers.read` / `.create` (list includes accrued and paid totals) |
| GET / PATCH | `/brokers/:id` | `brokers.read` / `.update` (detail includes commissions) |
| POST 🔑 | `/brokers/:id/payouts` | `brokers.payout`: `{commissionIds[], paidOn, mode, reference?, fromAccountId?}` |

Commissions are created by the booking workflow (on confirmation) and cancelled with it; there is no endpoint to create them by hand.

## Construction, vendors and expenses

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST | `/vendors` | `vendors.read` / `.create` (list includes payable balances) |
| GET / PATCH | `/vendors/:id` | `vendors.read` / `.update` (detail includes ledger, bills and payments) |
| POST 🔑 | `/vendors/:id/payments` | `vendors.pay`: `{amountPaise, paidOn, mode, reference?, remarks?, projectId?, fromAccountId?}`; capped at the payable balance |
| GET | `/work-orders?projectId&vendorId&status&q&sort` · `/work-orders/costs?projectId` | `construction.read` |
| POST | `/work-orders` | `construction.create`: with optional `milestones[{name, percentBp?, dueDate?}]` |
| GET / PATCH | `/work-orders/:id` | `construction.read` / `.update` (amount cannot drop below what is already billed) |
| POST | `/work-orders/:id/status` | `construction.update`: `{status, note?}`; draft → issued → in_progress → completed; cancelled from any open state (only once its bills are reversed) |
| POST | `/work-orders/:id/milestones/:milestoneId` | `construction.update`: `{completed, date?}` |
| GET | `/expenses?projectId&vendorId&workOrderId&from&to&q` | `expenses.read` (`x-total-amount` header carries the filtered total) |
| POST 🔑 | `/expenses` | `expenses.create`: `{settlement: paid\|payable, expenseAccountId, amountPaise, date, description, projectId?, vendorId? (required for payable), workOrderId?, billNumber?, mode?, paidFromAccountId?}`. A bill against a work order may never exceed its remaining value |
| POST | `/expenses/:id/reverse` | `expenses.reverse`: `{reason}`; refused for a payable bill the vendor has already been paid for |

## Documents and files

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/documents?entityType&entityId` | `documents.read` + access to that record |
| POST | `/documents` | `documents.upload`: `multipart/form-data` with `entityType`, `entityId`, `category`, `description?`, `file`. 413 above `MAX_UPLOAD_MB`; 422 for a disallowed type or a signature mismatch |
| GET | `/documents/:id/url?disposition=inline\|attachment` | `documents.read`: `{url, expiresAt}`. The link is short-lived; request a new one each time |
| DELETE | `/documents/:id` | `documents.delete` (soft delete; the file is retained) |
| GET | `/files/:token` | **public**, local driver only: serves the file for a valid, unexpired signed token |

`entityType` is one of `project`, `land_parcel`, `plot`, `customer`, `booking`, `payment`, `vendor`, `work_order`, `lead`, `company`.

## Accounting and reports

| Method | Path | Permission |
| --- | --- | --- |
| GET / POST / PATCH | `/accounting/accounts[/:id]` | `accounting.read` / `accounting.manageAccounts` |
| GET / POST | `/accounting/journal-entries` | `accounting.read` / `accounting.create` (manual vouchers; control accounts blocked) |
| GET | `/accounting/journal-entries/:id` | `accounting.read` |
| POST | `/accounting/journal-entries/:id/reverse` | `accounting.reverse` (manual entries only) |
| GET | `/accounting/reports/trial-balance?asOf&projectId` | `reports.read` + `accounting.read` |
| GET | `/accounting/reports/profit-loss?from&to&projectId` | 〃 |
| GET | `/accounting/reports/balance-sheet?asOf&projectId` | 〃 |
| GET | `/accounting/reports/ledger/:accountId?from&to&projectId` | 〃 |
| GET | `/dashboard?projectId` | `dashboard.read` (sections, including the leads, land and works cards, are gated by module read permissions) |
| GET | `/search?q` | results limited to modules you can read |
| GET | `/api/health` | public liveness and DB check (outside `/v1`) |
