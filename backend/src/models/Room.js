'use strict';
const { Schema, model } = require('mongoose');
const { ROOM_TYPES, ROOM_STATUSES } = require('../config/business');
const { cleanJSON, AuditEntry } = require('./common');

/**
 * Room status (physical readiness) is deliberately separate from reservation
 * status (guest lifecycle). `currentReservation` links an occupied room to
 * the stay in it; the stay's own status lives on the Reservation.
 */
const RoomSchema = new Schema({
  number: { type: String, required: true, unique: true, trim: true, match: [/^\d{3}$/, 'Room number must be 3 digits.'] },
  floor: { type: String, required: true, match: /^\d$/ },
  type: { type: String, required: true, enum: Object.keys(ROOM_TYPES) },
  status: { type: String, required: true, enum: ROOM_STATUSES, default: 'cleaning' },
  currentReservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  statusHistory: { type: [AuditEntry], default: [] }
}, { timestamps: true });

RoomSchema.index({ status: 1, floor: 1 });
RoomSchema.virtual('rate').get(function () { return ROOM_TYPES[this.type]?.rate; });
RoomSchema.virtual('beds').get(function () { return ROOM_TYPES[this.type]?.beds; });
RoomSchema.virtual('capacity').get(function () { return ROOM_TYPES[this.type]?.cap; });
RoomSchema.pre('validate', function (next) { if (this.number) this.floor = this.number[0]; next(); });
cleanJSON(RoomSchema, ['statusHistory']);

module.exports = model('Room', RoomSchema);
