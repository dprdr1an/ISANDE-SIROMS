'use strict';
const express = require('express');
const router = express.Router();
const {
  User, Room, Reservation, GuestRequest, HousekeepingTask, Inspection,
  MaintenanceTicket, LostFoundItem, InventoryItem, RestockRequest,
  Transaction, Notification
} = require('../models');
const W = require('../services/workflows');
const { asyncHandler, ApiError, requireDB } = require('../middleware/errorHandler');
const { requireAuth, requireRole, PAGE_PERMISSIONS } = require('../middleware/auth');

router.use(requireDB);

/* ================= AUTH ================= */
router.post('/auth/login', asyncHandler(async (req, res) => {
  const { pin } = req.body;
  if (!/^\d{4}$/.test(String(pin || ''))) throw new ApiError(400, 'Enter a 4-digit PIN.');
  const user = await User.findOne({ pin: String(pin), status: 'active' }).select('+pin');
  if (!user) throw new ApiError(401, 'That PIN was not recognised.');
  req.session.user = { _id: user._id, name: user.name, role: user.role, staffId: user.staffId, title: user.title };
  res.json({ user: req.session.user, permissions: PAGE_PERMISSIONS[user.role] });
}));

router.post('/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

router.get('/auth/me', asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Not signed in.');
  res.json({ user: req.user, permissions: PAGE_PERMISSIONS[req.user.role] });
}));

router.use(requireAuth);   // everything below requires a session

/* ================= USERS / STAFF ================= */
router.get('/users', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.role) q.role = req.query.role;
  if (req.query.status) q.status = req.query.status;
  res.json(await User.find(q).sort({ name: 1 }));
}));

/* ================= ROOMS (single source of truth) ================= */
router.get('/rooms', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.floor) q.floor = Number(req.query.floor);
  res.json(await Room.find(q).populate('currentReservation').sort({ number: 1 }));
}));

router.get('/rooms/:id', asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).populate('currentReservation');
  if (!room) throw new ApiError(404, 'Room not found.');
  res.json(room);
}));

router.patch('/rooms/:id', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  const allowed = (({ status, notes }) => ({ status, notes }))(req.body);
  Object.keys(allowed).forEach((k) => allowed[k] === undefined && delete allowed[k]);
  const room = await Room.findByIdAndUpdate(req.params.id, allowed, { new: true, runValidators: true });
  if (!room) throw new ApiError(404, 'Room not found.');
  res.json(room);
}));

/* ================= RESERVATIONS ================= */
router.get('/reservations', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.imported != null) q.imported = req.query.imported !== 'false';
  res.json(await Reservation.find(q).populate('room').sort({ checkIn: 1 }));
}));

router.get('/reservations/:id', asyncHandler(async (req, res) => {
  const r = await Reservation.findById(req.params.id).populate('room');
  if (!r) throw new ApiError(404, 'Reservation not found.');
  res.json(r);
}));

router.post('/reservations', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  const ref = req.body.ref || await W.nextReservationRef();
  const reservation = await Reservation.create({ ...req.body, ref });
  if (reservation.paid > 0) {
    await W.recordTransaction({
      reservation: reservation._id, bookingRef: reservation.ref, guest: reservation.guest,
      type: 'Reservation payment', method: req.body.method || 'Cash',
      amount: reservation.paid, staff: req.user._id, staffName: req.user.name
    });
  }
  res.status(201).json(reservation);
}));

router.patch('/reservations/:id', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  const r = await Reservation.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!r) throw new ApiError(404, 'Reservation not found.');
  res.json(r);
}));

/* ---- Reservation workflow actions ---- */
router.post('/reservations/:id/check-in', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.checkIn({ reservationId: req.params.id, ...req.body, user: req.user }));
}));

router.post('/reservations/walk-in', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.status(201).json(await W.walkIn({ ...req.body, user: req.user }));
}));

router.post('/reservations/:id/start-checkout', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.startCheckout({ reservationId: req.params.id, ...req.body, user: req.user }));
}));

router.post('/reservations/:id/complete-checkout', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.completeCheckout({ reservationId: req.params.id, ...req.body, user: req.user }));
}));

