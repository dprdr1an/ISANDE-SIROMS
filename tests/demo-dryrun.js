'use strict';
/* Runs the REAL server/seed/seed.js then server/seed/demo.js (twice) against an
   in-memory stub of the persistence layer. Every save() still goes through full
   Mongoose document validation, so business rules are genuinely enforced.
   Verifies: base seed unaffected, demo starting state correct, and that running
   the demo seed twice creates no duplicates. */
const path = require('path');
const mongoose = require('mongoose');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dryrun';
process.env.SESSION_SECRET = 'dry-run';

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'server/models'));

require.cache[require.resolve(path.join(ROOT, 'server/config/db'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { connectDB: async () => {}, isConnected: () => true }
};

const store = [];                 // every saved document
const byId = new Map();
const failures = [];

/* ---- filter matching (supports the operators the seeds actually use) ---- */
function valueMatches(actual, cond) {
  if (cond instanceof RegExp) return cond.test(String(actual ?? ''));
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !mongoose.isValidObjectId(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$ne':  return String(actual) !== String(v);
        case '$nin': return !v.map(String).includes(String(actual));
        case '$in':  return v.map(String).includes(String(actual));
        case '$gt':  return actual != null && new Date(actual) > new Date(v);
        case '$lt':  return actual != null && new Date(actual) < new Date(v);
        case '$exists': return (actual !== undefined) === v;
        default: return true;
      }
    });
  }
  if (cond === null) return actual == null || String(actual) === 'null';
  return String(actual) === String(cond);
}
const matches = (doc, filter = {}) => Object.entries(filter).every(([k, cond]) => {
  const actual = k === '_id' ? doc._id : doc.get(k);
  return valueMatches(actual, cond);
});

/* ---- a thenable query supporting .sort() / .session() ---- */
class FakeQuery {
  constructor(rows, single) { this.rows = rows; this.single = single; }
  sort(spec) {
    const [f, dir] = Object.entries(spec || {})[0] || [];
    if (f) this.rows = [...this.rows].sort((a, b) => {
      const x = String(a.get(f) ?? ''), y = String(b.get(f) ?? '');
      return (x < y ? -1 : x > y ? 1 : 0) * (dir < 0 ? -1 : 1);
    });
    return this;
  }
  session() { return this; }
  populate() { return this; }
  lean() { return this; }
  select() { return this; }
  then(res, rej) { try { res(this.single ? (this.rows[0] || null) : this.rows); } catch (e) { rej(e); } }
}

Object.values(M).forEach((Model) => {
  if (!Model || !Model.modelName) return;
  const name = Model.modelName;
  const own = () => store.filter((d) => d.constructor.modelName === name);
  Model.findOne = (filter = {}) => new FakeQuery(own().filter((d) => matches(d, filter)), true);
  Model.find = (filter = {}) => new FakeQuery(own().filter((d) => matches(d, filter)), false);
  Model.findById = (id) => new FakeQuery([byId.get(String(id))].filter(Boolean), true);
  Model.countDocuments = async (filter = {}) => own().filter((d) => matches(d, filter)).length;
  Model.deleteMany = async (filter = {}) => {
    let n = 0;
    for (let i = store.length - 1; i >= 0; i--) {
      const d = store[i];
      if (d.constructor.modelName === name && matches(d, filter)) { store.splice(i, 1); byId.delete(String(d._id)); n++; }
    }
    return { deletedCount: n };
  };
  Model.create = async (data) => {
    const arr = Array.isArray(data) ? data : [data];
    const made = arr.map((d) => new Model(d));
    for (const doc of made) await doc.save();
    return Array.isArray(data) ? made : made[0];
  };
});

mongoose.Model.prototype.save = async function save() {
  const err = this.validateSync();
  if (err) {
    failures.push({ model: this.constructor.modelName,
      key: this.code || this.ref || this.number || this.staffId || this.item || '(n/a)',
      errors: Object.entries(err.errors).map(([f, e]) => `${f}: ${e.message}`) });
    throw err;
  }
  if (!byId.has(String(this._id))) { store.push(this); byId.set(String(this._id), this); }
  return this;
};
mongoose.disconnect = async () => {};

