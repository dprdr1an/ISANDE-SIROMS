SIROMS — SIESTA SPACES
Integrated Room Operations Management System (prototype v12 — UI/UX redesign)

HOW TO RUN
1. Keep index.html, app.js and styles.css in the same folder.
2. Open index.html in Chrome, Edge or Firefox.

LOGIN
The welcome screen and staff login are now one screen. Enter a 4-digit
Staff ID (or pick one from "Prototype staff IDs").
The ID determines the role, so there is no department picker.

  6767  Anne Reyes     Front Desk
  2211  Ana Cruz       Housekeeper
  3344  Liza Mendoza   Housekeeping Supervisor
  4455  Carlo Diaz     Maintenance Staff
  5566  Marco Santos   Operations Manager

CORE WORKFLOWS

Checkout inspection workflow (new)
  A guest cannot be checked out immediately. The flow is:
    1. Front desk opens Check-out, settles any room balance, and presses
       "Start Room Inspection". The booking becomes "Pending Room Inspection"
       and the room is auto-assigned to housekeeping for inspection.
    2. Housekeeping opens Room Inspections, runs the checklist, and records
       any Damaged Items / Missing Items / Other Incidents (item, description,
       quantity, estimated cost, photo placeholder, remarks).
    3. The system computes the security-deposit settlement automatically:
         - no issues  -> full deposit refunded
         - damages < deposit -> deducted, remainder refunded
         - damages > deposit -> deposit consumed, extra billed to the guest
       Submitting sets the booking to "Inspection Completed", or
       "Pending Damage Payment" when the guest still owes money. Each finding
       becomes an Incident Report.
    4. Front desk reviews the findings on the Check-out screen, collects any
       additional charges, and presses "Complete Checkout". Deposit refund /
       forfeiture / damage-charge transactions are recorded, incidents are
       marked Paid, and the booking becomes "Checked Out".
    5. The room turns Dirty and enters the cleaning workflow below.

  Booking statuses: Confirmed -> Checked in -> Pending Room Inspection ->
  Inspection Completed -> (Pending Damage Payment) -> Checked Out.

  Incident Reports lists every damage / missing-item / incident with its
  status (Pending, Paid, Waived). Front desk and managers can waive a charge
  or mark it paid.

Cleaning workflow
  Assigned -> In Progress -> Ready for Inspection -> Completed
  Housekeepers move their own rooms forward. Only the supervisor can inspect
  and approve, and a room only returns to Available after approval. Approval
  requires every checklist item to be ticked; otherwise the room can be sent
  back for recleaning.

Maintenance workflow
  Housekeeper reports an issue -> Supervisor assesses priority, room impact
  and assigns a technician -> Technician updates status, ETA and parts until
  Resolved. Maintenance staff only see work orders the supervisor forwarded.

Payments
  Check-in, walk-in and check-out all block until the outstanding balance is
  settled. Every payment is written to the Transactions ledger.

PERMISSIONS
  Inventory: only Supervisor and Operations Manager can add items or change
  stock. Housekeepers have view-only access and can send a restock request.
  Lost & Found: any staff member can log an item; only the Front Desk can
  verify and release one.
  Navigation is filtered per role, and direct access to an unpermitted page
  falls back to the dashboard.

REPORTS (Operations Manager)
  Occupancy trend, revenue summary (by method and by type), room status
  distribution, housekeeping performance, maintenance statistics, inventory
  usage and guest request summary. CSV export available.
  Checkout inspection reports: Damage Incidents, Missing Items, Most
  Frequently Damaged Rooms, Most Frequently Damaged Items, and Security
  Deposit Transactions. Incident Reports has its own CSV export.

DASHBOARD WIDGETS (inspection)
  Front desk: Rooms Pending Inspection, Pending Damage Payments, Deposit
  Refunds Today. Manager: Checkout Inspections summary and Rooms with
  Reported Damages.

