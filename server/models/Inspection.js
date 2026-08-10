'use strict';
const mongoose = require('mongoose');
const { INSPECTION_STATUSES, INCIDENT_CATEGORIES, INCIDENT_STATUSES } = require('./constants');

/** A damage / missing item / incident found during a checkout inspection.
 *  Stored ONCE here; the Incident Reports page projects these (audit §7.3). */
const findingSchema = new mongoose.Schema({
  code:        { type: String, required: true },               // INC-1042
  category:    { type: String, enum: INCIDENT_CATEGORIES, required: true },
  item:        { type: String, required: [true, 'Item or facility is required.'], trim: true },
  description: { type: String, default: '' },
  qty:         { type: Number, default: 1, min: [1, 'Quantity must be at least 1.'] },
  cost:        { type: Number, default: 0, min: [0, 'Cost cannot be negative.'] },
  photos:      { type: Number, default: 0, min: 0 },           // placeholder count
  remarks:     { type: String, default: '' },
  status:      { type: String, enum: INCIDENT_STATUSES, default: 'Pending' }
});

// Missing items scale by quantity; damages are a flat repair cost.
findingSchema.virtual('totalCost').get(function () {
  return this.category === 'Missing Item' ? this.cost * this.qty : this.cost;
});
findingSchema.set('toJSON', { virtuals: true });

const inspectionSchema = new mongoose.Schema({
  room:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },
  reservation:{ type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', required: true },
  bookingRef: { type: String, required: true },
  guest:      { type: String, required: true },

  inspector:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  inspectorName: { type: String, default: '' },

  checklist: [{ label: String, checked: { type: Boolean, default: true }, _id: false }],
  findings:  [findingSchema],
  remarks:   { type: String, default: '' },

  status: { type: String, enum: INSPECTION_STATUSES, default: 'Pending', index: true },

  deposit:   { type: Number, default: 0, min: 0 },
  damages:   { type: Number, default: 0, min: 0 },
  applied:   { type: Number, default: 0, min: 0 },   // taken from the deposit
  refund:    { type: Number, default: 0, min: 0 },   // returned to guest
  extraDue:  { type: Number, default: 0, min: 0 },   // still owed by guest

  startedAt:   { type: Date, default: Date.now },
  completedAt: Date
}, { timestamps: true });

/** Deposit settlement maths — the rule the whole checkout gate depends on. */
inspectionSchema.methods.settle = function () {
  const damages = (this.findings || []).reduce(
    (s, f) => s + (f.category === 'Missing Item' ? f.cost * f.qty : f.cost), 0);
  this.damages  = damages;
  this.applied  = Math.min(this.deposit, damages);
  this.refund   = Math.max(0, this.deposit - damages);
  this.extraDue = Math.max(0, damages - this.deposit);
  return { deposit: this.deposit, damages, applied: this.applied, refund: this.refund, extra: this.extraDue };
};

inspectionSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('Inspection', inspectionSchema);
