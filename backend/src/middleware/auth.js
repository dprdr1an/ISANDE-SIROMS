'use strict';
/**
 * Authentication & authorisation.
 * Identity and role always come from the server-side session → database,
 * never from anything the browser sends.
 */
const { User } = require('../models');
const { unauthorized, forbidden } = require('../utils/errors');
const { PAGE_PERMISSIONS } = require('../config/business');

async function requireAuth(req, _res, next) {
  try {
    const id = req.session && req.session.userId;
    if (!id) throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_EXPIRED');
    const user = await User.findById(id);
    if (!user || !user.active) {
      req.session.destroy(() => {});
      throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_EXPIRED');
    }
    req.user = user;
    next();
  } catch (e) { next(e); }
}

/** Allow only the listed roles. */
const allow = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

/** Allow roles that can open a given page in the UI (mirrors the prototype map). */
const allowPage = page => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!PAGE_PERMISSIONS[req.user.role].includes(page)) return next(forbidden());
  next();
};

const canPage = (user, page) => PAGE_PERMISSIONS[user.role].includes(page);

/**
 * CSRF defence for cookie sessions: every state-changing API request must
 * carry a custom header. Browsers cannot attach custom headers cross-site
 * without a CORS pre-flight, which the server only approves for configured
 * origins. Combined with SameSite=Lax cookies.
 */
function requireCsrfHeader(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-SIROMS-Request') !== '1') return next(forbidden('Request rejected: missing request header.'));
  next();
}

module.exports = { requireAuth, allow, allowPage, canPage, requireCsrfHeader };