const realExit = process.exit;
let exitCode = null;
process.exit = (c) => { exitCode = c; };

const count = (n) => store.filter((d) => d.constructor.modelName === n).length;
const find1 = (n, pred) => store.find((d) => d.constructor.modelName === n && pred(d));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label + (extra ? ` — ${extra}` : '')); }
};

function runScript(file) {
  exitCode = null;
  delete require.cache[require.resolve(path.join(ROOT, file))];
  require(path.join(ROOT, file));
  return new Promise((r) => setTimeout(r, 500));
}

(async () => {
  const quiet = console.log; let muted = false;
  const mute = () => { muted = true; console.log = () => {}; };
  const unmute = () => { muted = false; console.log = quiet; };

  console.log('Dry run: base seed → demo seed → demo seed again (no database)\n');

  mute(); await runScript('server/seed/seed.js'); unmute();
  console.log('BASE SEED');
  ok('base seed completed without validation failure', failures.length === 0 && exitCode === 0);
  const baseCounts = {
    Room: count('Room'), Reservation: count('Reservation'), User: count('User'),
    MaintenanceTicket: count('MaintenanceTicket'), HousekeepingTask: count('HousekeepingTask'),
    LostFoundItem: count('LostFoundItem'), GuestRequest: count('GuestRequest'),
    InventoryItem: count('InventoryItem'), Transaction: count('Transaction')
  };
  ok('18 rooms / 12 reservations / 4 tickets seeded',
    baseCounts.Room === 18 && baseCounts.Reservation === 12 && baseCounts.MaintenanceTicket === 4);
  const room203 = find1('Room', (d) => d.number === '203');
  // The rebuilt seed reserves Room 203 for the demo: it must start clean.
  ok('Room 203 starts AVAILABLE with no occupant (reserved for the demo)',
    room203.status === 'available' && !room203.currentReservation);
  ok('no background record touches Room 203',
    !find1('MaintenanceTicket', (d) => d.roomNumber === '203') &&
    !find1('HousekeepingTask', (d) => d.roomNumber === '203') &&
    !find1('GuestRequest', (d) => d.roomNumber === '203'));

  /* ---------- first demo run ---------- */
  mute(); await runScript('server/seed/demo.js'); unmute();
  console.log('\nDEMO SEED — first run');
  ok('demo seed completed without validation failure', failures.length === 0 && exitCode === 0,
    failures.map((f) => `${f.model} ${f.key}: ${f.errors}`).join(' | '));

  const john = find1('Reservation', (d) => d.ref === 'SSR-2026-9001');
  ok('John Dela Cruz reservation SSR-2026-9001 created', !!john);
  ok('status is Confirmed (check-in can be demonstrated)', john && john.status === 'Confirmed');
  ok('one night, Standard, deposit ₱1,000 held separately',
    john && john.adults === 1 && john.roomType === 'Standard' && john.deposit === 1000);
  ok('accommodation ₱1,800 with the deposit NOT folded in',
    john && john.total === 1800 && john.depositCollected === false);
  ok('no room pre-assigned (assigned live at check-in)', john && !john.room);
  ok('storyline NOT pre-completed (not checked in/out)',
    john && !john.checkedInAt && !john.checkedOutAt && john.inspectionState === 'none');

  const r203 = find1('Room', (d) => d.number === '203');
  ok('Room 203 is now AVAILABLE so check-in will succeed', r203.status === 'available');
  ok('Room 203 has no current reservation', !r203.currentReservation);

  ok('no relocation was needed — Room 203 was already free',
    !find1('Reservation', (d) => d.ref !== 'SSR-2026-9001' && String(d.room) === String(r203._id)));
  ok('other in-house guests untouched',
    store.filter((d) => d.constructor.modelName === 'Reservation' && d.status === 'Checked in').length >= 5);

  ok('nothing pre-created: no inspection for the demo stay',
    !find1('Inspection', (d) => String(d.reservation) === String(john._id)));
  ok('nothing pre-created: no housekeeping task for the demo stay',
    !find1('HousekeepingTask', (d) => String(d.reservation) === String(john._id)));
  ok('nothing pre-created: no lost & found item for Room 203',
    !find1('LostFoundItem', (d) => String(d.room) === String(r203._id)));
  ok('base maintenance tickets untouched (still 4)', count('MaintenanceTicket') === 4);
  ok('base lost & found untouched (still 3)', count('LostFoundItem') === 3);
  ok('base inventory untouched (still 8)', count('InventoryItem') === 8);
  ok('base rooms untouched (still 18 — Room 203 reused, not duplicated)', count('Room') === 18);
  ok('base staff untouched (still 9 — accounts reused)', count('User') === 9);

  const afterFirst = {
    Reservation: count('Reservation'), Transaction: count('Transaction'),
    Room: count('Room'), MaintenanceTicket: count('MaintenanceTicket')
  };

  /* ---------- second demo run: idempotency ---------- */
  mute(); await runScript('server/seed/demo.js'); unmute();
  console.log('\nDEMO SEED — second run (idempotency)');
  ok('second run completed cleanly', failures.length === 0 && exitCode === 0);
  ok('no duplicate reservations',
    count('Reservation') === afterFirst.Reservation,
    `${afterFirst.Reservation} → ${count('Reservation')}`);
  ok('only ONE John Dela Cruz reservation exists',
    store.filter((d) => d.constructor.modelName === 'Reservation' && d.guest === 'John Dela Cruz').length === 1);
  ok('no duplicate transactions', count('Transaction') === afterFirst.Transaction);
  ok('no duplicate rooms', count('Room') === afterFirst.Room);
  ok('no duplicate maintenance tickets', count('MaintenanceTicket') === afterFirst.MaintenanceTicket);
  const john2 = find1('Reservation', (d) => d.ref === 'SSR-2026-9001');
  ok('demo reservation still in the Confirmed starting state', john2.status === 'Confirmed');
  ok('Room 203 still available after re-run',
    find1('Room', (d) => d.number === '203').status === 'available');

  /* ---------- business rules still enforced ---------- */
  console.log('\nBUSINESS RULES STILL ENFORCED');
  const oid = () => new mongoose.Types.ObjectId();
  ok('ticket cannot be assigned before assessment',
    !!new M.MaintenanceTicket({ code: 'Z1', room: oid(), roomNumber: '203', category: 'Electrical',
      issue: 'Broken bedside lamp', stage: 'assigned', assignedToName: 'Carlo Diaz' }).validateSync());
  ok('…and is valid once assessed',
    !new M.MaintenanceTicket({ code: 'Z2', room: oid(), roomNumber: '203', category: 'Electrical',
      issue: 'Broken bedside lamp', stage: 'assigned', priority: 'Low', assignedToName: 'Carlo Diaz' }).validateSync());
  ok('lost & found cannot be released without a claimant',
    !!new M.LostFoundItem({ code: 'Z3', item: 'Apple Watch', category: 'Electronics',
      location: 'Room 203', status: 'Released' }).validateSync());
  const insp = new M.Inspection({ room: oid(), roomNumber: '203', reservation: oid(),
    bookingRef: 'SSR-2026-9001', guest: 'John Dela Cruz', deposit: 1000,
    findings: [{ code: 'INC-9001', category: 'Damaged Item', item: 'Bedside lamp', cost: 650 }] });
  const s = insp.settle();
  ok('broken lamp ₱650 deducted from ₱1000 deposit → ₱350 refund',
    s.damages === 650 && s.applied === 650 && s.refund === 350 && s.extra === 0);

  process.exit = realExit;
  console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nValidation failures:'); failures.forEach((f) => console.log(' ', f)); }
  process.exit(fail || failures.length ? 1 : 0);
})();
