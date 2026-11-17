'use strict';
const { Schema } = require('mongoose');

/** Who did something, and when. Name is denormalised so history survives user changes. */
const actorFields = {
  by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  byName: { type: String, trim: true, maxlength: 80, default: '' }
};
const AuditEntry = new Schema({
  at: { type: Date, default: Date.now, required: true },
  ...actorFields,
  what: { type: String, required: true, trim: true, maxlength: 500 }
}, { _id: false });
const StatusEntry = new Schema({
  status: { type: String, required: true },
  at: { type: Date, default: Date.now, required: true },
  ...actorFields,
  note: { type: String, trim: true, maxlength: 500, default: '' }
}, { _id: false });

/** Whole-peso integer amount. */
const money = (extra = {}) => ({
  type: Number,
  default: 0,
  validate: { validator: Number.isInteger, message: 'Amounts must be whole pesos.' },
  ...extra
});
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Strip internal fields from JSON output. */
function cleanJSON(schema, hidden = []) {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const h of hidden) delete ret[h];
      return ret;
    }
  });
}

module.exports = { actorFields, AuditEntry, StatusEntry, money, YMD, cleanJSON };
