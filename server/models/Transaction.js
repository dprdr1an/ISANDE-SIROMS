'use strict';
const mongoose = require('mongoose');
const { TX_TYPES, PAYMENT_METHODS } = require('./constants');

/** Immutable financial record. Balances are derived from these (brief §12). */
const transactionSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },          // TX-000123
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', default: null },
  bookingRef:  { type: String, default: '' },
  guest:       { type: String, default: '' },
  room:        { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  roomNumber:  { type: String, default: '' },

  type:   { type: String, required: true, enum: { values: TX_TYPES, message: '{VALUE} is not a valid transaction type.' } },
  method: { type: String, enum: PAYMENT_METHODS, default: 'Cash' },
  // Negative amounts represent money leaving the property (refunds).
  amount: { type: Number, required: [true, 'Amount is required.'],
            validate: { validator: Number.isFinite, message: 'Amount must be a number.' } },
  depositApplied: { type: Number, default: 0, min: 0 },

  staff:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  staffName: { type: String, default: '' },
  when:      { type: Date, default: Date.now, index: true }
}, { timestamps: true });

transactionSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('Transaction', transactionSchema);
