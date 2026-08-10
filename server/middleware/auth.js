'use strict';
const { ApiError } = require('./errorHandler');

/**
 * Server-side role enforcement. The prototype only hid nav items client-side;
 * once an API exists that is not enough (audit §7.5).
 */
const PAGE_PERMISSIONS = {
  frontdesk:   ['dashboard','reservations','rooms','checkin','inspection','incidents','requests','lostfound'],
  housekeeper: ['dashboard','rooms','housekeeping','inspection','requests','lostfound','inventory'],
  supervisor:  ['dashboard','rooms','housekeeping','inspection','incidents','maintenance','requests','lostfound','inventory'],
  maintenance: ['dashboard','rooms','maintenance','lostfound'],
  manager:     ['dashboard','reservations','rooms','housekeeping','inspection','incidents','maintenance','requests','lostfound','inventory','transactions','reports']
};

/** Attach req.user from the session. */
function currentUser(req, res, next) {
  req.user = (req.session && req.session.user) || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'You must be signed in.'));
  next();
}

/** requireRole('supervisor','manager') */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'You must be signed in.'));
  if (!roles.includes(req.user.role)) {
    return next(new ApiError(403, `This action requires: ${roles.join(' or ')}.`));
  }
  next();
};

module.exports = { PAGE_PERMISSIONS, currentUser, requireAuth, requireRole };
