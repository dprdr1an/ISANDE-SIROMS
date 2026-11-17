'use strict';
/**
 * GET /api/state — one role-scoped snapshot shaped exactly like the arrays the
 * SIROMS frontend renders (rooms, reservations, tasks, …). The UI re-fetches
 * it after every successful change, so what staff see is always what MongoDB
 * holds.
 *
 * Least privilege: each collection is only included for roles that use it.
 * Maintenance never receives tickets awaiting assessment; only the front desk
 * and managers receive financial data and guest contact details.
 */
const M = require('../models');
const B = require('../config/business');
const { env } = require('../config/env');
const { isoLocal, today, clockLabel } = require('../utils/time');
const { incidentCost } = require('./shared');
const staff = require('./staffService');

const has = (role, ...roles) => roles.includes(role);

const vmIncident = i => ({
  id: i.incidentId, _id: String(i._id), room: i.roomNumber, booking: i.bookingRef, guest: i.guestName,
  date: isoLocal(i.reportedAt), reportedBy: i.reportedByName, category: i.category, item: i.item,
  description: i.description, qty: i.qty, cost: i.unitCost, total: incidentCost(i), photos: i.photos, remarks: i.remarks, status: i.status
});

function vmReservation(r, full) {
  const base = { id: String(r._id), ref: r.ref, guest: r.guest.name, room: r.roomNumber || '—', roomType: r.roomType, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, adults: r.adults, kids: r.kids };
  if (!full) return base;
  return { ...base, contact: r.guest.contact, source: r.source, externalRef: r.externalRef, total: r.total, paid: r.amountPaid, inspectionId: r.inspection ? String(r.inspection) : null };
}

function vmStay(r, insp, incidents, role) {
  const money = has(role, 'frontdesk', 'manager');
  const inspStatus = !insp ? 'none' : insp.status === 'Completed' ? 'done' : 'pending';
  return {
    guest: r.guest.name, ref: r.ref, checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, kids: r.kids,
    folio: money ? r.charges.map(c => [c.description, c.amount]) : [],
    paid: money ? r.amountPaid : 0,
    deposit: r.deposit.amount, inspStatus,
    inspectionId: insp ? String(insp._id) : null,
    incidents: has(role, 'maintenance') ? [] : incidents.map(vmIncident),
    inspBy: insp ? insp.inspectedByName : '', inspRemarks: insp ? insp.remarks : '', checkoutNote: r.checkoutNote,
    reservationStatus: r.status
  };
}

const vmTask = t => ({
  id: String(t._id), room: t.roomNumber, staff: t.assignedToName || 'Unassigned', staffUserId: t.assignedTo ? String(t.assignedTo) : null,
  priority: t.priority, type: t.type, note: t.note, status: t.status, kind: t.kind === 'inspection' ? 'inspection' : undefined, ref: t.bookingRef || undefined,
  assignedAt: isoLocal(t.assignedAt), startedAt: t.startedAt ? isoLocal(t.startedAt) : undefined, submittedAt: t.submittedAt ? isoLocal(t.submittedAt) : null, completedAt: t.completedAt ? isoLocal(t.completedAt) : undefined,
  reworked: !!t.reworked,
  inspection: t.lastInspection ? { result: t.lastInspection.result, by: t.lastInspection.byName, note: t.lastInspection.note, reworked: !!t.lastInspection.reworked } : undefined
});
const vmTicket = t => ({
  id: String(t._id), ticketNo: t.ticketNo, room: t.roomNumber, category: t.category, issue: t.issue, description: t.description,
  priority: t.priority, impact: t.impact, status: t.status, stage: t.stage, eta: t.eta ? isoLocal(t.eta) : '',
  assignedTo: t.assignedToName || '', reportedBy: t.reportedByName, reportedAt: isoLocal(t.reportedAt), resolvedAt: t.resolvedAt ? isoLocal(t.resolvedAt) : undefined,
  parts: t.parts, history: t.history.map(h => ({ when: isoLocal(h.at), who: h.byName, what: h.what }))
});
const vmRequest = q => ({ id: String(q._id), requestNo: q.requestNo, room: q.roomNumber, guest: q.guestName, items: q.items.map(i => ({ name: i.name, qty: i.qty, price: i.unitPrice })), notes: q.notes, status: q.status, createdAt: isoLocal(q.createdAt), by: q.createdByName });
const vmLost = x => ({
  id: String(x._id), itemNo: x.itemNo, item: x.item, category: x.category, location: x.location, condition: x.condition, status: x.status,
  reporter: x.reportedByName, when: isoLocal(x.foundAt), description: x.description, storageLocation: x.storageLocation,
  claimant: x.claim?.claimantName || '', releasedTo: x.release?.releasedTo || '', releasedBy: x.release?.byName || '', releasedAt: x.release?.at ? isoLocal(x.release.at) : ''
});
const vmTxn = t => ({ id: String(t._id), txnNo: t.txnNo, when: isoLocal(t.at), ref: t.bookingRef, guest: t.guestName, room: t.roomNumber, type: t.type, method: t.method, amount: t.amount, staff: t.processedByName, depositApplied: t.depositApplied || 0 });

