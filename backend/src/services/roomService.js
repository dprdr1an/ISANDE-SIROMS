'use strict';
/** Rooms. Status changes only happen inside workflows (check-in, cleaning approval, maintenance…). */
const { Room } = require('../models');
const { notFound, conflict } = require('../utils/errors');
const { actor } = require('./shared');

function list({ status, floor, q } = {}) {
  const f = {};
  if (status) f.status = status;
  if (floor) f.floor = floor;
  if (q) f.number = { $regex: '^' + q.replace(/\D/g, '') };
  return Room.find(f).sort({ number: 1 });
}
async function get(number) {
  const r = await Room.findOne({ number });
  if (!r) throw notFound('Room');
  return r;
}
/** Manager: add a room. New rooms start in 'cleaning' so they pass a cleaning inspection before sale. */
async function create(user, b) {
  if (await Room.findOne({ number: b.number })) throw conflict(`Room ${b.number} already exists.`, 'DUPLICATE');
  return Room.create({ number: b.number, type: b.type, status: 'cleaning', statusHistory: [{ ...actor(user), what: 'Room added' }] });
}
/** Manager: change room type (only while no guest is in it). */
async function update(user, number, b) {
  const r = await get(number);
  if (r.currentReservation) throw conflict(`Room ${number} has a guest; change its type after checkout.`);
  const updated = await Room.findOneAndUpdate({ _id: r._id, currentReservation: null }, { $set: { type: b.type }, $push: { statusHistory: { ...actor(user), what: `Type changed to ${b.type}` } } }, { new: true, runValidators: true });
  if (!updated) throw conflict('A guest just checked into this room.');
  return updated;
}
module.exports = { list, get, create, update };
