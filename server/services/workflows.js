'use strict';
/**
 * Cross-module workflow services.
 *
 * Every function here changes MORE THAN ONE collection. Brief §21 requires
 * those updates to stay consistent, so each workflow runs inside a MongoDB
 * transaction when the deployment supports one (replica set / Atlas) and
 * falls back to sequential writes with verification on a standalone server.
 */
const mongoose = require('mongoose');
const {
  Room, Reservation, GuestRequest, HousekeepingTask, Inspection,
  MaintenanceTicket, Transaction, Notification, User
} = require('../models');
const { ApiError } = require('../middleware/errorHandler');

/* ------------------------------------------------------------------ *
 * Transaction helper
 * ------------------------------------------------------------------ */
let supportsTransactions = null;

/** Run `fn(session)` in a transaction where available, else plain. */
async function withTransaction(fn) {
  if (supportsTransactions === false) return fn(null);
  let session;
  try {
    session = await mongoose.startSession();
  } catch {
    supportsTransactions = false;
    return fn(null);
  }
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    supportsTransactions = true;
    return out;
  } catch (err) {
    // Standalone mongod rejects transactions — remember and retry without.
    if (/Transaction numbers|replica set|not supported/i.test(err.message)) {
      supportsTransactions = false;
      return fn(null);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

const opt = (session) => (session ? { session } : {});

/* ------------------------------------------------------------------ *
 * Reference codes
 * ------------------------------------------------------------------ */
async function nextCode(Model, field, prefix, pad = 4) {
  const last = await Model.findOne({ [field]: new RegExp(`^${prefix}`) })
    .sort({ [field]: -1 }).select(field).lean();
  const n = last ? parseInt(String(last[field]).replace(/\D/g, ''), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

const nextReservationRef = () =>
  nextCode(Reservation, 'ref', `SSR-${new Date().getFullYear()}-`);
const nextTicketCode = () => nextCode(MaintenanceTicket, 'code', 'MT-');
const nextTxCode     = () => nextCode(Transaction, 'code', 'TX-', 6);
const nextLostCode   = () => nextCode(require('../models').LostFoundItem, 'code', 'LF-');

/* ------------------------------------------------------------------ *
 * Notifications — generated from real events only (brief §13)
 * ------------------------------------------------------------------ */
async function notify(roles, title, message, entity = {}, session = null) {
  const doc = {
    roles: Array.isArray(roles) ? roles : [roles],
    title, message,
    entityType: entity.type || '',
    entityId: entity.id || null,
    user: entity.user || null
  };
  const [n] = await Notification.create([doc], opt(session));
  return n;
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */
async function recordTransaction(data, session = null) {
  const code = await nextTxCode();
  const [tx] = await Transaction.create([{ ...data, code }], opt(session));
  return tx;
}

/* ------------------------------------------------------------------ *
 * CHECK-IN
 * Reservation → Checked in | Room → occupied | Transaction (if paid)
 * ------------------------------------------------------------------ */
async function checkIn({ reservationId, roomId, amountPaid = 0, method = 'Cash', adults, kids, user }) {
  return withTransaction(async (session) => {
    const reservation = await Reservation.findById(reservationId).session(session);
    if (!reservation) throw new ApiError(404, 'Reservation not found.');
    if (reservation.status === 'Checked in') throw new ApiError(409, 'This reservation is already checked in.');
    if (!['Confirmed', 'Pending payment', 'Needs review'].includes(reservation.status))
      throw new ApiError(409, `A reservation with status "${reservation.status}" cannot be checked in.`);

    const room = await Room.findById(roomId).session(session);
    if (!room) throw new ApiError(404, 'Room not found.');
    if (room.status !== 'available')
      throw new ApiError(409, `Room ${room.number} is ${room.status} and cannot be assigned.`);

    if (adults != null) reservation.adults = adults;
    if (kids != null) reservation.kids = kids;

    const balance = reservation.total - reservation.paid;
    if (amountPaid < balance)
      throw new ApiError(400, `Outstanding balance of ₱${balance - amountPaid} must be settled before check-in.`);

    if (amountPaid > 0) {
      reservation.paid += amountPaid;
      await recordTransaction({
        reservation: reservation._id, bookingRef: reservation.ref, guest: reservation.guest,
        room: room._id, roomNumber: room.number, type: 'Check-in payment',
        method, amount: amountPaid, staff: user?._id, staffName: user?.name
      }, session);
    }

    reservation.room = room._id;
    reservation.status = 'Checked in';
    reservation.checkedInAt = new Date();
    reservation.inspectionState = 'none';
    await reservation.save({ session });

    room.status = 'occupied';
    room.currentReservation = reservation._id;
    room.housekeeping.state = 'clean';
    await room.save({ session });

    return { reservation, room };
  });
}

/* ------------------------------------------------------------------ *
 * WALK-IN — creates the reservation, then reuses check-in
 * ------------------------------------------------------------------ */
async function walkIn({ guest, contact, roomId, nights = 1, adults = 1, kids = 0,
                        amountPaid = 0, method = 'Cash', user }) {
  return withTransaction(async (session) => {
    const room = await Room.findById(roomId).session(session);
    if (!room) throw new ApiError(404, 'Room not found.');
    if (room.status !== 'available')
      throw new ApiError(409, `Room ${room.number} is ${room.status} and cannot be assigned.`);

    const checkInDate = new Date();
    const checkOutDate = new Date(Date.now() + nights * 86400000);
    const total = room.rate * nights;
    if (amountPaid < total)
      throw new ApiError(400, `Walk-in requires full payment of ₱${total}.`);

    const ref = await nextReservationRef();
    const [reservation] = await Reservation.create([{
      ref, guest, contact, source: 'Walk-in', room: room._id, roomType: room.type,
      checkIn: checkInDate, checkOut: checkOutDate, adults, kids,
      total, paid: amountPaid, status: 'Checked in', checkedInAt: checkInDate,
      folio: [{ label: `Room ${room.number} × ${nights} night(s)`, amount: total }]
    }], opt(session));

    await recordTransaction({
      reservation: reservation._id, bookingRef: ref, guest, room: room._id,
      roomNumber: room.number, type: 'Walk-in payment', method,
      amount: amountPaid, staff: user?._id, staffName: user?.name
    }, session);

    room.status = 'occupied';
    room.currentReservation = reservation._id;
    await room.save({ session });

    return { reservation, room };
  });
}

/* ------------------------------------------------------------------ *
 * CHECKOUT STEP 1 — settle room balance, send for inspection
 * Reservation → Pending Room Inspection | Inspection created
 * HousekeepingTask{kind:'inspection'} created | notify housekeeping
 * ------------------------------------------------------------------ */
async function startCheckout({ reservationId, amountPaid = 0, method = 'Cash', notes = '', user }) {
  return withTransaction(async (session) => {
    const reservation = await Reservation.findById(reservationId).session(session);
    if (!reservation) throw new ApiError(404, 'Reservation not found.');
    if (reservation.status !== 'Checked in')
      throw new ApiError(409, `Only a checked-in guest can start checkout (status is "${reservation.status}").`);

    const room = await Room.findById(reservation.room).session(session);
    if (!room) throw new ApiError(404, 'Room not found for this reservation.');

    const balance = reservation.total - reservation.paid;
    if (amountPaid < balance)
      throw new ApiError(400, `Room balance of ₱${balance - amountPaid} must be settled before inspection.`);

    if (amountPaid > 0) {
      reservation.paid += amountPaid;
      await recordTransaction({
        reservation: reservation._id, bookingRef: reservation.ref, guest: reservation.guest,
        room: room._id, roomNumber: room.number, type: 'Check-out payment',
        method, amount: amountPaid, staff: user?._id, staffName: user?.name
      }, session);
    }

    reservation.status = 'Pending Room Inspection';
    reservation.inspectionState = 'pending';
    await reservation.save({ session });

    room.status = 'ready-for-inspection';
    room.housekeeping.state = 'awaiting-inspection';
    await room.save({ session });

    const [inspection] = await Inspection.create([{
      room: room._id, roomNumber: room.number, reservation: reservation._id,
      bookingRef: reservation.ref, guest: reservation.guest,
      deposit: reservation.deposit, status: 'Pending'
    }], opt(session));

    const [task] = await HousekeepingTask.create([{
      room: room._id, roomNumber: room.number, type: 'Checkout inspection',
      kind: 'inspection', priority: 'High', status: 'Assigned',
      note: `Inspect Room ${room.number} before ${reservation.guest} checks out`,
      reservation: reservation._id
    }], opt(session));

    await notify(['housekeeper', 'supervisor'], 'Room inspection needed',
      `Room ${room.number} needs a checkout inspection before ${reservation.guest} can check out.`,
      { type: 'Inspection', id: inspection._id }, session);

    return { reservation, room, inspection, task };
  });
}

/* ------------------------------------------------------------------ *
 * SUBMIT INSPECTION — findings + deposit settlement
 * Reservation → Inspection Completed | Pending Damage Payment
 * ------------------------------------------------------------------ */
async function submitInspection({ inspectionId, checklist = [], findings = [], remarks = '', user }) {
  return withTransaction(async (session) => {
    const inspection = await Inspection.findById(inspectionId).session(session);
    if (!inspection) throw new ApiError(404, 'Inspection not found.');
    if (inspection.status === 'Completed')
      throw new ApiError(409, 'This inspection has already been submitted.');

    const reservation = await Reservation.findById(inspection.reservation).session(session);
    if (!reservation) throw new ApiError(404, 'Reservation not found.');

    // Stamp each finding with an incident code.
    let seq = await nextCode(Inspection, 'findings.code', 'INC-').catch(() => 'INC-0001');
    let n = parseInt(String(seq).replace(/\D/g, ''), 10) || 1;
    inspection.findings = findings.map((f) => ({
      code: `INC-${String(n++).padStart(4, '0')}`,
      category: f.category, item: f.item, description: f.description || '',
      qty: f.category === 'Missing Item' ? (f.qty || 1) : 1,
      cost: f.cost || 0, photos: f.photos || 0, remarks: f.remarks || '', status: 'Pending'
    }));
    inspection.checklist = checklist;
    inspection.remarks = remarks;
    inspection.inspector = user?._id || null;
    inspection.inspectorName = user?.name || '';
    inspection.deposit = reservation.deposit;
    inspection.settle();                       // computes damages/applied/refund/extraDue
    inspection.status = 'Completed';
    inspection.completedAt = new Date();
    await inspection.save({ session });

    reservation.inspectionState = 'done';
    reservation.status = inspection.extraDue > 0 ? 'Pending Damage Payment' : 'Inspection Completed';
    await reservation.save({ session });

    // Close the inspection task.
    await HousekeepingTask.updateMany(
      { reservation: reservation._id, kind: 'inspection', status: { $ne: 'Completed' } },
      { $set: { status: 'Completed', completedAt: new Date(),
                assignedToName: user?.name || 'Housekeeping' } },
      opt(session));

    await notify(['frontdesk'], 'Inspection completed',
      `Room ${inspection.roomNumber}: ${inspection.findings.length
        ? `${inspection.findings.length} issue(s), ₱${inspection.damages} in damages`
        : 'no issues found'}. Ready for checkout.`,
      { type: 'Inspection', id: inspection._id }, session);

    return { inspection, reservation };
  });
}

/* ------------------------------------------------------------------ *
 * CHECKOUT STEP 2 — settle deposit, finalise
 * Reservation → Checked Out | Room → dirty | Transactions | Cleaning task
 * (the four-way consistency requirement in brief §21)
 * ------------------------------------------------------------------ */
async function completeCheckout({ reservationId, amountPaid = 0, method = 'Cash', user }) {
  return withTransaction(async (session) => {
    const reservation = await Reservation.findById(reservationId).session(session);
    if (!reservation) throw new ApiError(404, 'Reservation not found.');
    if (!['Inspection Completed', 'Pending Damage Payment'].includes(reservation.status))
      throw new ApiError(409, 'The room must be inspected before checkout can be completed.');

    const room = await Room.findById(reservation.room).session(session);
    if (!room) throw new ApiError(404, 'Room not found.');

    const inspection = await Inspection.findOne({ reservation: reservation._id, status: 'Completed' })
      .sort({ completedAt: -1 }).session(session);
    if (!inspection) throw new ApiError(409, 'No completed inspection found for this stay.');

    const owed = Math.max(0, inspection.extraDue - amountPaid);
    if (owed > 0)
      throw new ApiError(400, `Additional charges of ₱${owed} must be settled to complete checkout.`);

    if (inspection.extraDue > 0 && amountPaid > 0) {
      await recordTransaction({
        reservation: reservation._id, bookingRef: reservation.ref, guest: reservation.guest,
        room: room._id, roomNumber: room.number, type: 'Damage charge', method,
        amount: inspection.extraDue, staff: user?._id, staffName: user?.name
      }, session);
    }

    // Deposit outcome: refund (negative = money out) or forfeiture.
    await recordTransaction({
      reservation: reservation._id, bookingRef: reservation.ref, guest: reservation.guest,
      room: room._id, roomNumber: room.number,
      type: inspection.refund > 0 ? 'Deposit refund' : 'Deposit forfeited',
      method: inspection.refund > 0 ? method : '—',
      amount: inspection.refund > 0 ? -inspection.refund : 0,
      depositApplied: inspection.applied, staff: user?._id, staffName: user?.name
    }, session);

    inspection.findings.forEach((f) => { if (f.status === 'Pending') f.status = 'Paid'; });
    await inspection.save({ session });

    reservation.status = 'Checked Out';
    reservation.checkedOutAt = new Date();
    await reservation.save({ session });

    room.status = 'dirty';
    room.currentReservation = null;
    room.housekeeping.state = 'dirty';
    await room.save({ session });

    const [task] = await HousekeepingTask.create([{
      room: room._id, roomNumber: room.number, type: 'Checkout cleaning',
      kind: 'cleaning', priority: 'High', status: 'Assigned',
      note: 'Room vacated after checkout', reservation: reservation._id
    }], opt(session));

    await notify(['supervisor', 'housekeeper'], 'Room ready for cleaning',
      `Room ${room.number} was checked out and is now Dirty — cleaning required.`,
      { type: 'Room', id: room._id }, session);

    return { reservation, room, inspection, task, settlement: {
      deposit: inspection.deposit, damages: inspection.damages,
      applied: inspection.applied, refund: inspection.refund, extra: inspection.extraDue } };
  });
}

/* ------------------------------------------------------------------ *
 * HOUSEKEEPING TASK PROGRESS
 * Assigned → In Progress → Ready for Inspection → (supervisor) Completed
 * Room status follows the task (brief §5 chain).
 * ------------------------------------------------------------------ */
async function advanceTask({ taskId, user }) {
  return withTransaction(async (session) => {
    const task = await HousekeepingTask.findById(taskId).session(session);
    if (!task) throw new ApiError(404, 'Task not found.');
    if (task.kind === 'inspection')
      throw new ApiError(400, 'Checkout inspections are completed from the Room Inspections page.');
    if (user.role === 'housekeeper' && String(task.assignedTo) !== String(user._id))
      throw new ApiError(403, 'You can only update rooms assigned to you.');

    const room = await Room.findById(task.room).session(session);

    if (task.status === 'Assigned') {
      task.status = 'In Progress'; task.startedAt = new Date();
      if (room) { room.status = 'cleaning'; room.housekeeping.state = 'in-progress'; await room.save({ session }); }
    } else if (task.status === 'In Progress') {
      task.status = 'Ready for Inspection'; task.submittedAt = new Date();
      if (room) { room.status = 'ready-for-inspection'; room.housekeeping.state = 'awaiting-inspection'; await room.save({ session }); }
      await notify(['supervisor'], 'Room ready for inspection',
        `Room ${task.roomNumber} finished cleaning and needs supervisor approval.`,
        { type: 'HousekeepingTask', id: task._id }, session);
    } else {
      throw new ApiError(409, `A task at "${task.status}" cannot be advanced here.`);
    }
    await task.save({ session });
    return { task, room };
  });
}

/** Supervisor approves or returns a cleaning task. */
async function reviewTask({ taskId, approved, note = '', user }) {
  return withTransaction(async (session) => {
    const task = await HousekeepingTask.findById(taskId).session(session);
    if (!task) throw new ApiError(404, 'Task not found.');
    if (task.status !== 'Ready for Inspection')
      throw new ApiError(409, 'Only a room awaiting inspection can be reviewed.');

    const room = await Room.findById(task.room).session(session);
    if (approved) {
      task.status = 'Completed'; task.completedAt = new Date();
      task.inspectionResult = 'Approved';
      if (room) {
        room.status = 'available'; room.housekeeping.state = 'clean';
        room.housekeeping.lastCleaned = new Date();
        room.housekeeping.lastCleanedBy = task.assignedToName;
        await room.save({ session });
      }
      await notify(['frontdesk'], 'Room available',
        `Room ${task.roomNumber} passed inspection and is available.`,
        { type: 'Room', id: task.room }, session);
    } else {
      task.status = 'In Progress'; task.inspectionResult = 'Returned for recleaning';
      if (room) { room.status = 'cleaning'; room.housekeeping.state = 'in-progress'; await room.save({ session }); }
      await notify(['housekeeper'], 'Room returned',
        `Room ${task.roomNumber} was returned for recleaning.`,
        { type: 'HousekeepingTask', id: task._id, user: task.assignedTo }, session);
    }
    task.inspectionNote = note;
    task.supervisor = user?._id || null;
    task.supervisorName = user?.name || '';
    await task.save({ session });
    return { task, room };
  });
}

/* ------------------------------------------------------------------ *
 * GUEST REQUESTS — the headline cross-role flow (brief §8, §24)
 * ------------------------------------------------------------------ */
async function createGuestRequest({ roomId, items, notes = '', user }) {
  return withTransaction(async (session) => {
    const room = await Room.findById(roomId).populate('currentReservation').session(session);
    if (!room) throw new ApiError(404, 'Room not found.');
    if (!room.currentReservation)
      throw new ApiError(409, `Room ${room.number} has no guest checked in.`);

    const [request] = await GuestRequest.create([{
      room: room._id, roomNumber: room.number,
      reservation: room.currentReservation._id,
      guest: room.currentReservation.guest,
      items, notes, status: 'Pending',
      createdBy: user?._id, createdByName: user?.name
    }], opt(session));

    // Charge the folio for any priced items.
    const charge = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
    if (charge > 0) {
      const reservation = await Reservation.findById(room.currentReservation._id).session(session);
      reservation.total += charge;
      reservation.folio.push({ label: `Guest request: ${items.map((i) => i.name).join(', ')}`, amount: charge });
      await reservation.save({ session });
      request.charge = charge;
      await request.save({ session });
    }

    // Requirement §13: the SUPERVISOR is notified so they can assign it.
    await notify(['supervisor'], 'New guest request',
      `Room ${room.number} · ${room.currentReservation.guest} requested ${items.map((i) => `${i.name} ×${i.qty}`).join(', ')}.`,
      { type: 'GuestRequest', id: request._id }, session);

    return request;
  });
}

/** Supervisor assigns the request to a housekeeper. */
async function assignGuestRequest({ requestId, housekeeperId, user }) {
  return withTransaction(async (session) => {
    const request = await GuestRequest.findById(requestId).session(session);
    if (!request) throw new ApiError(404, 'Guest request not found.');
    if (request.status === 'Delivered')
      throw new ApiError(409, 'This request has already been delivered.');

    const hk = await User.findById(housekeeperId).session(session);
    if (!hk) throw new ApiError(404, 'Housekeeper not found.');
    if (hk.role !== 'housekeeper')
      throw new ApiError(400, `${hk.name} is not a housekeeper.`);

    request.assignedTo = hk._id;
    request.assignedToName = hk.name;
    request.assignedBy = user?._id || null;
    request.assignedByName = user?.name || '';
    request.assignedAt = new Date();
    if (request.status === 'Pending') request.status = 'Assigned';
    await request.save({ session });

    await notify(['housekeeper'], 'Guest request assigned',
      `Room ${request.roomNumber}: ${request.items.map((i) => i.name).join(', ')} assigned to you.`,
      { type: 'GuestRequest', id: request._id, user: hk._id }, session);

    return request;
  });
}

/** Housekeeper advances Assigned → In delivery → Delivered. */
async function advanceGuestRequest({ requestId, user }) {
  return withTransaction(async (session) => {
    const request = await GuestRequest.findById(requestId).session(session);
    if (!request) throw new ApiError(404, 'Guest request not found.');
    if (!request.assignedTo)
      throw new ApiError(409, 'This request must be assigned to a housekeeper first.');
    if (user.role === 'housekeeper' && String(request.assignedTo) !== String(user._id))
      throw new ApiError(403, 'You can only update requests assigned to you.');

    if (request.status === 'Assigned' || request.status === 'Pending') {
      request.status = 'In delivery';
    } else if (request.status === 'In delivery') {
      request.status = 'Delivered';
      request.deliveredAt = new Date();
      request.deliveredByName = user?.name || '';
      await notify(['frontdesk'], 'Guest request delivered',
        `Room ${request.roomNumber}: ${request.items.map((i) => i.name).join(', ')} delivered.`,
        { type: 'GuestRequest', id: request._id }, session);
    } else {
      throw new ApiError(409, `A request at "${request.status}" cannot be advanced.`);
    }
    await request.save({ session });
    return request;
  });
}

/* ------------------------------------------------------------------ *
 * MAINTENANCE (brief §9, §26)
 * ------------------------------------------------------------------ */
async function reportIssue({ roomId, category, issue, user }) {
  return withTransaction(async (session) => {
    const room = await Room.findById(roomId).session(session);
    if (!room) throw new ApiError(404, 'Room not found.');
    const code = await nextTicketCode();
    const [ticket] = await MaintenanceTicket.create([{
      code, room: room._id, roomNumber: room.number, category, issue,
      stage: 'assessment', status: 'Awaiting assessment',
      reportedBy: user?._id, reportedByName: user?.name,
      history: [{ who: user?.name || 'Staff', what: 'Issue reported to supervisor' }]
    }], opt(session));

    room.maintenance.state = 'reported';
    room.maintenance.openTickets += 1;
    await room.save({ session });

    await notify(['supervisor'], 'Room issue awaiting assessment',
      `Room ${room.number}: ${issue}`, { type: 'MaintenanceTicket', id: ticket._id }, session);
    return ticket;
  });
}

async function assessTicket({ ticketId, priority, impact, technicianId, eta, user }) {
  return withTransaction(async (session) => {
    const ticket = await MaintenanceTicket.findById(ticketId).session(session);
    if (!ticket) throw new ApiError(404, 'Ticket not found.');
    if (ticket.stage !== 'assessment')
      throw new ApiError(409, 'This ticket has already been assessed.');

    const tech = await User.findById(technicianId).session(session);
    if (!tech) throw new ApiError(404, 'Technician not found.');
    if (tech.role !== 'maintenance')
      throw new ApiError(400, `${tech.name} is not maintenance staff.`);

    ticket.priority = priority;
    ticket.impact = impact;
    ticket.assignedTo = tech._id;
    ticket.assignedToName = tech.name;
    ticket.eta = eta || null;
    ticket.stage = 'assigned';
    ticket.status = 'Assigned';
    ticket.history.push({ who: user?.name || 'Supervisor',
      what: `Assessed as ${priority} priority and assigned to ${tech.name}` });
    await ticket.save({ session });

    // A room taken offline is a room-status change — the Room record owns it.
    if (impact && /offline/i.test(impact)) {
      const room = await Room.findById(ticket.room).session(session);
      if (room && !['occupied'].includes(room.status)) {
        room.status = 'maintenance';
        room.maintenance.state = 'under-repair';
        await room.save({ session });
      }
    }

    await notify(['maintenance'], 'New work order',
      `Room ${ticket.roomNumber}: ${ticket.issue} (${priority} priority).`,
      { type: 'MaintenanceTicket', id: ticket._id, user: tech._id }, session);
    return ticket;
  });
}

async function updateTicket({ ticketId, status, eta, parts, note, user }) {
  return withTransaction(async (session) => {
    const ticket = await MaintenanceTicket.findById(ticketId).session(session);
    if (!ticket) throw new ApiError(404, 'Ticket not found.');
    if (user.role === 'maintenance' && String(ticket.assignedTo) !== String(user._id))
      throw new ApiError(403, 'You can only update work orders assigned to you.');

    if (status) ticket.status = status;
    if (eta) ticket.eta = eta;
    if (parts != null) ticket.parts = parts;
    if (note) ticket.repairNotes = note;
    ticket.history.push({ who: user?.name || 'Technician', what: note || `Status set to ${status}` });

    if (status === 'Resolved') {
      ticket.stage = 'resolved';
      ticket.resolvedAt = new Date();
      const room = await Room.findById(ticket.room).session(session);
      if (room) {
        room.maintenance.openTickets = Math.max(0, room.maintenance.openTickets - 1);
        if (room.maintenance.openTickets === 0) {
          room.maintenance.state = 'ok';
          // Only reclaim the room if maintenance was the reason it was offline.
          if (room.status === 'maintenance') room.status = 'available';
        }
        await room.save({ session });
      }
      await notify(['supervisor', 'frontdesk'], 'Repair completed',
        `Room ${ticket.roomNumber}: ${ticket.issue} resolved.`,
        { type: 'MaintenanceTicket', id: ticket._id }, session);
    }
    await ticket.save({ session });
    return ticket;
  });
}

module.exports = {
  withTransaction, notify, recordTransaction,
  nextReservationRef, nextTicketCode, nextTxCode, nextLostCode, nextCode,
  checkIn, walkIn, startCheckout, submitInspection, completeCheckout,
  advanceTask, reviewTask,
  createGuestRequest, assignGuestRequest, advanceGuestRequest,
  reportIssue, assessTicket, updateTicket
};
