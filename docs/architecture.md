# Architecture

## Overview

```
Browser (React SPA) ──/api/v1──▶ Express API ──▶ MongoDB replica set
   │  access token in memory           │  routes → controllers (thin) → services → models
   │  refresh token: HttpOnly cookie   │  middleware: requestId, helmet, CORS, rate limit,
   │  TanStack Query cache             │  authenticate, tenant, authorize, validate, idempotency
                                       ├─ jobs: reservation expiry, installment + follow-up reminders (node-cron)
                                       └─ storage driver: local disk (signed links) | S3 (presigned)
```

- **packages/shared** is imported by both apps and holds the Zod request schemas, the permission catalog, the status state machines, the money and date helpers and the payment-schedule generator. The server validates every request with the same schemas the forms use. The client only uses them to improve the user experience.
- **Routes are thin.** Business rules live in services. Each service receives an explicit `TenantContext` and never reads `companyId` from the request.

## Tenancy and authorization

1. `authenticate` verifies the JWT (HS256, issuer and audience, 15 min). It then loads the **session** the token points to, so revoking a session or logging out invalidates its access tokens immediately.
2. `tenant` reads the active company from the **server-side session**, never from the client. It loads the active `Membership` and `Role` and builds `req.ctx`:
   `{ userId, companyId, roleId, permissions:Set, projectScope: ObjectId[] | null, meta }`.
3. `authorize('bookings.create', …)` checks permissions per route.
4. Services scope every query with `companyId` and, for project data, with the user's `projectScope` (see `scopedFilter`). A request for a project outside the scope returns **404**, so users cannot probe IDs.
5. **Defence in depth:** the `tenantGuard` Mongoose plugin throws if any query or aggregate on a tenant collection lacks a `companyId` filter. Legitimate cross-tenant jobs must opt in with `{ crossTenant: true }`.
6. Cross-entity references are validated inside the same company. For example, a booking's customer, plots, plan and broker must all belong to the caller's company and project.

## Data model

Every tenant-owned collection has `companyId`. Project data also has `projectId`. All collections have timestamps.

| Collection | Key fields | Important indexes |
| --- | --- | --- |
| companies | name, slug, settings (overpayment policy, hold hours, number prefixes) | slug unique |
| users | email, passwordHash (argon2id, `select:false`), emailVerifiedAt, lockout fields | email unique |
| memberships | companyId, userId, roleId, status, projectAccess {mode, projectIds} | (companyId,userId) unique |
| roles | name, systemKey, permissions[] | (companyId,name) unique, case-insensitive |
| permissions | global catalog (key, group, action) | key unique |
| sessions | userId, tokenHash, previousTokenHash, activeCompanyId, expiresAt | tokenHash unique, TTL |
| authtokens, invitations | hashed single-use tokens | tokenHash unique, TTL |
| projects | code, status, address, RERA, map {width,height,bg} | (companyId,code) unique |
| projectphases, blocks | projectId, code | (companyId,projectId,code) unique |
| plots | projectId, blockId, plotNumber, areaX100, ratePaisePerSqft, plcBp, listPricePaise, status, currentBookingId, mapShape | (companyId,projectId,blockId,plotNumber) unique; (companyId,projectId,status) |
| plotstatushistories | plotId, from, to, reason, bookingId, actorId | append-only |
| customers | customerCode, name, phone, PAN, Aadhaar **last 4 only**, coApplicants[] | (companyId,customerCode) unique |
| brokers | phone, commissionBp | (companyId,phone) unique |
| brokercommissions | brokerId, bookingId, projectId, basePaise, rateBp, amountPaise, status (accrued/paid/cancelled), accrual/cancel journal entry IDs, payout {number, paidOn, mode, journalEntryId} | (companyId,bookingId) unique; (companyId,brokerId,status) |
| paymentplans | rules[] (validated by Zod) | (companyId,name) unique |
| bookings | bookingNumber, status, amounts, running totals, planSnapshot, salesJournalEntryId | (companyId,bookingNumber) unique |
| bookingitems | bookingId, plotId, price snapshot, `active` | **partial unique (plotId) where active=true** |
| installments | bookingId, sequence, dueDate, amountPaise, paidPaise, status | (companyId,bookingId,sequence) unique; (companyId,status,dueDate) |
| payments | kind (receipt/refund), number, amount, allocated/advance split, status, journalEntryId, reversal | (companyId,number) unique |
| paymentallocations | paymentId, installmentId, amount, reversedAt | |
| accounts | code, type, systemKey | (companyId,code) unique; (companyId,systemKey) unique |
| journalentries | entryNumber, voucherType, date, lines[{accountId, debit, credit, customerId, bookingId, vendorId, brokerId}], source, reversalOf/reversedBy | (companyId,entryNumber) unique; lines.accountId; lines.customerId; lines.vendorId; lines.brokerId (sparse) |
| notifications | userId, type, link, readAt, dedupeKey | (userId,dedupeKey) unique; TTL 180 days |
| auditlogs | actorId, action, entity, changes, ip, requestId | immutable (update/delete hooks throw) |
| counters | (companyId,key) → seq | unique |
| idempotencykeys | (companyId,userId,key), request hash, stored response | unique, TTL 24h |
| landparcels | khasraNumber, khataNumber, village/tehsil/district/state, areaX100 + unit, owners[], agreedCostPaise, paidPaise, status, statusHistory[], projectId? | (companyId,district,village,khasraNumber) partial unique among non-deleted parcels |
| landpayments | landParcelId, amountPaise, date, mode, payee, number (`LPV/…`), journalEntryId | (companyId,number) unique |
| leads | name, phone, source, status, projectId?, assignedTo, nextFollowUpAt, lastReminderOn, lostReason, customerId, convertedAt | (companyId,status,nextFollowUpAt); (companyId,assignedTo,status); (companyId,phone) |
| leadactivities | leadId, type, summary, actorId | (companyId,leadId,createdAt) |
| vendors | name, category, GSTIN, PAN, contact | (companyId,name) unique, case-insensitive |
| workorders | number (`WO/…`), projectId, vendorId, amountPaise, billedPaise, status, milestones[{name, percentBp, dueDate, completedAt}] | (companyId,number) unique; (companyId,projectId,status) |
| expenses | number (`EXP/…`), settlement (paid/payable), projectId, accountId, vendorId?, workOrderId?, amountPaise, status, journalEntryId, reversal | (companyId,number) unique; (companyId,projectId,date) |
| vendorpayments | number (`VPV/…`), vendorId, amountPaise, date, mode, journalEntryId | (companyId,number) unique |
| documents | entityType, entityId, category, fileName, mimeType, sizeBytes, storageKey (`select:false`), checksumSha256, uploadedBy, deletedAt | (companyId,entityType,entityId,createdAt) |

