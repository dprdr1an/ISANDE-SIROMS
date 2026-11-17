'use strict';
/** Authentication, attendance and notifications. */
const bcrypt = require('bcryptjs');
const { User, Attendance, Notification } = require('../models');
const { ROLE_LABELS } = require('../config/business');
const { unauthorized, notFound, conflict } = require('../utils/errors');

const MAX_FAILS = 5, LOCK_MINUTES = 15;
// A real hash of a random string: comparing against it when the staff ID is
// unknown keeps response times similar, so IDs can't be enumerated by timing.
const DUMMY_HASH = bcrypt.hashSync(require('crypto').randomBytes(18).toString('hex'), require('../config/env').env.BCRYPT_ROUNDS);

async function authenticate(staffId, password) {
  const user = await User.findOne({ staffId }).select('+passwordHash +failedLogins +lockedUntil');
  const generic = unauthorized('Staff ID or password is incorrect.', 'INVALID_CREDENTIALS');
  if (!user) { await bcrypt.compare(password, DUMMY_HASH); throw generic; }
  if (!user.active) { await bcrypt.compare(password, DUMMY_HASH); throw generic; }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw unauthorized(`Too many failed attempts. Try again in ${Math.ceil((user.lockedUntil - Date.now()) / 60000)} minute(s).`, 'LOCKED');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const fails = (user.failedLogins || 0) + 1;
    await User.updateOne({ _id: user._id }, fails >= MAX_FAILS ? { $set: { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60e3) } } : { $set: { failedLogins: fails } });
    throw generic;
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return User.findById(user._id);
}

/* ---------------- Attendance ---------------- */
const openShift = user => Attendance.findOne({ user: user._id, timeOut: null }).sort({ timeIn: -1 });
// `now` is injectable for tests; it is always a real UTC instant (Date).
async function timeIn(user, now = new Date()) {
  const open = await openShift(user);
  if (open) return open;
  return Attendance.create({ user: user._id, name: user.name, roleLabel: ROLE_LABELS[user.role], timeIn: now });
}
async function timeOut(user, now = new Date()) {
  const open = await openShift(user);
  if (!open) throw conflict('You are not timed in.', 'ALREADY_DONE');
  open.timeOut = now;
  await open.save();
  return open;
}
/** Latest shift per staff member (for the manager dashboard). */
async function attendanceBoard() {
  const users = await User.find({ active: true }).sort({ role: 1, name: 1 });
  const shifts = await Attendance.find({ user: { $in: users.map(u => u._id) } }).sort({ timeIn: -1 }).limit(500);
  return users.map(u => ({ user: u, shift: shifts.find(s => String(s.user) === String(u._id)) || null }));
}

/* ---------------- Notifications ---------------- */
const listNotifications = user => Notification.find({ roles: user.role }).sort({ createdAt: -1 }).limit(50);
async function markRead(user, id) {
  const n = await Notification.findOne({ _id: id, roles: user.role });
  if (!n) throw notFound('Notification');
  await Notification.updateOne({ _id: n._id }, { $addToSet: { readBy: user._id } });
}
const markAllRead = user => Notification.updateMany({ roles: user.role }, { $addToSet: { readBy: user._id } });

module.exports = { authenticate, timeIn, timeOut, openShift, attendanceBoard, listNotifications, markRead, markAllRead };
