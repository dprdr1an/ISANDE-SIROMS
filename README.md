# SIROMS — Siesta Spaces Integrated Room Operations Management System

Room operations for Siesta Spaces: front desk, reservations, housekeeping, checkout
inspections, maintenance, guest requests, lost & found, inventory, payments and reports.

- **Frontend:** the existing vanilla HTML/CSS/JS app (`frontend/`). It now reads and writes
  through the API. There is no framework and no build step.
- **Backend:** Node.js + Express + Mongoose (`backend/`), storing data in MongoDB (Atlas).
- Express serves the frontend from the same origin, so there is **one server and one URL**.

```
frontend/   index.html · styles.css · app.js · api.js (single API client)
backend/
  src/
    config/      env.js (settings) · db.js (one connection) · business.js (all rules & enums)
    models/      17 Mongoose models
    middleware/  auth (session, roles, CSRF header) · validate (zod) · errors
    services/    business logic — every state transition lives here
    routes/      auth.js (/api/auth) · api.js (/api)
    utils/       workflow (transactions / retry-safe), time, errors, format
    app.js · server.js
  scripts/seed.js   development sample data
  test/api.test.js  automated API tests
  API.md            endpoint reference
```

---

## 1. Requirements

- Node.js **20 or newer** (developed on Node 22)
- A MongoDB database. **MongoDB Atlas** is the intended target. A local MongoDB 6+ replica
  set also works.

## 2. Set up MongoDB Atlas (restricted access)

1. **Database Access → Add New Database User.** Create a user with password authentication.
   Give it the built-in role **readWrite** on the database `siroms` only (Specific
   Privileges → `readWrite@siroms`). Do not give it Atlas admin or `readWriteAnyDatabase`.
   - If you will run the automated tests against Atlas, also grant `readWrite@siroms_test`.
     A separate test cluster is better.
2. **Network Access → Add IP Address.** Add only the public IP of the machine that runs the
   backend, using "Add Current IP Address".
   - **Do not add `0.0.0.0/0`.** If your IP changes, update the entry rather than opening
     access to everyone.
3. **Database → Connect → Drivers.** Copy the `mongodb+srv://…` connection string.

The connection string is read only by the backend. It is never sent to the browser.

## 3. Configure

