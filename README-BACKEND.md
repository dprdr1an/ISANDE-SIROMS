# SIROMS — MongoDB backend

## Status

| Phase (brief §30) | State |
|---|---|
| 1 · Express + Mongoose + env + error handling | **Done** |
| 2 · Models (12) | **Done** |
| 3 · CRUD + workflow APIs (49 routes) | **Done** |
| 7 · Seed script | **Done** |
| 4 · Frontend API client (`public/api.js`) | **Done** |
| 4/5 · Rewiring `app.js` render + mutation sites to the API | **Not done — see "Remaining work"** |
| 6 · Delete obsolete in-memory seed data | Blocked on the above |
| 8 · Live integration tests | Blocked — no MongoDB in the build environment |

`public/app.js` still contains and uses its original hardcoded arrays. The
backend is complete and tested offline, but **the UI is not yet reading from
it.** Do not treat this as a finished migration.

## Setup

```bash
npm install
cp .env.example .env          # then edit it
npm run seed                  # once, to load demonstration data
npm run dev                   # or: npm start
```

`.env`:

```
PORT=3000
MONGO_URI=mongodb://127.0.0.1:27017/siroms
SESSION_SECRET=<long random string>
NODE_ENV=development
```

Works with a local `mongod` or an Atlas connection string. `.env` is
git-ignored (it was not before — the old `.gitignore` did not list it).

Seed PINs: `6767` Anne Reyes (front desk) · `2211` Ana Cruz (housekeeper) ·
`3344` Liza Mendoza (supervisor) · `4455` Carlo Diaz (maintenance) ·
`5566` Marco Santos (manager).

`npm run seed` upserts. `npm run seed:fresh` drops the collections first.
Seeding never runs on boot.

## Design decisions worth knowing

**One room record.** `Room.status` is the only room status anywhere. A stay is
linked by `Room.currentReservation` → `Reservation`. The prototype stored the
stay twice (`room.stay` *and* `reservations[]`) and already needed a
room-number fallback because the two drifted; that duplication is gone.

**Findings stored once.** Damage/missing-item records live on
`Inspection.findings`. `GET /api/incidents` projects them, so the Incident
Reports page cannot disagree with the inspection that produced it.

**Multi-collection writes are wrapped.** Every workflow in
`server/services/workflows.js` runs inside a MongoDB transaction when the
deployment supports one (replica set / Atlas) and falls back to sequential
writes on a standalone `mongod`. Completing a checkout updates reservation,
room, transactions and the new cleaning task together.

**Roles enforced server-side.** The prototype only hid nav items in the
browser. `requireRole()` now guards every mutating route.

**Failures are loud.** No route falls back to sample data. If Mongo is down,
`requireDB` returns 503 and the client throws rather than reporting success.

## A gap the audit found

The brief's headline scenario — supervisor assigns a guest request to Ana Cruz
— **did not exist in the prototype.** `guestRequests` had no `assignedTo`
field, there was no assign control, and creation notified housekeepers rather
than the supervisor. So this was built as a new feature:

- `GuestRequest.assignedTo / assignedBy / assignedAt`
- `PATCH /api/guest-requests/:id/assign` (supervisor/manager only)
- `PATCH /api/guest-requests/:id/advance` (scoped to the assignee)
- Creation now notifies the **supervisor**
- A request cannot be `Assigned`/`In delivery` with nobody assigned (validator)

Full detail in `docs/DEPENDENCY-MAP.md` §6.

## Testing

```bash
npm test     # 80 offline checks
```

Covers schema validation, the preserved business rules (inspection-before-
checkout, deposit maths, assessment-before-assignment, claimant-before-release),
inventory arithmetic, all 49 routes, the role matrix, and a check that no
connection string is hardcoded.

**These are offline tests.** The build environment has no MongoDB (the binary
download is blocked), so nothing here has run against a real database. The
three cross-role scenarios in brief §24-26 have **not** been executed. Run them
yourself after `npm run seed`:

### §24 Guest request
```bash
# Front desk creates for Room 104 (seeded Pending, guest Patricia Tan)
curl -c j -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"pin":"6767"}'
curl -b j localhost:3000/api/guest-requests
# Supervisor assigns to Ana Cruz
curl -c j2 -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"pin":"3344"}'
curl -b j2 localhost:3000/api/users?role=housekeeper
curl -b j2 -X PATCH localhost:3000/api/guest-requests/<id>/assign \
  -H 'Content-Type: application/json' -d '{"housekeeperId":"<anaId>"}'
# Ana advances In delivery → Delivered
curl -c j3 -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"pin":"2211"}'
curl -b j3 'localhost:3000/api/guest-requests?mine=true'
curl -b j3 -X PATCH localhost:3000/api/guest-requests/<id>/advance   # ×2
# Front desk sees Delivered on the same document
```

### §25 Checkout → housekeeping
`POST /reservations/:id/start-checkout` → `PATCH /inspections/:id/submit`
(with a finding) → `POST /reservations/:id/complete-checkout` →
`PATCH /housekeeping/tasks/:id/advance` ×2 → `PATCH /housekeeping/tasks/:id/review`.
Check `GET /api/rooms/:id` after each step: `occupied → ready-for-inspection
→ dirty → cleaning → ready-for-inspection → available`.

### §26 Maintenance
`POST /maintenance/tickets` (as housekeeper) → `PATCH /maintenance/tickets/:id/assess`
(as supervisor) → `PATCH /maintenance/tickets/:id` with `status:"Resolved"`
(as the assigned technician).

## Remaining work

`public/app.js` must be migrated module by module. `public/api.js` provides
everything needed: `SIROMS.api.*` for calls, `SIROMS.store` mirroring the old
array names, and `SIROMS.refresh(scope)` to re-read after a mutation.

Per module:

1. Change `const rooms = [...]` to read `SIROMS.store.rooms`.
2. Replace each in-memory mutation with its API call.
3. `await SIROMS.refresh('<scope>')` then re-render.
4. Surface `ApiFailure` in the existing toast — never render success on failure.

Suggested order: guest requests (proves the headline flow) → rooms/reservations
→ checkout/inspection → housekeeping → maintenance → lost & found → inventory
→ transactions/reports. Delete each hardcoded array only once its module is
migrated, then remove the seed arrays from `app.js` entirely (Phase 6).

Two things to keep while migrating: the context-preserving navigation from the
earlier UX pass (brief §22) — those handlers now need a record `_id` rather than
a ref string — and the single-page heading hierarchy.
