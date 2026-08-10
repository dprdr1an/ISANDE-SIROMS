'use strict';
const mongoose = require('mongoose');

/** Housekeeper asks, supervisor/manager fulfils (brief §11). */
const restockRequestSchema = new mongoose.Schema({
  item:     { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true },
  qty:      { type: Number, default: 1, min: [1, 'Quantity must be at least 1.'] },
  note:     { type: String, default: '' },
  status:   { type: String, enum: ['Pending', 'Fulfilled', 'Declined'], default: 'Pending', index: true },
  requestedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  requestedByName: { type: String, default: '' },
  handledByName:   { type: String, default: '' },
  handledAt: Date
}, { timestamps: true });

restockRequestSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('RestockRequest', restockRequestSchema);
