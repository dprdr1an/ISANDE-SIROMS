'use strict';
/** Wrap async handlers and send consistent { ok:true, data } responses. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const json = doc => (doc && typeof doc.toJSON === 'function' ? doc.toJSON() : doc);
module.exports = { wrap, send, json };
