'use strict';
const { Schema, model } = require('mongoose');
const { TRANSACTION_TYPES, LEDGER_METHODS, CURRENCY } = require('../config/business');
const { cleanJSON, money, actorFields } = require('./common');

/**
 * Payment ledger entry. Positive = money in, negative = refund.
 * `idempotencyKey` is derived on the server from the operation (for example
 * "checkout-deposit:<reservationId>") and uniquely indexed, so the same
 * financial event can never be recorded twice.
 */
const TransactionSchema = new Schema({
  txnNo: { type: String, required: true, unique: true },              // TXN-100045
  idempotencyKey: { type: String, unique: true, sparse: true },
  at: { type: Date, default: Date.now, required: true },
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  bookingRef: { type: String, required: true },
  guestName: { type: String, required: true },
  roomNumber: { type: String, default: '—' },
  type: { type: String, required: true, enum: TRANSACTION_TYPES },
  method: { type: String, required: true, enum: LEDGER_METHODS },
  amount: money({ required: true, min: -10000000, max: 10000000 }),
  currency: { type: String, default: CURRENCY, enum: [CURRENCY] },
  depositApplied: money({ min: 0 }),
  incidents: [{ type: Schema.Types.ObjectId, ref: 'Incident' }],
  guestRequest: { type: Schema.Types.ObjectId, ref: 'GuestRequest', default: null },
  processedBy: actorFields.by,
  processedByName: { type: String, required: true }
}, { timestamps: true });

TransactionSchema.index({ at: -1 });
TransactionSchema.index({ reservation: 1, at: -1 });
TransactionSchema.index({ type: 1, method: 1 });
cleanJSON(TransactionSchema, ['idempotencyKey']);

module.exports = model('Transaction', TransactionSchema);
