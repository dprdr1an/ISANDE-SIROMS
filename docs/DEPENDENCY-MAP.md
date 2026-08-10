# SIROMS — Dependency Map (pre-refactor audit)

Audit of `index.html` (461 lines), `app.js` (1943 lines), `styles.css` (441 lines).

## 1. Current architecture

| Layer | Reality today |
|---|---|
| Frontend | Single-page vanilla JS. 13 `<section class="page">` blocks in one HTML file, toggled by `go(page)`. No framework, no build step, no modules. |
| Backend | **None.** No Express, no server, no `package.json`. Opened as a `file://` page. |
| Database | **None.** No Mongoose, no MongoDB, no persistence of any kind. |
| State | 16 module-scope `const` arrays/objects in `app.js` = the entire source of truth. |
| Persistence | Zero. Every reload discards all work. |
| Auth | 4-digit PIN matched against a hardcoded `accounts` object; `currentUser` held in a variable. |

**Consequence:** the reported symptom ("one user creates something, another page shows old data") is not a sync bug. Within one tab the arrays *are* shared and consistent. The real problem is there is only ever **one browser, one session, one memory space** — a Front Desk action and a Supervisor action can never be two different people. Nothing survives a reload. This refactor therefore adds the missing persistence + server tier rather than repairing a broken sync mechanism.

## 2. Hardcoded state (the 16 sources of truth to migrate)

| `app.js` | Array | → Target collection |
|---|---|---|
| L43 | `accounts` (5 PIN logins) | **User** |
| L62/63 | `housekeepers[]`, `technicians[]` (name strings) | **User** (role-filtered) |
| L69 | `rooms[]` — embeds live `stay` sub-object | **Room** (+ **Reservation** for the stay) |
| L93 | `reservations[]` | **Reservation** |
| L122 | `incidents[]` | **Inspection.findings** (+ derived incident view) |
| L129 | `onlineBookings[]` (import queue) | **Reservation** (`source`, `imported:false`) |
| L140 | `tasks[]` — cleaning **and** `kind:'inspection'` tasks | **HousekeepingTask** |
| L153 | `tickets[]` | **MaintenanceTicket** |
| L168 | `guestRequests[]` | **GuestRequest** |
| L175 | `lostItems[]` | **LostFoundItem** |
| L182 | `inventory[]` | **InventoryItem** |
| L191 | `inventoryLog[]` | **InventoryItem.movements[]** |
| L198 | `restockRequests[]` | **RestockRequest** (or GuestRequest-style doc) |
| L201 | `transactions[]` | **Transaction** |
| L217 | `notifications[]` | **Notification** |
| L229 | `attendance[]` | **User.attendance** |

127 lines perform in-memory mutations (`.unshift/.push/.splice`, `.status=`, `room.stay=`). Each is a write that must become an API call.

## 3. Roles and permissions (preserve exactly)

```
frontdesk   dashboard reservations rooms checkin inspection incidents requests lostfound
housekeeper dashboard rooms housekeeping inspection requests lostfound inventory
supervisor  dashboard rooms housekeeping inspection incidents maintenance requests lostfound inventory
maintenance dashboard rooms maintenance lostfound
manager     everything + transactions + reports
```

Enforced client-side only today (`permissions` map hides nav + `.supervisor-only` / `.housekeeper-only` / `.inventory-manage` CSS classes). Must be re-enforced **server-side**.

## 4. Status vocabularies (business rules — do not alter)

