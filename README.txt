SIROMS — SIESTA SPACES
Integrated Room Operations Management System (prototype v8)

HOW TO RUN
1. Keep index.html, app.js and styles.css in the same folder.
2. Open index.html in Chrome, Edge or Firefox.

LOGIN
From the landing page choose "Staff Login" and enter a 4-digit Staff ID.
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
