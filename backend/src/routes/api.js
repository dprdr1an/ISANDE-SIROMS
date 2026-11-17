'use strict';
/**
 * Protected API. Every route: authenticated session → role check → zod
 * validation → service. Roles mirror the prototype's page permissions and
 * the action rules documented in README.md.
 */
const express = require('express');
const B = require('../config/business');
const { requireAuth, allow, allowPage } = require('../middleware/auth');
const { validate, z, objectId, pesos, ymd, localDateTime, text, clientRequestId, roomNumber, idParam } = require('../middleware/validate');
const { notFound } = require('../utils/errors');
const { startOfDay, fromLocal } = require('../utils/time');
const M = require('../models');
const reservations = require('../services/reservationService');
const housekeeping = require('../services/housekeepingService');
const inspections = require('../services/inspectionService');
const maintenance = require('../services/maintenanceService');
const guest = require('../services/guestServices');
const inventory = require('../services/inventoryService');
const roomsSvc = require('../services/roomService');
const staff = require('../services/staffService');
const reports = require('../services/reportService');
const { buildState, vmIncident, vmReservation, vmTask, vmTicket, vmRequest, vmLost, vmTxn } = require('../services/stateService');
const { wrap, send, json } = require('./helpers');

const r = express.Router();
r.use(requireAuth);

const method = z.enum(B.PAYMENT_METHODS);
const payment = { method, amount: pesos };
const refParam = z.object({ ref: z.string().regex(/^[A-Z]+-[\w-]{2,20}$/, 'Invalid booking reference.') });
const roomParam = z.object({ number: roomNumber });
const FRONT = allow('frontdesk');

/* ---------------- State & meta ---------------- */
r.get('/state', wrap(async (req, res) => send(res, await buildState(req.user))));
r.get('/meta', wrap(async (_req, res) => send(res, {
  roomTypes: B.ROOM_TYPES, deposit: B.DEPOSIT, currency: B.CURRENCY, bookingStatuses: B.BOOKING_STATUSES, taskFlow: B.TASK_FLOW,
  ticketStatuses: B.TICKET_STATUSES, inspectChecks: B.INSPECT_CHECKS, checkoutChecks: B.CHECKOUT_INSPECT_CHECKS, requestCatalog: B.REQUEST_CATALOG, permissions: B.PAGE_PERMISSIONS
})));

/* ---------------- Attendance ---------------- */
r.post('/attendance/time-in', wrap(async (req, res) => send(res, json(await staff.timeIn(req.user)))));
r.post('/attendance/time-out', wrap(async (req, res) => send(res, json(await staff.timeOut(req.user)))));

/* ---------------- Rooms ---------------- */
r.get('/rooms', validate(z.object({ status: z.enum(B.ROOM_STATUSES).optional(), floor: z.string().regex(/^\d$/).optional(), q: text(10).optional() }), 'query'),
  wrap(async (req, res) => send(res, (await roomsSvc.list(req.validQuery)).map(json))));
r.get('/rooms/:number', validate(roomParam, 'params'), wrap(async (req, res) => send(res, json(await roomsSvc.get(req.params.number)))));
r.post('/rooms', allow('manager'), validate(z.object({ number: roomNumber, type: z.enum(Object.keys(B.ROOM_TYPES)) })),
  wrap(async (req, res) => send(res, json(await roomsSvc.create(req.user, req.body)), 201)));
r.patch('/rooms/:number', allow('manager'), validate(roomParam, 'params'), validate(z.object({ type: z.enum(Object.keys(B.ROOM_TYPES)) })),
  wrap(async (req, res) => send(res, json(await roomsSvc.update(req.user, req.params.number, req.body)))));
r.post('/rooms/:number/transfer', FRONT, validate(roomParam, 'params'), validate(z.object({ toRoom: roomNumber })),
  wrap(async (req, res) => send(res, vmReservation(await reservations.transfer(req.user, req.params.number, req.body.toRoom), true))));

