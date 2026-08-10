'use strict';
const mongoose = require('mongoose');
const { BOOKING_STATUSES, DEPOSIT } = require('./constants');

const folioLineSchema = new mongoose.Schema({
  label:  { type: String, required: true },
  amount: { type: Number, required: true }
}, { _id: false });

/**
 * Reservation doubles as the stay record: pre-arrival fields plus the live
 * in-house data the prototype kept in room.stay.
 */
const reservationSchema = new mongoose.Schema({
  ref: { type: String, required: true, unique: true, trim: true },   // e.g. SSR-2026-0720

  guest:   { type: String, required: [true, 'Guest name is required.'], trim: true },
  contact: { type: String, trim: true },
  source:  { type: String, default: 'Front Desk', trim: true },      // Booking.com, Agoda, Walk-in…

  room:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  roomType: { type: String, enum: ['Standard', 'Family'], required: true },

  checkIn:  { type: Date, required: [true, 'Check-in date is required.'] },
  checkOut: { type: Date, required: [true, 'Check-out date is required.'] },
  adults:   { type: Number, default: 1, min: [1, 'At least one adult is required.'] },
  kids:     { type: Number, default: 0, min: 0 },

  total:   { type: Number, required: true, min: [0, 'Total cannot be negative.'] },
  paid:    { type: Number, default: 0, min: [0, 'Paid amount cannot be negative.'] },
  deposit: { type: Number, default: DEPOSIT, min: 0 },
  folio:   [folioLineSchema],

  status: { type: String, enum: { values: BOOKING_STATUSES, message: '{VALUE} is not a valid booking status.' },
            default: 'Confirmed', index: true },

  // Checkout-inspection state (business rule: no checkout before inspection)
  inspectionState: { type: String, enum: ['none', 'pending', 'done'], default: 'none' },
  checkedInAt:  Date,
  checkedOutAt: Date,
  imported: { type: Boolean, default: true }   // false = still in the online-booking import queue
}, { timestamps: true });

reservationSchema.virtual('balance').get(function () { return this.total - this.paid; });

reservationSchema.path('checkOut').validate(function (v) {
  return !this.checkIn || !v || v > this.checkIn;
}, 'Check-out must be after check-in.');

reservationSchema.index({ status: 1, checkIn: 1 });
reservationSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });

module.exports = mongoose.model('Reservation', reservationSchema);
