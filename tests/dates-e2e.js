'use strict';
/* Regression test for the "Invalid Date – Invalid Date" bug.
   The API serialises Mongoose Date fields as ISO timestamps, but the frontend
   formatter did `new Date(value + 'T00:00:00')`, which only works for a bare
   'YYYY-MM-DD'. Appending 'T00:00:00' to an ISO string produced
   '2026-08-11T00:00:00.000ZT00:00:00' → Invalid Date.

   These tests pin the formatters directly (no DOM needed) and then render the
   real Reservations page through the real API to prove John shows real dates. */
const path = require('path');
const fs = require('fs');
const http = require('http');
const mongoose = require('mongoose');
const { JSDOM } = require('jsdom');

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/dates';
process.env.SESSION_SECRET = 'dates';
const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'server/models'));
require.cache[require.resolve(path.join(ROOT, 'server/config/db'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { connectDB: async () => {}, isConnected: () => true }
};

/* ---- in-memory persistence ---- */
const store = []; const byId = new Map();
function vmatch(a, c) {
  if (c instanceof RegExp) return c.test(String(a ?? ''));
  if (c && typeof c === 'object' && !(c instanceof Date) && !mongoose.isValidObjectId(c)) {
    return Object.entries(c).every(([op, v]) => ({
      $ne: () => String(a) !== String(v), $nin: () => !v.map(String).includes(String(a)),
      $in: () => v.map(String).includes(String(a)), $gt: () => a != null && new Date(a) > new Date(v),
      $gte: () => a != null && new Date(a) >= new Date(v), $lte: () => a != null && new Date(a) <= new Date(v),
      $exists: () => (a !== undefined) === v
    }[op] || (() => true))());
  }
  if (c === null) return a == null;
  return String(a) === String(c);
}
const matches = (d, f = {}) => Object.entries(f).every(([k, c]) =>
  k === '$or' ? c.some((x) => matches(d, x)) : vmatch(k === '_id' ? d._id : d.get(k), c));
class Q {
  constructor(rows, single) { this.rows = rows; this.single = single; }
  sort(sp) { const [f, dir] = Object.entries(sp || {})[0] || []; if (f) this.rows = [...this.rows].sort((a, b) => {
    const x = String(a.get(f) ?? ''), y = String(b.get(f) ?? ''); return (x < y ? -1 : x > y ? 1 : 0) * (dir < 0 ? -1 : 1); }); return this; }
  session() { return this; } select() { return this; } limit() { return this; }
  lean() { this.isLean = true; return this; }
  populate(paths) { this._pop = (this._pop || []).concat(String(paths || '').split(/\s+/).filter(Boolean)); return this; }
  expand(d) { if (!d) return d;
    if (!this._pop || !this._pop.length) return this.isLean ? d.toObject() : d;
    const plain = d.toObject();
    this._pop.forEach((p) => { const v = plain[p];
      if (v && !Array.isArray(v)) { const ref = byId.get(String(v._id || v)); if (ref) plain[p] = ref.toObject(); } });
    return plain; }
  then(res, rej) { try { const rows = this.rows.map((d) => this.expand(d));
    res(this.single ? (rows[0] || null) : rows); } catch (e) { rej(e); } }
}
Object.values(M).forEach((Model) => {
  if (!Model || !Model.modelName) return;
  const n = Model.modelName; const own = () => store.filter((d) => d.constructor.modelName === n);
  Model.findOne = (f = {}) => new Q(own().filter((d) => matches(d, f)), true);
  Model.find = (f = {}) => new Q(own().filter((d) => matches(d, f)), false);
  Model.findById = (id) => new Q([byId.get(String(id))].filter(Boolean), true);
  Model.countDocuments = async (f = {}) => own().filter((d) => matches(d, f)).length;
  Model.deleteMany = async (f = {}) => { let c = 0; for (let i = store.length - 1; i >= 0; i--) {
    const d = store[i]; if (d.constructor.modelName === n && matches(d, f)) { store.splice(i, 1); byId.delete(String(d._id)); c++; } } return { deletedCount: c }; };
  Model.create = async (data) => { const arr = Array.isArray(data) ? data : [data];
    const made = arr.map((d) => new Model(d)); for (const doc of made) await doc.save(); return Array.isArray(data) ? made : made[0]; };
  Model.updateMany = async (f = {}, u = {}) => { for (const d of own().filter((x) => matches(x, f))) { d.set(u.$set || u); await d.save(); } return {}; };
  Model.findByIdAndUpdate = async (id, u) => { const d = byId.get(String(id)); if (!d) return null; d.set(u.$set || u); await d.save(); return d; };
  Model.aggregate = async (p) => { const st = p.find((x) => x.$group); if (!st) return []; const g = st.$group;
    const k = String(g._id).replace('$', ''); const o = {}; own().forEach((d) => { const v = d.get(k); o[v] = (o[v] || 0) + 1; });
    return Object.entries(o).map(([_id, nn]) => ({ _id, n: nn })); };
});
mongoose.Model.prototype.save = async function () { const e = this.validateSync(); if (e) throw e;
  if (!byId.has(String(this._id))) { store.push(this); byId.set(String(this._id), this); } return this; };
mongoose.startSession = async () => { throw new Error('replica set not supported'); };
mongoose.disconnect = async () => {};

let pass = 0, fail = 0;
const ok = (l, c, x) => { if (c) { pass++; console.log('  ✔ ' + l); } else { fail++; console.log('  ✘ ' + l + (x ? ` — ${x}` : '')); } };
const docs = (n) => store.filter((d) => d.constructor.modelName === n);

(async () => {
  const quiet = console.log; console.log = () => {};
  const realExit = process.exit; process.exit = () => {};
  require(path.join(ROOT, 'server/seed/seed.js'));
  await new Promise((r) => setTimeout(r, 600));
  process.exit = realExit; console.log = quiet;

  const { app } = require(path.join(ROOT, 'server/server.js'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: BASE + '/' });
  const { window } = dom;
  window.scrollTo = () => {}; window.confirm = () => true;
  window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};
  let cookie = '';
  window.fetch = async (url, opts = {}) => {
    const res = await fetch(BASE + url, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) } });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  window.eval(fs.readFileSync(path.join(ROOT, 'public/api.js'), 'utf8'));
  // app.js declares its helpers with `const`, which is not reachable on
  // `window`; expose them for assertions without altering the shipped file.
  window.eval(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
    + '\n;window.__dateUtils={fmtDay,fmtDT,fmtTime,nights,manilaDay,toDate};');
  const $ = (id) => window.document.getElementById(id);

  /* ---------- 1. the formatters themselves ---------- */
  console.log('DATE FORMATTERS ACCEPT BOTH SHAPES');
  // These are `const` inside app.js's scope, so reach them through eval
  // rather than window properties.
  const { fmtDay, fmtDT, fmtTime, nights, manilaDay } = window.__dateUtils;
  [['date-only', '2026-08-11'],
   ['ISO timestamp', '2026-08-11T00:00:00.000Z'],
   ['ISO with offset', '2026-08-11T08:00:00+08:00'],
   ['Date object', new Date('2026-08-11T00:00:00.000Z')],
   ['epoch millis', Date.parse('2026-08-11T00:00:00.000Z')]
  ].forEach(([label, v]) => {
    ok(`fmtDay(${label}) is not "Invalid Date"`, fmtDay(v) !== 'Invalid Date' && fmtDay(v) !== '—', fmtDay(v));
    ok(`fmtDay(${label}) renders Aug 11`, /Aug\s*11/.test(fmtDay(v)), fmtDay(v));
  });
  ok('fmtDT on an ISO timestamp is valid', !/Invalid/.test(fmtDT('2026-08-11T00:00:00.000Z')));
  ok('fmtTime on an ISO timestamp is valid', !/Invalid/.test(fmtTime('2026-08-11T00:00:00.000Z')));

  console.log('\nBAD INPUT DEGRADES GRACEFULLY (never "Invalid Date")');
  [null, undefined, '', 'garbage', {}].forEach((v) =>
    ok(`fmtDay(${JSON.stringify(v)}) → em dash`, fmtDay(v) === '—', fmtDay(v)));

  console.log('\nNIGHTS CALCULATION');
  ok('date-only 08-11 → 08-12 = 1 night', nights('2026-08-11', '2026-08-12') === 1);
  ok('ISO 08-11 → 08-12 = 1 night',
    nights('2026-08-11T00:00:00.000Z', '2026-08-12T00:00:00.000Z') === 1);
  ok('ISO 08-11 → 08-14 = 3 nights',
    nights('2026-08-11T00:00:00.000Z', '2026-08-14T00:00:00.000Z') === 3);
  ok('mixed shapes still agree', nights('2026-08-11', '2026-08-12T00:00:00.000Z') === 1);

  console.log('\nNO OFF-BY-ONE ACROSS THE MANILA DAY BOUNDARY');
  // 2026-08-10T16:00Z is exactly midnight on 11 Aug in Manila (UTC+8)
  ok('Manila midnight renders as Aug 11, not Aug 10', /Aug\s*11/.test(fmtDay('2026-08-10T16:00:00.000Z')), fmtDay('2026-08-10T16:00:00.000Z'));
  ok('manilaDay() agrees', manilaDay('2026-08-10T16:00:00.000Z') === '2026-08-11');
  // 15:59Z is still 23:59 on 10 Aug in Manila
  ok('one minute earlier is still Aug 10', manilaDay('2026-08-10T15:59:00.000Z') === '2026-08-10');
  ok('a bare calendar date keeps its own day', manilaDay('2026-08-11') === '2026-08-11');

  /* ---------- 2. John renders real dates through the real API ---------- */
  console.log('\nJOHN DELA CRUZ RENDERS REAL DATES');
  $('employeePin').value = '6767';
  $('staffLoginForm').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 450));
  window.go('reservations');
  await new Promise((r) => setTimeout(r, 250));
  const table = $('reservationTable').textContent;
  ok('Reservations table contains NO "Invalid Date"', !table.includes('Invalid Date'),
    table.slice(0, 200));
  ok('John appears in the table', table.includes('John Dela Cruz'));

  const john = docs('Reservation').find((r) => r.ref === 'SSR-2026-9001');
  const row = [...window.document.querySelectorAll('#reservationTable tr')]
    .find((tr) => tr.textContent.includes('John Dela Cruz'));
  ok('John\'s row shows a real date range',
    row && /[A-Z][a-z]{2}\s*\d{1,2}\s*–\s*[A-Z][a-z]{2}\s*\d{1,2}/.test(row.textContent), row && row.textContent);
  ok('John\'s row shows "1 night"', row && /1 night/.test(row.textContent));
  ok('displayed dates match the database values',
    row && row.textContent.includes(fmtDay(john.checkIn)) && row.textContent.includes(fmtDay(john.checkOut)));

  console.log('\nCHECK-IN SCREEN STILL CORRECT');
  window.go('checkin');
  await new Promise((r) => setTimeout(r, 250));
  const opt = [...$('checkinReservation').options].find((o) => o.textContent.includes('John Dela Cruz'));
  ok('John selectable, with a valid date in the label', !!opt && !/Invalid/.test(opt.textContent), opt && opt.textContent);
  $('checkinReservation').value = opt.value;
  $('checkinReservation').dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const summary = $('checkinSummary').textContent;
  ok('check-in summary has no Invalid Date', !summary.includes('Invalid Date'), summary.slice(0, 160));
  ok('summary shows 1 night', /Nights\s*1/.test(summary.replace(/\s+/g, ' ')), summary.slice(0, 200));

  console.log('\nPRICING UNCHANGED');
  ok('₱1,800 accommodation still shown', /1,800/.test(summary));
  ok('₱1,000 deposit still shown separately', /Security deposit[\s\S]*1,000/.test(summary));
  ok('₱2,800 due at check-in', $('checkinBalance').textContent.includes('2,800'));
  ok('database: total is accommodation only', john.total === 1800 && john.deposit === 1000);
  ok('John is still Confirmed and not checked in',
    john.status === 'Confirmed' && !john.checkedInAt);

  console.log('\nDASHBOARD DATE-BASED WIDGETS WORK');
  window.go('dashboard');
  await new Promise((r) => setTimeout(r, 250));
  ok('dashboard renders without Invalid Date',
    !$('roleDashboard').textContent.includes('Invalid Date'));
  ok("Today's Arrivals finds John (date comparison fixed)",
    $('roleDashboard').textContent.includes('John Dela Cruz'),
    'arrivals widget did not list him');

  server.close();
  console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
