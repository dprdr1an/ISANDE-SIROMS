'use strict';
const { Counter, Notification } = require('../models');
const { opt } = require('../utils/workflow');
const { conflict } = require('../utils/errors');

/** Next value of a named counter (atomic). */
async function nextSeq(name, session, start = 1000) {
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, opt(session, { new: true, upsert: true }));
  // First use: jump to `start` so references don't begin at 1.
  if (c.seq < start) {
    const bumped = await Counter.findOneAndUpdate({ _id: name, seq: c.seq }, { $set: { seq: start } }, opt(session, { new: true }));
    return bumped ? bumped.seq : nextSeq(name, session, start);
  }
  return c.seq;
}
const pad = (n, w = 4) => String(n).padStart(w, '0');
const REFS = {
  reservation: async s => `SSR-${new Date().getFullYear()}-${pad(await nextSeq('reservation', s, 725))}`,
  walkin: async s => `WALK-${pad(await nextSeq('walkin', s, 2042))}`,
  incident: async s => `INC-${await nextSeq('incident', s, 1043)}`,
  ticket: async s => `WO-${await nextSeq('ticket', s, 1006)}`,
  lost: async s => `LF-${await nextSeq('lost', s, 1004)}`,
  request: async s => `GR-${await nextSeq('request', s, 1004)}`,
  txn: async s => `TXN-${await nextSeq('txn', s, 100013)}`
};

const actor = user => ({ by: user._id, byName: user.name });

async function notify(roles, title, text, session) {
  await Notification.create([{ roles, title, text }], opt(session));
}

/**
 * Conditional state change: update only if the record is still in one of
 * the expected states. Returns the updated document or throws 409.
 */
async function transition(Model, filter, update, session, message) {
  const doc = await Model.findOneAndUpdate(filter, update, opt(session, { new: true, runValidators: true }));
  if (!doc) throw conflict(message || 'This record was changed by someone else. Refresh and try again.', 'STALE_STATE');
  return doc;
}

/** Security-deposit settlement (waived incidents are not charged). */
const incidentCost = i => i.unitCost * (i.category === 'Missing Item' ? i.qty : 1);
function settle(deposit, incidents) {
  const damages = incidents.filter(i => i.status !== 'Waived').reduce((a, i) => a + incidentCost(i), 0);
  return {
    deposit,
    damages,
    applied: Math.min(deposit, damages),
    refund: Math.max(0, deposit - damages),
    extra: Math.max(0, damages - deposit)
  };
}

module.exports = { nextSeq, REFS, actor, notify, transition, incidentCost, settle };