/* ================= GUEST REQUESTS ================= */
router.get('/guest-requests', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  // A housekeeper sees requests assigned to them (plus unassigned, for context).
  if (req.query.mine === 'true') q.assignedTo = req.user._id;
  res.json(await GuestRequest.find(q).populate('room assignedTo').sort({ createdAt: -1 }));
}));

router.post('/guest-requests', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.status(201).json(await W.createGuestRequest({ ...req.body, user: req.user }));
}));

router.patch('/guest-requests/:id/assign', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.assignGuestRequest({ requestId: req.params.id, housekeeperId: req.body.housekeeperId, user: req.user }));
}));

router.patch('/guest-requests/:id/advance', requireRole('housekeeper', 'supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.advanceGuestRequest({ requestId: req.params.id, user: req.user }));
}));

/* ================= HOUSEKEEPING TASKS ================= */
router.get('/housekeeping/tasks', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  if (req.query.kind) q.kind = req.query.kind;
  if (req.query.mine === 'true') q.assignedTo = req.user._id;
  res.json(await HousekeepingTask.find(q).populate('room assignedTo').sort({ createdAt: -1 }));
}));

router.post('/housekeeping/tasks', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  const room = await Room.findById(req.body.room);
  if (!room) throw new ApiError(404, 'Room not found.');
  let assignedToName = 'Unassigned';
  if (req.body.assignedTo) {
    const hk = await User.findById(req.body.assignedTo);
    if (!hk || hk.role !== 'housekeeper') throw new ApiError(400, 'Assignee must be a housekeeper.');
    assignedToName = hk.name;
  }
  const task = await HousekeepingTask.create({
    ...req.body, roomNumber: room.number, assignedToName,
    supervisor: req.user._id, supervisorName: req.user.name
  });
  if (req.body.assignedTo) {
    await W.notify(['housekeeper'], 'New task assigned',
      `Room ${room.number}: ${task.type}.`, { type: 'HousekeepingTask', id: task._id, user: req.body.assignedTo });
  }
  res.status(201).json(task);
}));

router.patch('/housekeeping/tasks/:id', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  const task = await HousekeepingTask.findById(req.params.id);
  if (!task) throw new ApiError(404, 'Task not found.');
  if (req.body.assignedTo) {
    const hk = await User.findById(req.body.assignedTo);
    if (!hk || hk.role !== 'housekeeper') throw new ApiError(400, 'Assignee must be a housekeeper.');
    task.assignedTo = hk._id; task.assignedToName = hk.name;
    await W.notify(['housekeeper'], 'New task assigned',
      `Room ${task.roomNumber}: ${task.type}.`, { type: 'HousekeepingTask', id: task._id, user: hk._id });
  }
  if (req.body.priority) task.priority = req.body.priority;
  if (req.body.note != null) task.note = req.body.note;
  await task.save();
  res.json(task);
}));

router.patch('/housekeeping/tasks/:id/advance', requireRole('housekeeper', 'supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.advanceTask({ taskId: req.params.id, user: req.user }));
}));

router.patch('/housekeeping/tasks/:id/review', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.reviewTask({ taskId: req.params.id, approved: !!req.body.approved, note: req.body.note, user: req.user }));
}));

/* ================= INSPECTIONS ================= */
router.get('/inspections', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  res.json(await Inspection.find(q).populate('room reservation').sort({ createdAt: -1 }));
}));

router.get('/inspections/:id', asyncHandler(async (req, res) => {
  const i = await Inspection.findById(req.params.id).populate('room reservation');
  if (!i) throw new ApiError(404, 'Inspection not found.');
  res.json(i);
}));

router.patch('/inspections/:id/submit', requireRole('housekeeper', 'supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.submitInspection({ inspectionId: req.params.id, ...req.body, user: req.user }));
}));

/* Incident view — projected from inspection findings, stored once (audit §7.3) */
router.get('/incidents', asyncHandler(async (req, res) => {
  const inspections = await Inspection.find({ 'findings.0': { $exists: true } }).lean();
  let rows = inspections.flatMap((insp) => insp.findings.map((f) => ({
    ...f,
    totalCost: f.category === 'Missing Item' ? f.cost * f.qty : f.cost,
    inspectionId: insp._id, room: insp.roomNumber, booking: insp.bookingRef,
    guest: insp.guest, date: insp.completedAt || insp.createdAt, reportedBy: insp.inspectorName
  })));
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  if (req.query.category) rows = rows.filter((r) => r.category === req.query.category);
  res.json(rows.sort((a, b) => new Date(b.date) - new Date(a.date)));
}));