/* ---------------- Reservations & front desk ---------------- */
r.get('/reservations', allowPage('reservations'),
  validate(z.object({ q: text(80).optional(), status: z.enum(B.BOOKING_STATUSES).optional(), source: z.enum(B.BOOKING_SOURCES).optional() }), 'query'),
  wrap(async (req, res) => send(res, (await reservations.list(req.validQuery)).map(x => vmReservation(x, true)))));
r.get('/reservations/online-bookings', allowPage('reservations'), wrap(async (_req, res) => send(res, (await M.OnlineBooking.find({ status: 'Pending' }).sort({ checkIn: 1 })).map(json))));
r.post('/reservations/online-bookings/:externalId/import', FRONT, validate(z.object({ externalId: z.string().regex(/^[A-Z]{2,4}-\d{3,10}$/) }), 'params'),
  wrap(async (req, res) => send(res, vmReservation(await reservations.importOnline(req.user, req.params.externalId), true), 201)));
r.get('/reservations/:ref', allowPage('reservations'), validate(refParam, 'params'), wrap(async (req, res) => {
  const x = await reservations.getByRef(req.params.ref);
  const txns = await M.Transaction.find({ reservation: x._id }).sort({ at: 1 });
  send(res, { ...vmReservation(x, true), charges: x.charges, statusHistory: x.statusHistory, transactions: txns.map(vmTxn) });
}));
r.post('/reservations', FRONT, validate(z.object({
  guest: text(80, 2), contact: text(40, 7), checkIn: ymd, checkOut: ymd, roomType: z.enum(Object.keys(B.ROOM_TYPES)),
  adults: z.number().int().min(1).max(10), kids: z.number().int().min(0).max(10), ...payment, clientRequestId
})), wrap(async (req, res) => send(res, vmReservation(await reservations.createManual(req.user, req.body), true), 201)));
r.patch('/reservations/:ref', FRONT, validate(refParam, 'params'), validate(z.object({
  guest: text(80, 2).optional(), contact: text(40, 7).optional(), adults: z.number().int().min(1).max(10).optional(), kids: z.number().int().min(0).max(10).optional(), markReviewed: z.boolean().optional()
}).strict()), wrap(async (req, res) => send(res, vmReservation(await reservations.updateDetails(req.user, req.params.ref, req.body), true))));
r.post('/reservations/walk-in', FRONT, validate(z.object({
  guest: text(80, 2), contact: text(40, 7), adults: z.number().int().min(1).max(10), kids: z.number().int().min(0).max(10),
  roomType: z.enum(Object.keys(B.ROOM_TYPES)), roomNumber, nights: z.number().int().min(1).max(30), ...payment, clientRequestId
})), wrap(async (req, res) => send(res, vmReservation(await reservations.walkIn(req.user, req.body), true), 201)));
r.post('/reservations/:ref/check-in', FRONT, validate(refParam, 'params'), validate(z.object({
  roomNumber, adults: z.number().int().min(1).max(10), kids: z.number().int().min(0).max(10), ...payment
})), wrap(async (req, res) => send(res, vmReservation(await reservations.checkIn(req.user, req.params.ref, req.body), true))));
r.post('/reservations/:ref/checkout/start', FRONT, validate(refParam, 'params'), validate(z.object({ ...payment, note: text(500).optional() })),
  wrap(async (req, res) => send(res, vmReservation(await reservations.startCheckout(req.user, req.params.ref, req.body), true))));
r.post('/reservations/:ref/checkout/complete', FRONT, validate(refParam, 'params'), validate(z.object({ ...payment })),
  wrap(async (req, res) => { const out = await reservations.completeCheckout(req.user, req.params.ref, req.body); send(res, { reservation: vmReservation(out.reservation, true), settlement: out.settlement }); }));

