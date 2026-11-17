'use strict';
/**
 * Auto-created housekeeping tasks (after checkout, transfer, maintenance).
 * `openKey` (unique) guarantees at most one open task per room and kind, so a
 * retried workflow never creates a duplicate task.
 */
const { HousekeepingTask } = require('../models');
const { opt } = require('../utils/workflow');

async function ensureTask(room, fields, user, session) {
  const openKey = `${room.number}:${fields.kind}`;
  const existing = await HousekeepingTask.findOne({ openKey }, null, opt(session));
  if (existing) return { task: existing, created: false };
  try {
    const [task] = await HousekeepingTask.create([{ room: room._id, roomNumber: room.number, openKey, assignedBy: user ? user._id : null, ...fields }], opt(session));
    return { task, created: true };
  } catch (e) {
    if (e.code === 11000) return { task: await HousekeepingTask.findOne({ openKey }, null, opt(session)), created: false };
    throw e;
  }
}

const ensureCleaningTask = (room, { type, priority = 'High', note = '' }, user, session) =>
  ensureTask(room, { kind: 'cleaning', type, priority, note, status: 'Assigned', assignedTo: null, assignedToName: '' }, user, session);

const ensureInspectionTask = (room, reservation, inspection, user, session) =>
  ensureTask(room, {
    kind: 'inspection', type: 'Checkout inspection', priority: 'High', status: 'Assigned',
    note: `Inspect Room ${room.number} before ${reservation.guest.name} checks out`,
    reservation: reservation._id, inspection: inspection._id, bookingRef: reservation.ref
  }, user, session);

module.exports = { ensureCleaningTask, ensureInspectionTask };
