'use strict';
const { Schema, model } = require('mongoose');
const { cleanJSON, money, actorFields } = require('./common');

/** Checkout room inspection (one per reservation). */
const InspectionSchema = new Schema({
  // Unique: a stay can only have one checkout inspection, so a retried
  // "start checkout" cannot open a second one.
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', required: true, unique: true },
  bookingRef: { type: String, required: true },
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },
  status: { type: String, enum: ['Pending', 'Completed'], default: 'Pending' },
  requestedAt: { type: Date, default: Date.now },
  requestedBy: actorFields.by,
  requestedByName: { type: String, default: '' },
  inspectedAt: Date,
  inspectedBy: actorFields.by,
  inspectedByName: { type: String, default: '' },
  checklist: { type: [{ item: String, passed: Boolean, _id: false }], default: [] },
  incidents: [{ type: Schema.Types.ObjectId, ref: 'Incident' }],
  remarks: { type: String, trim: true, maxlength: 1000, default: '' },
  // Snapshot at submission time; checkout re-computes from live incidents
  // (a charge may be waived between inspection and checkout).
  settlement: {
    deposit: money(), damages: money(), applied: money(), refund: money(), extra: money()
  }
}, { timestamps: true });

InspectionSchema.index({ status: 1, room: 1 });
cleanJSON(InspectionSchema);

module.exports = model('Inspection', InspectionSchema);