/* ---------------- Housekeeping ---------------- */
const HK = allowPage('housekeeping');
r.get('/housekeeping/tasks', HK, wrap(async (req, res) => send(res, (await housekeeping.list(req.user)).map(vmTask))));
r.get('/housekeeping/history', HK, wrap(async (_req, res) => send(res, (await housekeeping.history()).map(t => ({ ...vmTask(t), inspections: t.inspections })))));
r.post('/housekeeping/tasks', allow('supervisor'), validate(z.object({
  roomNumber, assigneeId: objectId, type: z.enum(B.TASK_TYPES), priority: z.enum(B.TASK_PRIORITIES), note: text(500).optional()
})), wrap(async (req, res) => send(res, vmTask(await housekeeping.create(req.user, req.body)), 201)));
r.patch('/housekeeping/tasks/:id/assign', allow('supervisor'), validate(idParam, 'params'), validate(z.object({
  assigneeId: objectId, type: z.enum(B.TASK_TYPES).optional(), priority: z.enum(B.TASK_PRIORITIES).optional(), note: text(500).optional()
})), wrap(async (req, res) => send(res, vmTask(await housekeeping.reassign(req.user, req.params.id, req.body)))));
r.post('/housekeeping/tasks/:id/start', allow('housekeeper'), validate(idParam, 'params'), wrap(async (req, res) => send(res, vmTask(await housekeeping.start(req.user, req.params.id)))));
r.post('/housekeeping/tasks/:id/submit', allow('housekeeper'), validate(idParam, 'params'), wrap(async (req, res) => send(res, vmTask(await housekeeping.submit(req.user, req.params.id)))));
r.post('/housekeeping/tasks/:id/review', allow('supervisor'), validate(idParam, 'params'), validate(z.object({
  decision: z.enum(['approve', 'reclean']), checklist: z.array(z.boolean()).max(20).default([]), note: text(500).optional()
})), wrap(async (req, res) => { const out = await housekeeping.review(req.user, req.params.id, req.body); send(res, { task: vmTask(out.task), roomStatus: out.roomStatus }); }));

/* ---------------- Checkout inspections ---------------- */
const INSP = allowPage('inspection');
r.get('/inspections', INSP, validate(z.object({ status: z.enum(['Pending', 'Completed']).optional() }), 'query'),
  wrap(async (req, res) => send(res, (await inspections.list(req.validQuery.status ? { status: req.validQuery.status } : {})).map(json))));
r.get('/inspections/:id', INSP, validate(idParam, 'params'), wrap(async (req, res) => send(res, json(await inspections.get(req.params.id)))));
r.post('/inspections/:id/submit', allow('housekeeper', 'supervisor'), validate(idParam, 'params'), validate(z.object({
  checklist: z.array(z.boolean()).max(20).default([]),
  findings: z.array(z.object({
    category: z.enum(B.INCIDENT_CATEGORIES), item: text(120), description: text(1000).optional(),
    qty: z.number().int().min(1).max(999), cost: pesos.max(1000000), photos: z.number().int().min(0).max(20).optional(), remarks: text(1000).optional()
  })).max(30).default([]),
  remarks: text(1000).optional()
})), wrap(async (req, res) => {
  const out = await inspections.submit(req.user, req.params.id, req.body);
  send(res, { inspection: json(out.inspection), settlement: out.settlement, incidents: out.incidents.map(vmIncident) });
}));

/* ---------------- Incidents ---------------- */
const INC = allowPage('incidents');
r.get('/incidents', INC, validate(z.object({ status: z.enum(B.INCIDENT_STATUSES).optional(), category: z.enum(B.INCIDENT_CATEGORIES).optional() }), 'query'),
  wrap(async (req, res) => send(res, (await inspections.listIncidents(req.validQuery)).map(vmIncident))));
r.get('/incidents/:key', INC, validate(z.object({ key: z.string().regex(/^(INC-\d+|[a-f0-9]{24})$/) }), 'params'), wrap(async (req, res) => send(res, vmIncident(await inspections.getIncident(req.params.key)))));
r.patch('/incidents/:key/status', allow('frontdesk', 'manager'), validate(z.object({ key: z.string().regex(/^(INC-\d+|[a-f0-9]{24})$/) }), 'params'),
  validate(z.object({ status: z.enum(['Paid', 'Waived']), note: text(500).optional() })),
  wrap(async (req, res) => send(res, vmIncident(await inspections.setIncidentStatus(req.user, req.params.key, req.body)))));

