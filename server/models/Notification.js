'use strict';
const mongoose = require('mongoose');
const { ROLES } = require('./constants');

/** Generated from real events only — never hardcoded counts (brief §13). */
const notificationSchema = new mongoose.Schema({
  roles: { type: [{ type: String, enum: ROLES }], default: [], index: true },
  user:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // optional direct target
  title:   { type: String, required: [true, 'Title is required.'], trim: true },
  message: { type: String, required: [true, 'Message is required.'], trim: true },
  entityType: { type: String, default: '' },      // 'GuestRequest', 'Room', …
  entityId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  when: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

notificationSchema.set('toJSON', { virtuals: true, transform: (d, r) => { delete r.__v; return r; } });
module.exports = mongoose.model('Notification', notificationSchema);
