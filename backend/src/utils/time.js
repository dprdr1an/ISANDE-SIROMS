'use strict';
/**
 * Date helpers in the hotel's timezone (APP_TIMEZONE, default Asia/Manila).
 * Reservation dates are stored as 'YYYY-MM-DD' strings (date-only, no TZ
 * ambiguity). Event timestamps are stored as Date and sent to the browser as
 * local 'YYYY-MM-DDTHH:mm' strings, the format the frontend already uses.
 */
const { env } = require('../config/env');

function parts(d, tz = env.APP_TIMEZONE) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
const isoDate = (d = new Date()) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const isoLocal = d => { if (!d) return ''; const p = parts(new Date(d)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
const today = () => isoDate(new Date());
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function nights(a, b) {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.max(1, Math.round(ms / 864e5));
}
const timeLabel = d => (d ? new Date(d).toLocaleTimeString('en-PH', { timeZone: env.APP_TIMEZONE, hour: 'numeric', minute: '2-digit' }) : '—');
/** Clock time for an instant: "5:58 PM" if it falls on the hotel-local date of `now`,
 *  otherwise "Oct 21, 6:48 AM", so an earlier day's time is never mistaken for today's. */
function clockLabel(d, now = new Date()) {
  if (!d) return '—';
  const t = timeLabel(d);
  if (isoDate(new Date(d)) === isoDate(now)) return t;
  return `${new Date(d).toLocaleDateString('en-PH', { timeZone: env.APP_TIMEZONE, month: 'short', day: 'numeric' })}, ${t}`;
}
/** Convert a browser 'YYYY-MM-DDTHH:mm' (hotel local time) to a Date. */
function fromLocal(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null;
  // Determine the timezone offset for that local time.
  const guess = new Date(s + ':00Z');
  const p = parts(guess);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offset = asUTC - guess.getTime();
  return new Date(guess.getTime() - offset);
}
/** Start of the hotel-local day `n` days from today, as a Date. */
const startOfDay = (n = 0) => fromLocal(addDays(today(), n) + 'T00:00');

module.exports = { isoDate, isoLocal, today, addDays, nights, timeLabel, clockLabel, fromLocal, startOfDay };
