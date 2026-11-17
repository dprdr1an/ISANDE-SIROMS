'use strict';
/** Guest requests and Lost & Found. */
const { GuestRequest, LostItem, Room, Reservation } = require('../models');
const { REQUEST_CATALOG } = require('../config/business');
const { runWorkflow, opt } = require('../utils/workflow');
const { notFound, conflict, badRequest, unprocessable } = require('../utils/errors');
const { fromLocal } = require('../utils/time');
const { REFS, actor, notify, transition } = require('./shared');
const ledger = require('./ledger');

const IN_HOUSE = ['Checked in', 'Pending Room Inspection', 'Inspection Completed', 'Pending Damage Payment'];

/* ---------------- Guest requests ---------------- */
const listRequests = () => GuestRequest.find().sort({ createdAt: -1 }).limit(500);

async function createRequest(user, b) {
  if (b.clientRequestId) {
    const dup = await GuestRequest.findOne({ clientRequestId: b.clientRequestId });
    if (dup) return dup;
  }
  const room = await Room.findOne({ number: b.roomNumber });
  if (!room) throw notFound('Room');
  const r = room.currentReservation ? await Reservation.findById(room.currentReservation) : null;
  if (!r || !IN_HOUSE.includes(r.status)) throw conflict(`Room ${room.number} has no in-house guest.`);
  // Prices come from the catalog; only "Other" items carry a staff-entered price.
  const items = b.items.map(i => {
    if (i.name === 'Other') {
      if (!i.custom || !i.custom.trim()) throw badRequest('Describe the custom item before sending.');
      return { name: i.custom.trim(), qty: i.qty, unitPrice: i.price || 0 };
    }
    const c = REQUEST_CATALOG.find(x => x.name === i.name);
    if (!c) throw badRequest(`Unknown item: ${i.name}`);
    return { name: c.name, qty: i.qty, unitPrice: c.price };
  });
  const charge = items.reduce((a, i) => a + i.unitPrice * i.qty, 0);
  // Charges go on the folio, which is settled when checkout starts.
  if (charge > 0 && r.status !== 'Checked in') throw unprocessable('Checkout has already started for this guest, so new charges can’t be added to the room. Log free items only, or collect separately.');
  return runWorkflow(async s => {
    const [req] = await GuestRequest.create([{
      requestNo: await REFS.request(s), clientRequestId: b.clientRequestId,
      room: room._id, roomNumber: room.number, reservation: r._id, guestName: r.guest.name,
      items, notes: b.notes || '', charge, createdBy: user._id, createdByName: user.name,
      statusHistory: [{ status: 'Pending', at: new Date(), ...actor(user) }]
    }], opt(s));
    if (charge > 0) {
      await transition(Reservation, { _id: r._id, status: 'Checked in' },
        { $push: { charges: { description: items.map(i => i.name).join(', '), amount: charge, kind: 'request', guestRequest: req._id } } }, s,
        'The guest’s checkout started while you were logging this. Nothing was charged.');
      await ledger.record({ key: `request:${req._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: room.number, type: 'Additional charge', method: 'Charge to room', amount: charge, guestRequest: req._id, user }, s);
    }
    await notify(['housekeeper'], 'New guest request', `Room ${room.number} · ${items.map(i => i.name).join(', ')}`, s);
    return req;
  });
}

async function advanceRequest(user, id) {
  const req = await GuestRequest.findById(id);
  if (!req) throw notFound('Guest request');
  const next = { Pending: 'In delivery', 'In delivery': 'Delivered' }[req.status];
  if (!next) throw conflict('This request has already been delivered.', 'ALREADY_DONE');
  return transition(GuestRequest, { _id: req._id, status: req.status }, { $set: { status: next }, $push: { statusHistory: { status: next, at: new Date(), ...actor(user) } } });
}

/* ---------------- Lost & found ---------------- */
const listLost = () => LostItem.find().sort({ foundAt: -1 }).limit(500);
async function getLost(id) {
  const x = await LostItem.findById(id);
  if (!x) throw notFound('Found item');
  return x;
}
async function createLost(user, b) {
  if (b.clientRequestId) {
    const dup = await LostItem.findOne({ clientRequestId: b.clientRequestId });
    if (dup) return dup;
  }
  const foundAt = fromLocal(b.foundAt);
  if (!foundAt) throw badRequest('Date and time found is invalid.');
  if (foundAt.getTime() > Date.now() + 5 * 60e3) throw unprocessable('Date found cannot be in the future.');
  return runWorkflow(async s => {
    const [x] = await LostItem.create([{
      itemNo: await REFS.lost(s), clientRequestId: b.clientRequestId,
      item: b.item, category: b.category, location: b.location, condition: b.condition, description: b.description, foundAt,
      reportedBy: user._id, reportedByName: user.name, statusHistory: [{ status: 'Stored', at: new Date(), ...actor(user), note: 'Logged and stored' }]
    }], opt(s));
    return x;
  });
}
async function claimLost(user, id, b) {
  const x = await getLost(id);
  if (x.status !== 'Stored') throw conflict(`This item is ${x.status.toLowerCase()}.`, 'ALREADY_DONE');
  return transition(LostItem, { _id: x._id, status: 'Stored' }, {
    $set: { status: 'Claim pending', claim: { claimantName: b.claimantName || '', note: b.note || '', at: new Date(), ...actor(user) } },
    $push: { statusHistory: { status: 'Claim pending', at: new Date(), ...actor(user), note: b.claimantName ? `Claim by ${b.claimantName}` : 'Claim recorded' } }
  });
}
async function releaseLost(user, id, b) {
  const x = await getLost(id);
  if (x.status === 'Released') throw conflict('This item has already been released.', 'ALREADY_DONE');
  if (b.ownershipVerified !== true) throw unprocessable('Verify the claimant’s ownership before releasing the item.');
  return transition(LostItem, { _id: x._id, status: { $in: ['Stored', 'Claim pending'] } }, {
    $set: { status: 'Released', release: { releasedTo: b.releasedTo || x.claim?.claimantName || '', ownershipVerified: true, at: new Date(), ...actor(user) } },
    $push: { statusHistory: { status: 'Released', at: new Date(), ...actor(user), note: b.releasedTo ? `Released to ${b.releasedTo}` : 'Released to owner' } }
  });
}

module.exports = { listRequests, createRequest, advanceRequest, listLost, getLost, createLost, claimLost, releaseLost };
