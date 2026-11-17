'use strict';
const { Schema, model } = require('mongoose');
const { INCIDENT_CATEGORIES, INCIDENT_STATUSES } = require('../config/business');
const { cleanJSON, StatusEntry, money, actorFields } = require('./common');

/** Damage / missing item / other incident raised during a checkout inspection. */
const IncidentSchema = new Schema({
  incidentId: { type: String, required: true, unique: true },     // INC-1043
  idempotencyKey: { type: String, unique: true, sparse: true },   // inspection:<id>:<n>
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  inspection: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null },
  bookingRef: { type: String, required: true },
  roomNumber: { type: String, required: true },
  guestName: { type: String, required: true },
  category: { type: String, required: true, enum: INCIDENT_CATEGORIES },
  item: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 1000, default: '' },
  qty: { type: Number, required: true, min: 1, max: 999, validate: Number.isInteger },
  // For Missing Item this is the cost per item; otherwise the estimated cost.
  unitCost: money({ required: true, min: 0, max: 1000000 }),
  photos: { type: Number, default: 0, min: 0, max: 20 },          // placeholder count (prototype)
  remarks: { type: String, trim: true, maxlength: 1000, default: '' },
  status: { type: String, enum: INCIDENT_STATUSES, default: 'Pending' },
  reportedAt: { type: Date, default: Date.now },
  reportedBy: actorFields.by,
  reportedByName: { type: String, default: '' },
  statusHistory: { type: [StatusEntry], default: [] }
}, { timestamps: true });

IncidentSchema.index({ reservation: 1 });
IncidentSchema.index({ status: 1, category: 1 });
IncidentSchema.virtual('cost').get(function () { return this.unitCost * (this.category === 'Missing Item' ? this.qty : 1); });
cleanJSON(IncidentSchema, ['idempotencyKey']);

module.exports = model('Incident', IncidentSchema);
