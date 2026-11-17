'use strict';
/**
 * Checkout room inspections and incident reports.
 * Housekeeping submits findings; each finding becomes an Incident and the
 * deposit settlement is computed on the server. The booking then moves to
 * Inspection Completed or Pending Damage Payment.
 */
const { Inspection, Incident, Reservation, HousekeepingTask } = require('../models');
const { CHECKOUT_INSPECT_CHECKS, DEPOSIT } = require('../config/business');
const { runWorkflow, opt, insertOnce } = require('../utils/workflow');
const { notFound, conflict, badRequest } = require('../utils/errors');
const { money: fmt } = require('../utils/format');
const { REFS, actor, notify, transition, settle } = require('./shared');

const list = (filter = {}) => Inspection.find(filter).sort({ requestedAt: -1 }).limit(300);
async function get(id) {
  const i = await Inspection.findById(id).populate('incidents');
  if (!i) throw notFound('Inspection');
  return i;
}

async function submit(user, id, { checklist = [], findings = [], remarks = '' }) {
  const insp = await Inspection.findById(id);
  if (!insp) throw notFound('Inspection');
  if (insp.status === 'Completed') throw conflict(`Room ${insp.roomNumber} has already been inspected.`, 'ALREADY_DONE');
  const r = await Reservation.findById(insp.reservation);
  if (!r || r.status !== 'Pending Room Inspection') throw conflict('This booking is not waiting for a checkout inspection.');
  findings.forEach((f, i) => { if (!f.item.trim()) throw badRequest(`Finding ${i + 1} needs an item or facility name.`); });
  const results = CHECKOUT_INSPECT_CHECKS.map((item, i) => ({ item, passed: checklist[i] !== false }));
  return runWorkflow(async s => {
    const created = [];
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      created.push(await insertOnce(Incident, {
        idempotencyKey: `inspection:${insp._id}:${i}`, incidentId: await REFS.incident(s),
        reservation: r._id, inspection: insp._id, bookingRef: r.ref, roomNumber: insp.roomNumber, guestName: r.guest.name,
        category: f.category, item: f.item.trim(), description: f.description || '',
        qty: f.category === 'Missing Item' ? f.qty : 1, unitCost: f.cost, photos: f.photos || 0, remarks: f.remarks || '',
        status: 'Pending', reportedBy: user._id, reportedByName: user.name,
        statusHistory: [{ status: 'Pending', at: new Date(), ...actor(user), note: 'Recorded during checkout inspection' }]
      }, s));
    }
    const m = settle(r.deposit.amount || DEPOSIT, created);
    const done = await transition(Inspection, { _id: insp._id, status: 'Pending' }, {
      $set: { status: 'Completed', inspectedAt: new Date(), inspectedBy: user._id, inspectedByName: user.name, checklist: results, incidents: created.map(c => c._id), remarks, settlement: m }
    }, s, 'This room has already been inspected.');
    const next = m.extra > 0 ? 'Pending Damage Payment' : 'Inspection Completed';
    await transition(Reservation, { _id: r._id, status: 'Pending Room Inspection' }, {
      $set: { status: next },
      $push: { statusHistory: { status: next, at: new Date(), ...actor(user), note: created.length ? `${created.length} finding(s), ${fmt(m.damages)}` : 'No issues found' } }
    }, s);
    await HousekeepingTask.updateOne({ inspection: insp._id, status: { $ne: 'Completed' } }, {
      $set: { status: 'Completed', completedAt: new Date(), lastInspection: { result: created.length ? 'Issues found' : 'No issues found', at: new Date(), ...actor(user) } },
      $unset: { openKey: 1 }
    }, opt(s));
    await notify(['frontdesk'], 'Inspection completed', `Room ${insp.roomNumber}: ${created.length ? `${created.length} issue(s), ${fmt(m.damages)} in damages` : 'no issues found'}. Ready for checkout.`, s);
    return { inspection: done, settlement: m, incidents: created };
  });
}

/* ---------------- Incidents ---------------- */
function listIncidents({ status, category } = {}) {
  const f = {};
  if (status) f.status = status;
  if (category) f.category = category;
  return Incident.find(f).sort({ reportedAt: -1 }).limit(500);
}
async function getIncident(key) {
  const i = await Incident.findOne(/^INC-/.test(key) ? { incidentId: key } : { _id: key });
  if (!i) throw notFound('Incident');
  return i;
}
/** Front desk / manager: mark a pending charge Paid or Waived. */
async function setIncidentStatus(user, key, { status, note = '' }) {
  const inc = await getIncident(key);
  if (inc.status !== 'Pending') throw conflict(`${inc.incidentId} is already ${inc.status}.`, 'ALREADY_DONE');
  return runWorkflow(async s => {
    const set = { status };
    if (status === 'Waived') set.remarks = (inc.remarks ? inc.remarks + ' · ' : '') + `Charge waived by ${user.name}`;
    const updated = await transition(Incident, { _id: inc._id, status: 'Pending' }, { $set: set, $push: { statusHistory: { status, at: new Date(), ...actor(user), note } } }, s);
    // A waiver can bring a held booking back within the deposit.
    if (status === 'Waived' && inc.reservation) {
      const r = await Reservation.findById(inc.reservation, null, opt(s));
      if (r && r.status === 'Pending Damage Payment') {
        const insp = await Inspection.findById(r.inspection, null, opt(s));
        const all = await Incident.find({ _id: { $in: insp ? insp.incidents : [] } }, null, opt(s));
        if (settle(r.deposit.amount, all).extra === 0)
          await Reservation.updateOne({ _id: r._id, status: 'Pending Damage Payment' }, { $set: { status: 'Inspection Completed' }, $push: { statusHistory: { status: 'Inspection Completed', at: new Date(), ...actor(user), note: `Charges within deposit after waiving ${inc.incidentId}` } } }, opt(s));
      }
    }
    return updated;
  });
}

module.exports = { list, get, submit, listIncidents, getIncident, setIncidentStatus };
