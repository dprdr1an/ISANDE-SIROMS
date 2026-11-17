'use strict';
/** Typed API errors. The message is safe to show to staff; never put secrets in it. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const badRequest = (msg, details) => new ApiError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'Please sign in to continue.', code = 'UNAUTHENTICATED') => new ApiError(401, code, msg);
const forbidden = (msg = 'Your role is not allowed to do that.') => new ApiError(403, 'FORBIDDEN', msg);
const notFound = (what = 'Record') => new ApiError(404, 'NOT_FOUND', `${what} was not found.`);
const conflict = (msg, code = 'CONFLICT') => new ApiError(409, code, msg);
const unprocessable = (msg, details) => new ApiError(422, 'RULE_VIOLATION', msg, details);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, unprocessable };
