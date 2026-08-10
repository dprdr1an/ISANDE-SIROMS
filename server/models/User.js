'use strict';
const mongoose = require('mongoose');
const { ROLES } = require('./constants');

const attendanceSchema = new mongoose.Schema({
  date:  { type: String, required: true },      // YYYY-MM-DD
  timeIn:  String,
  timeOut: String,
  status: { type: String, enum: ['On shift', 'Break', 'Off shift'], default: 'On shift' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  staffId: { type: String, required: [true, 'Staff ID is required.'], unique: true, trim: true },
  pin:     { type: String, required: [true, 'PIN is required.'], match: [/^\d{4}$/, 'PIN must be 4 digits.'], select: false },
  name:    { type: String, required: [true, 'Name is required.'], trim: true },
  role:    { type: String, required: true, enum: { values: ROLES, message: '{VALUE} is not a valid role.' } },
  title:   { type: String, trim: true },
  status:  { type: String, enum: ['active', 'inactive'], default: 'active' },
  contact: { type: String, trim: true },
  shift:   { type: String, trim: true },
  attendance: [attendanceSchema]
}, { timestamps: true });

userSchema.index({ role: 1, status: 1 });

// Never leak the PIN, even if a query forgets to deselect it.
userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => { delete ret.pin; delete ret.__v; return ret; }
});

module.exports = mongoose.model('User', userSchema);
