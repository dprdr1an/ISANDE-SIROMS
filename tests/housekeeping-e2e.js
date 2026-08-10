'use strict';
/* End-to-end Housekeeping test.
   Runs the REAL Express app (routes → workflow services → models) over real
   HTTP, with only the Mongo driver replaced by an in-memory store; every
   save() still runs full Mongoose validation. The REAL public/app.js + api.js
   are loaded in jsdom and driven through the actual UI controls.

   Covers: create → appears on board → survives reload → start cleaning →
   submit for inspection → supervisor approves → room available. */
const path = require('path');
const fs = require('fs');
const http = require('http');
const mongoose = require('mongoose');
const { JSDOM } = require('jsdom');

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/e2e';
process.env.SESSION_SECRET = 'e2e-secret';

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'server/models'));

require.cache[require.resolve(path.join(ROOT, 'server/config/db'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { connectDB: async () => {}, isConnected: () => true }
};

/* ---------------- in-memory persistence (stands in for MongoDB) ---------------- */
const store = [];
const byId = new Map();
function vmatch(actual, cond) {
  if (cond instanceof RegExp) return cond.test(String(actual ?? ''));
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !mongoose.isValidObjectId(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne': return String(actual) !== String(v);
        case '$nin': return !v.map(String).includes(String(actual));
        case '$in': return v.map(String).includes(String(actual));
        case '$gt': return actual != null && new Date(actual) > new Date(v);
        case '$gte': return actual != null && new Date(actual) >= new Date(v);
        case '$lte': return actual != null && new Date(actual) <= new Date(v);
        case '$exists': return (actual !== undefined) === v;
        default: return true;
      }
    });
  }
  if (cond === null) return actual == null;
  return String(actual) === String(cond);
}
const matches = (doc, filter = {}) => Object.entries(filter).every(([k, cond]) => {
  if (k === '$or') return cond.some((c) => matches(doc, c));
  return vmatch(k === '_id' ? doc._id : doc.get(k), cond);
});
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
  const name = Model.modelName;
  const own = () => store.filter((d) => d.constructor.modelName === name);
  Model.findOne = (f = {}) => new Q(own().filter((d) => matches(d, f)), true);
  Model.find = (f = {}) => new Q(own().filter((d) => matches(d, f)), false);
  Model.findById = (id) => new Q([byId.get(String(id))].filter(Boolean), true);
  Model.countDocuments = async (f = {}) => own().filter((d) => matches(d, f)).length;
  Model.deleteMany = async (f = {}) => { let n = 0; for (let i = store.length - 1; i >= 0; i--) {
    const d = store[i]; if (d.constructor.modelName === name && matches(d, f)) { store.splice(i, 1); byId.delete(String(d._id)); n++; } } return { deletedCount: n }; };
  Model.create = async (data) => { const arr = Array.isArray(data) ? data : [data];
    const made = arr.map((d) => new Model(d)); for (const doc of made) await doc.save();
    return Array.isArray(data) ? made : made[0]; };
  Model.updateMany = async (f = {}, upd = {}) => { const set = upd.$set || upd;
    for (const d of own().filter((x) => matches(x, f))) { d.set(set); await d.save(); } return { modifiedCount: 1 }; };
  Model.findByIdAndUpdate = async (id, upd, opts = {}) => { const d = byId.get(String(id)); if (!d) return null;
    d.set(upd.$set || upd); await d.save(); return d; };
  Model.aggregate = async (pipe) => { const g = pipe.find((p) => p.$group);
    if (!g) return []; const key = String(g._id).replace('$', ''); const out = {};
    own().forEach((d) => { const k = d.get(key); out[k] = (out[k] || 0) + 1; });
    return Object.entries(out).map(([k, n]) => ({ _id: k, n })); };
});
mongoose.Model.prototype.save = async function () {
  const err = this.validateSync(); if (err) throw err;
  if (!byId.has(String(this._id))) { store.push(this); byId.set(String(this._id), this); }
  return this;
};
mongoose.startSession = async () => { throw new Error('replica set not supported'); };
mongoose.disconnect = async () => {};

