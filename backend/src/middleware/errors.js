'use strict';
/**
 * Consistent JSON errors: { ok:false, error:{ code, message, details? } }.
 * Stack traces, database messages and credentials are logged server-side only.
 */
const mongoose = require('mongoose');
const { ApiError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.originalUrl}.` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500, code = 'SERVER_ERROR', message = 'Something went wrong on the server. Refresh to check the record before trying again.', details;
  if (err instanceof ApiError) ({ status, code, message, details } = err);
  else if (err instanceof mongoose.Error.CastError) { status = 400; code = 'INVALID_ID'; message = 'Invalid identifier.'; }
  else if (err instanceof mongoose.Error.ValidationError) {
    status = 422; code = 'VALIDATION';
    details = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
    message = details[0]?.message || 'Validation failed.';
  } else if (err && err.code === 11000) {
    status = 409; code = 'DUPLICATE';
    const field = Object.keys(err.keyPattern || {})[0];
    message = field === 'openKey' ? 'That room already has an open task of this kind.' : field === 'nameKey' ? 'An item with that name already exists.' : 'That record already exists.';
  } else if (err && err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'Request body is not valid JSON.'; }
  else if (err && err.type === 'entity.too.large') { status = 413; code = 'TOO_LARGE'; message = 'Request body is too large.'; }
  if (status >= 500) console.error(`[SIROMS] ${req.method} ${req.originalUrl}`, err);
  res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

module.exports = { notFoundHandler, errorHandler };
