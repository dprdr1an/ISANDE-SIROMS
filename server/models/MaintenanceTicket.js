'use strict';
const mongoose = require('mongoose');
const { TICKET_STAGES, TICKET_STATUSES, PRIORITIES } = require('./constants');

const historySchema = new mongoose.Schema({
  when: { type: Date, default: Date.now },
  who:  { type: String, required: true },
  what: { type: String, required: true }
}, { _id: false });

const maintenanceTicketSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true },   // MT-1004
  room:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },

  category: { type: String, required: [true, 'Category is required.'], trim: true },
  issue:    { type: String, required: [true, 'Issue description is required.'], trim: true },

  priority: { type: String, enum: { values: [...PRIORITIES, null] }, default: null },
  impact:   { type: String, default: null },

  stage:  { type: String, enum: TICKET_STAGES, default: 'assessment', index: true },
  status: { type: String, enum: { values: TICKET_STATUSES, message: '{VALUE} is not a valid ticket status.' },
            default: 'Awaiting assessment', index: true },

  assignedTo:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  assignedToName: { type: String, default: '' },
  reportedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reportedByName: { type: String, default: '' },

  eta:   Date,
  parts: { type: String, default: '' },
  repairNotes: { type: String, default: '' },
  history: [historySchema],

  reportedAt: { type: Date, default: Date.now },
  resolvedAt: Date
}, { timestamps: true });

// A ticket cannot be forwarded to a technician without an assessment.
// Declared as a path validator (not a pre-hook) so it also applies to
// validateSync() and to findOneAndUpdate with runValidators.
maintenanceTicketSchema.path('stage').validate(function (v) {
  return v !== 'assigned' || !!this.priority;
}, 'A ticket must be assessed (priority set) before it is assigned to a technician.');

maintenanceTicketSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('MaintenanceTicket', maintenanceTicketSchema);