------------------------------------------------------------
UX REVISION PASS (v9)
------------------------------------------------------------
Context-preserving navigation
  Actions that target a specific record now open that record with it
  already selected, instead of dropping the user on a generic list:
    - "Check in" (arrivals)        -> opens that reservation, Reserved tab
    - "Check out" (departures)     -> opens that room on the Check-out tab
    - "Settle" (payments)          -> opens that reservation
    - "Settle" (damage payments)   -> opens that room on the Check-out tab
    - "Open" (rooms pending insp.) -> opens that room's inspection
    - Reservation status badges    -> route to the right desk/step
    - Maintenance Update / Assess  -> open that specific work order
  Helpers: openCheckinFor, openCheckoutFor, openReservationContext,
  openInspectionFor, openTicketContext (bindContextActions wires them).

QA fixes
  - pendingPayments() now scopes to pre-arrival bookings only (was using
    the wrong status casing and pulling in checked-in in-house guests).
  - Walk-in "no rooms" message no longer leaks a literal ${type}.
  - Guest-request status changes refresh dashboard counts.
  - Departures widget is stage-aware (Inspecting / Inspected + action label).

UI consistency
  - Login "Back" button moved into normal flow with clear separation.
  - Added an 8 / 16 / 24px spacing layer standardising padding across
    forms, cards, tables, modals, buttons and dashboards; added
    focus-visible outlines. Palette, layout and components unchanged.

------------------------------------------------------------
UI HIERARCHY & DUPLICATE-TITLE REFACTOR (v10)
------------------------------------------------------------
Problem
  The topbar shows each page's title (from PAGE_META), and most pages
  then repeated that same title again as an in-page section heading —
  e.g. "Guest Transactions" appeared in the topbar AND directly below it.
  An audit found this on 10 pages: Reservations, Rooms, Guest
  Transactions, Room Inspections, Incident Reports, Maintenance,
  Lost & Found, Inventory, Payment Transactions and Reports.