```bash
cd backend
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `backend/.env`:

| Variable | What to put |
|---|---|
| `MONGODB_URI` | Your Atlas connection string (with the restricted user's password) |
| `MONGODB_DB` | `siroms` |
| `SESSION_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SEED_PASSWORD` | **Development only.** A password (10+ characters) that the seed gives every sample staff account |

Everything else has working defaults. Each setting is explained in `.env.example`.
`backend/.env` is listed in `.gitignore`. Never commit it.

## 4. Install, seed, run

```bash
cd backend
npm install
npm run seed          # first time; refuses if the database already has users
npm start             # or: npm run dev  (restarts on file changes)
```

Open **http://localhost:3000**. The server prints whether multi-document transactions are on.
They are on for Atlas.

- `npm run seed:reset` **deletes every SIROMS collection** in `MONGODB_DB` and reseeds.
  It is development only, and it refuses to run when `NODE_ENV=production`.
- Sample dates are relative to today, so the dashboards always have arrivals and departures.

### Development accounts

All seeded accounts use the password you set in `SEED_PASSWORD`. The login screen can list
staff IDs, but never passwords, under "Development staff IDs". That list is switched off
automatically when `NODE_ENV=production`.

| Staff ID | Name | Role |
|---|---|---|
| 6767 | Anne Reyes | Front Desk |
| 2211 | Ana Cruz | Housekeeper |
| 2212 / 2213 / 2214 | Joy Ramos / Mika Ong / Carla Reyes | Housekeeper |
| 3344 | Liza Mendoza | Housekeeping Supervisor |
| 4455 | Carlo Diaz | Maintenance Staff |
| 4456 | Rey Molina | Maintenance Staff |
| 5566 | Marco Santos | Operations Manager |

These accounts are for development and demonstration only. For a real deployment, create
staff with individual strong passwords and do not run the seed.

## 5. Tests

```bash
cd backend
npm test
```

- The suite always uses the database **`siroms_test`** on the server in `MONGODB_URI`,
  whatever `MONGODB_DB` says. Your `siroms` data is never touched.
- It wipes and reseeds `siroms_test`, starts the app on a random port, and runs 24 tests.
  They cover sign-in and roles, persistence across a backend restart, reservations,
  check-in/checkout with inspection and deposit settlement, housekeeping, maintenance,
  lost & found, inventory, guest requests, transactions and reports. They also check
  duplicate and retry handling.
- `SEED_PASSWORD` (10+ characters) must be set in `backend/.env`.

The browser end-to-end checks used during development were run with Playwright. That script
is not part of the project. See the delivery notes for what was covered.

## 6. How it works

### Authentication and roles
- Staff sign in with Staff ID + password. Passwords are stored only as **bcrypt** hashes.
- Login is rate limited (`LOGIN_RATE_LIMIT` per IP per 15 minutes). An account locks for
  15 minutes after 5 failed passwords.
- Sessions are stored in MongoDB. The cookie `siroms.sid` is `HttpOnly` and `SameSite=Lax`,
  is `Secure` when `NODE_ENV=production`, and expires after `SESSION_TTL_HOURS` of
  inactivity. The session ID is regenerated at login.
- **The role always comes from the database user linked to the session.** Nothing the
  browser sends can change it.
  - Every route checks the role on the server (`allow()` / `allowPage()`).
  - `/api/state` only returns the data that role may see. For example, maintenance staff do
    not receive guest contact details, payments, or tickets that have not been assessed.
- Every non-GET request must carry the header `X-SIROMS-Request: 1`. This header, together
  with `SameSite` cookies and a same-origin CORS policy, blocks cross-site form posts.

### Data integrity
- Amounts are whole pesos. The **server** calculates every total, balance, deposit
  deduction and refund. Amounts the client sends are only accepted as "money received",
  and are checked against what is due.
- **Room status** (`available / occupied / cleaning / maintenance`) is stored on `Room`.
  **Booking status** is stored on `Reservation`, with a `statusHistory`. Each changes only
  through service functions that check the current state:
  - The update is conditional on the expected current state.
  - A concurrent or stale change returns **409 STALE_STATE** instead of overwriting.
- Multi-step workflows (check-in, checkout, inspection, approval) run inside a
  **MongoDB transaction** when the deployment supports it (Atlas does).
  - Otherwise they fall back to a retry-safe order: validate → write idempotent records →
    switch the state last.
- **Idempotency.**
  - "Create" requests carry a `clientRequestId`, and repeating one returns the original
    record.
  - Payments use deterministic keys (for example `checkin:<booking>`), so a double-click
    or retry can never charge twice.
- **Audit trail.** Every change records who made it and when:
  - booking status history
  - task and ticket history
  - inventory movement logs with stock before/after
  - the transaction ledger
  - incident status changes
- Errors are returned as `{ ok:false, error:{ code, message } }`. Stack traces and database
  details are logged on the server only.

### Frontend
- `frontend/api.js` is the only place that calls the server.
- After each successful change, the app reloads the role-scoped state from `/api/state`.
  It also refreshes every 45 seconds while idle.
- Buttons show a busy state and cannot be submitted twice.
- A failed request shows an error toast and never shows a success message.
- An expired session returns to the login screen with a message.

## 7. Production notes

This project has **not** been security-audited or load-tested for production. Before
deploying, at minimum:

- Set `NODE_ENV=production`, use a strong unique `SESSION_SECRET`, and serve over HTTPS.
  Set `TRUST_PROXY=true` behind a TLS-terminating proxy.
- Create real staff accounts with individual passwords, and do not run the seed.
- Keep the Atlas IP access list restricted, and keep the database user limited to
  `readWrite` on the SIROMS database.
- Add backups, monitoring, and a process for password resets. There is no password-reset
  feature.

## 8. Known limitations

- **Photos:** inspection and lost & found photos are counters only. Nothing is uploaded.
- **Occupancy trend:** the history chart is simulated. There is no stored daily occupancy;
  today's value is live.
- **Ledger:** "Additional charge" rows are counted as revenue, as the prototype did, even
  though they are charged to the room and collected at checkout.
- **Incidents:** "Mark as paid" on an incident does not create a ledger payment.
- **Security deposit:** reserved-guest check-in does not collect the ₱1,000 deposit
  separately, but checkout assumes it is held. This is prototype behaviour that was kept.
- **Housekeeper checklist:** there is no housekeeper self-checklist. The checklist is
  enforced when the supervisor approves.
- **Rooms:** adding or retyping rooms is available through the API (manager) only. There is
  no screen for it.
- **Staff management:** there is no screen for creating staff or resetting passwords.

See `README.txt` for the workflow descriptions and the UI change history.
