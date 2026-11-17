# SIROMS API reference

Base path: `/api`. All bodies are JSON.

**Responses**

| Outcome | Shape |
|---|---|
| Success | `{ "ok": true, "data": … }` |
| Error | `{ "ok": false, "error": { "code", "message", "details"? } }` |

**Authentication.** Sign in with `POST /api/auth/login`. This sets the `siroms.sid` session
cookie, which the browser must send with every later request (`credentials: 'include'`).
All `/api/*` routes except `/api/auth/*` and `/api/health` require a session.

**CSRF header.** Every POST/PATCH must include `X-SIROMS-Request: 1`. Without it, the
request gets 403 `FORBIDDEN`.

**Roles:** `frontdesk`, `housekeeper`, `supervisor`, `maintenance`, `manager`.

- "Page: x" means any role whose page permissions include `x`. See `PAGE_PERMISSIONS` in
  `src/config/business.js`.
- The role is always taken from the signed-in user on the server.

**Status codes**

| Code | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | `BAD_REQUEST` (input failed validation, with `details: [{ field, message }]`), `INVALID_ID` or `BAD_JSON` |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` or `LOCKED` (5 failed passwords → 15-minute lock) |
| 403 | `FORBIDDEN` (wrong role) |
| 404 | Not found |
| 409 | Conflict: `CONFLICT` (wrong state, room conflict), `DUPLICATE`, `ALREADY_DONE`, `STALE_STATE` (record changed meanwhile) |
| 422 | `RULE_VIOLATION` (valid input that breaks a business rule, such as a wrong payment amount), or `VALIDATION` from a model constraint |
| 429 | Too many sign-in attempts |
| 500 | Generic server error. No internals are returned. |

**Money** is in whole pesos (integers ≥ 0). The server computes every total, balance and
settlement.

**Dates.** Booking dates are `YYYY-MM-DD`. Date-times are local `YYYY-MM-DDTHH:mm` in
`APP_TIMEZONE`.

`method` (payment) is one of `Cash`, `Card`, `GCash`, `Maya`, `Bank transfer`.

**Idempotency.** `clientRequestId` is an optional UUID on create requests. Sending the same
value again returns the original record instead of creating a duplicate.

## Auth — `/api/auth`

| Method | Path | Who | Body / notes |
|---|---|---|---|
| POST | `/login` | anyone (rate limited) | `{ staffId: "6767", password }` → `{ user, shift }`. Records time-in. |
| POST | `/logout` | anyone | Destroys the session and clears the cookie |
| GET | `/me` | anyone | `{ authenticated, user }` (200 even when signed out) |
| GET | `/demo-accounts` | anyone, **development only** | Staff IDs and names, never passwords. Empty in production. |

`GET /api/health` → `{ status: 'up', db: 'connected' | 'disconnected' }` (no auth).

## State, meta, attendance

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/state` | any | Role-scoped snapshot used by the UI: rooms, reservations, tasks, tickets, requests, lost items, inventory, transactions, incidents, notifications, staff. Finance and guest contact data are sent to front desk/manager only. |
| GET | `/meta` | any | Room types/rates, deposit, enums, checklists, request catalog, page permissions |
| POST | `/attendance/time-in` | any | Opens a shift (idempotent) |
| POST | `/attendance/time-out` | any | Closes the open shift |

## Rooms

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/rooms?status=&floor=&q=` | any | |
| GET | `/rooms/:number` | any | |
| POST | `/rooms` | manager | `{ number: "307", type: "Standard" \| "Family" }`. New rooms start in `cleaning`. 409 if the number exists. |
| PATCH | `/rooms/:number` | manager | `{ type }`. Rejected while a guest is in the room. |
| POST | `/rooms/:number/transfer` | frontdesk | `{ toRoom }`. Checked-in guests only. The target must be available and not reserved by an overlapping booking. The old room goes to `cleaning`. |

## Reservations & front desk

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/reservations?q=&status=&source=` | page: reservations | |
| GET | `/reservations/:ref` | page: reservations | Includes `charges`, `statusHistory`, `transactions` |
| POST | `/reservations` | frontdesk | `{ guest, contact, checkIn, checkOut, roomType, adults, kids, method, amount, clientRequestId? }`. `amount` must be between the ₱1,000 deposit and the total. |
| PATCH | `/reservations/:ref` | frontdesk | `{ guest?, contact?, adults?, kids?, markReviewed? }`. Pre-arrival bookings only. |
| GET | `/reservations/online-bookings` | page: reservations | Pending channel bookings |
| POST | `/reservations/online-bookings/:externalId/import` | frontdesk | Idempotent: importing twice returns the same reservation |
| POST | `/reservations/walk-in` | frontdesk | `{ guest, contact, adults, kids, roomType, roomNumber, nights, method, amount, clientRequestId? }`. `amount` must equal stay + deposit. |
| POST | `/reservations/:ref/check-in` | frontdesk | `{ roomNumber, adults, kids, method, amount }`. `amount` must equal the outstanding balance. The room must be available, of the booked type, and not reserved by an overlapping booking. |
| POST | `/reservations/:ref/checkout/start` | frontdesk | `{ method, amount, note? }`. Settles the room balance (exact amount), sets the booking to **Pending Room Inspection**, and creates the inspection and a housekeeping inspection task. |
| POST | `/reservations/:ref/checkout/complete` | frontdesk | `{ method, amount }`. Requires a completed inspection. `amount` must equal the damage charge still due. Records the damage charge, deposit refund/forfeit and incident payments. The room goes to `cleaning`. Returns `{ reservation, settlement }`. |

