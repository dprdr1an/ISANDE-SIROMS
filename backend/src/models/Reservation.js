'use strict';
const { Schema, model } = require('mongoose');
const { BOOKING_STATUSES, BOOKING_SOURCES, ROOM_TYPES, CURRENCY } = require('../config/business');
const { cleanJSON, StatusEntry, money, YMD, actorFields } = require('./common');

/** One folio line: room charge, guest-request charge, etc. */
const ChargeSchema = new Schema({
  description: { type: String, required: true, trim: true, maxlength: 200 },
  amount: money({ required: true, min: 0 }),
  kind: { type: String, enum: ['room', 'request', 'other'], default: 'other' },
  guestRequest: { type: Schema.Types.ObjectId, ref: 'GuestRequest', default: null },
  at: { type: Date, default: Date.now }
}, { _id: false });

const ReservationSchema = new Schema({
  ref: { type: String, required: true, unique: true, trim: true },
  externalRef: { type: String, trim: true, default: '' },       // e.g. Booking.com id
  // Client-generated key for "create" requests, so a retried submit cannot
  // create a second reservation. Sparse: absent for imported/seeded records.
  clientRequestId: { type: String, unique: true, sparse: true },
  guest: {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    contact: { type: String, trim: true, maxlength: 40, default: '' }
  },
  source: { type: String, required: true, enum: BOOKING_SOURCES },
  checkIn: { type: String, required: true, match: YMD },
  checkOut: { type: String, required: true, match: YMD },
  roomType: { type: String, required: true, enum: Object.keys(ROOM_TYPES) },
  room: { type: Schema.Types.ObjectId, ref: 'Room', default: null },
  roomNumber: { type: String, default: '' },                     // denormalised for display/history
  adults: { type: Number, required: true, min: 1, max: 10 },
  kids: { type: Number, default: 0, min: 0, max: 10 },
  currency: { type: String, default: CURRENCY, enum: [CURRENCY] },
  charges: { type: [ChargeSchema], default: [] },                // the folio
  amountPaid: money({ min: 0 }),
  deposit: {
    amount: money({ min: 0 }),
    status: { type: String, enum: ['none', 'held', 'refunded', 'applied', 'forfeited'], default: 'none' }
  },
  status: { type: String, required: true, enum: BOOKING_STATUSES },
  inspection: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null },
  checkoutNote: { type: String, trim: true, maxlength: 500, default: '' },
  checkedInAt: Date,
  checkedOutAt: Date,
  createdBy: actorFields.by,
  statusHistory: { type: [StatusEntry], default: [] }
}, { timestamps: true });

ReservationSchema.index({ status: 1, checkIn: 1 });
ReservationSchema.index({ room: 1, status: 1 });
ReservationSchema.index({ 'guest.name': 1 });
ReservationSchema.virtual('total').get(function () { return (this.charges || []).reduce((a, c) => a + c.amount, 0); });
ReservationSchema.virtual('balance').get(function () { return this.total - (this.amountPaid || 0); });
ReservationSchema.pre('validate', function (next) {
  if (this.checkIn && this.checkOut && this.checkOut <= this.checkIn) this.invalidate('checkOut', 'Check-out must be after check-in.');
  next();
});
cleanJSON(ReservationSchema, ['clientRequestId']);

module.exports = model('Reservation', ReservationSchema);
