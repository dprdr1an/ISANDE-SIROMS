'use strict';
/**
 * Reservations, check-in, walk-in, guest transfer and checkout.
 * Every money amount is validated here against server-side balances;
 * the browser only proposes how much was received.
 */
const { Reservation, Room, OnlineBooking, Inspection, Incident, HousekeepingTask } = require('../models');
const { ROOM_TYPES, DEPOSIT, PRE_ARRIVAL } = require('../config/business');
const { runWorkflow, opt } = require('../utils/workflow');
const { notFound, conflict, unprocessable, badRequest } = require('../utils/errors');
const { today, nights, addDays } = require('../utils/time');
const { money: fmt } = require('../utils/format');
const { REFS, actor, notify, transition, settle } = require('./shared');
const ledger = require('./ledger');
const tasks = require('./taskFactory');

const hist = (user, status, note = '') => ({ status, at: new Date(), ...actor(user), note });

async function getByRef(ref, session) {
  const r = await Reservation.findOne({ ref }, null, opt(session));
  if (!r) throw notFound('Reservation');
  return r;
}

async function list({ q, status, source } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'guest.name': rx }, { ref: rx }, { roomNumber: rx }, { source: rx }];
  }
  return Reservation.find(filter).sort({ checkIn: -1, createdAt: -1 }).limit(500);
}

/** Another pre-arrival booking holding this room for overlapping dates? */
async function roomConflict(roomId, checkIn, checkOut, exceptId, session) {
  return Reservation.findOne({
    room: roomId, _id: { $ne: exceptId }, status: { $in: PRE_ARRIVAL },
    checkIn: { $lt: checkOut }, checkOut: { $gt: checkIn }
  }, null, opt(session));
}

function assertPayment(amount, due, label) {
  if (amount < due) throw unprocessable(`${label} of ${fmt(due - amount)} must be settled first.`);
  if (amount > due) throw unprocessable(`Amount received (${fmt(amount)}) is more than the ${fmt(due)} due. Enter the exact amount.`);
}

