'use strict';
const { isConnected } = require('../config/db');

/** Wrap an async route so rejected promises reach the error handler. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Throwable HTTP error with a status code. */
class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Refuse to serve data when the DB is down rather than returning stale/empty. */
function requireDB(req, res, next) {
  if (!isConnected()) {
    return res.status(503).json({
      error: 'Database unavailable',
      message: 'SIROMS cannot reach the database. No data can be read or saved right now.'
    });
  }
  next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', message: `No route for ${req.method} ${req.originalUrl}` });
}

/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  // Mongoose validation -> 400 with per-field detail
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]))
    });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid identifier', message: `"${err.value}" is not a valid ${err.kind}.` });
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate value', details: err.keyValue });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('✖ Unhandled error:', err);
  res.status(status).json({
    error: status >= 500 ? 'Server error' : err.message,
    message: err.message,
    ...(err.details ? { details: err.details } : {})
  });
}

module.exports = { asyncHandler, ApiError, requireDB, notFound, errorHandler };