async function buildState(user) {
  const role = user.role;
  const fullRes = has(role, 'frontdesk', 'manager');
  const want = {
    reservations: has(role, 'frontdesk', 'manager', 'housekeeper', 'supervisor'),
    transactions: has(role, 'frontdesk', 'manager'),
    incidents: has(role, 'frontdesk', 'housekeeper', 'supervisor', 'manager'),
    requests: has(role, 'frontdesk', 'housekeeper', 'supervisor', 'manager'),
    inventory: has(role, 'housekeeper', 'supervisor', 'manager'),
    online: has(role, 'frontdesk', 'manager')
  };
  const none = Promise.resolve([]);
  const [rooms, reservations, inspections, incidents, tasks, tickets, requests, lost, items, logs, restock, txns, online, notifications, staffUsers, shift, board] = await Promise.all([
    M.Room.find().sort({ number: 1 }),
    M.Reservation.find(want.reservations ? (fullRes ? {} : { $or: [{ status: { $nin: ['Confirmed', 'Pending payment', 'Needs review', 'Cancelled'] } }] }) : { _id: null }).sort({ checkIn: -1, createdAt: -1 }).limit(1000),
    M.Inspection.find({}).limit(2000),
    M.Incident.find().sort({ reportedAt: -1 }).limit(1000),
    M.HousekeepingTask.find().sort({ assignedAt: -1 }).limit(1000),
    M.MaintenanceTicket.find(role === 'maintenance' ? { stage: { $ne: 'assessment' } } : {}).sort({ reportedAt: -1 }).limit(1000),
    want.requests ? M.GuestRequest.find().sort({ createdAt: -1 }).limit(500) : none,
    M.LostItem.find().sort({ foundAt: -1 }).limit(500),
    want.inventory ? M.InventoryItem.find().sort({ category: 1, name: 1 }) : none,
    want.inventory ? M.InventoryLog.find().sort({ at: -1 }).limit(100) : none,
    want.inventory ? M.RestockRequest.find().sort({ requestedAt: -1 }).limit(200) : none,
    want.transactions ? M.Transaction.find().sort({ at: -1 }).limit(2000) : none,
    want.online ? M.OnlineBooking.find({ status: 'Pending' }).sort({ checkIn: 1 }) : none,
    staff.listNotifications(user),
    M.User.find({ active: true, role: { $in: ['housekeeper', 'maintenance'] } }).sort({ name: 1 }),
    staff.openShift(user),
    role === 'manager' ? staff.attendanceBoard() : Promise.resolve([])
  ]);

  const resById = new Map(reservations.map(r => [String(r._id), r]));
  // In-house stays are needed for room tiles even when the role has no reservation access.
  const missing = rooms.filter(r => r.currentReservation && !resById.has(String(r.currentReservation))).map(r => r.currentReservation);
  if (missing.length) (await M.Reservation.find({ _id: { $in: missing } })).forEach(r => resById.set(String(r._id), r));
  const inspByRes = new Map(inspections.map(i => [String(i.reservation), i]));
  const incById = new Map(incidents.map(i => [String(i._id), i]));

  const roomVMs = rooms.map(rm => {
    const vm = { n: rm.number, type: rm.type, status: rm.status, floor: rm.floor, beds: rm.beds, rate: rm.rate };
    const r = rm.currentReservation && resById.get(String(rm.currentReservation));
    if (r) {
      const insp = inspByRes.get(String(r._id)) || null;
      const inc = insp ? insp.incidents.map(id => incById.get(String(id))).filter(Boolean) : [];
      vm.stay = vmStay(r, insp, inc, role);
    }
    return vm;
  });

  const attendance = role === 'manager'
    ? board.map(({ user: u, shift: sh }) => ({ name: u.name, role: B.ROLE_LABELS[u.role], in: sh ? clockLabel(sh.timeIn) : '—', out: sh && sh.timeOut ? clockLabel(sh.timeOut) : '—', status: sh && !sh.timeOut ? 'On shift' : 'Off shift' }))
    : [];

  return {
    me: { id: String(user._id), staffId: user.staffId, name: user.name, role, label: B.ROLE_LABELS[role], initials: user.initials },
    shift: { isTimedIn: !!shift, in: shift ? clockLabel(shift.timeIn) : '—' },
    meta: {
      today: today(), timezone: env.APP_TIMEZONE, deposit: B.DEPOSIT, currency: B.CURRENCY, roomTypes: B.ROOM_TYPES,
      permissions: B.PAGE_PERMISSIONS, inspectChecks: B.INSPECT_CHECKS, checkoutChecks: B.CHECKOUT_INSPECT_CHECKS, requestCatalog: B.REQUEST_CATALOG,
      housekeepers: staffUsers.filter(u => u.role === 'housekeeper').map(u => ({ id: String(u._id), name: u.name })),
      technicians: staffUsers.filter(u => u.role === 'maintenance').map(u => ({ id: String(u._id), name: u.name }))
    },
    rooms: roomVMs,
    reservations: want.reservations ? reservations.filter(r => fullRes || r.status === 'Checked Out').map(r => vmReservation(r, fullRes)) : [],
    incidents: want.incidents ? incidents.map(vmIncident) : [],
    onlineBookings: online.map(b => ({ id: b.externalId, guest: b.guest, contact: b.contact, source: b.source, checkIn: b.checkIn, checkOut: b.checkOut, roomType: b.roomType, adults: b.adults, kids: b.kids, total: b.total, prepaid: b.prepaid })),
    tasks: tasks.map(vmTask),
    tickets: tickets.map(vmTicket),
    guestRequests: requests.map(vmRequest),
    lostItems: lost.map(vmLost),
    inventory: items.map(i => ({ id: String(i._id), item: i.name, category: i.category, stock: i.stock, reorder: i.reorderLevel, lastUpdated: isoLocal(i.lastUpdatedAt), lastBy: i.lastUpdatedByName })),
    inventoryLog: logs.map(l => ({ id: String(l._id), when: isoLocal(l.at), item: l.itemName, movement: l.movement, qty: l.qty, before: l.stockBefore, after: l.stockAfter, by: l.byName, reason: l.reason })),
    restockRequests: restock.map(r => ({ id: String(r._id), itemId: String(r.item), item: r.itemName, by: r.byName, when: isoLocal(r.requestedAt), note: r.note, status: r.status })),
    transactions: txns.map(vmTxn),
    notifications: notifications.map(n => ({ id: String(n._id), title: n.title, text: n.text, roles: n.roles, unread: !n.readBy.some(id => String(id) === String(user._id)), when: isoLocal(n.createdAt) })),
    attendance
  };
}

module.exports = { buildState, vmIncident, vmReservation, vmTask, vmTicket, vmRequest, vmLost, vmTxn };