Booking status flow:

- Pre-arrival: `Confirmed`, `Pending payment` or `Needs review`
- Then: `Checked in` → `Pending Room Inspection` → `Inspection Completed` or `Pending Damage Payment` → `Checked Out`

## Housekeeping

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/housekeeping/tasks` | page: housekeeping | Housekeepers see their own tasks plus open checkout-inspection tasks |
| GET | `/housekeeping/history` | page: housekeeping | |
| POST | `/housekeeping/tasks` | supervisor | `{ roomNumber, assigneeId, type, priority, note? }`. Only one open task per room and type (409 otherwise). |
| PATCH | `/housekeeping/tasks/:id/assign` | supervisor | `{ assigneeId, type?, priority?, note? }` |
| POST | `/housekeeping/tasks/:id/start` | housekeeper (assignee) | Assigned → In Progress |
| POST | `/housekeeping/tasks/:id/submit` | housekeeper (assignee) | In Progress → Ready for Inspection |
| POST | `/housekeeping/tasks/:id/review` | supervisor | `{ decision: "approve" \| "reclean", checklist: [bool…], note? }`. Approve requires every checklist item to be true. The room returns to `available` only if it has no guest and is not under maintenance. |

## Checkout inspections & incidents

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/inspections?status=Pending\|Completed` | page: inspection | |
| GET | `/inspections/:id` | page: inspection | |
| POST | `/inspections/:id/submit` | housekeeper, supervisor | `{ checklist, findings: [{ category, item, description?, qty, cost, photos?, remarks? }], remarks? }`. Creates incident reports and computes the deposit settlement. Submitting a second time returns 409 `ALREADY_DONE`. |
| GET | `/incidents?status=&category=` | page: incidents | |
| GET | `/incidents/:key` | page: incidents | `key` = `INC-1234` or an id |
| PATCH | `/incidents/:key/status` | frontdesk, manager | `{ status: "Paid" \| "Waived", note? }`. A waiver re-evaluates *Pending Damage Payment*. |

## Maintenance

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/maintenance` | page: maintenance | Maintenance staff don't see tickets awaiting assessment |
| GET | `/maintenance/:id` | page: maintenance | |
| POST | `/maintenance` | housekeeper | `{ roomNumber, category, description, clientRequestId? }` |
| POST | `/maintenance/:id/assess` | supervisor | `{ priority, impact, technicianId, note? }`. `impact: "Room must be taken offline"` sets a vacant room to `maintenance`. |
| POST | `/maintenance/:id/updates` | maintenance | `{ status, availability, eta, parts?, notes }`. `availability` is one of `Keep room offline`, `Send to housekeeping` or `Return to available`. `Return to available` is refused while a housekeeping task is open. |

## Guest requests

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/guest-requests` | page: requests | |
| POST | `/guest-requests` | page: requests | `{ roomNumber, items: [{ name, qty, custom?, price? }], notes?, clientRequestId? }`. Catalog prices are applied on the server. Charges post to the guest folio and are only allowed while the guest is *Checked in*. |
| POST | `/guest-requests/:id/advance` | frontdesk, housekeeper, supervisor | Pending → In delivery → Delivered |

## Lost & found

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/lost-and-found` | any | |
| GET | `/lost-and-found/:id` | any | |
| POST | `/lost-and-found` | any | `{ item, category, location, condition, description, foundAt, clientRequestId? }`. `foundAt` cannot be in the future. |
| POST | `/lost-and-found/:id/claim` | frontdesk | `{ claimantName?, note? }`. Stored → Claim pending. |
| POST | `/lost-and-found/:id/release` | frontdesk | `{ ownershipVerified: true, releasedTo? }`. Without `ownershipVerified: true` the request gets 422 `RULE_VIOLATION`. |

## Inventory

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/inventory` | page: inventory | |
| GET | `/inventory/logs` | page: inventory | Latest 500 movements, with stock before/after |
| POST | `/inventory/items` | supervisor, manager | `{ name, category, stock, reorderLevel }`. 409 if the name exists. |
| POST | `/inventory/movements` | supervisor, manager | `{ itemId, movement, qty, reason, restockRequestId? }`. Stock cannot go negative. Supplying `restockRequestId` marks that request *Handled*. |
| GET | `/inventory/restock-requests` | page: inventory | |
| POST | `/inventory/restock-requests` | housekeeper | `{ itemId, note? }`. One open request per item per housekeeper. |

## Transactions, notifications, reports, staff

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/transactions?range=today\|7\|30\|all\|custom&from=&to=&method=&type=&reservation=` | frontdesk, manager | The ledger is append-only. There is no edit or delete endpoint. |
| GET | `/notifications` | any | Role-targeted, with per-user `unread` |
| POST | `/notifications/:id/read`, `/notifications/read-all` | any | |
| GET | `/reports/summary?days=7\|30` | manager | Occupancy, revenue by method/type, housekeeping, maintenance, requests, inspections, deposits. The UI's CSV export is built from this. |
| GET | `/users/staff` | supervisor, manager | Names and roles for assignment pickers. No credentials. |

## Example (curl)

```bash
# sign in and keep the cookie
curl -c jar.txt -H 'Content-Type: application/json' -H 'X-SIROMS-Request: 1' \
     -d '{"staffId":"6767","password":"<your SEED_PASSWORD>"}' http://localhost:3000/api/auth/login
curl -b jar.txt http://localhost:3000/api/reservations/SSR-2026-0721
```