/* ---------------- Maintenance ---------------- */
const MT = allowPage('maintenance');
r.get('/maintenance', MT, wrap(async (req, res) => send(res, (await maintenance.list(req.user)).map(vmTicket))));
r.get('/maintenance/:id', MT, validate(idParam, 'params'), wrap(async (req, res) => send(res, vmTicket(await maintenance.get(req.user, req.params.id)))));
r.post('/maintenance', allow('housekeeper'), validate(z.object({ roomNumber, category: z.enum(B.TICKET_CATEGORIES), description: text(1000, 5), clientRequestId })),
  wrap(async (req, res) => send(res, vmTicket(await maintenance.report(req.user, req.body)), 201)));
r.post('/maintenance/:id/assess', allow('supervisor'), validate(idParam, 'params'), validate(z.object({
  priority: z.enum(B.TICKET_PRIORITIES), impact: z.enum(B.TICKET_IMPACTS), technicianId: objectId, note: text(500).optional()
})), wrap(async (req, res) => send(res, vmTicket(await maintenance.assess(req.user, req.params.id, req.body)))));
r.post('/maintenance/:id/updates', allow('maintenance'), validate(idParam, 'params'), validate(z.object({
  status: z.enum([...B.TICKET_ACTIVE, 'Resolved']), availability: z.enum(B.ROOM_AVAILABILITY_ACTIONS), eta: localDateTime, parts: text(200).optional(), notes: text(1000, 3)
})), wrap(async (req, res) => send(res, vmTicket(await maintenance.update(req.user, req.params.id, req.body)))));

/* ---------------- Guest requests ---------------- */
const RQ = allowPage('requests');
r.get('/guest-requests', RQ, wrap(async (_req, res) => send(res, (await guest.listRequests()).map(vmRequest))));
r.post('/guest-requests', RQ, validate(z.object({
  roomNumber, notes: text(500).optional(), clientRequestId,
  items: z.array(z.object({ name: text(80, 1), qty: z.number().int().min(1).max(50), custom: text(80).optional(), price: pesos.max(50000).optional() })).min(1).max(20)
})), wrap(async (req, res) => send(res, vmRequest(await guest.createRequest(req.user, req.body)), 201)));
r.post('/guest-requests/:id/advance', allow('frontdesk', 'housekeeper', 'supervisor'), validate(idParam, 'params'),
  wrap(async (req, res) => send(res, vmRequest(await guest.advanceRequest(req.user, req.params.id)))));

/* ---------------- Lost & found ---------------- */
r.get('/lost-and-found', wrap(async (_req, res) => send(res, (await guest.listLost()).map(vmLost))));
r.get('/lost-and-found/:id', validate(idParam, 'params'), wrap(async (req, res) => send(res, vmLost(await guest.getLost(req.params.id)))));
r.post('/lost-and-found', validate(z.object({
  item: text(120, 2), category: z.enum(B.LOST_CATEGORIES), location: text(120, 2), condition: z.enum(B.LOST_CONDITIONS),
  description: text(1000, 3), foundAt: localDateTime, clientRequestId
})), wrap(async (req, res) => send(res, vmLost(await guest.createLost(req.user, req.body)), 201)));
r.post('/lost-and-found/:id/claim', FRONT, validate(idParam, 'params'), validate(z.object({ claimantName: text(80).optional(), note: text(500).optional() })),
  wrap(async (req, res) => send(res, vmLost(await guest.claimLost(req.user, req.params.id, req.body)))));
r.post('/lost-and-found/:id/release', FRONT, validate(idParam, 'params'), validate(z.object({ ownershipVerified: z.boolean(), releasedTo: text(80).optional() })),
  wrap(async (req, res) => send(res, vmLost(await guest.releaseLost(req.user, req.params.id, req.body)))));

