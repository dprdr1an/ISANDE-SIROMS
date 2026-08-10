'use strict';
const mongoose = require('mongoose');
const { TASK_FLOW, TASK_TYPES, TASK_KINDS, TASK_PRIORITIES } = require('./constants');

const checklistItemSchema = new mongoose.Schema({
  label:   { type: String, required: true },
  checked: { type: Boolean, default: false }
}, { _id: false });

const housekeepingTaskSchema = new mongoose.Schema({
  room:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true, trim: true },

  type: { type: String, enum: TASK_TYPES, default: 'Checkout cleaning' },
  kind: { type: String, enum: TASK_KINDS, default: 'cleaning', index: true },
  priority: { type: String, enum: TASK_PRIORITIES, default: 'Medium' },
  note: { type: String, default: '' },

  assignedTo:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  assignedToName: { type: String, default: 'Unassigned' },
  supervisor:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  supervisorName: { type: String, default: '' },

  status: { type: String, enum: { values: TASK_FLOW, message: '{VALUE} is not a valid task status.' },
            default: 'Assigned', index: true },

  checklist: [checklistItemSchema],
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation', default: null },

  assignedAt:  { type: Date, default: Date.now },
  startedAt:   Date,
  submittedAt: Date,
  completedAt: Date,
  inspectionResult: { type: String, enum: ['Approved', 'Returned for recleaning', null], default: null },
  inspectionNote: String
}, { timestamps: true });

housekeepingTaskSchema.index({ status: 1, assignedTo: 1 });
housekeepingTaskSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });

module.exports = mongoose.model('HousekeepingTask', housekeepingTaskSchema);
