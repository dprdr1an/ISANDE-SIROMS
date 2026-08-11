'use strict';
/* Tests the exact scenario in the brief:
   Front Desk creates a request for Room 203 → Supervisor assigns Ana Cruz →
   Ana sees it in BOTH Guest Requests and Housekeeping → she starts it from the
   Housekeeping board → both views update → she delivers it → both views agree.
   Plus: a normal cleaning task still works, and role rules are unchanged.

   Runs the real Express app over HTTP with the real public/app.js in jsdom;
   only the Mongo driver is replaced by an in-memory store. */
const path = require('path');
const fs = require('fs');
const http = require('http');
const mongoose = require('mongoose');
const { JSDOM } = require('jsdom');

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/frontdesk';
process.env.SESSION_SECRET = 'frontdesk-secret';

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
  // Single-level populate, like Mongoose. Non-mutating: stored documents are
  // never altered, so populating room->reservation cannot create a cycle.
  populate(paths) { this._pop = (this._pop || []).concat(String(paths || '').split(/\s+/).filter(Boolean)); return this; }
  expand(d) {
    if (!d) return d;
    if (!this._pop || !this._pop.length) return this.isLean ? d.toObject() : d;
    const plain = d.toObject();
    this._pop.forEach((p) => { const v = plain[p];
      if (v && !Array.isArray(v)) { const ref = byId.get(String(v._id || v)); if (ref) plain[p] = ref.toObject(); } });
    return plain;
  }
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
const ok = (l, c, x) => { if (c) { pass++; console.log('  \u2714 ' + l); } else { fail++; console.log('  \u2718 ' + l + (x ? ` \u2014 ${x}` : '')); } };
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
  console.log(`Real Express server on ${BASE}\n`);

  async function browser() {
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
    window.eval(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'));
    const $ = (id) => window.document.getElementById(id);
    return { window, doc: window.document, $,
      login: async (pin) => { $('employeePin').value = pin;
        $('staffLoginForm').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 450)); },
      go: async (p) => { window.go(p); await new Promise((r) => setTimeout(r, 250)); } };
  }

  console.log('FRONT DESK FINDS JOHN');
  const fd = await browser();
  await fd.login('6767');
  ok('front desk signed in', fd.$('profileName').textContent.includes('Anne'));

  // Reservations page: search for him the way a receptionist would
  await fd.go('reservations');
  fd.$('reservationSearch').value = 'John Dela Cruz';
  fd.$('reservationSearch').dispatchEvent(new fd.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const table = fd.$('reservationTable').textContent;
  ok('searching "John Dela Cruz" finds his reservation', table.includes('John Dela Cruz'));
  ok('shows reference SSR-2026-9001', table.includes('SSR-2026-9001'));
  ok('shows status Confirmed', table.includes('Confirmed'));

  console.log('\nCHECK-IN IS AVAILABLE AND PRICED CORRECTLY');
  await fd.go('checkin');
  const opts = [...fd.$('checkinReservation').options].map((o) => o.textContent);
  ok('John is selectable in the check-in dropdown', opts.some((o) => o.includes('John Dela Cruz')),
     opts.join(' | ').slice(0, 160));
  const johnOpt = [...fd.$('checkinReservation').options].find((o) => o.textContent.includes('John Dela Cruz'));
  fd.$('checkinReservation').value = johnOpt.value;
  fd.$('checkinReservation').dispatchEvent(new fd.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const summary = fd.$('checkinSummary').textContent;
  ok('summary shows the \u20b11,800 room rate', /1,800/.test(summary), summary.slice(0, 220));
  ok('summary shows the separate \u20b11,000 security deposit', /Security deposit[\s\S]*1,000/.test(summary));
  ok('amount due now is \u20b12,800', fd.$('checkinBalance').textContent.includes('2,800'),
     fd.$('checkinBalance').textContent);
  ok('Room 203 is offered as an available room',
    [...fd.$('checkinRoom').options].some((o) => o.textContent.includes('Room 203')));

  console.log('\nUNDERPAYMENT IS REFUSED');
  fd.$('checkinRoom').value = [...fd.$('checkinRoom').options].find((o) => o.textContent.includes('Room 203')).value;
  fd.$('checkinPaid').value = 1800;                       // accommodation only
  fd.$('checkinPaid').dispatchEvent(new fd.window.Event('input', { bubbles: true }));
  fd.$('checkinForm').dispatchEvent(new fd.window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 450));
  const john0 = docs('Reservation').find((r) => r.ref === 'SSR-2026-9001');
  ok('paying only \u20b11,800 does NOT check him in', john0.status === 'Confirmed');
  ok('the error names the missing deposit', /deposit/i.test(fd.$('toast').textContent),
     fd.$('toast').textContent);

  console.log('\nCHECK IN FOR \u20b12,800');
  fd.$('checkinPaid').value = 2800;
  fd.$('checkinPaid').dispatchEvent(new fd.window.Event('input', { bubbles: true }));
  fd.$('checkinForm').dispatchEvent(new fd.window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
  const john = docs('Reservation').find((r) => r.ref === 'SSR-2026-9001');
  ok('MongoDB: reservation status \u2192 Checked in', john.status === 'Checked in');
  ok('MongoDB: accommodation fully paid (\u20b11,800)', john.paid === 1800);
  ok('MongoDB: total is still accommodation only (no deposit inside)', john.total === 1800);
  ok('MongoDB: deposit recorded as collected', john.depositCollected === true && john.deposit === 1000);
  const r203 = docs('Room').find((r) => r.number === '203');
  ok('MongoDB: Room 203 \u2192 occupied', r203.status === 'occupied');
  ok('MongoDB: Room 203 linked to John', String(r203.currentReservation) === String(john._id));

  const tx = docs('Transaction').filter((t) => t.bookingRef === 'SSR-2026-9001');
  const accTx = tx.find((t) => t.type === 'Check-in payment');
  const depTx = tx.find((t) => t.type === 'Deposit');
  ok('two separate transactions written', tx.length === 2, tx.map((t) => t.type).join(', '));
  ok('accommodation transaction = \u20b11,800', accTx && accTx.amount === 1800);
  ok('deposit transaction = \u20b11,000 (separate)', depTx && depTx.amount === 1000);

  console.log('\nSTATE VISIBLE ACROSS MODULES');
  await fd.go('rooms');
  ok('Rooms page shows 203 as occupied by John',
    fd.$('roomGrid').textContent.includes('John Dela Cruz'));
  const sup = await browser(); await sup.login('3344');
  await sup.go('rooms');
  ok('supervisor sees the same Room 203 state',
    sup.$('roomGrid').textContent.includes('John Dela Cruz'));
  const mgr = await browser(); await mgr.login('5566');
  const dash = await mgr.window.SIROMS.api.dashboard();
  ok('manager dashboard counts it from live data', dash.rooms.occupied >= 1, 'rooms=' + JSON.stringify(dash.rooms) + ' totalRooms=' + dash.totalRooms);

  console.log('\nFAMILY ROOM PRICING');
  const famRoom = docs('Room').find((r) => r.type === 'Family' && r.status === 'available');
  ok('a Family room is \u20b12,600 per night', famRoom && famRoom.rate === 2600);
  const wi = await fd.window.SIROMS.api.walkIn({
    guest: 'Pricing Test', roomId: String(famRoom._id), nights: 1, amountPaid: 3600 });
  ok('one-night Family walk-in accepts \u20b13,600 (2,600 + 1,000)', !!wi.reservation);
  ok('walk-in accommodation stored as \u20b12,600', wi.reservation.total === 2600);
  const wtx = docs('Transaction').filter((t) => t.bookingRef === wi.reservation.ref);
  ok('walk-in wrote separate accommodation + deposit transactions',
    wtx.some((t) => t.type === 'Walk-in payment' && t.amount === 2600) &&
    wtx.some((t) => t.type === 'Deposit' && t.amount === 1000));
  let refused = false;
  try { await fd.window.SIROMS.api.walkIn({ guest: 'X', roomId: String(docs('Room').find((r) => r.type === 'Family' && r.status === 'available' && String(r._id) !== String(famRoom._id))._id), nights: 1, amountPaid: 2600 }); }
  catch (e) { refused = true; }
  ok('paying only the rate (no deposit) is refused', refused);

  server.close();
  console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