## Money, areas and dates

- Money is stored as **integer paise** in a JavaScript `number`. Safe integers go up to about ₹90 trillion. Percentages are **basis points** and areas are **hundredths of a sq ft**.
- Arithmetic goes through `@erp/shared/money`. Multiplications use `BigInt` with half-away-from-zero rounding. `allocateProportionally` uses the largest-remainder method, so installment amounts always add up to the booking total exactly.
- User-entered rupees are parsed from strings (`rupeesToPaise('1,25,000.50')`) and never through `parseFloat`.
- **Calendar dates** (due dates, booking and voucher dates) are stored as 00:00 UTC of the calendar day and exchanged as `YYYY-MM-DD`. "Today" means today in Asia/Kolkata. Timestamps are stored in UTC and displayed in IST. Financial years run April to March (`2026-27`).

## Booking lifecycle

```
             create(mode=reserve)              confirm
 available ───────────────────────▶ reserved ──────────▶ booked ──(fully paid, manual)──▶ sold
     ▲                                  │  expire (job)     │
     └──────────── cancel / expire ─────┴───────────────────┘
 available ⇄ blocked (manual)
```

Booking creation is **one transaction** that:

1. re-reads project, customer, plan and plots, and re-checks availability;
2. claims each plot with a conditional update `{ _id, status:'available' } → reserved|booked`;
3. allocates a gap-free booking number from `counters` (`BKG/2026-27/00001`);
4. posts the sales journal entry, then inserts the booking, the booking items (the partial unique index blocks a second active item for the same plot), the installments, the plot status history and the audit log.

Three independent guards stop double-booking: the in-transaction check, the conditional claim and the unique index. The test suite fires six concurrent bookings at one plot and expects exactly one `201` and five `409`s.

Cancellation and expiry release the plots, cancel the installments, reverse the sales entry and move the money received into **Refunds Payable**, less any cancellation charge, which is booked as income. Refunds are then paid against that balance.

## Payments

`POST /payments` takes an `Idempotency-Key` and runs in one transaction:

- open installments are loaded oldest-due first and filled FIFO. Each update is guarded by the previous `paidPaise`, so a concurrent receipt cannot double-allocate;
- any excess becomes a customer **advance**, or the receipt is rejected (422), depending on company policy;
- a receipt number is allocated (`RCPT/2026-27/000001`);
- a receipt voucher is posted: Dr Cash/Bank, Cr Customer Receivables for the allocated part, Cr Customer Advances for the excess;
- the booking's running totals are updated, conditional on its status.

