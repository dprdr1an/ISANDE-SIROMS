'use strict';
const { Schema, model } = require('mongoose');
const { REQUEST_STATUSES } = require('../config/business');
const { cleanJSON, StatusEntry, money, actorFields } = require('./common');

const GuestRequestSchema = new Schema({
  requestNo: { type: String, required: true, unique: true },          // GR-1001
  clientRequestId: { type: String, unique: true, sparse: true },
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  guestName: { type: String, required: true },
  items: {
    type: [{
      name: { type: String, required: true, trim: true, maxlength: 80 },
      qty: { type: Number, required: true, min: 1, max: 50 },
      unitPrice: money({ min: 0, max: 50000 }),
      _id: false
    }],
    validate: { validator: v => v.length > 0 && v.length <= 20, message: 'A request needs 1–20 items.' }
  },
  notes: { type: String, trim: true, maxlength: 500, default: '' },
  charge: money({ min: 0 }),
  status: { type: String, enum: REQUEST_STATUSES, default: 'Pending' },
  createdBy: actorFields.by,
  createdByName: { type: String, default: '' },
  statusHistory: { type: [StatusEntry], default: [] }
}, { timestamps: true });

GuestRequestSchema.index({ status: 1, createdAt: -1 });
cleanJSON(GuestRequestSchema, ['clientRequestId']);

module.exports = model('GuestRequest', GuestRequestSchema);
