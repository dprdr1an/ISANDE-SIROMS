'use strict';
const { Schema, model } = require('mongoose');
const { ROLES, BOOKING_SOURCES, ROOM_TYPES } = require('../config/business');
const { cleanJSON, money, YMD } = require('./common');

/** In-app notification, addressed to roles; read state is per user. */
const NotificationSchema = new Schema({
  title: { type: String, required: true, maxlength: 120 },
  text: { type: String, required: true, maxlength: 500 },
  roles: { type: [{ type: String, enum: ROLES }], required: true },
  readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
NotificationSchema.index({ roles: 1, createdAt: -1 });
cleanJSON(NotificationSchema, ['readBy']);

/** Staff shift record (time in / time out). */
const AttendanceSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  roleLabel: { type: String, required: true },
  timeIn: { type: Date, required: true },
  timeOut: { type: Date, default: null }
}, { timestamps: true });
AttendanceSchema.index({ user: 1, timeIn: -1 });
cleanJSON(AttendanceSchema);

/** Bookings received from connected sites, waiting to be imported. */
const OnlineBookingSchema = new Schema({
  externalId: { type: String, required: true, unique: true },
  guest: { type: String, required: true },
  contact: { type: String, default: '' },
  source: { type: String, required: true, enum: BOOKING_SOURCES },
  checkIn: { type: String, required: true, match: YMD },
  checkOut: { type: String, required: true, match: YMD },
  roomType: { type: String, required: true, enum: Object.keys(ROOM_TYPES) },
  adults: { type: Number, required: true, min: 1 },
  kids: { type: Number, default: 0, min: 0 },
  total: money({ required: true, min: 0 }),
  prepaid: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending', 'Imported'], default: 'Pending' },
  importedAs: { type: Schema.Types.ObjectId, ref: 'Reservation', default: null },
  importedAt: Date
}, { timestamps: true });
cleanJSON(OnlineBookingSchema);

/** Monotonic counters for human-readable references (SSR-2026-0725, INC-1043…). */
const CounterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

module.exports = {
  Notification: model('Notification', NotificationSchema),
  Attendance: model('Attendance', AttendanceSchema),
  OnlineBooking: model('OnlineBooking', OnlineBookingSchema),
  Counter: model('Counter', CounterSchema)
};
