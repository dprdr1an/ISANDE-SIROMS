'use strict';
/**
 * DEVELOPMENT-ONLY seed.
 *   npm run seed          → seeds an empty database (refuses if users exist)
 *   npm run seed:reset    → DELETES all SIROMS collections, then seeds
 *
 * Loads the prototype's original sample data (rooms, bookings, tasks, …) with
 * dates relative to today, and creates staff accounts whose password is taken
 * from SEED_PASSWORD in backend/.env. No password is stored in this file.
 * Refuses to run when NODE_ENV=production.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { env, assertConfig } = require('../src/config/env');
const M = require('../src/models');
const { connectDB, disconnectDB } = require('../src/config/db');
const { DEPOSIT } = require('../src/config/business');
const { today, addDays, fromLocal } = require('../src/utils/time');

const RESET = process.argv.includes('--reset');

async function main() {
  if (env.isProd) throw new Error('Refusing to seed: NODE_ENV=production.');
  assertConfig();
  const password = process.env.SEED_PASSWORD || '';
  if (password.length < 10) throw new Error('Set SEED_PASSWORD (at least 10 characters) in backend/.env before seeding. It becomes the password of every development account.');
  if (require.main === module) await connectDB();
  if (RESET || process.env.SIROMS_SEED_RESET === '1') {
    const names = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);
    for (const n of names) await mongoose.connection.db.dropCollection(n);
    // init() is cached per process, so rebuild indexes explicitly after dropping.
    for (const m of Object.values(M)) await m.createIndexes();
    console.log(`Reset: dropped ${names.length} collections in "${env.MONGODB_DB}".`);
  } else if (await M.User.estimatedDocumentCount()) {
    throw new Error('Database already has users. Run "npm run seed:reset" to wipe and reseed (development only).');
  }

  const T = today(), D = n => addDays(T, n);
  const at = (dayOffset, hhmm = '09:00') => fromLocal(`${D(dayOffset)}T${hhmm}`);
  const now = new Date();

  /* ---------- Staff (development accounts) ---------- */
  const hash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  const staffList = [
    ['6767', 'Anne Reyes', 'frontdesk'], ['2211', 'Ana Cruz', 'housekeeper'], ['3344', 'Liza Mendoza', 'supervisor'],
    ['4455', 'Carlo Diaz', 'maintenance'], ['5566', 'Marco Santos', 'manager'],
    ['2212', 'Joy Ramos', 'housekeeper'], ['2213', 'Mika Ong', 'housekeeper'], ['2214', 'Carla Reyes', 'housekeeper'], ['4456', 'Rey Molina', 'maintenance']
  ];
  const users = {};
  for (const [staffId, name, role] of staffList) users[name] = await M.User.create({ staffId, name, role, passwordHash: hash });
  const U = n => users[n];
  const A = n => ({ by: U(n)._id, byName: n });

  /* ---------- Rooms ---------- */
  const roomDefs = [
    ['101', 'Standard', 'occupied'], ['102', 'Standard', 'cleaning'], ['103', 'Standard', 'available'], ['104', 'Standard', 'occupied'],
    ['105', 'Family', 'available'], ['106', 'Standard', 'available'], ['201', 'Standard', 'occupied'],
    // 202 has a cleaning task waiting for inspection, so it is not yet available
    // (the prototype showed it as available, which contradicted its own rule).
    ['202', 'Family', 'cleaning'],
    ['203', 'Standard', 'occupied'], ['204', 'Standard', 'cleaning'], ['205', 'Family', 'available'], ['206', 'Family', 'occupied'],
    ['301', 'Standard', 'cleaning'], ['302', 'Family', 'occupied'], ['303', 'Standard', 'available'], ['304', 'Family', 'occupied'],
    ['305', 'Standard', 'occupied'], ['306', 'Standard', 'maintenance']
  ];
  const rooms = {};
  for (const [number, type, status] of roomDefs) rooms[number] = await M.Room.create({ number, type, status });

  /* ---------- Reservations ---------- */
  const mkRes = async (o) => {
    const doc = await M.Reservation.create({
      ref: o.ref, guest: { name: o.guest, contact: o.contact }, source: o.source, checkIn: o.checkIn, checkOut: o.checkOut,
      roomType: o.roomType, room: o.room ? rooms[o.room]._id : null, roomNumber: o.room || '', adults: o.adults, kids: o.kids,
      charges: o.charges, amountPaid: o.paid, status: o.status, deposit: o.inHouse ? { amount: DEPOSIT, status: 'held' } : { amount: 0, status: 'none' },
      checkedInAt: o.inHouse ? fromLocal(`${o.checkIn}T14:00`) : undefined,
      statusHistory: [{ status: o.status, at: now, ...A('Anne Reyes'), note: 'Seeded from prototype data' }]
    });
    if (o.inHouse) await M.Room.updateOne({ _id: rooms[o.room]._id }, { $set: { currentReservation: doc._id } });
    return doc;
  };
  const roomCharge = (n, amt) => ({ description: `Room charge · ${n} night${n > 1 ? 's' : ''}`, amount: amt, kind: 'room' });
  const pre = [
    ['SSR-2026-0720', 'Andrea Lim', '0917 555 0193', 'Booking.com', T, D(2), 'Family', '205', 2, 1, 7800, 7800, 'Confirmed'],
    ['SSR-2026-0721', 'Joshua Tan', '0917 210 4456', 'Front Desk', T, D(1), 'Standard', '106', 2, 0, 1800, 800, 'Pending payment'],
    ['SSR-2026-0722', 'Bea Ramos', '0918 774 9021', 'Agoda', T, D(2), 'Family', '202', 2, 2, 5200, 0, 'Needs review'],
    ['SSR-2026-0723', 'Miguel Cruz', '0917 663 2210', 'Booking.com', D(1), D(3), 'Standard', '303', 1, 0, 3600, 3600, 'Confirmed'],
    ['SSR-2026-0724', 'Lea Santos', '0918 552 8890', 'Expedia', D(2), D(3), 'Family', null, 2, 2, 2600, 0, 'Pending payment']
  ];
  for (const [ref, guest, contact, source, ci, co, roomType, room, adults, kids, total, paid, status] of pre)
    await mkRes({ ref, guest, contact, source, checkIn: ci, checkOut: co, roomType, room, adults, kids, charges: [roomCharge(Math.round((Date.parse(co) - Date.parse(ci)) / 864e5), total)], paid, status });
  const inHouse = [
    ['SSR-0714', 'Jose Ramos', '0917 100 2201', 'Front Desk', -2, 0, 'Standard', '101', 2, 0, [roomCharge(2, 3600), { description: 'Extra mattress', amount: 500, kind: 'request' }], 3600],
    ['SSR-0716', 'Patricia Tan', '0917 100 2202', 'Booking.com', -1, 1, 'Standard', '104', 2, 0, [roomCharge(2, 3600)], 3600],
    ['SSR-0717', 'Lara Go', '0917 100 2203', 'Agoda', -3, 0, 'Standard', '201', 1, 0, [roomCharge(3, 5400)], 5400],
    ['SSR-0718', 'Ken Ong', '0917 100 2204', 'Front Desk', -1, 2, 'Standard', '203', 2, 1, [roomCharge(3, 5400), { description: 'Baby crib', amount: 300, kind: 'request' }], 4000],
    ['SSR-0719', 'Sam Lim', '0917 100 2205', 'Booking.com', -2, 1, 'Family', '206', 3, 2, [roomCharge(3, 7800)], 7800],
    ['SSR-0712', 'Tina Chua', '0917 100 2206', 'Expedia', -4, 0, 'Family', '302', 2, 2, [roomCharge(4, 10400), { description: 'Laundry service', amount: 250, kind: 'request' }], 10400],
    ['SSR-0715', 'Rina Santos', '0917 100 2207', 'Front Desk', -2, 3, 'Family', '304', 4, 0, [roomCharge(5, 13000)], 13000],
    ['SSR-0713', 'Ella Diaz', '0917 100 2208', 'Agoda', -1, 1, 'Standard', '305', 1, 0, [roomCharge(2, 3600)], 3600]
  ];
  const resv = {};
  for (const [ref, guest, contact, source, ci, co, roomType, room, adults, kids, charges, paid] of inHouse)
    resv[ref] = await mkRes({ ref, guest, contact, source, checkIn: D(ci), checkOut: D(co), roomType, room, adults, kids, charges, paid, status: 'Checked in', inHouse: true });

  /* ---------- Online bookings waiting for import ---------- */
  await M.OnlineBooking.insertMany([
    ['BDC-778120', 'Camille Ong', '0917 884 2210', 'Booking.com', 1, 3, 'Family', 2, 1, 5200, true],
    ['BDC-778145', 'Daniel Yap', '0918 330 1145', 'Booking.com', 2, 4, 'Standard', 2, 0, 3600, true],
    ['BDC-778162', 'Grace Villanueva', '0917 445 9080', 'Booking.com', 2, 3, 'Standard', 1, 0, 1800, false],
    ['BDC-778190', 'Henry Lim', '0916 771 3322', 'Booking.com', 3, 6, 'Family', 2, 2, 7800, true],
    ['AGD-551204', 'Ivy Marquez', '0917 909 4412', 'Agoda', 1, 2, 'Standard', 2, 0, 1800, false],
    ['EXP-330911', 'Noel Bautista', '0918 220 6655', 'Expedia', 4, 6, 'Family', 3, 1, 5200, true]
  ].map(([externalId, guest, contact, source, ci, co, roomType, adults, kids, total, prepaid]) => ({ externalId, guest, contact, source, checkIn: D(ci), checkOut: D(co), roomType, adults, kids, total, prepaid })));

  /* ---------- Housekeeping tasks ---------- */
  const mkTask = (room, staff, priority, type, note, status, extra = {}) => M.HousekeepingTask.create({
    room: rooms[room]._id, roomNumber: room, kind: 'cleaning', type, priority, note, status,
    assignedTo: U(staff)._id, assignedToName: staff, assignedBy: U('Liza Mendoza')._id, assignedAt: now,
    startedAt: status !== 'Assigned' ? now : undefined, submittedAt: ['Ready for Inspection', 'Completed'].includes(status) ? now : undefined,
    completedAt: status === 'Completed' ? now : undefined,
    openKey: status === 'Completed' ? undefined : `${room}:cleaning`, ...extra
  });
  await mkTask('301', 'Ana Cruz', 'High', 'Checkout cleaning', 'Guest departed 10:05 AM', 'Assigned');
  await mkTask('102', 'Joy Ramos', 'Normal', 'Stay-over cleaning', '', 'Assigned');
  await mkTask('204', 'Ana Cruz', 'Normal', 'Checkout cleaning', '', 'In Progress');
  await mkTask('202', 'Joy Ramos', 'Normal', 'Checkout cleaning', '', 'Ready for Inspection');
  const approved = (note, reworked = false) => { const i = { result: 'Approved', at: now, ...A('Liza Mendoza'), note, reworked }; return { lastInspection: i, inspections: [i], reworked }; };
  await mkTask('105', 'Mika Ong', 'Normal', 'Stay-over cleaning', '', 'Completed', approved('Passed on first check.'));
  await mkTask('303', 'Mika Ong', 'Normal', 'Checkout cleaning', '', 'Completed', approved(''));
  await mkTask('106', 'Carla Reyes', 'Normal', 'Deep cleaning', '', 'Completed', approved('Re-checked after touch-up.', true));

  /* ---------- Maintenance ---------- */
  const h = (d, hhmm, who, what) => ({ at: at(d, hhmm), ...A(who), what });
  await M.MaintenanceTicket.create([
    { ticketNo: 'WO-1001', room: rooms['306']._id, roomNumber: '306', category: 'Air-conditioning', issue: 'Air-conditioning not cooling', priority: 'High', impact: 'Room must be taken offline', status: 'Repair in progress', stage: 'assigned', eta: at(1, '12:00'), assignedTo: U('Carlo Diaz')._id, assignedToName: 'Carlo Diaz', reportedBy: U('Ana Cruz')._id, reportedByName: 'Ana Cruz', reportedAt: at(-1, '08:30'), parts: 'Compressor capacitor', history: [h(-1, '08:30', 'Ana Cruz', 'Issue reported to supervisor'), h(-1, '09:10', 'Liza Mendoza', 'Assessed as High priority, room taken offline'), h(0, '08:00', 'Carlo Diaz', 'Repair in progress — capacitor replacement')] },
    { ticketNo: 'WO-1002', room: rooms['204']._id, roomNumber: '204', category: 'Plumbing', issue: 'Loose bathroom faucet', status: 'Awaiting assessment', stage: 'assessment', reportedBy: U('Ana Cruz')._id, reportedByName: 'Ana Cruz', reportedAt: now, history: [{ at: now, ...A('Ana Cruz'), what: 'Issue reported to supervisor' }] },
    { ticketNo: 'WO-1003', room: rooms['203']._id, roomNumber: '203', category: 'Electrical', issue: 'Bedside lamp not switching on', priority: 'Low', impact: 'Room can stay in use', status: 'Waiting for parts', stage: 'assigned', eta: at(2, '12:00'), assignedTo: U('Rey Molina')._id, assignedToName: 'Rey Molina', reportedBy: U('Joy Ramos')._id, reportedByName: 'Joy Ramos', reportedAt: at(-1, '10:00'), parts: 'Lamp switch', history: [h(-1, '10:00', 'Joy Ramos', 'Issue reported to supervisor'), h(-1, '10:40', 'Liza Mendoza', 'Assessed as Low priority'), h(0, '08:20', 'Rey Molina', 'Waiting for replacement switch')] },
    { ticketNo: 'WO-1004', room: rooms['102']._id, roomNumber: '102', category: 'Furniture / Fixture', issue: 'Wobbly desk chair', priority: 'Medium', impact: 'Room can stay in use', status: 'Resolved', stage: 'resolved', eta: at(-1, '12:00'), assignedTo: U('Carlo Diaz')._id, assignedToName: 'Carlo Diaz', reportedBy: U('Mika Ong')._id, reportedByName: 'Mika Ong', reportedAt: at(-2, '09:00'), resolvedAt: at(-1, '11:00'), parts: 'Chair bolts', history: [h(-2, '09:00', 'Mika Ong', 'Issue reported'), h(-1, '11:00', 'Carlo Diaz', 'Resolved — bolts tightened and tested')] },
    { ticketNo: 'WO-1005', room: rooms['305']._id, roomNumber: '305', category: 'Plumbing', issue: 'Slow draining shower', priority: 'Medium', impact: 'Room can stay in use', status: 'Resolved', stage: 'resolved', eta: at(-2, '12:00'), assignedTo: U('Rey Molina')._id, assignedToName: 'Rey Molina', reportedBy: U('Ana Cruz')._id, reportedByName: 'Ana Cruz', reportedAt: at(-3, '09:00'), resolvedAt: at(-2, '10:30'), parts: '', history: [h(-3, '09:00', 'Ana Cruz', 'Issue reported'), h(-2, '10:30', 'Rey Molina', 'Resolved — drain cleared')] }
  ]);

  /* ---------- Guest requests ---------- */
  const reqDoc = (no, room, guest, items, notes, status, by, when) => ({ requestNo: no, room: rooms[room]._id, roomNumber: room, reservation: Object.values(resv).find(r => r.roomNumber === room)?._id, guestName: guest, items, notes, status, charge: items.reduce((a, i) => a + i.unitPrice * i.qty, 0), createdBy: U(by)._id, createdByName: by, createdAt: when, statusHistory: [{ status, at: when, ...A(by) }] });
  await M.GuestRequest.create([
    reqDoc('GR-1001', '104', 'Patricia Tan', [{ name: 'Extra mattress', qty: 1, unitPrice: 500 }], '', 'In delivery', 'Anne Reyes', now),
    reqDoc('GR-1002', '206', 'Sam Lim', [{ name: 'Additional towels', qty: 2, unitPrice: 0 }, { name: 'Extra pillow', qty: 2, unitPrice: 0 }], 'Family of five', 'Pending', 'Anne Reyes', now),
    reqDoc('GR-1003', '203', 'Ken Ong', [{ name: 'Baby crib', qty: 1, unitPrice: 300 }], 'Set up before 8 PM', 'Delivered', 'Anne Reyes', at(-1, '15:00'))
  ]);

  /* ---------- Lost & found ---------- */
  await M.LostItem.create([
    { itemNo: 'LF-1001', item: 'Black wristwatch', category: 'Jewelry / Accessories', location: 'Room 204', condition: 'Good condition', status: 'Stored', reportedBy: U('Ana Cruz')._id, reportedByName: 'Ana Cruz', foundAt: at(-1, '11:20'), description: 'Black analog watch with silver buckle.' },
    { itemNo: 'LF-1002', item: 'Blue wallet', category: 'Bag / Wallet', location: '2F hallway', condition: 'Minor damage', status: 'Claim pending', reportedBy: U('Carlo Diaz')._id, reportedByName: 'Carlo Diaz', foundAt: at(-2, '16:05'), description: 'Blue leather wallet, no cash inside.' },
    { itemNo: 'LF-1003', item: 'Phone charger', category: 'Electronics', location: 'Room 301', condition: 'Good condition', status: 'Stored', reportedBy: U('Mika Ong')._id, reportedByName: 'Mika Ong', foundAt: at(-1, '10:10'), description: 'White USB-C charger with cable.' }
  ]);

  /* ---------- Inventory ---------- */
  const inv = {};
  for (const [name, category, stock, reorderLevel, d] of [
    ['Bath towels', 'Linen', 42, 20, -1], ['Bed sheets', 'Linen', 18, 15, -1], ['Pillow cases', 'Linen', 12, 20, -2], ['Soap sets', 'Guest supplies', 8, 20, -1],
    ['Shampoo sachets', 'Guest supplies', 64, 30, -3], ['All-purpose cleaner', 'Cleaning supplies', 6, 8, -2], ['Toilet paper', 'Guest supplies', 55, 25, -1]
  ]) inv[name] = await M.InventoryItem.create({ name, category, stock, reorderLevel, lastUpdatedAt: at(d), lastUpdatedBy: U('Liza Mendoza')._id, lastUpdatedByName: 'Liza Mendoza' });
  await M.InventoryLog.create([
    ['Bath towels', 'Stock used', 12, 54, 42, -1, 'Issued for Floor 2 checkouts'], ['Soap sets', 'Stock used', 10, 18, 8, -1, 'Guest supplies restocking'],
    ['Bed sheets', 'Stock received', 20, 0, 18, -2, 'Delivery from supplier'], ['All-purpose cleaner', 'Stock used', 4, 10, 6, -2, 'Weekly deep clean'], ['Pillow cases', 'Stock used', 8, 20, 12, -3, 'Linen rotation']
  ].map(([n, movement, qty, _b, _a, d, reason]) => ({ item: inv[n]._id, itemName: n, movement, qty, reason, at: at(d), ...A('Liza Mendoza') })));

  // Historic prototype log rows don't carry reliable before/after figures, so those are left blank.
  /* ---------- Transactions (historic) ---------- */
  const tx = [
    [0, '09:00', 'SSR-2026-0720', 'Andrea Lim', '205', 'Reservation payment', 'GCash', 7800],
    [0, '10:00', 'SSR-2026-0721', 'Joshua Tan', '106', 'Deposit', 'Cash', 800],
    [0, '11:00', 'SSR-0716', 'Patricia Tan', '104', 'Additional charge', 'Cash', 500],
    [0, '13:00', 'SSR-0718', 'Ken Ong', '203', 'Additional charge', 'GCash', 300],
    [-1, '09:00', 'SSR-0715', 'Rina Santos', '304', 'Reservation payment', 'Card', 13000],
    [-1, '09:30', 'SSR-0713', 'Ella Diaz', '305', 'Reservation payment', 'GCash', 3600],
    [-2, '09:00', 'SSR-0719', 'Sam Lim', '206', 'Reservation payment', 'Maya', 7800],
    [-2, '11:00', 'CHK-108', 'Marta Yu', '108', 'Check-out payment', 'Cash', 1800],
    [-3, '09:00', 'SSR-0712', 'Tina Chua', '302', 'Reservation payment', 'Card', 10400],
    [-4, '09:00', 'WALK-2041', 'Ryan Cruz', '103', 'Walk-in payment', 'Cash', 1800],
    [-5, '09:00', 'SSR-0709', 'Karla Uy', '201', 'Reservation payment', 'GCash', 5400],
    [-6, '09:00', 'REF-0705', 'Leo Tan', '202', 'Refund', 'GCash', -1800]
  ];
  const resByRef = {};
  for (const r of await M.Reservation.find()) resByRef[r.ref] = r._id;
  await M.Transaction.create(tx.map(([d, hhmm, bookingRef, guestName, roomNumber, type, method, amount], i) => ({
    txnNo: `TXN-${100001 + i}`, at: at(d, hhmm), reservation: resByRef[bookingRef] || null, bookingRef, guestName, roomNumber, type, method, amount,
    processedBy: U('Anne Reyes')._id, processedByName: 'Anne Reyes'
  })));

  /* ---------- Historic incidents (bookings no longer in the system) ---------- */
  await M.Incident.create([
    { incidentId: 'INC-1042', bookingRef: 'SSR-0705', roomNumber: '108', guestName: 'Marta Yu', category: 'Damaged Item', item: 'Bathroom mirror', description: 'Cracked mirror above the sink.', qty: 1, unitCost: 850, photos: 1, remarks: 'Charged against deposit at checkout.', status: 'Paid', reportedAt: at(-2, '10:00'), reportedBy: U('Mika Ong')._id, reportedByName: 'Mika Ong' },
    { incidentId: 'INC-1039', bookingRef: 'SSR-0709', roomNumber: '201', guestName: 'Karla Uy', category: 'Missing Item', item: 'Bath towels', description: 'Two bath towels missing from the room.', qty: 2, unitCost: 300, photos: 0, remarks: 'Guest waived — loyalty member.', status: 'Waived', reportedAt: at(-5, '10:00'), reportedBy: U('Ana Cruz')._id, reportedByName: 'Ana Cruz' }
  ]);

  /* ---------- Notifications ---------- */
  await M.Notification.create([
    ['New online bookings', '6 bookings from connected sites are waiting to be imported.', ['frontdesk']],
    ['Payment outstanding', 'Joshua Tan (SSR-2026-0721) still owes ₱1,000 before check-in.', ['frontdesk']],
    ['Room issue awaiting assessment', 'Room 204 faucet issue reported by Ana Cruz.', ['supervisor']],
    ['Room ready for inspection', 'Room 202 was submitted by Joy Ramos.', ['supervisor']],
    ['Low stock alert', 'Soap sets and pillow cases are below reorder level.', ['supervisor', 'manager']],
    ['Work order in progress', 'Room 306 air-conditioning repair is underway.', ['maintenance', 'manager']],
    ['New task assigned', 'Room 301 checkout cleaning is assigned to you.', ['housekeeper']]
  ].map(([title, text, roles]) => ({ title, text, roles })));

  /* ---------- Attendance (the prototype's sample shifts) ----------
   * Seeded as COMPLETED shifts on the previous day. They used to be open
   * shifts "today", which made a real login adopt the sample time-in
   * (e.g. "On shift · since 6:48 AM" for 6767) instead of recording one. */
  await M.Attendance.create([['Anne Reyes', '06:48'], ['Ana Cruz', '07:02'], ['Joy Ramos', '07:08'], ['Mika Ong', '07:14'], ['Liza Mendoza', '06:55'], ['Carlo Diaz', '07:25']]
    .map(([n, hhmm]) => {
      const timeIn = at(-1, hhmm);
      return { user: U(n)._id, name: n, roleLabel: { frontdesk: 'Front Desk', housekeeper: 'Housekeeper', supervisor: 'Housekeeping Supervisor', maintenance: 'Maintenance Staff' }[U(n).role], timeIn, timeOut: new Date(timeIn.getTime() + 8 * 3600e3) };
    }));

  /* ---------- Counters continue after the seeded references ---------- */
  await M.Counter.insertMany([
    { _id: 'reservation', seq: 724 }, { _id: 'walkin', seq: 2041 }, { _id: 'incident', seq: 1042 }, { _id: 'ticket', seq: 1005 },
    { _id: 'lost', seq: 1003 }, { _id: 'request', seq: 1003 }, { _id: 'txn', seq: 100012 }
  ]);

  console.log(`Seeded "${env.MONGODB_DB}": ${staffList.length} staff, ${roomDefs.length} rooms, ${pre.length + inHouse.length} reservations.`);
  console.log('Development accounts (password = SEED_PASSWORD from backend/.env):');
  for (const [id, name, role] of staffList) console.log(`  ${id}  ${name.padEnd(14)} ${role}`);
}

if (require.main !== module) module.exports = { seed: main };
else main().then(() => disconnectDB()).catch(async e => {
  console.error('Seed failed:', e.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
