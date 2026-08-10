'use strict';
const mongoose = require('mongoose');
const { REQUEST_STATUSES } = require('./constants');

const requestItemSchema = new mongoose.Schema({
  name:  { type: String, required: [true, 'Item name is required.'], trim: true },
  qty:   { type: Number, required: true, min: [1, 'Quantity must be at least 1.'], default: 1 },
  price: { type: Number, default: 0, min: 0 }
}, { _id: false });

/**
 * ONE request document, shared by every role (brief §4, §8, §16).
 * Front desk creates it → supervisor assigns a housekeeper → that housekeeper
 * advances it → front desk/manager read the same document.
 *
 * NOTE: assignedTo/assignedBy/assignedAt did not exist in the prototype — the
 * supervisor assignment step is new (see DEPENDENCY-MAP §6).
 */
const guestRequestSchema = new mongoose.Schema({
  room:  { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: [true, 'Room is required.'] },
  roomNumber: { type: String, required: true, trim: true },   // denormalised for fast display
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', default: null },
  guest: { type: String, required: [true, 'Guest name is required.'], trim: true },

  items: {
    type: [requestItemSchema],
    validate: [(v) => Array.isArray(v) && v.length > 0, 'At least one item is required.']
  },
  notes: { type: String, trim: true, default: '' },

  status: { type: String, enum: { values: REQUEST_STATUSES, message: '{VALUE} is not a valid request status.' },
            default: 'Pending', index: true },

  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,

  assignedTo:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  assignedToName: { type: String, default: '' },
  assignedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedByName: { type: String, default: '' },
  assignedAt:     Date,

  deliveredAt: Date,
  deliveredByName: String,
  charge: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

guestRequestSchema.virtual('totalCharge').get(function () {
  return (this.items || []).reduce((sum, i) => sum + i.price * i.qty, 0);
});

// A request may only leave Pending once somebody owns it. Path validator so it
// applies to validateSync() and to updates run with runValidators.
guestRequestSchema.path('status').validate(function (v) {
  return !['Assigned', 'In delivery'].includes(v) || !!this.assignedTo;
}, 'A request cannot be "{VALUE}" without an assigned housekeeper.');

guestRequestSchema.index({ status: 1, createdAt: -1 });
guestRequestSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });

module.exports = mongoose.model('GuestRequest', guestRequestSchema);