/* ---------------- Create (front desk) ---------------- */
async function createManual(user, b) {
  if (b.checkIn < today()) throw unprocessable('Check-in cannot be in the past.');
  if (b.checkOut <= b.checkIn) throw unprocessable('Check-out must be after check-in.');
  const n = nights(b.checkIn, b.checkOut);
  if (n > 30) throw unprocessable('Reservations are limited to 30 nights.');
  const total = ROOM_TYPES[b.roomType].rate * n;
  if (b.amount < DEPOSIT) throw unprocessable(`Collect at least the ${fmt(DEPOSIT)} deposit before confirming.`);
  if (b.amount > total) throw unprocessable(`Amount received (${fmt(b.amount)}) is more than the ${fmt(total)} total.`);
  if (b.clientRequestId) {
    const dup = await Reservation.findOne({ clientRequestId: b.clientRequestId });
    if (dup) return dup;                           // retried submit — same reservation
  }
  return runWorkflow(async s => {
    const status = b.amount >= total ? 'Confirmed' : 'Pending payment';
    const [r] = await Reservation.create([{
      ref: await REFS.reservation(s), clientRequestId: b.clientRequestId,
      guest: { name: b.guest, contact: b.contact }, source: 'Front Desk',
      checkIn: b.checkIn, checkOut: b.checkOut, roomType: b.roomType, roomNumber: '',
      adults: b.adults, kids: b.kids,
      charges: [{ description: `Room charge · ${n} night${n > 1 ? 's' : ''}`, amount: total, kind: 'room' }],
      amountPaid: b.amount, status, createdBy: user._id, statusHistory: [hist(user, status, 'Reservation taken at the front desk')]
    }], opt(s));
    await ledger.record({ key: `reservation:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, type: status === 'Confirmed' ? 'Reservation payment' : 'Deposit', method: b.method, amount: b.amount, user }, s);
    return r;
  });
}

/** Update guest details on a booking that has not arrived yet. */
async function updateDetails(user, ref, b) {
  const r = await getByRef(ref);
  if (!PRE_ARRIVAL.includes(r.status)) throw conflict('Only bookings that have not checked in can be edited.');
  const set = {};
  if (b.guest != null) set['guest.name'] = b.guest;
  if (b.contact != null) set['guest.contact'] = b.contact;
  if (b.adults != null) set.adults = b.adults;
  if (b.kids != null) set.kids = b.kids;
  if (b.markReviewed && r.status === 'Needs review') set.status = r.balance <= 0 ? 'Confirmed' : 'Pending payment';
  return transition(Reservation, { _id: r._id, status: r.status }, { $set: set, $push: { statusHistory: hist(user, set.status || r.status, 'Details updated') } });
}

/* ---------------- Online booking import ---------------- */
async function importOnline(user, externalId) {
  const b = await OnlineBooking.findOne({ externalId });
  if (!b) throw notFound('Online booking');
  if (b.status === 'Imported') throw conflict('This booking has already been imported.', 'ALREADY_DONE');
  return runWorkflow(async s => {
    let r = await Reservation.findOne({ clientRequestId: `import-${b._id}` }, null, opt(s));
    if (!r) {
      const status = b.prepaid ? 'Confirmed' : 'Pending payment';
      [r] = await Reservation.create([{
        ref: await REFS.reservation(s), externalRef: b.externalId, clientRequestId: `import-${b._id}`,
        guest: { name: b.guest, contact: b.contact }, source: b.source,
        checkIn: b.checkIn, checkOut: b.checkOut, roomType: b.roomType, adults: b.adults, kids: b.kids,
        charges: [{ description: `Room charge · ${nights(b.checkIn, b.checkOut)} nights`, amount: b.total, kind: 'room' }],
        amountPaid: b.prepaid ? b.total : 0, status, createdBy: user._id,
        statusHistory: [hist(user, status, `Imported from ${b.source} (${b.externalId})`)]
      }], opt(s));
    }
    if (b.prepaid) await ledger.record({ key: `import:${b._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, type: 'Reservation payment', method: 'Online', amount: b.total, user }, s);
    await transition(OnlineBooking, { _id: b._id, status: 'Pending' }, { $set: { status: 'Imported', importedAs: r._id, importedAt: new Date() } }, s, 'This booking has already been imported.');
    return r;
  });
}

/* ---------------- Check-in (reserved guest) ---------------- */
async function checkIn(user, ref, b) {
  return runWorkflow(async s => {
    const r = await getByRef(ref, s);
    if (!PRE_ARRIVAL.includes(r.status)) throw conflict(`${r.guest.name} is not awaiting check-in (status: ${r.status}).`, 'ALREADY_DONE');
    assertPayment(b.amount, r.balance, 'Outstanding balance');
    const room = await Room.findOne({ number: b.roomNumber }, null, opt(s));
    if (!room) throw notFound('Room');
    if (!(room.status === 'available' && !room.currentReservation) && String(room.currentReservation) !== String(r._id))
      throw conflict(`Room ${room.number} is not available (${room.status}).`);
    const clash = await roomConflict(room._id, r.checkIn, r.checkOut, r._id, s);
    if (clash) throw conflict(`Room ${room.number} is reserved for ${clash.guest.name} (${clash.ref}) on overlapping dates.`);
    // Claim the room (idempotent for a retried request).
    await transition(Room, { _id: room._id, $or: [{ status: 'available', currentReservation: null }, { currentReservation: r._id }] },
      { $set: { status: 'occupied', currentReservation: r._id }, $push: { statusHistory: { ...actor(user), what: `Occupied — ${r.guest.name} checked in (${r.ref})` } } }, s,
      `Room ${room.number} was just taken. Choose another room.`);
    if (b.amount > 0) await ledger.record({ key: `checkin:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: room.number, type: 'Check-in payment', method: b.method, amount: b.amount, user }, s);
    return transition(Reservation, { _id: r._id, status: { $in: PRE_ARRIVAL } }, {
      $set: { status: 'Checked in', room: room._id, roomNumber: room.number, adults: b.adults, kids: b.kids, amountPaid: r.total, deposit: { amount: DEPOSIT, status: 'held' }, checkedInAt: new Date() },
      $push: { statusHistory: hist(user, 'Checked in', `Room ${room.number}`) }
    }, s, 'This reservation was already checked in.');
  });
}

/* ---------------- Walk-in registration ---------------- */
async function walkIn(user, b) {
  if (b.clientRequestId) {
    const dup = await Reservation.findOne({ clientRequestId: b.clientRequestId });
    if (dup) return dup;
  }
  return runWorkflow(async s => {
    const room = await Room.findOne({ number: b.roomNumber }, null, opt(s));
    if (!room) throw notFound('Room');
    if (room.type !== b.roomType) throw badRequest(`Room ${room.number} is a ${room.type} room.`);
    if (room.status !== 'available' || room.currentReservation) throw conflict(`Room ${room.number} is not available.`);
    const start = today(), end = addDays(start, b.nights);
    const clash = await roomConflict(room._id, start, end, null, s);
    if (clash) throw conflict(`Room ${room.number} is reserved for ${clash.guest.name} (${clash.ref}) during this stay.`);
    const roomCharge = room.rate * b.nights, total = roomCharge + DEPOSIT;
    assertPayment(b.amount, total, 'Room charge and deposit');
    const [r] = await Reservation.create([{
      ref: await REFS.walkin(s), clientRequestId: b.clientRequestId,
      guest: { name: b.guest, contact: b.contact }, source: 'Walk-in',
      checkIn: start, checkOut: end, roomType: room.type, room: room._id, roomNumber: room.number,
      adults: b.adults, kids: b.kids,
      charges: [{ description: `Room charge · ${b.nights} night${b.nights > 1 ? 's' : ''}`, amount: roomCharge, kind: 'room' }],
      amountPaid: roomCharge, deposit: { amount: DEPOSIT, status: 'held' }, status: 'Checked in', checkedInAt: new Date(),
      createdBy: user._id, statusHistory: [hist(user, 'Checked in', `Walk-in, Room ${room.number}`)]
    }], opt(s));
    await transition(Room, { _id: room._id, status: 'available', currentReservation: null },
      { $set: { status: 'occupied', currentReservation: r._id }, $push: { statusHistory: { ...actor(user), what: `Occupied — walk-in ${r.guest.name} (${r.ref})` } } }, s,
      `Room ${room.number} was just taken. Choose another room.`);
    await ledger.record({ key: `walkin:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: room.number, type: 'Walk-in payment', method: b.method, amount: b.amount, user }, s);
    return r;
  });
}

/* ---------------- Transfer an in-house guest ---------------- */
async function transfer(user, fromNumber, toNumber) {
  if (fromNumber === toNumber) throw badRequest('Choose a different room.');
  return runWorkflow(async s => {
    const from = await Room.findOne({ number: fromNumber }, null, opt(s));
    const to = await Room.findOne({ number: toNumber }, null, opt(s));
    if (!from || !to) throw notFound('Room');
    if (!from.currentReservation) throw conflict(`Room ${fromNumber} has no guest.`);
    const r = await Reservation.findById(from.currentReservation, null, opt(s));
    if (!r || r.status !== 'Checked in') throw conflict('Only checked-in guests can be transferred (not during checkout).');
    if (to.status !== 'available' || to.currentReservation) throw conflict(`Room ${toNumber} is not available.`);
    const clash = await roomConflict(to._id, today(), r.checkOut, r._id, s);
    if (clash) throw conflict(`Room ${toNumber} is reserved for ${clash.guest.name} (${clash.ref}).`);
    await transition(Room, { _id: to._id, status: 'available', currentReservation: null }, { $set: { status: 'occupied', currentReservation: r._id }, $push: { statusHistory: { ...actor(user), what: `Occupied — ${r.guest.name} transferred from ${fromNumber}` } } }, s);
    await transition(Room, { _id: from._id, currentReservation: r._id }, { $set: { status: 'cleaning', currentReservation: null }, $push: { statusHistory: { ...actor(user), what: `Vacated — guest moved to ${toNumber}` } } }, s);
    await tasks.ensureCleaningTask(from, { type: 'Checkout cleaning', priority: 'High', note: `Turnover after transfer to Room ${toNumber}` }, user, s);
    const updated = await transition(Reservation, { _id: r._id, status: 'Checked in' }, { $set: { room: to._id, roomNumber: to.number, roomType: to.type }, $push: { statusHistory: hist(user, 'Checked in', `Transferred ${fromNumber} → ${toNumber}`) } }, s);
    await notify(['supervisor', 'housekeeper'], 'Room needs turnover', `Room ${fromNumber} was vacated after a guest transfer.`, s);
    return updated;
  });
}

/* ---------------- Checkout, step 1: settle balance → inspection ---------------- */
async function startCheckout(user, ref, b) {
  return runWorkflow(async s => {
    const r = await getByRef(ref, s);
    if (r.status === 'Pending Room Inspection') throw conflict(`Room ${r.roomNumber} is already with housekeeping for inspection.`, 'ALREADY_DONE');
    if (r.status !== 'Checked in') throw conflict(`Checkout can't start: booking status is ${r.status}.`);
    const room = await Room.findById(r.room, null, opt(s));
    if (!room || String(room.currentReservation) !== String(r._id)) throw conflict('Room record does not match this stay. Contact a manager.');
    assertPayment(b.amount, r.balance, 'Room balance');
    if (b.amount > 0) await ledger.record({ key: `checkout-balance:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: room.number, type: 'Check-out payment', method: b.method, amount: b.amount, user }, s);
    let insp = await Inspection.findOne({ reservation: r._id }, null, opt(s));
    if (!insp) [insp] = await Inspection.create([{ reservation: r._id, bookingRef: r.ref, room: room._id, roomNumber: room.number, requestedBy: user._id, requestedByName: user.name }], opt(s));
    await tasks.ensureInspectionTask(room, r, insp, user, s);
    const updated = await transition(Reservation, { _id: r._id, status: 'Checked in' }, {
      $inc: { amountPaid: b.amount },
      $set: { status: 'Pending Room Inspection', inspection: insp._id, checkoutNote: b.note || '' },
      $push: { statusHistory: hist(user, 'Pending Room Inspection', 'Checkout started; sent to housekeeping') }
    }, s, 'Checkout was already started for this guest.');
    await notify(['housekeeper', 'supervisor'], 'Room inspection needed', `Room ${room.number} needs a checkout inspection before ${r.guest.name} can check out.`, s);
    return updated;
  });
}

/* ---------------- Checkout, step 2: deposit settlement → checked out ---------------- */
async function completeCheckout(user, ref, b) {
  return runWorkflow(async s => {
    const r = await getByRef(ref, s);
    if (r.status === 'Checked Out') throw conflict(`${r.guest.name} is already checked out.`, 'ALREADY_DONE');
    if (r.status === 'Pending Room Inspection') throw conflict(`Room ${r.roomNumber} is still being inspected by housekeeping.`);
    if (!['Inspection Completed', 'Pending Damage Payment'].includes(r.status)) throw conflict(`Checkout can't be completed: booking status is ${r.status}.`);
    const insp = await Inspection.findById(r.inspection, null, opt(s));
    if (!insp || insp.status !== 'Completed') throw conflict('The checkout inspection has not been submitted.');
    const incidents = await Incident.find({ _id: { $in: insp.incidents } }, null, opt(s));
    const m = settle(r.deposit.amount, incidents);         // authoritative, from live incident status
    if (m.extra > 0) {
      if (b.amount < m.extra) throw unprocessable(`Additional charges of ${fmt(m.extra - b.amount)} must be settled to complete checkout.`);
      if (b.amount > m.extra) throw unprocessable(`Amount received (${fmt(b.amount)}) is more than the ${fmt(m.extra)} due.`);
      await ledger.record({ key: `checkout-damage:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: r.roomNumber, type: 'Damage charge', method: b.method, amount: m.extra, incidents: insp.incidents, user }, s);
    }
    await ledger.record({
      key: `checkout-deposit:${r._id}`, reservation: r._id, bookingRef: r.ref, guestName: r.guest.name, roomNumber: r.roomNumber,
      type: m.refund > 0 ? 'Deposit refund' : 'Deposit forfeited', method: m.refund > 0 ? b.method : '—',
      amount: m.refund > 0 ? -m.refund : 0, depositApplied: m.applied, incidents: insp.incidents, user
    }, s);
    await Incident.updateMany({ _id: { $in: insp.incidents }, status: 'Pending' },
      { $set: { status: 'Paid' }, $push: { statusHistory: { status: 'Paid', at: new Date(), ...actor(user), note: 'Settled at checkout' } } }, opt(s));
    const room = await Room.findById(r.room, null, opt(s));
    const updated = await transition(Reservation, { _id: r._id, status: { $in: ['Inspection Completed', 'Pending Damage Payment'] } }, {
      $set: { status: 'Checked Out', checkedOutAt: new Date(), 'deposit.status': m.applied === 0 ? 'refunded' : m.refund > 0 ? 'applied' : 'forfeited' },
      $push: { statusHistory: hist(user, 'Checked Out', m.refund > 0 ? `Refunded ${fmt(m.refund)}` : m.extra > 0 ? `Collected ${fmt(m.extra)} damages` : 'Deposit fully applied') }
    }, s, 'This guest was already checked out.');
    if (room && String(room.currentReservation) === String(r._id)) {
      await Room.updateOne({ _id: room._id, currentReservation: r._id }, { $set: { status: 'cleaning', currentReservation: null }, $push: { statusHistory: { ...actor(user), what: `Checked out — ${r.guest.name}; awaiting cleaning` } } }, opt(s));
      await tasks.ensureCleaningTask(room, { type: 'Checkout cleaning', priority: 'High', note: 'Room vacated after checkout' }, user, s);
    }
    await notify(['supervisor'], 'Room ready for cleaning', `Room ${r.roomNumber} was checked out and now needs cleaning.`, s);
    return { reservation: updated, settlement: m };
  });
}

module.exports = { list, getByRef, createManual, updateDetails, importOnline, checkIn, walkIn, transfer, startCheckout, completeCheckout };
