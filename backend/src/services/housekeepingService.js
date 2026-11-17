'use strict';
/**
 * Cleaning workflow: Assigned → In Progress → Ready for Inspection → Completed.
 * Housekeepers move only their own tasks; only a supervisor can approve, and
 * approval requires every checklist item to pass. A room becomes Available
 * only on approval (and only if no guest or maintenance hold is on it).
 */
const { HousekeepingTask, Room, User } = require('../models');
const { INSPECT_CHECKS, TASK_TYPES } = require('../config/business');
const { runWorkflow, opt } = require('../utils/workflow');
const { notFound, conflict, forbidden, unprocessable, badRequest } = require('../utils/errors');
const { actor, notify, transition } = require('./shared');

async function getTask(id, session) {
  const t = await HousekeepingTask.findById(id, null, opt(session));
  if (!t) throw notFound('Housekeeping task');
  return t;
}
async function housekeeper(userId) {
  const u = await User.findOne({ _id: userId, role: 'housekeeper', active: true });
  if (!u) throw badRequest('Choose an active housekeeper.');
  return u;
}

function list(user) {
  const filter = user.role === 'housekeeper' ? { $or: [{ assignedTo: user._id }, { kind: 'inspection', status: { $ne: 'Completed' } }] } : {};
  return HousekeepingTask.find(filter).sort({ assignedAt: -1 }).limit(500);
}
const history = () => HousekeepingTask.find({ status: 'Completed' }).sort({ completedAt: -1 }).limit(200);

/** Supervisor: assign a new cleaning task. */
async function create(user, b) {
  if (b.type === 'Checkout inspection') throw badRequest('Checkout inspections are created by the front desk at checkout.');
  if (!TASK_TYPES.includes(b.type)) throw badRequest('Unknown task type.');
  const room = await Room.findOne({ number: b.roomNumber });
  if (!room) throw notFound('Room');
  if (!['cleaning', 'available'].includes(room.status)) throw conflict(`Room ${room.number} is ${room.status}; tasks can be assigned to rooms that are cleaning or available.`);
  const hk = await housekeeper(b.assigneeId);
  return runWorkflow(async s => {
    const [t] = await HousekeepingTask.create([{
      room: room._id, roomNumber: room.number, kind: 'cleaning', type: b.type, priority: b.priority, note: b.note || '',
      status: 'Assigned', assignedTo: hk._id, assignedToName: hk.name, assignedBy: user._id, openKey: `${room.number}:cleaning`
    }], opt(s)).catch(e => {
      if (e.code === 11000) throw conflict(`Room ${room.number} already has an open housekeeping task. Reassign it instead.`, 'DUPLICATE');
      throw e;
    });
    await notify(['housekeeper'], 'New task assigned', `Room ${room.number} · ${b.type} — ${hk.name}`, s);
    return t;
  });
}

/** Supervisor: (re)assign an open cleaning task. */
async function reassign(user, id, b) {
  const t = await getTask(id);
  if (t.kind !== 'cleaning') throw badRequest('Checkout inspections are not assigned to a single housekeeper.');
  if (t.status === 'Completed') throw conflict('This task is already completed.');
  const hk = await housekeeper(b.assigneeId);
  const set = { assignedTo: hk._id, assignedToName: hk.name };
  if (b.type && b.type !== 'Checkout inspection') set.type = b.type;
  if (b.priority) set.priority = b.priority;
  if (b.note) set.note = b.note;
  return runWorkflow(async s => {
    const updated = await transition(HousekeepingTask, { _id: t._id, status: { $ne: 'Completed' } }, { $set: set }, s);
    await notify(['housekeeper'], 'New task assigned', `Room ${t.roomNumber} · ${updated.type} — ${hk.name}`, s);
    return updated;
  });
}

function assertOwn(user, t) {
  if (t.kind !== 'cleaning') throw badRequest('Checkout inspections are submitted from the inspection form.');
  if (!t.assignedTo || String(t.assignedTo) !== String(user._id)) throw forbidden('Only the housekeeper assigned to this room can update it.');
}

