'use strict';
const { Schema, model } = require('mongoose');
const { TICKET_CATEGORIES, TICKET_STATUSES, TICKET_PRIORITIES, TICKET_IMPACTS } = require('../config/business');
const { cleanJSON, AuditEntry, actorFields } = require('./common');

/**
 * Work order. stage drives visibility:
 *   assessment → only the reporting housekeeper, supervisor and manager see it
 *   assigned   → forwarded to maintenance
 *   resolved   → closed
 */
const MaintenanceTicketSchema = new Schema({
  ticketNo: { type: String, required: true, unique: true },          // WO-1001
  clientRequestId: { type: String, unique: true, sparse: true },
  room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: { type: String, required: true },
  category: { type: String, required: true, enum: TICKET_CATEGORIES },
  issue: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 1000, default: '' },
  priority: { type: String, enum: [...TICKET_PRIORITIES, null], default: null },
  impact: { type: String, enum: [...TICKET_IMPACTS, null], default: null },
  status: { type: String, enum: TICKET_STATUSES, default: 'Awaiting assessment' },
  stage: { type: String, enum: ['assessment', 'assigned', 'resolved'], default: 'assessment' },
  eta: { type: Date, default: null },
  parts: { type: String, trim: true, maxlength: 200, default: '' },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  assignedToName: { type: String, default: '' },
  reportedBy: actorFields.by,
  reportedByName: { type: String, default: '' },
  reportedAt: { type: Date, default: Date.now },
  assessedBy: actorFields.by,
  assessedAt: Date,
  resolvedAt: Date,
  history: { type: [AuditEntry], default: [] }
}, { timestamps: true });

MaintenanceTicketSchema.index({ stage: 1, priority: 1 });
MaintenanceTicketSchema.index({ room: 1, stage: 1 });
cleanJSON(MaintenanceTicketSchema, ['clientRequestId']);

module.exports = model('MaintenanceTicket', MaintenanceTicketSchema);
