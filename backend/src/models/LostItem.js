'use strict';
const { Schema, model } = require('mongoose');
const { LOST_CATEGORIES, LOST_CONDITIONS, LOST_STATUSES, STORAGE_LOCATION } = require('../config/business');
const { cleanJSON, StatusEntry, actorFields } = require('./common');

const LostItemSchema = new Schema({
  itemNo: { type: String, required: true, unique: true },            // LF-1001
  clientRequestId: { type: String, unique: true, sparse: true },
  item: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  category: { type: String, required: true, enum: LOST_CATEGORIES },
  location: { type: String, required: true, trim: true, maxlength: 120 },   // where it was found
  condition: { type: String, required: true, enum: LOST_CONDITIONS },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  foundAt: { type: Date, required: true },
  storageLocation: { type: String, default: STORAGE_LOCATION },
  status: { type: String, enum: LOST_STATUSES, default: 'Stored' },
  reportedBy: actorFields.by,
  reportedByName: { type: String, default: '' },
  claim: {
    claimantName: { type: String, trim: true, maxlength: 80, default: '' },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    at: Date,
    ...actorFields
  },
  release: {
    releasedTo: { type: String, trim: true, maxlength: 80, default: '' },
    ownershipVerified: { type: Boolean, default: false },
    at: Date,
    ...actorFields
  },
  statusHistory: { type: [StatusEntry], default: [] }
  // Photographs: the prototype has no upload/storage support yet; see README.
}, { timestamps: true });

LostItemSchema.index({ status: 1, foundAt: -1 });
cleanJSON(LostItemSchema, ['clientRequestId']);

module.exports = model('LostItem', LostItemSchema);
