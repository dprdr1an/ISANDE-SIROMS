'use strict';
const { Schema, model } = require('mongoose');
const { INVENTORY_CATEGORIES, INVENTORY_MOVEMENTS } = require('../config/business');
const { cleanJSON, actorFields } = require('./common');

const int = (extra = {}) => ({ type: Number, validate: { validator: Number.isInteger, message: 'Must be a whole number.' }, ...extra });

const InventoryItemSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  nameKey: { type: String, required: true, unique: true },          // lower-case, for case-insensitive uniqueness
  category: { type: String, required: true, enum: INVENTORY_CATEGORIES },
  stock: int({ required: true, min: 0, max: 100000 }),
  reorderLevel: int({ required: true, min: 0, max: 100000 }),
  lastUpdatedAt: { type: Date, default: Date.now },
  lastUpdatedBy: actorFields.by,
  lastUpdatedByName: { type: String, default: '' }
}, { timestamps: true });
InventoryItemSchema.pre('validate', function (next) { if (this.name) this.nameKey = this.name.trim().toLowerCase(); next(); });
cleanJSON(InventoryItemSchema, ['nameKey']);

const InventoryLogSchema = new Schema({
  item: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true },
  movement: { type: String, required: true, enum: [...INVENTORY_MOVEMENTS, 'Item added'] },
  qty: int({ required: true, min: 0 }),
  stockBefore: int({ min: 0 }),
  stockAfter: int({ min: 0 }),
  reason: { type: String, required: true, trim: true, maxlength: 300 },
  restockRequest: { type: Schema.Types.ObjectId, ref: 'RestockRequest', default: null },
  at: { type: Date, default: Date.now },
  ...actorFields
}, { timestamps: true });
InventoryLogSchema.index({ at: -1 });
InventoryLogSchema.index({ item: 1, at: -1 });
cleanJSON(InventoryLogSchema);

const RestockRequestSchema = new Schema({
  item: { type: Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true },
  note: { type: String, trim: true, maxlength: 300, default: '' },
  status: { type: String, enum: ['Open', 'Handled'], default: 'Open' },
  requestedAt: { type: Date, default: Date.now },
  ...actorFields,
  handledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  handledByName: { type: String, default: '' },
  handledAt: Date,
  inventoryLog: { type: Schema.Types.ObjectId, ref: 'InventoryLog', default: null }
}, { timestamps: true });
RestockRequestSchema.index({ status: 1, requestedAt: -1 });
cleanJSON(RestockRequestSchema);

module.exports = {
  InventoryItem: model('InventoryItem', InventoryItemSchema),
  InventoryLog: model('InventoryLog', InventoryLogSchema),
  RestockRequest: model('RestockRequest', RestockRequestSchema)
};
