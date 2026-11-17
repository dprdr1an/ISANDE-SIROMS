'use strict';
/**
 * Work orders: housekeeper reports → supervisor assesses priority & room
 * impact and forwards to a technician → technician updates until Resolved.
 * Maintenance staff never see tickets still awaiting assessment.
 */
const { MaintenanceTicket, Room, User, HousekeepingTask } = require('../models');
const { TICKET_ACTIVE } = require('../config/business');
const { runWorkflow, opt } = require('../utils/workflow');
const { notFound, conflict, badRequest, forbidden, unprocessable } = require('../utils/errors');
const { fromLocal } = require('../utils/time');
const { REFS, actor, notify, transition } = require('./shared');
const tasks = require('./taskFactory');

const visibleFilter = user => (user.role === 'maintenance' ? { stage: { $ne: 'assessment' } } : {});
const list = user => MaintenanceTicket.find(visibleFilter(user)).sort({ reportedAt: -1 }).limit(500);
async function get(user, id) {
  const t = await MaintenanceTicket.findOne({ _id: id, ...visibleFilter(user) });
  if (!t) throw notFound('Work order');
  return t;
}
const entry = (user, what) => ({ at: new Date(), ...actor(user), what });

async function report(user, b) {
  if (b.clientRequestId) {
    const dup = await MaintenanceTicket.findOne({ clientRequestId: b.clientRequestId });
    if (dup) return dup;
  }
  const room = await Room.findOne({ number: b.roomNumber });
  if (!room) throw notFound('Room');
  return runWorkflow(async s => {
    const [t] = await MaintenanceTicket.create([{
      ticketNo: await REFS.ticket(s), clientRequestId: b.clientRequestId,
      room: room._id, roomNumber: room.number, category: b.category,
      issue: b.description.split('.')[0].slice(0, 60).trim() || b.description.slice(0, 60), description: b.description,
      reportedBy: user._id, reportedByName: user.name, history: [entry(user, 'Issue reported to supervisor')]
    }], opt(s));
    await notify(['supervisor'], 'Room issue awaiting assessment', `Room ${room.number} · ${b.category}`, s);
    return t;
  });
}

async function assess(user, id, b) {
  const t = await MaintenanceTicket.findById(id);
  if (!t) throw notFound('Work order');
  if (t.stage !== 'assessment') throw conflict('This work order has already been assessed.', 'ALREADY_DONE');
  const tech = await User.findOne({ _id: b.technicianId, role: 'maintenance', active: true });
  if (!tech) throw badRequest('Choose an active maintenance technician.');
  return runWorkflow(async s => {
    const updated = await transition(MaintenanceTicket, { _id: t._id, stage: 'assessment' }, {
      $set: { priority: b.priority, impact: b.impact, assignedTo: tech._id, assignedToName: tech.name, stage: 'assigned', status: 'Accepted', assessedBy: user._id, assessedAt: new Date() },
      $push: { history: entry(user, `Assessed as ${b.priority} priority · ${b.impact}${b.note ? ` — ${b.note}` : ''}`) }
    }, s, 'This work order has already been assessed.');
    if (b.impact === 'Room must be taken offline')
      await Room.updateOne({ _id: t.room, currentReservation: null }, { $set: { status: 'maintenance' }, $push: { statusHistory: { ...actor(user), what: `Taken offline — ${t.ticketNo} ${t.issue}` } } }, opt(s));
    await notify(['maintenance'], 'New work order', `Room ${t.roomNumber} · ${t.issue} · ${b.priority} priority`, s);
    return updated;
  });
}

async function update(user, id, b) {
  const t = await MaintenanceTicket.findById(id);
  if (!t) throw notFound('Work order');
  if (t.stage === 'assessment') throw forbidden('This work order has not been forwarded to maintenance yet.');
  if (t.stage === 'resolved') throw conflict('This work order is already resolved.', 'ALREADY_DONE');
  const eta = fromLocal(b.eta);
  if (!eta) throw badRequest('Estimated completion must be a valid date and time.');
  const room = await Room.findById(t.room);
  const resolved = b.status === 'Resolved';
  if (b.availability === 'Return to available' && room && !room.currentReservation) {
    const openTask = await HousekeepingTask.findOne({ room: room._id, status: { $ne: 'Completed' } });
    if (openTask) throw unprocessable(`Room ${room.number} has an open housekeeping task (${openTask.status}). Send it to housekeeping instead — it becomes available after the supervisor approves it.`);
  }
  return runWorkflow(async s => {
    const set = { status: b.status, eta, parts: b.parts || '' };
    if (!t.assignedTo) { set.assignedTo = user._id; set.assignedToName = user.name; }
    if (resolved) { set.stage = 'resolved'; set.resolvedAt = new Date(); }
    const updated = await transition(MaintenanceTicket, { _id: t._id, stage: 'assigned' }, { $set: set, $push: { history: entry(user, `${b.status} — ${b.notes}`) } }, s);
    if (room && !room.currentReservation) {
      if (b.availability === 'Send to housekeeping') {
        await Room.updateOne({ _id: room._id, currentReservation: null }, { $set: { status: 'cleaning' }, $push: { statusHistory: { ...actor(user), what: `Sent to housekeeping after ${t.ticketNo}` } } }, opt(s));
        const hasOpen = await HousekeepingTask.findOne({ room: room._id, status: { $ne: 'Completed' } }, null, opt(s));
        if (!hasOpen) await tasks.ensureCleaningTask(room, { type: 'Recleaning', priority: 'High', note: 'After maintenance work' }, user, s);
      } else if (b.availability === 'Return to available') {
        await Room.updateOne({ _id: room._id, currentReservation: null }, { $set: { status: 'available' }, $push: { statusHistory: { ...actor(user), what: `Returned to available after ${t.ticketNo}` } } }, opt(s));
      } else if (!resolved) {
        await Room.updateOne({ _id: room._id, currentReservation: null }, { $set: { status: 'maintenance' } }, opt(s));
      }
    }
    if (resolved) await notify(['supervisor', 'frontdesk'], 'Repair completed', `Room ${t.roomNumber} · ${t.issue}`, s);
    return updated;
  });
}

module.exports = { list, get, report, assess, update, TICKET_ACTIVE };
