'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { env } = require('../config/env');
const { ROLE_LABELS } = require('../config/business');
const { validate, z } = require('../middleware/validate');
const staff = require('../services/staffService');
const { wrap, send } = require('./helpers');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: env.LOGIN_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Wait a few minutes and try again.' } }
});
const meDTO = u => ({ id: String(u._id), staffId: u.staffId, name: u.name, role: u.role, label: ROLE_LABELS[u.role], initials: u.initials });

router.post('/login', loginLimiter,
  validate(z.object({ staffId: z.string().trim().regex(/^\d{4}$/, 'Staff ID must be 4 digits.'), password: z.string().min(1, 'Enter your password.').max(200) })),
  wrap(async (req, res) => {
    const user = await staff.authenticate(req.body.staffId, req.body.password);
    // New session id on login prevents session fixation.
    await new Promise((ok, fail) => req.session.regenerate(e => (e ? fail(e) : ok())));
    req.session.userId = String(user._id);
    req.session.role = user.role;
    await new Promise((ok, fail) => req.session.save(e => (e ? fail(e) : ok())));
    // Signing in again during an open shift resumes it rather than recording a new time-in.
    const resumed = !!(await staff.openShift(user));
    const shift = await staff.timeIn(user);
    send(res, { user: meDTO(user), shift: { isTimedIn: true, since: shift.timeIn, resumed } });
  }));

router.post('/logout', wrap(async (req, res) => {
  await new Promise(ok => (req.session ? req.session.destroy(() => ok()) : ok()));
  res.clearCookie('siroms.sid', { path: '/' });
  send(res, { signedOut: true });
}));

/** Session check used on page load. Returns 200 either way so a signed-out visit isn't logged as an error. */
router.get('/me', wrap(async (req, res) => {
  const id = req.session && req.session.userId;
  const user = id ? await User.findOne({ _id: id, active: true }) : null;
  send(res, user ? { authenticated: true, user: meDTO(user) } : { authenticated: false, user: null });
}));

/** Development only: list staff IDs (never passwords) for the login screen. */
router.get('/demo-accounts', wrap(async (_req, res) => {
  if (!env.ENABLE_DEMO_DIRECTORY) return send(res, { enabled: false, accounts: [] });
  const users = await User.find({ active: true }).sort({ staffId: 1 });
  send(res, { enabled: true, accounts: users.map(u => ({ staffId: u.staffId, name: u.name, label: ROLE_LABELS[u.role] })) });
}));

module.exports = router;
