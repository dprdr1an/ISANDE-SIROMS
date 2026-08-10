'use strict';
/* Offline test suite — everything verifiable WITHOUT a live MongoDB.
   Covers: schema validation, business-rule validators, deposit maths,
   inventory maths, route registration, role matrix, API-client surface.
   Live cross-role integration tests require a real database (see README). */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const path = require('path');
const mongoose = require('mongoose');
const M = require('../server/models');
const { PAGE_PERMISSIONS } = require('../server/middleware/auth');

let pass = 0, fail = 0;
const oid = () => new mongoose.Types.ObjectId();
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}
const errs = (doc) => { const e = doc.validateSync(); return e ? Object.keys(e.errors) : []; };
const section = (t) => console.log('\n' + t);

/* ---------------- models ---------------- */
section('Models — required fields & enums');
ok('Room rejects bad number/floor/type/rate/status',
  ['number', 'floor', 'type', 'rate', 'status'].every((k) =>
    errs(new M.Room({ number: '', floor: 0, type: 'Suite', capacity: 1, rate: -5, status: 'nope' })).includes(k)));
ok('Room accepts a valid document',
  errs(new M.Room({ number: '101', floor: 1, type: 'Standard', capacity: 2, rate: 1800 })).length === 0);
ok('Reservation rejects checkout before checkin',
  errs(new M.Reservation({ ref: 'R', guest: 'G', roomType: 'Standard',
    checkIn: new Date('2026-08-10'), checkOut: new Date('2026-08-09'), total: 100 })).includes('checkOut'));
ok('Reservation balance virtual computes',
  new M.Reservation({ ref: 'R', guest: 'G', roomType: 'Standard', checkIn: new Date(),
    checkOut: new Date(Date.now() + 864e5), total: 3600, paid: 1000 }).balance === 2600);
ok('User rejects an unknown role', errs(new M.User({ staffId: 'X', pin: '1234', name: 'A', role: 'chef' })).includes('role'));
ok('User rejects a non-4-digit PIN', errs(new M.User({ staffId: 'X', pin: '12', name: 'A', role: 'manager' })).includes('pin'));
ok('User hides the PIN in JSON',
  new M.User({ staffId: 'X', pin: '1234', name: 'A', role: 'manager' }).toJSON().pin === undefined);
ok('Transaction rejects bad type and non-numeric amount',
  ['type', 'amount'].every((k) => errs(new M.Transaction({ code: 'T', type: 'Bogus', amount: 'abc' })).includes(k)));
ok('Notification requires title and message',
  ['title', 'message'].every((k) => errs(new M.Notification({})).includes(k)));

/* ---------------- business rules ---------------- */
section('Business rules (preserved from the prototype)');
const gr = new M.GuestRequest({ room: oid(), roomNumber: '104', guest: 'P',
  items: [{ name: 'Extra Mattress', qty: 1, price: 500 }], status: 'Assigned' });
ok('Guest request cannot be Assigned without a housekeeper', errs(gr).includes('status'));
gr.assignedTo = oid();
ok('…and is valid once assigned', errs(gr).length === 0);
ok('Guest request requires at least one item',
  errs(new M.GuestRequest({ room: oid(), roomNumber: '1', guest: 'P', items: [] })).includes('items'));
ok('Guest request totalCharge = price × qty', gr.totalCharge === 500);

const tk = new M.MaintenanceTicket({ code: 'MT-1', room: oid(), roomNumber: '306',
  category: 'AC', issue: 'broken', stage: 'assigned' });
ok('Ticket cannot be assigned before assessment', errs(tk).includes('stage'));
tk.priority = 'High';
ok('…and is valid once a priority is set', errs(tk).length === 0);

const lf = new M.LostFoundItem({ code: 'LF-1', item: 'Wallet', category: 'Valuables',
  location: 'Lobby', status: 'Released' });
ok('Lost & found cannot be Released without a claimant', errs(lf).includes('status'));
lf.claimant = 'Marta Yu';
ok('…and is valid with a claimant', errs(lf).length === 0);

/* ---------------- deposit settlement ---------------- */
section('Deposit settlement maths (checkout gate)');
function settle(deposit, findings) {
  const i = new M.Inspection({ room: oid(), roomNumber: '1', reservation: oid(),
    bookingRef: 'R', guest: 'G', deposit, findings });
  return i.settle();
}
let s = settle(1000, []);
ok('No issues → full refund, nothing owed', s.damages === 0 && s.refund === 1000 && s.extra === 0);
s = settle(1000, [{ code: 'I1', category: 'Damaged Item', item: 'Lamp', cost: 400 }]);
ok('Damage under deposit → deduct 400, refund 600', s.applied === 400 && s.refund === 600 && s.extra === 0);
s = settle(1000, [{ code: 'I1', category: 'Damaged Item', item: 'TV', cost: 1500 }]);
ok('Damage over deposit → deposit consumed, 500 extra due', s.applied === 1000 && s.refund === 0 && s.extra === 500);
s = settle(1000, [{ code: 'I1', category: 'Missing Item', item: 'Towel', qty: 2, cost: 300 }]);
ok('Missing items scale by quantity (2 × 300 = 600)', s.damages === 600 && s.refund === 400);
s = settle(1000, [{ code: 'I1', category: 'Damaged Item', item: 'TV', cost: 1500 },
                  { code: 'I2', category: 'Missing Item', item: 'Towel', qty: 2, cost: 300 }]);
ok('Mixed findings total correctly (1500 + 600 = 2100)', s.damages === 2100 && s.extra === 1100);

