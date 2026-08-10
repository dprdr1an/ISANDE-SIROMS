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

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/e2e2';
process.env.SESSION_SECRET = 'e2e2-secret';

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
  Model.aggregate = async (p) => { const g = p.find((x) => x.$group); if (!g) return [];
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
  await new Promise((r) => setTimeout(r, 500));
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
    return {
      window, doc: window.document, $,
      login: async (pin) => { $('employeePin').value = pin;
        $('staffLoginForm').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 400)); },
      go: async (p) => { window.go(p); await new Promise((r) => setTimeout(r, 200)); },
      board: () => $('housekeepingBoard').textContent,
      column: (name) => { const c = [...window.document.querySelectorAll('.kanban-column')]
        .find((x) => x.querySelector('h3') && x.querySelector('h3').textContent.startsWith(name));
        return c ? c.textContent : ''; },
      requests: () => $('activeRequests').textContent
    };
  }

  /* ---- 1. Front desk creates a request for Room 203 ---- */
  console.log('1. FRONT DESK CREATES REQUEST (Room 203)');
  const fd = await browser();
  await fd.login('6767');
  await fd.go('requests');
  const beforeReq = docs('GuestRequest').length;
  const room203 = docs('Room').find((r) => r.number === '203');
  fd.$('requestRoom').value = '203';
  fd.$('requestRoom').dispatchEvent(new fd.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  fd.$('requestForm').dispatchEvent(new fd.window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  ok('request PERSISTED to MongoDB', docs('GuestRequest').length === beforeReq + 1,
    `${beforeReq} → ${docs('GuestRequest').length}`);
  const req = docs('GuestRequest').find((r) => r.roomNumber === '203' && r.status === 'Pending');
  ok('created as Pending and unassigned', !!req && !req.assignedTo);
  ok('guest name attached from the in-house stay', !!req && !!req.guest);

  /* ---- 2. Supervisor assigns Ana Cruz ---- */
  console.log('\n2. SUPERVISOR ASSIGNS ANA CRUZ');
  const sup = await browser();
  await sup.login('3344');
  await sup.go('requests');
  const sel = [...sup.doc.querySelectorAll('[data-assign-req]')]
    .find((s) => String(s.dataset.assignReq) === String(req._id));
  ok('supervisor sees an assign control on the request', !!sel);
  const ana = docs('User').find((u) => u.name === 'Ana Cruz');
  sel.value = String(ana._id);
  sel.dispatchEvent(new sup.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const reqAfter = docs('GuestRequest').find((r) => String(r._id) === String(req._id));
  ok('SAME document updated (no duplicate created)',
    docs('GuestRequest').length === beforeReq + 1 && String(reqAfter._id) === String(req._id));
  ok('status → Assigned, assignedTo = Ana Cruz',
    reqAfter.status === 'Assigned' && reqAfter.assignedToName === 'Ana Cruz');

  /* ---- 3-5. Ana sees it in BOTH modules ---- */
  console.log('\n3. ANA CRUZ — VISIBLE IN BOTH MODULES');
  const ana1 = await browser();
  await ana1.login('2211');
  await ana1.go('requests');
  ok('Guest Requests page shows the request', ana1.requests().includes('203'));
  await ana1.go('housekeeping');
  ok('HOUSEKEEPING board also shows it (the reported bug)',
    ana1.column('Assigned').includes('203') && ana1.column('Assigned').includes('Guest Delivery'),
    'Assigned col=' + ana1.column('Assigned').slice(0, 200));
  ok('card shows the guest name', ana1.board().includes(reqAfter.guest));
  ok('card carries a Guest Delivery type tag', ana1.board().includes('Guest Delivery'));
  ok('cleaning tasks still on the same board',
    ana1.board().includes('Cleaning'), 'board=' + ana1.board().slice(0, 200));

  /* ---- 6-7. Start the task FROM Housekeeping ---- */
  console.log('\n4. START FROM HOUSEKEEPING → BOTH VIEWS UPDATE');
  const startBtn = [...ana1.doc.querySelectorAll('[data-request-advance]')]
    .find((b) => String(b.dataset.requestAdvance) === String(req._id));
  ok('board offers a Start delivery button (not the cleaning flow)',
    !!startBtn && startBtn.textContent.includes('Start delivery'));
  startBtn.dispatchEvent(new ana1.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  ok('MongoDB status → In delivery',
    docs('GuestRequest').find((r) => String(r._id) === String(req._id)).status === 'In delivery');
  ok('Housekeeping board moved it to In Progress column',
    ana1.column('In Progress').includes('203'));
  await ana1.go('requests');
  ok('Guest Requests page reflects In delivery', ana1.requests().includes('In delivery'));

  /* ---- 8-9. Deliver ---- */
  console.log('\n5. DELIVER → BOTH MODULES AGREE');
  await ana1.go('housekeeping');
  const doneBtn = [...ana1.doc.querySelectorAll('[data-request-advance]')]
    .find((b) => String(b.dataset.requestAdvance) === String(req._id));
  ok('button now reads Mark delivered', !!doneBtn && doneBtn.textContent.includes('Mark delivered'));
  doneBtn.dispatchEvent(new ana1.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const final = docs('GuestRequest').find((r) => String(r._id) === String(req._id));
  ok('MongoDB status → Delivered', final.status === 'Delivered');
  ok('Housekeeping shows it under Completed', ana1.column('Completed').includes('203'));
  await ana1.go('requests');
  ok('Guest Requests also shows Delivered', ana1.requests().includes('Delivered'));
  ok('still exactly ONE document for this request',
    docs('GuestRequest').filter((r) => String(r._id) === String(req._id)).length === 1);
  ok('no shadow HousekeepingTask was created for it',
    !docs('HousekeepingTask').some((t) => t.type === 'Guest item delivery' && t.roomNumber === '203'));

  /* ---- 10. cleaning workflow untouched ---- */
  console.log('\n6. CLEANING WORKFLOW STILL WORKS');
  const cleanTask = docs('HousekeepingTask').find((t) => t.kind === 'cleaning' && t.status === 'Assigned' && t.assignedToName === 'Ana Cruz');
  ok('Ana has a seeded cleaning task', !!cleanTask);
  await ana1.go('housekeeping');
  const cbtn = [...ana1.doc.querySelectorAll('[data-task-advance]')]
    .find((b) => String(b.dataset.taskAdvance) === String(cleanTask._id));
  ok('cleaning task offers Start cleaning', !!cbtn && cbtn.textContent.includes('Start cleaning'));
  cbtn.dispatchEvent(new ana1.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  ok('cleaning task → In Progress in MongoDB',
    docs('HousekeepingTask').find((t) => String(t._id) === String(cleanTask._id)).status === 'In Progress');

  /* ---- 11. role rules unchanged ---- */
  console.log('\n7. ROLE RULES UNCHANGED');
  let refused = false;
  try { await ana1.window.SIROMS.api.assignGuestRequest(String(req._id), String(ana._id)); }
  catch (e) { refused = true; }
  ok('housekeeper cannot assign requests (supervisor only)', refused);
  const other = docs('User').find((u) => u.role === 'housekeeper' && u.name !== 'Ana Cruz');
  const req2 = await (async () => {
    const fd2 = await browser(); await fd2.login('6767');
    return fd2.window.SIROMS.api.createGuestRequest({ roomId: room203._id, items: [{ name: 'Extra towels', qty: 2, price: 0 }] });
  })();
  await sup.window.SIROMS.api.assignGuestRequest(req2._id, String(other._id));
  const ana2 = await browser(); await ana2.login('2211'); await ana2.go('housekeeping');
  ok("another housekeeper's request is NOT on Ana's board",
    !ana2.column('Assigned').includes('Extra towels'));

  server.close();
  console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
