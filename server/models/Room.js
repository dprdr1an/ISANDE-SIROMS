'use strict';
const mongoose = require('mongoose');
const { ROOM_STATUSES } = require('./constants');

/**
 * THE authoritative room record (brief §5, §16). No other collection stores a
 * room's status. Pages read this document; they never compute their own.
 */
const roomSchema = new mongoose.Schema({
  number:   { type: String, required: [true, 'Room number is required.'], unique: true, trim: true },
  floor:    { type: Number, required: [true, 'Floor is required.'], min: 1 },
  type:     { type: String, required: true, enum: ['Standard', 'Family'] },
  capacity: { type: Number, required: true, min: 1 },
  beds:     { type: String, trim: true },
  rate:     { type: Number, required: true, min: 0 },

  status: { type: String, enum: { values: ROOM_STATUSES, message: '{VALUE} is not a valid room status.' },
            default: 'available', index: true },

  // The single link between a room and its live stay. Replaces the prototype's
  // duplicated room.stay + reservations[] pair (audit §7.2).
  currentReservation: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', default: null },

  housekeeping: {
    state:      { type: String, enum: ['clean', 'dirty', 'in-progress', 'awaiting-inspection'], default: 'clean' },
    lastCleaned: Date,
    lastCleanedBy: String
  },
  maintenance: {
    state:    { type: String, enum: ['ok', 'reported', 'under-repair'], default: 'ok' },
    openTickets: { type: Number, default: 0, min: 0 }
  },
  notes: String
}, { timestamps: true });

roomSchema.index({ floor: 1, number: 1 });
roomSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });

module.exports = mongoose.model('Room', roomSchema);