- **Room:** `available` · `occupied` · `cleaning` · `maintenance` (only 4 in use today; the brief's richer list is layered on as `Reserved`, `Dirty`, `Ready for Inspection`, `Out of Service`).
- **Booking:** `Confirmed → Pending payment → Needs review → Checked in → Pending Room Inspection → Inspection Completed → Pending Damage Payment → Checked Out` (+ `Cancelled`).
- **Housekeeping task:** `Assigned → In Progress → Ready for Inspection → Completed`.
- **Maintenance stage:** `assessment → assigned → resolved`.
- **Guest request:** `Pending → In delivery → Delivered`.

## 5. Cross-module dependency graph

The 14 `notify()` calls are exactly the cross-role handoff points — each is a place where one role's write becomes another role's read.

```
FRONT DESK ──check-out──▶ Reservation:Pending Room Inspection
                         Room.stay.inspStatus = pending
                         + HousekeepingTask{kind:'inspection'}      ──▶ HOUSEKEEPER / SUPERVISOR
SUPERVISOR/HK ──submit inspection──▶ Inspection.findings → incidents[]
                         Reservation: Inspection Completed | Pending Damage Payment
                         deposit math                                ──▶ FRONT DESK
FRONT DESK ──settle + complete──▶ Reservation:Checked Out
                         Room.status = cleaning (Dirty)
                         + Transaction(refund/forfeit/damage)
                         + HousekeepingTask{Checkout cleaning}       ──▶ HOUSEKEEPER
HOUSEKEEPER ──advance──▶ Task: Assigned→In Progress→Ready for Inspection ──▶ SUPERVISOR
SUPERVISOR ──approve──▶ Task:Completed, Room.status=available        ──▶ FRONT DESK
HOUSEKEEPER ──report issue──▶ MaintenanceTicket{stage:assessment}    ──▶ SUPERVISOR
SUPERVISOR ──assess+assign──▶ Ticket{stage:assigned,assignedTo}      ──▶ MAINTENANCE
MAINTENANCE ──resolve──▶ Ticket{stage:resolved}                      ──▶ SUPERVISOR + FRONT DESK
FRONT DESK ──create request──▶ GuestRequest{Pending}                 ──▶ HOUSEKEEPER*
HOUSEKEEPER ──restock──▶ RestockRequest                              ──▶ SUPERVISOR
INVENTORY ──stock <= reorder──▶ low-stock alert                      ──▶ SUPERVISOR + MANAGER
```

## 6. Gap found during audit — guest request assignment does not exist

The brief's headline scenario requires:
> Supervisor sees the pending request → assigns it to Ana Cruz → Ana sees it in her tasks.

**This flow is not implemented today.** Evidence:

- `guestRequests` documents have **no `assignedTo` field** (L169-171): only `{id, room, guest, items, notes, status, createdAt, by}`.
- There is **no assign UI** — the only control is `[data-req-advance]` (L1435) which blindly flips `Pending → In delivery → Delivered`.
- `notify()` on request creation targets `['housekeeper']` (L1818), **not the supervisor**.
- Any housekeeper can advance any request; nothing is scoped to an individual.

So this is a **new feature**, not merely a persistence change. The refactor must add: `assignedTo` + `assignedBy` + `assignedAt` to the model, a supervisor assign action, housekeeper-scoped filtering, and re-target the creation notification to the supervisor.

## 7. Other risks flagged

1. **`.gitignore` does not list `.env`** (it only covers `*.dmb *.rsc *.int *.lk *.zip`). Requirement 29 — must be fixed before any secret exists.
2. **Room ↔ Reservation double-write.** A stay lives in *both* `room.stay` and the matching `reservations[]` row. `resFor(ref, room)` already falls back to room-number matching because refs drift. In MongoDB this must be **one** authoritative link (`Room.currentReservation` ref) to satisfy requirement 16.
3. **`incidents[]` is derived data** — findings are duplicated in `room.stay.incidents` *and* the global `incidents[]`. Should be stored once on the Inspection and projected.
4. **IDs are `nextId()` counters**, not stable keys. Must migrate to Mongo `_id` while keeping human refs (`SSR-…`, `INC-…`) as display fields.
5. **Client-only permissions** — any user could call any API once a server exists. Needs server-side role checks.

## 8. Migration order (maps to brief §30)

1. Express + Mongoose + `.env` + connection error handling
2. 11 models (+ RestockRequest)
3. CRUD + workflow APIs, server-side role checks, validation
4. Frontend `api.js`; arrays `const` → `let`, hydrated from API at boot
5. Rewire mutations to API calls; re-fetch after each
6. Delete obsolete in-memory seed data
7. `npm run seed` (explicit, never on boot)
8. Integration tests for the three scenarios in brief §24-26