/** Housekeeper: Assigned → In Progress. */
async function start(user, id) {
  const t = await getTask(id);
  assertOwn(user, t);
  if (t.status !== 'Assigned') throw conflict(`This task is already ${t.status}.`, 'ALREADY_DONE');
  return runWorkflow(async s => {
    const updated = await transition(HousekeepingTask, { _id: t._id, status: 'Assigned' }, { $set: { status: 'In Progress', startedAt: new Date() } }, s);
    // An occupied room (stay-over cleaning) stays occupied; maintenance holds stay.
    await Room.updateOne({ _id: t.room, currentReservation: null, status: { $in: ['available', 'cleaning'] } },
      { $set: { status: 'cleaning' }, $push: { statusHistory: { ...actor(user), what: `Cleaning started (${t.type})` } } }, opt(s));
    return updated;
  });
}

/** Housekeeper: In Progress → Ready for Inspection. */
async function submit(user, id) {
  const t = await getTask(id);
  assertOwn(user, t);
  if (t.status !== 'In Progress') throw conflict(t.status === 'Ready for Inspection' ? 'This room is already waiting for inspection.' : `This task is ${t.status}.`, 'ALREADY_DONE');
  return runWorkflow(async s => {
    const updated = await transition(HousekeepingTask, { _id: t._id, status: 'In Progress' }, { $set: { status: 'Ready for Inspection', submittedAt: new Date() } }, s);
    await notify(['supervisor'], 'Room ready for inspection', `Room ${t.roomNumber} was submitted by ${user.name}.`, s);
    return updated;
  });
}

/** Supervisor: approve (room → Available) or return for recleaning. */
async function review(user, id, { decision, checklist = [], note = '' }) {
  const t = await getTask(id);
  if (t.kind !== 'cleaning') throw badRequest('Checkout inspections are reviewed by the front desk at checkout.');
  if (t.status !== 'Ready for Inspection') throw conflict(`Room ${t.roomNumber} is not waiting for inspection (status: ${t.status}).`, 'ALREADY_DONE');
  const results = INSPECT_CHECKS.map((item, i) => ({ item, passed: checklist[i] === true }));
  return runWorkflow(async s => {
    if (decision === 'approve') {
      const failed = results.filter(r => !r.passed).length;
      if (failed) throw unprocessable(`${failed} checklist item${failed > 1 ? 's are' : ' is'} not ticked. Approve only a fully passed room.`);
      const insp = { result: 'Approved', at: new Date(), ...actor(user), note, checklist: results, reworked: !!t.reworked };
      const updated = await transition(HousekeepingTask, { _id: t._id, status: 'Ready for Inspection' },
        { $set: { status: 'Completed', completedAt: new Date(), lastInspection: insp }, $push: { inspections: insp }, $unset: { openKey: 1 } }, s);
      const room = await Room.findOneAndUpdate({ _id: t.room, currentReservation: null, status: { $ne: 'maintenance' } },
        { $set: { status: 'available' }, $push: { statusHistory: { ...actor(user), what: 'Approved after cleaning inspection — available' } } }, opt(s, { new: true }));
      await notify(['frontdesk'], 'Room available', room ? `Room ${t.roomNumber} passed inspection and is ready for guests.` : `Room ${t.roomNumber} passed cleaning inspection.`, s);
      return { task: updated, roomStatus: room ? room.status : null };
    }
    const insp = { result: 'Returned for recleaning', at: new Date(), ...actor(user), note, checklist: results };
    const updated = await transition(HousekeepingTask, { _id: t._id, status: 'Ready for Inspection' },
      { $set: { status: 'In Progress', reworked: true, lastInspection: insp }, $unset: { submittedAt: 1 }, $push: { inspections: insp } }, s);
    await notify(['housekeeper'], 'Room returned', `Room ${t.roomNumber} needs recleaning${note ? `: ${note}` : '.'}`, s);
    return { task: updated };
  });
}

module.exports = { list, history, create, reassign, start, submit, review, getTask };
