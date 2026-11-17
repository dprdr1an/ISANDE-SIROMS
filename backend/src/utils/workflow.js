'use strict';
/**
 * Multi-record workflows.
 *
 * With a replica set (MongoDB Atlas) every workflow runs inside a
 * multi-document transaction: either every write lands or none do.
 *
 * Without transaction support (e.g. a standalone dev server) the same code
 * runs with session = null. Services are written so that this mode is still
 * retry-safe:
 *   1. All validation happens before the first write.
 *   2. Financial records and auto-created tasks are inserted with a
 *      deterministic, uniquely indexed key, so a retry cannot duplicate them.
 *   3. The state change that "claims" the operation is a conditional update
 *      (it only matches the expected current status), so two concurrent
 *      requests cannot both complete it.
 */
const mongoose = require('mongoose');
const { supportsTransactions } = require('../config/db');

async function runWorkflow(fn) {
  if (!supportsTransactions()) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Mongoose option helper: `{ session }` or `{}`. */
const opt = (session, extra = {}) => (session ? { ...extra, session } : extra);

/**
 * Insert a document keyed by `idempotencyKey`. If it already exists (retry or
 * race), return the existing document instead of creating a duplicate.
 */
async function insertOnce(Model, doc, session) {
  if (!doc.idempotencyKey) throw new Error('insertOnce requires idempotencyKey');
  const existing = await Model.findOne({ idempotencyKey: doc.idempotencyKey }, null, opt(session));
  if (existing) return existing;
  try {
    const [created] = await Model.create([doc], opt(session));
    return created;
  } catch (e) {
    if (e && e.code === 11000) {
      const again = await Model.findOne({ idempotencyKey: doc.idempotencyKey }, null, opt(session));
      if (again) return again;
    }
    throw e;
  }
}

module.exports = { runWorkflow, opt, insertOnce };
