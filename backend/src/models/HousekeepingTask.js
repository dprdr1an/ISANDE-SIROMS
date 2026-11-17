'use strict';
const { Schema, model } = require('mongoose');
const { TASK_FLOW, TASK_TYPES, TASK_PRIORITIES } = require('../config/business');
const { cleanJSON, actorFields } = require('./common');

/** One supervisor cleaning inspection (approval or return for recleaning). */
const CleaningInspection = new Schema({
  result: { type: String, enum: ['Approved', 'Returned for recleaning', 'No issues found', 'Issues found'], required: true },
  at: { type: Date, default: Date.now },
  ...actorFields,
  note: { type: String, trim: true, maxlength: 500, default: '' },
  checklist: { type: [{ item: String, passed: Boolean, _id: false }], default: [] },
  reworked: { type: Boolean, default: false }
}, { _id: false });

const HousekeepingTaskSchema = new Schema({
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },
  kind: { type: String, enum: ['cleaning', 'inspection'], default: 'cleaning' },
  type: { type: String, required: true, enum: TASK_TYPES },
  priority: { type: String, enum: TASK_PRIORITIES, default: 'Normal' },
  note: { type: String, trim: true, maxlength: 500, default: '' },
  status: { type: String, enum: TASK_FLOW, default: 'Assigned' },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },   // null = Unassigned
  assignedToName: { type: String, default: '' },
  assignedBy: actorFields.by,
  assignedAt: { type: Date, default: Date.now },
  startedAt: Date,
  submittedAt: Date,
  completedAt: Date,
  reworked: { type: Boolean, default: false },
  lastInspection: { type: CleaningInspection, default: null },
  inspections: { type: [CleaningInspection], default: [] },          // full approval history
  reservation: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  inspection: { type: Schema.Types.ObjectId, ref: 'Inspection', default: null },
  bookingRef: { type: String, default: '' },
  // Set to "<room>:<kind>" while the task is open and removed on completion.
  // A unique sparse index on it allows only ONE open task per room and kind,
  // which also makes auto-created tasks safe against retries.
  openKey: { type: String, unique: true, sparse: true }
}, { timestamps: true });

HousekeepingTaskSchema.index({ status: 1, assignedTo: 1 });
HousekeepingTaskSchema.index({ room: 1, status: 1 });
cleanJSON(HousekeepingTaskSchema);

module.exports = model('HousekeepingTask', HousekeepingTaskSchema);
