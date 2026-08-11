'use strict';
/* Verifies the authoritative pricing and John Dela Cruz's exact starting state
   by running the REAL seed offline with full Mongoose validation. */
const path = require('path');
const mongoose = require('mongoose');
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/pricing';
process.env.SESSION_SECRET = 'pricing';

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'server/models'));
const { ROOM_TYPES, DEPOSIT } = require(path.join(ROOT, 'server/models/constants'));

require.cache[require.resolve(path.join(ROOT, 'server/config/db'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { connectDB: async () => {}, isConnected: () => true }
};

const store = []; const byId = new Map();
const matches = (d, f = {}) => Object.entries(f).every(([k, v]) =>
  String(k === '_id' ? d._id : d.get(k)) === String(v));
class Q {
  constructor(r, s) { this.rows = r; this.single = s; }
  sort() { return this; } session() { return this; } populate() { return this; }
  select() { return this; } lean() { return this; }
  then(res) { res(this.single ? (this.rows[0] || null) : this.rows); }
}
Object.values(M).forEach((Model) => {
  if (!Model || !Model.modelName) return;
  const n = Model.modelName; const own = () => store.filter((d) => d.constructor.modelName === n);
  Model.findOne = (f = {}) => new Q(own().filter((d) => matches(d, f)), true);
  Model.find = (f = {}) => new Q(own().filter((d) => matches(d, f)), false);
  Model.findById = (id) => new Q([byId.get(String(id))].filter(Boolean), true);
  Model.countDocuments = async () => own().length;
  Model.deleteMany = async () => { for (let i = store.length - 1; i >= 0; i--)
    if (store[i].constructor.modelName === n) { byId.delete(String(store[i]._id)); store.splice(i, 1); } return {}; };
  Model.create = async (d) => { const a = Array.isArray(d) ? d : [d];
    const m = a.map((x) => new Model(x)); for (const doc of m) await doc.save(); return Array.isArray(d) ? m : m[0]; };
});
mongoose.Model.prototype.save = async function () { const e = this.validateSync(); if (e) throw e;
  if (!byId.has(String(this._id))) { store.push(this); byId.set(String(this._id), this); } return this; };
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

  console.log('AUTHORITATIVE PRICING');
  ok('Standard rate = ₱1,800', ROOM_TYPES.Standard.rate === 1800);
  ok('Family rate = ₱2,600', ROOM_TYPES.Family.rate === 2600);
  ok('Security deposit = ₱1,000', DEPOSIT === 1000);
  ok('deposit is NOT folded into either rate',
    ROOM_TYPES.Standard.rate !== 2800 && ROOM_TYPES.Family.rate !== 3600);

  const rooms = docs('Room');
  ok('every Standard room in the DB is ₱1,800',
    rooms.filter((r) => r.type === 'Standard').every((r) => r.rate === 1800));
  ok('every Family room in the DB is ₱2,600',
    rooms.filter((r) => r.type === 'Family').every((r) => r.rate === 2600));
  ok('no room record carries a deposit-inflated rate',
    rooms.every((r) => r.rate !== 2800 && r.rate !== 3600));

  console.log('\nNO DUPLICATE PRICE TABLE IN THE FRONTEND');
  const appjs = require('fs').readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  ok('public/app.js defines no room rates', !/ROOM_TYPES\s*=\s*\{[^}]*rate\s*:/.test(appjs));
  ok('public/app.js reads the rate from the room record', /rateOf\s*=/.test(appjs));

  console.log('\nDERIVED TOTALS (accommodation only)');
  const bad = docs('Reservation').filter((r) => {
    const n = Math.round((r.checkOut - r.checkIn) / 86400000) || 1;
    return r.total !== ROOM_TYPES[r.roomType].rate * n;
  });
  ok('every reservation total = rate × nights', bad.length === 0,
    bad.map((b) => `${b.ref} ${b.total}`).join(', '));
  ok('no reservation total includes the deposit',
    docs('Reservation').every((r) => r.total % 100 === 0 && r.total !== r.total + DEPOSIT));
  ok('every reservation stores the deposit separately',
    docs('Reservation').every((r) => r.deposit === DEPOSIT));

  console.log('\nJOHN DELA CRUZ — INITIAL STATE');
  const john = docs('Reservation').find((r) => r.guest === 'John Dela Cruz');
  ok('reservation exists', !!john);
  ok('reference SSR-2026-9001', john.ref === 'SSR-2026-9001');
  ok('status Confirmed', john.status === 'Confirmed');
  ok('Standard room type', john.roomType === 'Standard');
  ok('one night', Math.round((john.checkOut - john.checkIn) / 86400000) === 1);
  ok('accommodation ₱1,800', john.total === 1800);
  ok('deposit ₱1,000 held separately', john.deposit === 1000);
  ok('deposit NOT yet collected (taken at check-in)', john.depositCollected === false);
  ok('initial amount due = ₱2,800', (john.total - john.paid) + john.deposit === 2800);
  ok('contact details populated', !!john.contact);
  ok('folio line present', john.folio.length === 1 && john.folio[0].amount === 1800);
  ok('NOT checked in', !john.checkedInAt && john.status !== 'Checked in');
  ok('no room assigned yet (assigned at check-in)', !john.room);

  console.log('\nROOM 203 HAS NO CONFLICTS');
  const r203 = rooms.find((r) => r.number === '203');
  ok('Room 203 is Available', r203.status === 'available');
  ok('Room 203 has no current reservation', !r203.currentReservation);
  ok('Room 203 rate is ₱1,800', r203.rate === 1800);
  ok('no other reservation occupies Room 203',
    !docs('Reservation').some((r) => String(r.room) === String(r203._id)));
  ok('no maintenance ticket for Room 203',
    !docs('MaintenanceTicket').some((t) => t.roomNumber === '203'));
  ok('no broken-lamp ticket anywhere', !docs('MaintenanceTicket').some((t) => /lamp/i.test(t.issue)));
  ok('no inspection for Room 203', !docs('Inspection').some((i) => i.roomNumber === '203'));
  ok('no housekeeping task for Room 203', !docs('HousekeepingTask').some((t) => t.roomNumber === '203'));
  ok('no guest request for Room 203', !docs('GuestRequest').some((g) => g.roomNumber === '203'));
  ok('no Apple Watch in lost & found', !docs('LostFoundItem').some((l) => /watch/i.test(l.item)));

  console.log('\nWORKFLOW NOT PRE-COMPLETED');
  ok('no inspection exists at all', docs('Inspection').length === 0);
  ok('no transaction against John', !docs('Transaction').some((t) => t.bookingRef === 'SSR-2026-9001'));
  ok('John has no checkout record', !john.checkedOutAt && john.inspectionState === 'none');

  console.log('\nBACKGROUND DATA PRESENT');
  ['User', 'Room', 'Reservation', 'HousekeepingTask', 'MaintenanceTicket',
   'LostFoundItem', 'InventoryItem', 'Transaction', 'GuestRequest'].forEach((n) =>
    ok(`${n}: ${docs(n).length} records`, docs(n).length > 0));
  const statuses = new Set(rooms.map((r) => r.status));
  ok('rooms show a mix of statuses', statuses.size >= 3, [...statuses].join(', '));

  console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