/* ---------------- inventory ---------------- */
section('Inventory stock maths');
const inv = new M.InventoryItem({ item: 'Towels', category: 'Linen', stock: 10, reorder: 12 });
inv.applyMovement(-4, 'issued', { name: 'Ana' });
ok('Issuing 4 from 10 leaves 6', inv.stock === 6);
ok('Movement history is recorded with before/after',
  inv.movements.length === 1 && inv.movements[0].before === 10 && inv.movements[0].after === 6);
ok('Low-stock flag trips at/below reorder level', inv.low === true);
let blocked = false;
try { inv.applyMovement(-99, 'over', { name: 'Ana' }); } catch { blocked = true; }
ok('Cannot issue more stock than exists', blocked);
inv.applyMovement(20, 'received', { name: 'Liza' });
ok('Receiving stock clears the low flag', inv.stock === 26 && inv.low === false);

/* ---------------- routes ---------------- */
section('API surface');
const { app } = require('../server/server.js');
const routes = [];
(function walk(stack, prefix) {
  stack.forEach((l) => {
    if (l.route) Object.keys(l.route.methods).forEach((m) =>
      routes.push(`${m.toUpperCase()} ${prefix}${l.route.path}`));
    else if (l.name === 'router' && l.handle.stack)
      walk(l.handle.stack, prefix + (l.regexp.source.includes('api') ? '/api' : ''));
  });
})(app._router.stack, '');
const need = [
  'GET /api/rooms', 'GET /api/rooms/:id', 'PATCH /api/rooms/:id',
  'GET /api/reservations', 'POST /api/reservations', 'GET /api/reservations/:id', 'PATCH /api/reservations/:id',
  'GET /api/guest-requests', 'POST /api/guest-requests', 'PATCH /api/guest-requests/:id/assign',
  'GET /api/housekeeping/tasks', 'POST /api/housekeeping/tasks', 'PATCH /api/housekeeping/tasks/:id',
  'GET /api/maintenance/tickets', 'POST /api/maintenance/tickets', 'PATCH /api/maintenance/tickets/:id',
  'GET /api/lost-found', 'POST /api/lost-found', 'PATCH /api/lost-found/:id',
  'GET /api/inventory', 'PATCH /api/inventory/:id',
  'GET /api/transactions', 'POST /api/transactions',
  'GET /api/notifications', 'PATCH /api/notifications/:id'
];
need.forEach((r) => ok(`route ${r}`, routes.includes(r)));
ok('health endpoint exists', routes.includes('GET /api/health'));
ok('workflow endpoints exist', ['POST /api/reservations/:id/check-in',
  'POST /api/reservations/:id/start-checkout', 'POST /api/reservations/:id/complete-checkout',
  'PATCH /api/inspections/:id/submit', 'PATCH /api/housekeeping/tasks/:id/advance',
  'PATCH /api/housekeeping/tasks/:id/review', 'PATCH /api/maintenance/tickets/:id/assess']
  .every((r) => routes.includes(r)));
ok('dashboard is computed server-side', routes.includes('GET /api/dashboard'));

/* ---------------- roles ---------------- */
section('Role matrix preserved');
const expected = {
  frontdesk: 8, housekeeper: 7, supervisor: 9, maintenance: 4, manager: 12
};
Object.entries(expected).forEach(([role, n]) =>
  ok(`${role} keeps ${n} permitted pages`, PAGE_PERMISSIONS[role].length === n,
     `got ${PAGE_PERMISSIONS[role].length}`));
ok('maintenance cannot reach housekeeping', !PAGE_PERMISSIONS.maintenance.includes('housekeeping'));
ok('housekeeper cannot reach transactions', !PAGE_PERMISSIONS.housekeeper.includes('transactions'));
ok('only manager reaches reports',
  PAGE_PERMISSIONS.manager.includes('reports') &&
  !['frontdesk', 'housekeeper', 'supervisor', 'maintenance'].some((r) => PAGE_PERMISSIONS[r].includes('reports')));

/* ---------------- modules load ---------------- */
section('Modules load cleanly');
const W = require('../server/services/workflows');
['checkIn', 'walkIn', 'startCheckout', 'submitInspection', 'completeCheckout', 'advanceTask',
 'reviewTask', 'createGuestRequest', 'assignGuestRequest', 'advanceGuestRequest',
 'reportIssue', 'assessTicket', 'updateTicket'].forEach((fn) =>
  ok(`workflow ${fn}() exported`, typeof W[fn] === 'function'));
ok('seed script parses', (() => {
  try { new (require('vm').Script)(require('fs').readFileSync(
    path.join(__dirname, '../server/seed/seed.js'), 'utf8')); return true; } catch { return false; }
})());
ok('frontend api.js parses', (() => {
  try { new (require('vm').Script)(require('fs').readFileSync(
    path.join(__dirname, '../public/api.js'), 'utf8')); return true; } catch { return false; }
})());
ok('.gitignore ignores .env',
  require('fs').readFileSync(path.join(__dirname, '../.gitignore'), 'utf8')
    .split('\n').some((l) => l.trim() === '.env'));
ok('no MongoDB URI hardcoded in source', (() => {
  const fs = require('fs');
  const files = ['server/server.js', 'server/config/db.js', 'server/routes/api.js',
                 'server/services/workflows.js', 'server/seed/seed.js', 'public/api.js'];
  return !files.some((f) => /mongodb(\+srv)?:\/\/(?!127\.0\.0\.1)/.test(
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
})());

console.log(`\n${'='.repeat(52)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