Hierarchy now used on every page
  H1  Page title ......... topbar only (one per page), with a supporting
                           subtitle underneath.
  H2  Section heading .... panel headers for genuinely distinct sections
                           (e.g. "Reserved Guest Check-in", "Booking
                           Summary", "Record Guest Request", report panels).
  H3  Subsection ......... card / list headings inside a section.

Changes
  - PAGE_META subtitles enriched so the fuller description lives in the
    topbar; no information was lost when the in-page copy was removed.
  - The duplicate title block was removed from every page's toolbar and
    replaced with a lean ".page-actions" row that keeps the buttons,
    filters and tabs but carries no redundant heading.
  - Role-specific descriptions that used to sit in-page (housekeeping,
    inspection, maintenance, inventory) now update the topbar subtitle
    via setPageSubtitle(); the orphaned elements were removed.
  - Genuine section headings were kept intact.
  - Dashboard greeting reduced to 22px so it no longer renders larger
    than the 24px page title (fixes "page title smaller than section
    title"). Heading scale locked: 24 (H1) > 22 (greeting) > 17 (H2)
    > 14 (H3).
  - New v10 CSS layer only; palette, typography, sidebar, buttons,
    cards, component styling, functionality and working layouts kept.

------------------------------------------------------------
GUEST TRANSACTIONS TAB FIX (v11)
------------------------------------------------------------
Symptom
  On Guest Transactions, the "Reserved Guest" tab appeared to work but
  "Walk-in" and "Check-out" did nothing.

Root cause (not a tab problem at all)
  wire() registers every event handler in one pass. Line ~1678 read
  $('addReservation') — a button that had been removed from index.html
  during an earlier layout change. $() returned null, so
  `null.onclick = ...` threw, and wire() aborted at that point.
  Every handler registered AFTER that line was therefore never attached,
  including the tab handler a few lines below. Reserved Guest only looked
  functional because its panel carries class="active" in the markup.
  The data-transaction values, panel IDs and CSS were all correct.

Fix
  1. Restored the missing "+ New Reservation" button on the Reservations
     page (front desk needs the action there anyway).
  2. Hardened $(): it now returns an inert stub instead of null when an
     element is missing. Handler assignments to the stub are absorbed, so
     a single absent node can never again silently kill every handler
     registered after it. A one-time console warning names the missing id.

Verified
  - All three tabs switch correctly; exactly one panel visible at a time
    and the selected tab gets the active styling.
  - Walk-in end to end: form -> room selection -> payment -> room and
    guest records update, reservation + transaction written.
  - Check-out end to end: guest loads, inspection required before final
    checkout, checkout blocked while inspection pending, damages applied
    against the deposit, room set to cleaning and a cleaning task created.
  - Swept every button/select/tab across all 5 roles: no dead controls.
  - Broad regression (nav, filters, searches, modals, workflows): 69 checks.

------------------------------------------------------------
UI/UX REDESIGN (v12)
------------------------------------------------------------
Still plain HTML + CSS + vanilla JS. No build step, no network
dependencies (icons are an inline SVG sprite) — open index.html.

Design system (styles.css)
  - Brand palette kept verbatim (--bg, --surface, --accent, --sidebar…).
    Added only accessible tints (--text-2/--text-3, status bg/fg pairs).
  - Tokens for spacing (4px scale), radii, shadows, type sizes, control
    heights, overlay widths and focus ring. One component set: buttons,
    fields, search, tabs, segmented filters, chips, KPI tiles, stat
    strips, tables (stack into cards on phones), lists, modals, drawer,
    confirm dialog, toasts, empty states, stepper, timeline, checklists.

Navigation (role-filtered, grouped)
  Overview: Dashboard · Front office: Front Desk, Reservations, Rooms
  Room operations: Housekeeping, Inspections (Checkout inspections +
  Incident reports as tabs), Maintenance · Guest services: Guest
  Requests, Lost & Found · Back office: Inventory, Payments, Reports.
  Sidebar collapses on desktop and becomes a drawer below 1024px.
  Badges show items the signed-in role can act on.

Key workflow changes
  - Dashboards rebuilt per role around queues with direct actions.
  - Front Desk: queue of guests on the left, guided workspace on the
    right. Check-out shows a 4-step stepper (room balance → inspection
    → deposit settlement → checked out). The primary button explains
    what's still owed and stays disabled until it's paid (the submit
    handlers still enforce every rule too). "Full balance" fills the
    amount in one click.
  - Reservations and rooms open a detail drawer with the next allowed
    action. Room transfer moved into the room drawer (with confirm).
  - Housekeepers get a touch-friendly room list with a "next up" card;
    supervisors get the board, workload, and an "awaiting assignment"
    queue.
  - Inspections page also lists "Inspected — awaiting checkout" and
    "Checked out" rooms with their next state.
  - Reports split into tabs; CSV exports unchanged.

Behaviour fixes made during the redesign
  - Check-in now preselects the reservation's reserved room (or the
    first available room of the booked type).
  - Typing an amount no longer resets the adults/children fields.
  - Supervisor cleaning checklist starts unticked; Approve is enabled
    only when all items are ticked (rule unchanged, default safer).
  - Dashboard "+ Assign Task" used to pass the click event as a task
    id and silently create nothing; fixed.
  - Waived incidents are no longer deducted from the deposit, and a
    booking held in Pending Damage Payment is released when a waiver
    brings the charges within the deposit.
  - Lost & Found release asks for confirmation ("Ownership verified"
    must be ticked); an optional claimant name and the releasing staff
    member are kept on the record.
  - window.confirm() for Time out replaced by an in-app dialog.

Known limitations (not changed)
  - Occupancy trend history is simulated (no stored history); the
    chart is labelled as illustrative. Today's bar is live.
  - Photos are placeholders (a counter) for inspections; Lost & Found
    has no photo field yet, though the paper lists photo upload.
  - Housekeepers have no recorded self-checklist; the checklist is
    shown as guidance and enforced at supervisor approval.
  - Reserved-guest check-in does not collect a separate security
    deposit, but the stay still assumes a ₱1,000 deposit at checkout.
  - "Mark as paid" on an incident does not record a ledger payment.
  - "Claim pending" has no action that sets it.
