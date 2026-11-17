'use strict';
const { Schema, model } = require('mongoose');
const { ROLES, ROLE_LABELS } = require('../config/business');
const { cleanJSON } = require('./common');

const UserSchema = new Schema({
  staffId: { type: String, required: true, unique: true, trim: true, match: [/^\d{4}$/, 'Staff ID must be 4 digits.'] },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  role: { type: String, required: true, enum: ROLES },
  active: { type: Boolean, default: true },
  // bcrypt hash only — never the password. Excluded from queries by default.
  passwordHash: { type: String, required: true, select: false },
  failedLogins: { type: Number, default: 0, select: false },
  lockedUntil: { type: Date, default: null, select: false },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true });

UserSchema.index({ role: 1, active: 1 });
UserSchema.virtual('label').get(function () { return ROLE_LABELS[this.role]; });
UserSchema.virtual('initials').get(function () {
  return String(this.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
});
cleanJSON(UserSchema, ['passwordHash', 'failedLogins', 'lockedUntil']);

module.exports = model('User', UserSchema);
