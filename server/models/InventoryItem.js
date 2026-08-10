'use strict';
const mongoose = require('mongoose');

/** Stock movement history lives with the item (brief §11). */
const movementSchema = new mongoose.Schema({
  when:   { type: Date, default: Date.now },
  change: { type: Number, required: true },        // +received / -issued
  reason: { type: String, default: '' },
  before: { type: Number, required: true },
  after:  { type: Number, required: true },
  byName: { type: String, default: '' },
  by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: false });

const inventoryItemSchema = new mongoose.Schema({
  item:     { type: String, required: [true, 'Item name is required.'], unique: true, trim: true },
  category: { type: String, required: [true, 'Category is required.'], trim: true },
  unit:     { type: String, default: 'pc' },
  stock:    { type: Number, required: true, min: [0, 'Stock cannot be negative.'], default: 0 },
  reorder:  { type: Number, required: true, min: [0, 'Reorder level cannot be negative.'], default: 0 },
  lastUpdated: { type: Date, default: Date.now },
  lastByName:  { type: String, default: '' },
  movements: [movementSchema]
}, { timestamps: true });

inventoryItemSchema.virtual('low').get(function () { return this.stock <= this.reorder; });

/** Apply a delta and record the movement atomically on the document. */
inventoryItemSchema.methods.applyMovement = function (change, reason, user) {
  const before = this.stock;
  const after = before + change;
  if (after < 0) throw new Error(`Cannot issue ${Math.abs(change)} — only ${before} in stock.`);
  this.stock = after;
  this.lastUpdated = new Date();
  this.lastByName = user?.name || '';
  this.movements.unshift({ change, reason, before, after, byName: user?.name || '', by: user?._id || null });
  return this;
};

inventoryItemSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('InventoryItem', inventoryItemSchema);
