'use strict';
/**
 * End-to-end API tests (Node's built-in runner): `npm test`
 *
 * Uses MONGODB_URI from backend/.env but ALWAYS the database "siroms_test",
 * which is wiped and reseeded at the start. Requires SEED_PASSWORD in .env.
 * Covers the brief's tests A–I against a real MongoDB server.
 */
process.env.MONGODB_DB = 'siroms_test';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SIROMS_SEED_RESET = '1';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('../src/config/env');
const M = require('../src/models');
const { connectDB, disconnectDB } = require('../src/config/db');
const { createApp } = require('../src/app');
const { seed } = require('../scripts/seed');
const staff = require('../src/services/staffService');
const { fromLocal, today, addDays, timeLabel, clockLabel } = require('../src/utils/time');
const TEST_START = new Date();

if (env.MONGODB_DB !== 'siroms_test') throw new Error('Refusing to run tests outside siroms_test.');
const PW = process.env.SEED_PASSWORD;
let server, base;

async function startServer() {
  const app = createApp();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stopServer() { await new Promise(ok => server.close(ok)); }

/** Minimal client with its own cookie jar. */
function client() {
  let cookie = '';
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (csrf) headers['X-SIROMS-Request'] = '1'; }
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; call.rawCookie = set; }
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json && json.data, error: json && json.error };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}, o) => call('POST', p, b, o), patch: (p, b = {}) => call('PATCH', p, b),
    login: async staffId => { const r = await call('POST', '/api/auth/login', { staffId, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; },
    get cookie() { return cookie; }, set cookie(v) { cookie = v; }, raw: call
  };
}
const fd = client(), hk = client(), hk2 = client(), sup = client(), mt = client(), mgr = client();
const state = c => c.get('/api/state').then(r => r.data);
const room = async (c, n) => (await state(c)).rooms.find(r => r.n === n);
const txCount = async ref => M.Transaction.countDocuments({ bookingRef: ref });

before(async () => {
  assert.ok(PW && PW.length >= 10, 'Set SEED_PASSWORD (10+ chars) in backend/.env');
  await connectDB();
  await seed();
  await startServer();
  await Promise.all([fd.login('6767'), hk.login('2211'), hk2.login('2212'), sup.login('3344'), mt.login('4455'), mgr.login('5566')]);
});
after(async () => { await stopServer(); await disconnectDB(); });

/* ---------------- TEST I: authentication ---------------- */
test('I. authentication & authorisation', async t => {
  const anon = client();
  await t.test('unauthenticated requests are rejected', async () => {
    assert.equal((await anon.get('/api/state')).status, 401);
    assert.equal((await anon.get('/api/rooms')).status, 401);
  });
  await t.test('invalid credentials are rejected with a generic message', async () => {
    const r = await anon.post('/api/auth/login', { staffId: '6767', password: 'wrong-password' });
    assert.equal(r.status, 401); assert.equal(r.error.code, 'INVALID_CREDENTIALS');
    const u = await anon.post('/api/auth/login', { staffId: '9999', password: 'whatever-123' });
    assert.equal(u.status, 401); assert.equal(u.error.message, r.error.message);
  });
  await t.test('state-changing requests need the CSRF header', async () => {
    const r = await anon.post('/api/auth/login', { staffId: '6767', password: PW }, { csrf: false });
    assert.equal(r.status, 403);
  });
  await t.test('session cookie is HttpOnly and SameSite=Lax', async () => {
    const c = client(); await c.login('6767');
    const raw = c.raw.rawCookie || '';
    assert.match(raw, /HttpOnly/i); assert.match(raw, /SameSite=Lax/i);
  });
  await t.test('role comes from the server, not the client', async () => {
    const me = await hk.get('/api/auth/me');
    assert.equal(me.data.user.role, 'housekeeper');
    const r = await hk.post('/api/inventory/items', { name: 'Hack', category: 'Linen', stock: 1, reorderLevel: 1, role: 'manager' });
    assert.equal(r.status, 403);
  });
  await t.test('password hashes are never returned', async () => {
    const dumps = [await mgr.get('/api/state'), await mgr.get('/api/users/staff'), await fd.get('/api/auth/me')].map(r => JSON.stringify(r.body));
    for (const d of dumps) { assert.ok(!/passwordHash|\$2[aby]\$/.test(d), 'leaked hash'); }
  });
  await t.test('account locks after 5 failed attempts', async () => {
    const c = client();
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { staffId: '2214', password: 'bad-guess-' + i });
    const r = await c.post('/api/auth/login', { staffId: '2214', password: PW });
    assert.equal(r.status, 401); assert.equal(r.error.code, 'LOCKED');
    await M.User.updateOne({ staffId: '2214' }, { $set: { lockedUntil: null, failedLogins: 0 } });
  });
  await t.test('logout ends the session', async () => {
    const c = client(); await c.login('6767');
    assert.equal((await c.get('/api/state')).status, 200);
    const old = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    c.cookie = old;                      // replay the old cookie
    const r = await c.get('/api/state');
    assert.equal(r.status, 401); assert.equal(r.error.code, 'SESSION_EXPIRED');
  });
});

