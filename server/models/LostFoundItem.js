'use strict';
const mongoose = require('mongoose');
const { LOSTFOUND_STATUSES } = require('./constants');

const lostFoundSchema = new mongoose.Schema({
  code:     { type: String, required: true, unique: true },      // LF-2031
  item:     { type: String, required: [true, 'Item name is required.'], trim: true },
  category: { type: String, required: [true, 'Category is required.'], trim: true },
  location: { type: String, required: [true, 'Where it was found is required.'], trim: true },
  room:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  condition:   { type: String, default: 'Good' },
  description: { type: String, default: '' },
  photo:       { type: String, default: '' },                    // placeholder path
  storage:     { type: String, default: 'Front desk safe' },

  reportedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reportedByName: { type: String, default: '' },
  foundAt:        { type: Date, default: Date.now },

  status: { type: String, enum: { values: LOSTFOUND_STATUSES, message: '{VALUE} is not a valid status.' },
            default: 'Stored', index: true },

  claimant:        { type: String, default: '' },
  claimantContact: { type: String, default: '' },
  claimNotes:      { type: String, default: '' },
  verifiedByName:  { type: String, default: '' },
  releasedByName:  { type: String, default: '' },
  releasedAt:      Date,
  history: [{ when: { type: Date, default: Date.now }, who: String, what: String, _id: false }]
}, { timestamps: true });

// Releasing requires a named claimant — preserves the verification rule.
lostFoundSchema.path('status').validate(function (v) {
  return v !== 'Released' || !!(this.claimant && this.claimant.trim());
}, 'An item cannot be released without a claimant name.');

lostFoundSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('LostFoundItem', lostFoundSchema);