router.patch('/incidents/:code', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['Paid', 'Waived', 'Pending'].includes(status)) throw new ApiError(400, 'Invalid incident status.');
  const insp = await Inspection.findOne({ 'findings.code': req.params.code });
  if (!insp) throw new ApiError(404, 'Incident not found.');
  const f = insp.findings.find((x) => x.code === req.params.code);
  f.status = status;
  if (req.body.remarks) f.remarks = req.body.remarks;
  await insp.save();
  res.json(f);
}));

/* ================= MAINTENANCE ================= */
router.get('/maintenance/tickets', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.stage) q.stage = req.query.stage;
  if (req.query.status) q.status = req.query.status;
  if (req.query.mine === 'true') q.assignedTo = req.user._id;
  res.json(await MaintenanceTicket.find(q).populate('room assignedTo').sort({ reportedAt: -1 }));
}));

router.post('/maintenance/tickets', requireRole('housekeeper', 'supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.status(201).json(await W.reportIssue({ ...req.body, user: req.user }));
}));

router.patch('/maintenance/tickets/:id/assess', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.assessTicket({ ticketId: req.params.id, ...req.body, user: req.user }));
}));

router.patch('/maintenance/tickets/:id', requireRole('maintenance', 'supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.json(await W.updateTicket({ ticketId: req.params.id, ...req.body, user: req.user }));
}));

/* ================= LOST & FOUND ================= */
router.get('/lost-found', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = req.query.status;
  res.json(await LostFoundItem.find(q).sort({ foundAt: -1 }));
}));

router.post('/lost-found', asyncHandler(async (req, res) => {
  const code = await W.nextLostCode();
  const item = await LostFoundItem.create({
    ...req.body, code,
    reportedBy: req.user._id, reportedByName: req.user.name,
    history: [{ who: req.user.name, what: 'Item logged and stored' }]
  });
  res.status(201).json(item);
}));

// Only the front desk may verify and release — preserves the existing rule.
router.patch('/lost-found/:id', asyncHandler(async (req, res) => {
  const item = await LostFoundItem.findById(req.params.id);
  if (!item) throw new ApiError(404, 'Item not found.');
  const { status } = req.body;
  if (['Verified', 'Released'].includes(status) && !['frontdesk', 'manager'].includes(req.user.role))
    throw new ApiError(403, 'Only the front desk can verify or release an item.');
  Object.assign(item, req.body);
  if (status === 'Released') { item.releasedAt = new Date(); item.releasedByName = req.user.name; }
  item.history.push({ who: req.user.name, what: `Status set to ${status || item.status}` });
  await item.save();
  res.json(item);
}));

/* ================= INVENTORY ================= */
router.get('/inventory', asyncHandler(async (req, res) => {
  res.json(await InventoryItem.find().sort({ item: 1 }));
}));

router.post('/inventory', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  res.status(201).json(await InventoryItem.create({ ...req.body, lastByName: req.user.name }));
}));

router.patch('/inventory/:id', requireRole('supervisor', 'manager'), asyncHandler(async (req, res) => {
  const item = await InventoryItem.findById(req.params.id);
  if (!item) throw new ApiError(404, 'Inventory item not found.');
  if (req.body.change != null) {
    const change = Number(req.body.change);
    if (!Number.isFinite(change) || change === 0) throw new ApiError(400, 'Stock movement must be a non-zero number.');
    try { item.applyMovement(change, req.body.reason || '', req.user); }
    catch (e) { throw new ApiError(400, e.message); }
  }
  if (req.body.reorder != null) item.reorder = req.body.reorder;
  await item.save();
  if (item.low) {
    await W.notify(['supervisor', 'manager'], 'Low stock alert',
      `${item.item} is down to ${item.stock} (reorder at ${item.reorder}).`,
      { type: 'InventoryItem', id: item._id });
  }
  res.json(item);
}));