/* ---------------- Inventory ---------------- */
const INV = allowPage('inventory');
const MANAGE = allow('supervisor', 'manager');
r.get('/inventory', INV, wrap(async (_req, res) => send(res, (await inventory.listItems()).map(json))));
r.get('/inventory/logs', INV, wrap(async (_req, res) => send(res, (await inventory.listLogs(500)).map(json))));
r.post('/inventory/items', MANAGE, validate(z.object({
  name: text(80, 2), category: z.enum(B.INVENTORY_CATEGORIES), stock: z.number().int().min(0).max(100000), reorderLevel: z.number().int().min(0).max(100000)
})), wrap(async (req, res) => send(res, json(await inventory.addItem(req.user, req.body)), 201)));
r.post('/inventory/movements', MANAGE, validate(z.object({
  itemId: objectId, movement: z.enum(B.INVENTORY_MOVEMENTS), qty: z.number().int().min(0).max(100000), reason: text(300, 3), restockRequestId: objectId.optional()
})), wrap(async (req, res) => { const out = await inventory.recordMovement(req.user, req.body); send(res, { item: json(out.item), log: json(out.log) }, 201); }));
r.get('/inventory/restock-requests', INV, wrap(async (_req, res) => send(res, (await inventory.listRestock()).map(json))));
r.post('/inventory/restock-requests', allow('housekeeper'), validate(z.object({ itemId: objectId, note: text(300).optional() })),
  wrap(async (req, res) => send(res, json(await inventory.requestRestock(req.user, req.body)), 201)));

/* ---------------- Transactions ---------------- */
r.get('/transactions', allow('frontdesk', 'manager'), validate(z.object({
  range: z.enum(['today', '7', '30', 'all', 'custom']).default('all'), from: localDateTime.optional(), to: localDateTime.optional(),
  method: z.enum(B.LEDGER_METHODS).optional(), type: z.enum(B.TRANSACTION_TYPES).optional(), reservation: z.string().max(30).optional()
}), 'query'), wrap(async (req, res) => {
  const q = req.validQuery, f = {};
  if (q.range === 'today') f.at = { $gte: startOfDay(0) };
  else if (q.range === '7') f.at = { $gte: startOfDay(-6) };
  else if (q.range === '30') f.at = { $gte: startOfDay(-29) };
  else if (q.range === 'custom') { f.at = {}; if (q.from) f.at.$gte = fromLocal(q.from); if (q.to) f.at.$lte = fromLocal(q.to); }
  if (q.method) f.method = q.method;
  if (q.type) f.type = q.type;
  if (q.reservation) f.bookingRef = q.reservation;
  send(res, (await M.Transaction.find(f).sort({ at: -1 }).limit(5000)).map(vmTxn));
}));

/* ---------------- Notifications ---------------- */
r.get('/notifications', wrap(async (req, res) => send(res, (await staff.listNotifications(req.user)).map(n => ({ id: String(n._id), title: n.title, text: n.text, when: n.createdAt, unread: !n.readBy.some(x => String(x) === String(req.user._id)) })))));
r.post('/notifications/read-all', wrap(async (req, res) => { await staff.markAllRead(req.user); send(res, { read: true }); }));
r.post('/notifications/:id/read', validate(idParam, 'params'), wrap(async (req, res) => { await staff.markRead(req.user, req.params.id); send(res, { read: true }); }));

/* ---------------- Reports ---------------- */
r.get('/reports/summary', allow('manager'), validate(z.object({ days: z.coerce.number().int().refine(v => [7, 30].includes(v), 'days must be 7 or 30').default(7) }), 'query'),
  wrap(async (req, res) => send(res, await reports.summary(req.validQuery.days))));

/* ---------------- Staff directory (for assignment pickers) ---------------- */
r.get('/users/staff', allow('supervisor', 'manager'), wrap(async (_req, res) => {
  const users = await M.User.find({ active: true }).sort({ role: 1, name: 1 });
  send(res, users.map(u => ({ id: String(u._id), name: u.name, role: u.role, label: B.ROLE_LABELS[u.role] })));
}));

r.use((req, _res, next) => next(notFound(`Route ${req.method} ${req.baseUrl}${req.path}`)));
module.exports = r;
