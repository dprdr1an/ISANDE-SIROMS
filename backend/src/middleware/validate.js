'use strict';
/** zod-based request validation. Parsed (and coerced) values replace the raw input. */
const { z } = require('zod');
const mongoose = require('mongoose');
const { badRequest } = require('../utils/errors');

function validate(schema, where = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[where] ?? {});
    if (!result.success) {
      const details = result.error.issues.map(i => ({ field: i.path.join('.') || where, message: i.message }));
      return next(badRequest(details[0] ? `${details[0].field}: ${details[0].message}` : 'Invalid request.', details));
    }
    if (where === 'query') req.validQuery = result.data; else req[where] = result.data;
    next();
  };
}

// Reusable field schemas
const objectId = z.string().refine(v => mongoose.isValidObjectId(v) && String(new mongoose.Types.ObjectId(v)) === v, 'Invalid id.');
const pesos = z.number({ error: 'Amount must be a number.' }).int('Amounts must be whole pesos.').min(0, 'Amount cannot be negative.').max(10000000);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm.');
const text = (max, min = 0) => z.string().trim().max(max).min(min);
const clientRequestId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid request id.').optional();
const roomNumber = z.string().regex(/^\d{3}$/, 'Room number must be 3 digits.');
const idParam = z.object({ id: objectId });

module.exports = { validate, z, objectId, pesos, ymd, localDateTime, text, clientRequestId, roomNumber, idParam };