router.get('/restock-requests', asyncHandler(async (req, res) => {
  res.json(await RestockRequest.find(req.query.status ? { status: req.query.status } : {}).sort({ createdAt: -1 }));
}));

router.post('/restock-requests', asyncHandler(async (req, res) => {
  const item = await InventoryItem.findById(req.body.item);
  if (!item) throw new ApiError(404, 'Inventory item not found.');
  const rr = await RestockRequest.create({
    item: item._id, itemName: item.item, qty: req.body.qty || 1, note: req.body.note || '',
    requestedBy: req.user._id, requestedByName: req.user.name
  });
  await W.notify(['supervisor', 'manager'], 'Restock requested',
    `${req.user.name} requested ${rr.qty} × ${item.item}.`, { type: 'RestockRequest', id: rr._id });
  res.status(201).json(rr);
}));

/* ================= TRANSACTIONS ================= */
router.get('/transactions', asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.method) q.method = req.query.method;
  if (req.query.type) q.type = req.query.type;
  if (req.query.from || req.query.to) {
    q.when = {};
    if (req.query.from) q.when.$gte = new Date(req.query.from);
    if (req.query.to) q.when.$lte = new Date(req.query.to);
  }
  res.json(await Transaction.find(q).sort({ when: -1 }).limit(Number(req.query.limit) || 500));
}));

router.post('/transactions', requireRole('frontdesk', 'manager'), asyncHandler(async (req, res) => {
  res.status(201).json(await W.recordTransaction({ ...req.body, staff: req.user._id, staffName: req.user.name }));
}));

/* ================= NOTIFICATIONS ================= */
router.get('/notifications', asyncHandler(async (req, res) => {
  const list = await Notification.find({ $or: [{ roles: req.user.role }, { user: req.user._id }] })
    .sort({ when: -1 }).limit(50).lean();
  res.json(list.map((n) => ({ ...n, unread: !(n.readBy || []).some((id) => String(id) === String(req.user._id)) })));
}));

router.patch('/notifications/:id', asyncHandler(async (req, res) => {
  const n = await Notification.findByIdAndUpdate(req.params.id,
    { $addToSet: { readBy: req.user._id } }, { new: true });
  if (!n) throw new ApiError(404, 'Notification not found.');
  res.json(n);
}));

router.patch('/notifications', asyncHandler(async (req, res) => {
  await Notification.updateMany({ $or: [{ roles: req.user.role }, { user: req.user._id }] },
    { $addToSet: { readBy: req.user._id } });
  res.json({ ok: true });
}));

/* ================= DASHBOARD (computed from real data, brief §27) ================= */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [roomAgg, taskAgg, tickets, requests, txToday, reservations] = await Promise.all([
    Room.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    HousekeepingTask.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    MaintenanceTicket.countDocuments({ stage: { $ne: 'resolved' } }),
    GuestRequest.countDocuments({ status: { $ne: 'Delivered' } }),
    Transaction.find({ when: { $gte: startOfDay } }).lean(),
    Reservation.find({ status: { $in: ['Confirmed', 'Checked in', 'Pending Room Inspection',
      'Inspection Completed', 'Pending Damage Payment'] } }).lean()
  ]);
  const rooms = Object.fromEntries(roomAgg.map((r) => [r._id, r.n]));
  const totalRooms = Object.values(rooms).reduce((a, b) => a + b, 0);
  res.json({
    rooms, totalRooms,
    occupancy: totalRooms ? Math.round(((rooms.occupied || 0) / totalRooms) * 100) : 0,
    tasks: Object.fromEntries(taskAgg.map((t) => [t._id, t.n])),
    openTickets: tickets,
    openRequests: requests,
    revenueToday: txToday.reduce((s, t) => s + t.amount, 0),
    transactionsToday: txToday.length,
    arrivalsToday: reservations.filter((r) => r.status === 'Confirmed'
      && new Date(r.checkIn).toDateString() === new Date().toDateString()).length,
    pendingInspection: reservations.filter((r) => r.status === 'Pending Room Inspection').length,
    pendingDamagePayments: reservations.filter((r) => r.status === 'Pending Damage Payment').length
  });
}));

module.exports = router;