/* ---------------- TEST A: rooms & persistence ---------------- */
test('A. rooms persist across a backend restart', async () => {
  assert.equal((await fd.post('/api/rooms', { number: '401', type: 'Standard' })).status, 403);
  const c = await mgr.post('/api/rooms', { number: '401', type: 'Family' });
  assert.equal(c.status, 201); assert.equal(c.data.status, 'cleaning');
  assert.equal((await mgr.post('/api/rooms', { number: '401', type: 'Family' })).status, 409);
  assert.equal((await mgr.post('/api/rooms', { number: '4A1', type: 'Family' })).status, 400);
  assert.equal((await fd.get('/api/rooms/401')).data.type, 'Family');
  // restart: drop the HTTP server and the DB connection, then reconnect
  await stopServer(); await disconnectDB(); await connectDB(); await startServer();
  const again = await fd.get('/api/rooms/401');
  assert.equal(again.status, 200, 'session and room survive restart'); assert.equal(again.data.number, '401');
  assert.equal((await fd.get('/api/rooms/999')).status, 404);
});

/* ---------------- TEST B: reservations ---------------- */
test('B. reservations: create, retrieve, validation, duplicates', async () => {
  const day = n => { const d = new Date(Date.now() + 8 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const body = { guest: 'Test Guest', contact: '0917 000 0000', checkIn: day(3), checkOut: day(5), roomType: 'Standard', adults: 2, kids: 0, method: 'Cash', amount: 1000, clientRequestId: 'test-res-0001' };
  const r = await fd.post('/api/reservations', body);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.data.status, 'Pending payment'); assert.equal(r.data.total, 3600);
  const again = await fd.post('/api/reservations', body);           // retried submit
  assert.equal(again.data.ref, r.data.ref);
  assert.equal(await txCount(r.data.ref), 1, 'retry must not duplicate the payment');
  const got = await fd.get(`/api/reservations/${r.data.ref}`);
  assert.equal(got.status, 200); assert.equal(got.data.transactions.length, 1);
  assert.equal((await fd.post('/api/reservations', { ...body, clientRequestId: 'test-res-0002', checkOut: day(3) })).status, 422);
  assert.equal((await fd.post('/api/reservations', { ...body, clientRequestId: 'test-res-0003', checkIn: day(-2), checkOut: day(1) })).status, 422);
  assert.equal((await fd.post('/api/reservations', { ...body, clientRequestId: 'test-res-0004', amount: 500 })).status, 422);
  assert.equal((await fd.post('/api/reservations', { ...body, clientRequestId: 'test-res-0005', amount: 99999 })).status, 422);
  assert.equal((await fd.post('/api/reservations', { ...body, clientRequestId: 'test-res-0006', amount: 10.5 })).status, 400);
  assert.equal((await hk.post('/api/reservations', { ...body, clientRequestId: 'test-res-0007' })).status, 403);
  assert.equal((await fd.get('/api/reservations?q=Test%20Guest')).data.length, 1);
  assert.equal((await fd.get('/api/reservations/SSR-0000-0000')).status, 404);
});

/* ---------------- TEST C: check-in & checkout ---------------- */
test('C. check-in and checkout with inspection and deposit settlement', async t => {
  await t.test('check-in blocked by outstanding balance; conflicting room rejected', async () => {
    const low = await fd.post('/api/reservations/SSR-2026-0721/check-in', { roomNumber: '106', adults: 2, kids: 0, method: 'Cash', amount: 500 });
    assert.equal(low.status, 422); assert.match(low.error.message, /must be settled/);
    const clash = await fd.post('/api/reservations/SSR-2026-0721/check-in', { roomNumber: '205', adults: 2, kids: 0, method: 'Cash', amount: 1000 });
    assert.equal(clash.status, 409); assert.match(clash.error.message, /Andrea Lim/);
    const busy = await fd.post('/api/reservations/SSR-2026-0721/check-in', { roomNumber: '101', adults: 2, kids: 0, method: 'Cash', amount: 1000 });
    assert.equal(busy.status, 409);
  });
  await t.test('valid check-in; retry does not double-charge', async () => {
    const ok = await fd.post('/api/reservations/SSR-2026-0721/check-in', { roomNumber: '106', adults: 2, kids: 0, method: 'Cash', amount: 1000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.data.status, 'Checked in'); assert.equal(ok.data.room, '106');
    assert.equal((await room(fd, '106')).status, 'occupied');
    const before = await txCount('SSR-2026-0721');
    const retry = await fd.post('/api/reservations/SSR-2026-0721/check-in', { roomNumber: '106', adults: 2, kids: 0, method: 'Cash', amount: 1000 });
    assert.equal(retry.status, 409); assert.equal(retry.error.code, 'ALREADY_DONE');
    assert.equal(await txCount('SSR-2026-0721'), before);
    assert.equal((await M.Transaction.findOne({ idempotencyKey: { $regex: '^checkin:' } })).amount, 1000);
  });
  await t.test('checkout → inspection → damage payment → checked out', async () => {
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/start', { method: 'Cash', amount: 0 })).status, 422);
    const start = await fd.post('/api/reservations/SSR-0714/checkout/start', { method: 'Cash', amount: 500, note: 'Key returned' });
    assert.equal(start.status, 200, JSON.stringify(start.body)); assert.equal(start.data.status, 'Pending Room Inspection');
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/start', { method: 'Cash', amount: 500 })).status, 409);
    assert.equal(await M.Transaction.countDocuments({ bookingRef: 'SSR-0714', type: 'Check-out payment' }), 1);
    assert.equal(await M.HousekeepingTask.countDocuments({ roomNumber: '101', kind: 'inspection', status: { $ne: 'Completed' } }), 1);
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/complete', { method: 'Cash', amount: 0 })).status, 409, 'cannot finish before inspection');
    const st = await room(hk, '101');
    assert.equal(st.stay.inspStatus, 'pending');
    assert.equal((await fd.post(`/api/inspections/${st.stay.inspectionId}/submit`, { findings: [] })).status, 403, 'front desk cannot inspect');
    const insp = await hk.post(`/api/inspections/${st.stay.inspectionId}/submit`, {
      checklist: [true, true, true, true, false, true], remarks: 'Mirror cracked',
      findings: [{ category: 'Damaged Item', item: 'Bathroom mirror', qty: 1, cost: 1200 }, { category: 'Missing Item', item: 'Bath towel', qty: 2, cost: 150 }]
    });
    assert.equal(insp.status, 200, JSON.stringify(insp.body));
    assert.deepEqual(insp.data.settlement, { deposit: 1000, damages: 1500, applied: 1000, refund: 0, extra: 500 });
    assert.equal(insp.data.incidents.length, 2);
    assert.equal((await hk.post(`/api/inspections/${st.stay.inspectionId}/submit`, { findings: [] })).status, 409, 'cannot inspect twice');
    const res = (await fd.get('/api/reservations/SSR-0714')).data;
    assert.equal(res.status, 'Pending Damage Payment');
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/complete', { method: 'Cash', amount: 0 })).status, 422);
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/complete', { method: 'Cash', amount: 700 })).status, 422);
    const done = await fd.post('/api/reservations/SSR-0714/checkout/complete', { method: 'Cash', amount: 500 });
    assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.data.reservation.status, 'Checked Out');
    const txs = await M.Transaction.find({ bookingRef: 'SSR-0714' });
    assert.equal(txs.filter(x => x.type === 'Damage charge').length, 1); assert.equal(txs.find(x => x.type === 'Damage charge').amount, 500);
    assert.equal(txs.filter(x => x.type === 'Deposit forfeited').length, 1);
    assert.equal((await fd.post('/api/reservations/SSR-0714/checkout/complete', { method: 'Cash', amount: 500 })).status, 409);
    assert.equal(await M.Transaction.countDocuments({ bookingRef: 'SSR-0714' }), txs.length, 'retry adds no ledger rows');
    const r101 = await room(fd, '101');
    assert.equal(r101.status, 'cleaning'); assert.equal(r101.stay, undefined);
    assert.equal(await M.HousekeepingTask.countDocuments({ roomNumber: '101', kind: 'cleaning', status: 'Assigned', assignedTo: null }), 1);
    assert.equal(await M.Incident.countDocuments({ bookingRef: 'SSR-0714', status: 'Paid' }), 2);
  });
  await t.test('no-issue inspection refunds the full deposit', async () => {
    await fd.post('/api/reservations/SSR-0717/checkout/start', { method: 'Cash', amount: 0 });
    const s = await room(sup, '201');
    await sup.post(`/api/inspections/${s.stay.inspectionId}/submit`, { findings: [] });
    const out = await fd.post('/api/reservations/SSR-0717/checkout/complete', { method: 'GCash', amount: 0 });
    assert.equal(out.status, 200); assert.equal(out.data.settlement.refund, 1000);
    const dep = await M.Transaction.findOne({ bookingRef: 'SSR-0717', type: 'Deposit refund' });
    assert.equal(dep.amount, -1000); assert.equal(dep.method, 'GCash');
  });
  await t.test('waiving a charge releases a booking held for damage payment', async () => {
    await fd.post('/api/reservations/SSR-0712/checkout/start', { method: 'Cash', amount: 250 });
    const s = await room(hk, '302');
    const ins = await hk.post(`/api/inspections/${s.stay.inspectionId}/submit`, { findings: [{ category: 'Missing Item', item: 'Hair dryer', qty: 1, cost: 1400 }] });
    assert.equal(ins.data.settlement.extra, 400);
    const inc = ins.data.incidents[0].id;
    assert.equal((await hk.patch(`/api/incidents/${inc}/status`, { status: 'Waived' })).status, 403);
    const w = await fd.patch(`/api/incidents/${inc}/status`, { status: 'Waived' });
    assert.equal(w.status, 200); assert.equal(w.data.status, 'Waived');
    assert.equal((await fd.get('/api/reservations/SSR-0712')).data.status, 'Inspection Completed');
    const out = await fd.post('/api/reservations/SSR-0712/checkout/complete', { method: 'Cash', amount: 0 });
    assert.equal(out.data.settlement.refund, 1000);
  });
  await t.test('walk-in: payment must cover room + deposit; retry is idempotent', async () => {
    const b = { guest: 'Walk Tester', contact: '0917 123 4567', adults: 1, kids: 0, roomType: 'Standard', roomNumber: '103', nights: 1, method: 'Cash', amount: 2000, clientRequestId: 'walkin-test-0001' };
    assert.equal((await fd.post('/api/reservations/walk-in', b)).status, 422);
    const ok = await fd.post('/api/reservations/walk-in', { ...b, amount: 2800 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const again = await fd.post('/api/reservations/walk-in', { ...b, amount: 2800 });
    assert.equal(again.data.ref, ok.data.ref);
    assert.equal(await txCount(ok.data.ref), 1);
  });
});

/* ---------------- TEST D: housekeeping ---------------- */
test('D. housekeeping workflow and supervisor-only approval', async () => {
  const s = await state(sup);
  const task = s.tasks.find(x => x.room === '101' && x.status === 'Assigned' && x.kind !== 'inspection');
  const ana = s.meta.housekeepers.find(h => h.name === 'Ana Cruz');
  assert.equal((await sup.post('/api/housekeeping/tasks', { roomNumber: '101', assigneeId: ana.id, type: 'Recleaning', priority: 'Normal' })).status, 409, 'one open task per room');
  assert.equal((await hk.patch(`/api/housekeeping/tasks/${task.id}/assign`, { assigneeId: ana.id })).status, 403);
  assert.equal((await sup.patch(`/api/housekeeping/tasks/${task.id}/assign`, { assigneeId: ana.id, priority: 'High' })).status, 200);
  assert.equal((await hk2.post(`/api/housekeeping/tasks/${task.id}/start`)).status, 403, 'other housekeepers cannot move it');
  assert.equal((await hk.post(`/api/housekeeping/tasks/${task.id}/submit`)).status, 409, 'cannot skip a stage');
  assert.equal((await hk.post(`/api/housekeeping/tasks/${task.id}/start`)).status, 200);
  assert.equal((await hk.post(`/api/housekeeping/tasks/${task.id}/submit`)).status, 200);
  for (const c of [hk, fd, mgr]) assert.equal((await c.post(`/api/housekeeping/tasks/${task.id}/review`, { decision: 'approve', checklist: [true, true, true, true, true] })).status, 403);
  const partial = await sup.post(`/api/housekeeping/tasks/${task.id}/review`, { decision: 'approve', checklist: [true, true, true, true, false] });
  assert.equal(partial.status, 422);
  assert.notEqual((await room(sup, '101')).status, 'available');
  const back = await sup.post(`/api/housekeeping/tasks/${task.id}/review`, { decision: 'reclean', note: 'Streaks on mirror' });
  assert.equal(back.status, 200); assert.equal(back.data.task.status, 'In Progress'); assert.equal(back.data.task.reworked, true);
  assert.equal((await hk.post(`/api/housekeeping/tasks/${task.id}/submit`)).status, 200);
  const ok = await sup.post(`/api/housekeeping/tasks/${task.id}/review`, { decision: 'approve', checklist: [true, true, true, true, true], note: 'Good' });
  assert.equal(ok.status, 200); assert.equal(ok.data.roomStatus, 'available');
  assert.equal((await room(fd, '101')).status, 'available');
  const hist = await M.HousekeepingTask.findById(task.id);
  assert.equal(hist.inspections.length, 2); assert.equal(hist.openKey, undefined);
  // stay-over cleaning on an occupied room must not change it to "cleaning"
  const occ = await sup.post('/api/housekeeping/tasks', { roomNumber: '305', assigneeId: ana.id, type: 'Stay-over cleaning', priority: 'Normal' });
  assert.equal(occ.status, 409, 'occupied rooms are not offered for assignment (prototype rule)');
});

/* ---------------- TEST E: maintenance ---------------- */
test('E. maintenance: report → assess → repair → resolve', async () => {
  const s = await state(sup);
  const carlo = s.meta.technicians.find(x => x.name === 'Carlo Diaz');
  assert.equal((await fd.post('/api/maintenance', { roomNumber: '105', category: 'Plumbing', description: 'Shower head leaking.' })).status, 403);
  const rep = await hk.post('/api/maintenance', { roomNumber: '105', category: 'Plumbing', description: 'Shower head leaking. Water on floor.', clientRequestId: 'wo-test-0001' });
  assert.equal(rep.status, 201); assert.equal(rep.data.stage, 'assessment');
  assert.equal((await hk.post('/api/maintenance', { roomNumber: '105', category: 'Plumbing', description: 'Shower head leaking. Water on floor.', clientRequestId: 'wo-test-0001' })).data.id, rep.data.id);
  const id = rep.data.id;
  assert.ok(!(await mt.get('/api/maintenance')).data.some(x => x.id === id), 'technicians cannot see unassessed tickets');
  assert.equal((await mt.get(`/api/maintenance/${id}`)).status, 404);
  assert.equal((await mt.post(`/api/maintenance/${id}/updates`, { status: 'Repair in progress', availability: 'Keep room offline', eta: '2030-01-01T10:00', notes: 'Started' })).status, 403);
  assert.equal((await hk.post(`/api/maintenance/${id}/assess`, { priority: 'High', impact: 'Room must be taken offline', technicianId: carlo.id })).status, 403);
  const as = await sup.post(`/api/maintenance/${id}/assess`, { priority: 'High', impact: 'Room must be taken offline', technicianId: carlo.id, note: 'Guest arriving tomorrow' });
  assert.equal(as.status, 200); assert.equal(as.data.stage, 'assigned');
  assert.equal((await room(fd, '105')).status, 'maintenance');
  assert.equal((await sup.post(`/api/maintenance/${id}/assess`, { priority: 'Low', impact: 'Room can stay in use', technicianId: carlo.id })).status, 409);
  assert.equal((await mt.post(`/api/maintenance/${id}/updates`, { status: 'Waiting for parts', availability: 'Keep room offline', eta: 'tomorrow', notes: 'x' })).status, 400);
  const up = await mt.post(`/api/maintenance/${id}/updates`, { status: 'Waiting for parts', availability: 'Keep room offline', eta: '2030-01-01T15:00', parts: 'Shower cartridge', notes: 'Ordered cartridge' });
  assert.equal(up.status, 200); assert.equal(up.data.parts, 'Shower cartridge'); assert.equal(up.data.eta, '2030-01-01T15:00');
  const res = await mt.post(`/api/maintenance/${id}/updates`, { status: 'Resolved', availability: 'Return to available', eta: '2030-01-01T15:00', parts: 'Shower cartridge', notes: 'Replaced and tested' });
  assert.equal(res.status, 200); assert.equal(res.data.stage, 'resolved'); assert.equal(res.data.history.length, 4);
  assert.equal((await room(fd, '105')).status, 'available');
  assert.equal((await mt.post(`/api/maintenance/${id}/updates`, { status: 'Testing', availability: 'Keep room offline', eta: '2030-01-01T15:00', notes: 'again' })).status, 409);
});

/* ---------------- TEST F: lost & found ---------------- */
test('F. lost & found: log, claim, verified release (front desk only)', async () => {
  const c = await mt.post('/api/lost-and-found', { item: 'Silver ring', category: 'Jewelry / Accessories', location: 'Room 306', condition: 'Good condition', description: 'Thin silver band', foundAt: '2026-01-01T10:00', clientRequestId: 'lf-test-0001' });
  assert.equal(c.status, 201); assert.equal(c.data.status, 'Stored'); assert.equal(c.data.reporter, 'Carlo Diaz');
  const id = c.data.id;
  assert.equal((await hk.get(`/api/lost-and-found/${id}`)).data.item, 'Silver ring');
  assert.equal((await mt.post(`/api/lost-and-found/${id}/claim`, { claimantName: 'X' })).status, 403);
  assert.equal((await fd.post(`/api/lost-and-found/${id}/claim`, { claimantName: 'Maria Lopez' })).data.status, 'Claim pending');
  assert.equal((await hk.post(`/api/lost-and-found/${id}/release`, { ownershipVerified: true })).status, 403);
  assert.equal((await mgr.post(`/api/lost-and-found/${id}/release`, { ownershipVerified: true })).status, 403);
  assert.equal((await fd.post(`/api/lost-and-found/${id}/release`, { ownershipVerified: false })).status, 422);
  const rel = await fd.post(`/api/lost-and-found/${id}/release`, { ownershipVerified: true });
  assert.equal(rel.status, 200); assert.equal(rel.data.status, 'Released'); assert.equal(rel.data.releasedTo, 'Maria Lopez'); assert.equal(rel.data.releasedBy, 'Anne Reyes');
  assert.equal((await fd.post(`/api/lost-and-found/${id}/release`, { ownershipVerified: true })).status, 409);
  assert.equal((await fd.get('/api/lost-and-found/notanid')).status, 400);
});

/* ---------------- TEST G: inventory ---------------- */
test('G. inventory: view-only housekeepers, restock request, consistent stock + log', async () => {
  const items = (await hk.get('/api/inventory')).data;
  const soap = items.find(i => i.name === 'Soap sets');
  assert.equal((await fd.get('/api/inventory')).status, 403);
  assert.equal((await hk.post('/api/inventory/movements', { itemId: soap.id, movement: 'Stock received', qty: 99, reason: 'hack' })).status, 403);
  const rq = await hk.post('/api/inventory/restock-requests', { itemId: soap.id, note: 'Trolley empty' });
  assert.equal(rq.status, 201);
  assert.equal((await hk.post('/api/inventory/restock-requests', { itemId: soap.id })).status, 409);
  const mv = await sup.post('/api/inventory/movements', { itemId: soap.id, movement: 'Stock received', qty: 30, reason: 'Supplier delivery', restockRequestId: rq.data.id });
  assert.equal(mv.status, 201); assert.equal(mv.data.item.stock, soap.stock + 30);
  assert.equal(mv.data.log.stockBefore, soap.stock); assert.equal(mv.data.log.stockAfter, soap.stock + 30);
  assert.equal((await M.RestockRequest.findById(rq.data.id)).status, 'Handled');
  const retry = await sup.post('/api/inventory/movements', { itemId: soap.id, movement: 'Stock received', qty: 30, reason: 'Supplier delivery', restockRequestId: rq.data.id });
  assert.equal(retry.status, 409);
  assert.equal((await M.InventoryItem.findById(soap.id)).stock, soap.stock + 30, 'stock unchanged by rejected retry');
  const used = await mgr.post('/api/inventory/movements', { itemId: soap.id, movement: 'Stock used', qty: 1000, reason: 'Count error' });
  assert.equal(used.data.item.stock, 0, 'never below zero');
  assert.equal((await sup.post('/api/inventory/items', { name: 'soap SETS', category: 'Guest supplies', stock: 1, reorderLevel: 1 })).status, 409);
  assert.equal((await sup.post('/api/inventory/items', { name: 'Hand soap', category: 'Guest supplies', stock: 40, reorderLevel: 10 })).status, 201);
});

/* ---------------- Guest requests ---------------- */
test('Guest requests: catalog prices, folio charge, checkout guard', async () => {
  const r = await fd.post('/api/guest-requests', { roomNumber: '104', items: [{ name: 'Extra mattress', qty: 1, price: 1 }], clientRequestId: 'gr-test-0001' });
  assert.equal(r.status, 201); assert.equal(r.data.items[0].price, 500, 'server uses catalog price, not the client value');
  const res = (await fd.get('/api/reservations/SSR-0716')).data;
  assert.equal(res.total, 4100);
  assert.equal((await fd.post('/api/guest-requests', { roomNumber: '104', items: [{ name: 'Extra mattress', qty: 1 }], clientRequestId: 'gr-test-0001' })).data.id, r.data.id);
  assert.equal(await M.Transaction.countDocuments({ guestRequest: r.data.id }), 1);
  assert.equal((await fd.post('/api/guest-requests', { roomNumber: '103', items: [{ name: 'Other' }] })).status, 400);
  assert.equal((await mt.post(`/api/guest-requests/${r.data.id}/advance`)).status, 403);
  assert.equal((await hk.post(`/api/guest-requests/${r.data.id}/advance`)).data.status, 'In delivery');
});

/* ---------------- TEST H: transactions & reports ---------------- */
test('H. transactions ledger and reports', async () => {
  assert.equal((await hk.get('/api/transactions')).status, 403);
  const all = (await mgr.get('/api/transactions?range=all')).data;
  assert.ok(all.length >= 12);
  const keys = await M.Transaction.find({ idempotencyKey: { $exists: true } }).distinct('idempotencyKey');
  assert.equal(keys.length, await M.Transaction.countDocuments({ idempotencyKey: { $exists: true } }), 'no duplicate financial events');
  const dmg = (await mgr.get('/api/transactions?range=all&type=Damage%20charge')).data;
  assert.ok(dmg.every(x => x.type === 'Damage charge'));
  assert.equal((await fd.get('/api/reports/summary')).status, 403);
  const sum = await mgr.get('/api/reports/summary?days=30');
  assert.equal(sum.status, 200); assert.equal(sum.data.rooms.total, 19);
  assert.equal((await mgr.get('/api/reports/summary?days=9')).status, 400);
});

/* ---------------- TEST J: attendance timestamps (Asia/Manila) ---------------- */
// Same formatting as frontend/app.js fmtInstant (used by the time-out confirmation).
const fmtInstant = d => new Date(d).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

test('J. attendance: clock-in / clock-out times are real and shown in Manila time', async t => {
  await t.test('seed leaves no open shift, so a login is never pre-dated', async () => {
    const stale = await M.Attendance.countDocuments({ timeOut: null, timeIn: { $lt: TEST_START } });
    assert.equal(stale, 0, 'seeded sample shifts must be closed');
  });

  await t.test('regression: a fresh login records "now", not the sample 7:14 AM', async () => {
    const c = client(), t0 = Date.now();
    const r = await c.login('2213');                                  // Mika Ong: seeded sample shift at 7:14 AM
    const since = new Date(r.data.shift.since);
    assert.match(r.data.shift.since, /Z$/, 'sent as an unambiguous UTC instant');
    assert.equal(r.data.shift.resumed, false);
    assert.ok(since.getTime() >= t0 - 1000 && since.getTime() <= Date.now() + 1000, `time-in ${r.data.shift.since} is not the login time`);
    const s = await state(c);
    assert.equal(s.shift.in, timeLabel(since));                       // dashboard pill = stored time, Manila
    assert.equal(s.shift.in, fmtInstant(r.data.shift.since));
  });

  await t.test('login at 5:58 PM Manila → dashboard "since 5:58 PM", time-out shows the recorded time', async () => {
    const user = await M.User.findOne({ staffId: '4456' });           // Rey Molina: no sample shifts
    const at558 = fromLocal(`${today()}T17:58`);
    assert.equal(at558.getUTCHours(), 9); assert.equal(at558.getUTCMinutes(), 58);   // stored as 09:58 UTC
    await staff.timeIn(user, at558);                                   // the 5:58 PM time-in
    const c = client();
    const r = await c.login('4456');                                   // signing in again during that shift
    assert.equal(r.data.shift.resumed, true);
    assert.equal(r.data.shift.since, at558.toISOString());
    const s = await state(c);
    assert.equal(s.shift.isTimedIn, true);
    assert.equal(s.shift.in, '5:58 PM');
    const t0 = Date.now();
    const out = await c.post('/api/attendance/time-out');
    assert.equal(out.status, 200);
    assert.match(out.data.timeOut, /Z$/);
    const outAt = new Date(out.data.timeOut).getTime();
    assert.ok(outAt >= t0 - 1000 && outAt <= Date.now() + 1000);
    assert.equal(out.data.timeIn, at558.toISOString(), 'time-out closes the same shift');
    assert.equal(fmtInstant(out.data.timeOut), timeLabel(out.data.timeOut), 'confirmation formatting matches the server');
    assert.equal((await state(c)).shift.isTimedIn, false);
    const again = await c.post('/api/attendance/time-out');
    assert.equal(again.status, 409);
  });

  await t.test('date boundary: an open shift from the previous Manila day is shown with its date', async () => {
    const user = await M.User.findOne({ staffId: '2214' });           // Carla Reyes
    const late = fromLocal(`${addDays(today(), -1)}T23:30`);           // 11:30 PM yesterday = 15:30 UTC yesterday
    assert.equal(late.getUTCHours(), 15);
    await staff.timeIn(user, late);
    const c = client(); await c.login('2214');
    const label = (await state(c)).shift.in;
    assert.equal(label, clockLabel(late));
    assert.match(label, /^[A-Z][a-z]{2} \d{1,2}, 11:30 PM$/, `expected a dated label, got "${label}"`);
    const board = (await state(mgr)).attendance.find(a => a.name === 'Carla Reyes');
    assert.equal(board.in, label);
    assert.equal(board.status, 'On shift');
  });
});
