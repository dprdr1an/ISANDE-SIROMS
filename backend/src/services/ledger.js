'use strict';
/** The only place that writes to the transactions ledger. */
const { Transaction } = require('../models');
const { insertOnce } = require('../utils/workflow');
const { REFS } = require('./shared');

/**
 * Record a financial event exactly once. `key` must identify the event
 * (e.g. `checkin:<reservationId>`), so retries return the existing entry.
 */
async function record({ key, reservation, bookingRef, guestName, roomNumber, type, method, amount, user, depositApplied = 0, incidents = [], guestRequest = null }, session) {
  const existing = await Transaction.findOne({ idempotencyKey: key }, null, session ? { session } : {});
  if (existing) return existing;
  return insertOnce(Transaction, {
    idempotencyKey: key,
    txnNo: await REFS.txn(session),
    at: new Date(),
    reservation: reservation || null,
    bookingRef, guestName, roomNumber: roomNumber || '—', type, method, amount,
    depositApplied, incidents, guestRequest,
    processedBy: user._id, processedByName: user.name
  }, session);
}

module.exports = { record };