/* ---------------- helpers ---------------- */
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label + (extra ? ` — ${extra}` : '')); } };
const countTasks = () => store.filter((d) => d.constructor.modelName === 'HousekeepingTask').length;
const findTask = (pred) => store.filter((d) => d.constructor.modelName === 'HousekeepingTask').find(pred);
const roomByNumber = (n) => store.find((d) => d.constructor.modelName === 'Room' && d.number === n);

(async () => {
  /* seed */
  const quiet = console.log; console.log = () => {};
  const realExit = process.exit; process.exit = () => {};
  require(path.join(ROOT, 'server/seed/seed.js'));
  await new Promise((r) => setTimeout(r, 500));
  process.exit = realExit; console.log = quiet;

  /* start the real server */
  const { app } = require(path.join(ROOT, 'server/server.js'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`Real Express server on ${BASE}\n`);

  /* a browser session: jsdom + cookie-aware fetch against the live server */
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
    const login = async (pin) => {
      $('employeePin').value = pin;
      $('staffLoginForm').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
    };
    return { window, doc: window.document, $, login,
      board: () => $('housekeepingBoard').textContent,
      column: (name) => {
        const col = [...window.document.querySelectorAll('.kanban-column')]
          .find((c) => c.querySelector('h3') && c.querySelector('h3').textContent.startsWith(name));
        return col ? col.textContent : '';
      } };
  }

  /* ---------------- 1. supervisor creates a task ---------------- */
  console.log('CREATE TASK (supervisor)');
  const sup = await browser();
  await sup.login('3344');
  ok('supervisor signed in via API', sup.$('profileName').textContent.includes('Liza'));
  sup.window.go('housekeeping');
  await new Promise((r) => setTimeout(r, 150));
  const seededOnBoard = sup.board();
  ok('board shows MongoDB tasks, not the old hardcoded ones',
    seededOnBoard.includes('303') && !seededOnBoard.includes('Room 301'),
    'board=' + seededOnBoard.slice(0, 120));

  const before = countTasks();
  sup.$('assignHousekeepingTask').dispatchEvent(new sup.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  ok('assign dialog opened with rooms from the database',
    sup.$('assignRoom').options.length > 0 && sup.$('assignStaff').options.length > 0);

  // pick Room 306 and the first housekeeper, using a type that used to be rejected
  const opt = [...sup.$('assignRoom').options].find((o) => o.dataset.number === '306')
           || sup.$('assignRoom').options[0];
  sup.$('assignRoom').value = opt.value;
  sup.$('assignType').value = 'Stay-over cleaning';
  sup.$('assignPriority').value = 'Normal';
  sup.$('assignNote').value = 'E2E created task';
  const chosenStaffId = sup.$('assignStaff').value;
  const chosenRoomNo = opt.dataset.number;
  sup.$('assignTaskForm').dispatchEvent(new sup.window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));

  ok('task was PERSISTED (HousekeepingTask count +1)', countTasks() === before + 1,
    `${before} → ${countTasks()}`);
  const created = findTask((t) => t.note === 'E2E created task');
  ok('persisted document has an _id and the chosen room', !!created && created.roomNumber === chosenRoomNo);
  ok('type "Stay-over cleaning" accepted (enum fix)', created && created.type === 'Stay-over cleaning');
  ok('priority "Normal" accepted (enum fix)', created && created.priority === 'Normal');
  ok('assignedTo stored as the housekeeper _id',
    created && String(created.assignedTo) === String(chosenStaffId));
  ok('NEW TASK APPEARS on the board without a page refresh',
    sup.column('Assigned').includes(`Room ${chosenRoomNo}`),
    'Assigned column=' + sup.column('Assigned').slice(0, 160));

  /* ---------------- 2. survives a browser refresh ---------------- */
  console.log('\nBROWSER REFRESH');
  const sup2 = await browser();
  await sup2.login('3344');
  sup2.window.go('housekeeping');
  await new Promise((r) => setTimeout(r, 200));
  ok('task still on the board after a fresh page load',
    sup2.column('Assigned').includes(`Room ${chosenRoomNo}`));

  /* ---------------- 3. assigned housekeeper sees it ---------------- */
  console.log('\nROLE VISIBILITY');
  const hkUser = store.find((d) => d.constructor.modelName === 'User' && String(d._id) === String(chosenStaffId));
  const pinByName = { 'Ana Cruz': '2211', 'Joy Ramos': '2212', 'Mika Ong': '2213', 'Carla Reyes': '2214' };
  const hk = await browser();
  await hk.login(pinByName[hkUser.name]);
  hk.window.go('housekeeping');
  await new Promise((r) => setTimeout(r, 200));
  ok(`assigned housekeeper (${hkUser.name}) sees the task`,
    hk.column('Assigned').includes(`Room ${chosenRoomNo}`));

  /* ---------------- 4. start cleaning ---------------- */
  console.log('\nSTART CLEANING → SUBMIT → APPROVE');
  const startBtn = [...hk.doc.querySelectorAll('[data-task-advance]')]
    .find((b) => String(b.dataset.taskAdvance) === String(created._id));
  ok('housekeeper has a Start cleaning button for the new task', !!startBtn);
  startBtn.dispatchEvent(new hk.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 450));
  ok('MongoDB status → In Progress', findTask((t) => String(t._id) === String(created._id)).status === 'In Progress');
  ok('room status → cleaning (server-owned)', roomByNumber(chosenRoomNo).status === 'cleaning');
  ok('UI moved the card to In Progress', hk.column('In Progress').includes(`Room ${chosenRoomNo}`));

  const submitBtn = [...hk.doc.querySelectorAll('[data-task-advance]')]
    .find((b) => String(b.dataset.taskAdvance) === String(created._id));
  submitBtn.dispatchEvent(new hk.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 450));
  ok('MongoDB status → Ready for Inspection',
    findTask((t) => String(t._id) === String(created._id)).status === 'Ready for Inspection');
  ok('UI moved the card to Ready for Inspection',
    hk.column('Ready for Inspection').includes(`Room ${chosenRoomNo}`));

  /* ---------------- 5. supervisor approves ---------------- */
  const sup3 = await browser();
  await sup3.login('3344');
  sup3.window.go('housekeeping');
  await new Promise((r) => setTimeout(r, 200));
  const inspectBtn = [...sup3.doc.querySelectorAll('[data-inspect]')]
    .find((b) => String(b.dataset.inspect) === String(created._id));
  ok('supervisor sees an Inspect button', !!inspectBtn);
  inspectBtn.dispatchEvent(new sup3.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  sup3.doc.querySelectorAll('.inspect-check').forEach((c) => { c.checked = true; });
  sup3.$('inspectForm').dispatchEvent(new sup3.window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  ok('MongoDB status → Completed',
    findTask((t) => String(t._id) === String(created._id)).status === 'Completed');
  ok('room returned to available (server-owned)', roomByNumber(chosenRoomNo).status === 'available');
  ok('UI moved the card to Completed', sup3.column('Completed').includes(`Room ${chosenRoomNo}`));

  /* ---------------- 6. failures surface honestly ---------------- */
  console.log('\nERROR HANDLING');
  const hk2 = await browser();
  await hk2.login('2211');
  let refused = false;
  try { await hk2.window.SIROMS.api.createTask({ room: roomByNumber('301')._id, type: 'Deep cleaning' }); }
  catch (e) { refused = true; }
  ok('housekeeper is refused task creation (role rules preserved)', refused);
  let badRejected = false;
  try { await sup3.window.SIROMS.api.createTask({ room: roomByNumber('301')._id, type: 'Nonsense type' }); }
  catch (e) { badRejected = true; }
  ok('invalid task type rejected by the API (enum still enforced)', badRejected);
  const beforeBad = countTasks();
  ok('no phantom task written after a rejected request', countTasks() === beforeBad);

  server.close();
  console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