Reversing a receipt (for example a bounced cheque) restores the installments, marks the allocations reversed, posts a reversal voucher and adjusts the totals. A payment is never accepted just because the client says so. All amounts are computed on the server.

## Accounting

Each company starts with a system chart of accounts. Services look accounts up by `systemKey`, so users can rename them.

| Event | Entry |
| --- | --- |
| Booking | Dr Customer Receivables (net) · Cr Plot Sales (gross − discount) · Cr Other Income (charges) |
| Receipt | Dr Cash/Bank · Cr Customer Receivables (allocated) · Cr Customer Advances (excess) |
| Cancellation | Reverse the sales entry, then Dr Receivables (allocated) + Dr Advances · Cr Refunds Payable · Cr Cancellation Charges |
| Refund | Dr Refunds Payable · Cr Cash/Bank |
| Broker commission (on confirmation) | Dr Brokerage · Cr Broker Payables (tagged `brokerId`); reversed if the booking is cancelled before payout |
| Broker payout | Dr Broker Payables · Cr Cash/Bank |
| Land payment | Dr Land & Development (WIP) · Cr Cash/Bank |
| Vendor bill (payable) | Dr expense / WIP account · Cr Vendor Payables (tagged `vendorId`) |
| Expense (paid now) | Dr expense / WIP account · Cr Cash/Bank |
| Vendor payment | Dr Vendor Payables · Cr Cash/Bank |
| Bill / expense reversal | Mirror entry linked through `reversalOf` |
| Manual voucher | Any balanced lines, **except control accounts** (customer receivables, customer advances, refunds payable, vendor payables, broker payables) |

- `postJournal` validates the balance (debit = credit > 0, one side per line), confirms the accounts belong to the company and are active, and numbers the voucher per financial year.
- Posted entries are **immutable**. Mongoose hooks reject updates and deletes, except the one-time `reversedBy` link. A correction is a reversal entry. A reversal cannot be reversed. System entries can only be corrected through their source workflow.
- Customer receivable, advance and refund lines carry `customerId` and `bookingId`, so the **customer ledger is derived straight from the books** and cannot drift. Vendor and broker payable lines carry `vendorId` / `brokerId` in the same way, so payable balances (`partyBalance`) come from the journal, and payment caps are checked against them inside the transaction.
- System accounts added in later releases (e.g. Broker Payables) are created on first use for companies registered earlier.
- Operational vouchers are numbered per financial year with their own series: `LPV` (land payments), `EXP` (expenses and bills), `VPV` (vendor payments), `BPV` (broker payouts), `WO` (work orders).
- The trial balance, P&L, balance sheet and account ledgers are aggregation pipelines over posted entries. The tests assert that the books balance after every workflow.

## Idempotency

Sensitive POSTs (bookings, payments, refunds, land payments, expenses, vendor payments, broker payouts) require an `Idempotency-Key`. The first request claims the key through a unique index and stores its final response. A retry with the same body replays that response (`idempotent-replayed: true`). A different body gets `422`. A retry while the first request is still running gets `409`. Failed requests release the key. The web client creates one key per dialog or form session, so double-clicks and network retries are safe.

## Documents

```
upload:   browser ──multipart──▶ POST /documents ── checks access to the record, type allow-list,
                                                    size, magic bytes ──▶ storage.put(key) + metadata row
view:     browser ──▶ GET /documents/:id/url ── re-checks access, audits ──▶ { url (≤5 min) }
          local driver: /api/v1/files/<HMAC token>   ·   s3 driver: presigned GET
```

Access to a document follows access to its record: project-scoped users only see files on records in their projects, and a lead's files follow lead visibility. Keys are `companyId/entityType/entityId/<uuid>.<ext>`, so a bucket listing never reveals filenames.

## Frontend

- **Auth:** the access token is held in memory. On page load the app calls `/auth/refresh`, which uses the HttpOnly cookie plus a CSRF header. 401 responses trigger a single shared refresh and one retry. Logout does a full reload to clear in-memory state.
- **Data:** TanStack Query handles caching. List state (page, size, sort, search, filters) lives in the URL. Mutations invalidate the related queries.
- **Permissions:** `useAuth().can()` and `<Can>` hide actions the user lacks, and route guards show a permission-denied page. The API still enforces every permission.
- **Map:** plain SVG with viewBox pan and zoom, keyboard-focusable plots with ARIA labels and a status legend that doubles as a highlight filter. It refreshes every 15 s while open. The editor supports drawing rectangles and polygons and auto-advances to the next unmapped plot.
- **UI kit:** shadcn/ui-style components in `components/ui`, built on Radix primitives for accessible dialogs, menus, tabs and tooltips. The visual identity uses deep-teal and amber tokens defined in `index.css`, with light and dark themes.
