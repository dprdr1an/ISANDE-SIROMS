'use strict';
/**
 * Demonstration data loader.  Run explicitly:  npm run seed
 * Never runs on server boot (brief §18).
 *
 *   npm run seed          upsert — keeps existing data, fills in what's missing
 *   npm run seed:fresh    --drop: wipe the SIROMS collections first
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const {
  User, Room, Reservation, GuestRequest, HousekeepingTask, Inspection,
  MaintenanceTicket, LostFoundItem, InventoryItem, RestockRequest,
  Transaction, Notification
} = require('../models');
const { ROOM_TYPES, DEPOSIT } = require('../models/constants');

const DROP = process.argv.includes('--drop');
const day = (n) => new Date(Date.now() + n * 86400000);
const T = () => new Date();

/**
 * Upsert through a real DOCUMENT rather than findOneAndUpdate.
 *
 * Why: Mongoose update validators run with `this` bound to the Query, not the
 * document, so any validator that reads a sibling field cannot see it. That
 * broke this seed two ways:
 *   • false failures — a ticket with priority 'High' and stage 'assigned' was
 *     rejected because the validator could not see `this.priority`;
 *   • false passes  — a reservation with checkOut before checkIn slipped
 *     through, because that validator short-circuits on `!this.checkIn`.
 * Loading (or building) the document and calling save() gives validators the
 * full document, so every business rule is enforced exactly as it is at
 * runtime. The rules themselves are untouched.
 */
async function saveDoc(Model, filter, data) {
  const doc = (await Model.findOne(filter)) || new Model();
  doc.set(data);
  await doc.save();                 // full document validation
  return doc;
}

/* ---------------- staff (PINs preserved from the prototype) ---------------- */
const STAFF = [
  { staffId: 'FD-001', pin: '6767', name: 'Anne Reyes',   role: 'frontdesk',   title: 'Front Desk',              shift: '7:00 AM – 3:00 PM' },
  { staffId: 'HK-014', pin: '2211', name: 'Ana Cruz',     role: 'housekeeper', title: 'Housekeeper',             shift: '6:00 AM – 2:00 PM' },
  { staffId: 'HK-002', pin: '3344', name: 'Liza Mendoza', role: 'supervisor',  title: 'Housekeeping Supervisor', shift: '6:00 AM – 3:00 PM' },
  { staffId: 'MT-007', pin: '4455', name: 'Carlo Diaz',   role: 'maintenance', title: 'Maintenance Technician',  shift: '8:00 AM – 5:00 PM' },
  { staffId: 'OM-001', pin: '5566', name: 'Marco Santos', role: 'manager',     title: 'Operations Manager',      shift: '8:00 AM – 6:00 PM' },
  // Additional floor staff referenced by tasks/tickets in the prototype
  { staffId: 'HK-015', pin: '2212', name: 'Joy Ramos',    role: 'housekeeper', title: 'Housekeeper' },
  { staffId: 'HK-016', pin: '2213', name: 'Mika Ong',     role: 'housekeeper', title: 'Housekeeper' },
  { staffId: 'HK-017', pin: '2214', name: 'Carla Reyes',  role: 'housekeeper', title: 'Housekeeper' },
  { staffId: 'MT-008', pin: '4456', name: 'Rey Molina',   role: 'maintenance', title: 'Maintenance Technician' }
];

/* ---------------- rooms: 3 floors ---------------- */
function buildRooms() {
  const out = [];
  const layout = {
    1: ['101', '102', '103', '104', '105', '106'],
    2: ['201', '202', '203', '204', '205', '206'],
    3: ['301', '302', '303', '304', '305', '306']
  };
  for (const [floor, numbers] of Object.entries(layout)) {
    numbers.forEach((n) => {
      const type = n.endsWith('6') || n.endsWith('2') ? 'Family' : 'Standard';
      const spec = ROOM_TYPES[type];
      out.push({ number: n, floor: Number(floor), type, capacity: spec.capacity,
                 rate: spec.rate, beds: spec.beds, status: 'available' });
    });
  }
  return out;
}

/* ---------------- in-house stays + upcoming bookings ---------------- */
const STAYS = [
  { ref: 'SSR-0714', guest: 'Jose Ramos',    room: '101', src: 'Front Desk',   in: -2, out: 0, a: 2, k: 0, total: 4100, paid: 3600 },
  { ref: 'SSR-0716', guest: 'Patricia Tan',  room: '104', src: 'Booking.com',  in: -1, out: 1, a: 2, k: 0, total: 3600, paid: 3600 },
  { ref: 'SSR-0717', guest: 'Lara Go',       room: '201', src: 'Agoda',        in: -3, out: 0, a: 1, k: 0, total: 5400, paid: 5400 },
  { ref: 'SSR-0718', guest: 'Ken Ong',       room: '203', src: 'Front Desk',   in: -1, out: 2, a: 2, k: 1, total: 5700, paid: 4000 },
  { ref: 'SSR-0719', guest: 'Sam Lim',       room: '206', src: 'Booking.com',  in: -2, out: 1, a: 3, k: 2, total: 7800, paid: 7800 },
  { ref: 'SSR-0712', guest: 'Tina Chua',     room: '302', src: 'Expedia',      in: -4, out: 0, a: 2, k: 2, total: 10650, paid: 10400 },
  { ref: 'SSR-0715', guest: 'Rina Santos',   room: '304', src: 'Front Desk',   in: -2, out: 3, a: 4, k: 0, total: 13000, paid: 13000 },
  { ref: 'SSR-0713', guest: 'Ella Diaz',     room: '305', src: 'Agoda',        in: -1, out: 1, a: 1, k: 0, total: 3600, paid: 3600 }
];

const UPCOMING = [
  { ref: 'SSR-2026-0720', guest: 'Andrea Lim',    contact: '0917 555 0110', src: 'Booking.com', in: 0, out: 2, a: 2, k: 1, type: 'Family',   total: 7800, paid: 7800, status: 'Confirmed' },
  { ref: 'SSR-2026-0721', guest: 'Ben Uy',        contact: '0918 555 0111', src: 'Agoda',       in: 0, out: 1, a: 1, k: 0, type: 'Standard', total: 1800, paid: 900,  status: 'Pending payment' },
  { ref: 'SSR-2026-0722', guest: 'Cathy Sy',      contact: '0919 555 0112', src: 'Expedia',     in: 1, out: 3, a: 2, k: 0, type: 'Standard', total: 3600, paid: 0,    status: 'Needs review' },
  { ref: 'SSR-2026-0723', guest: 'Dan Villanueva',contact: '0920 555 0113', src: 'Front Desk',  in: 2, out: 4, a: 2, k: 2, type: 'Family',   total: 5200, paid: 5200, status: 'Confirmed' }
];

const INVENTORY = [
  { item: 'Bath towels',      category: 'Linen',     stock: 48, reorder: 30 },
  { item: 'Bed sheets',       category: 'Linen',     stock: 22, reorder: 24 },
  { item: 'Pillow cases',     category: 'Linen',     stock: 60, reorder: 30 },
  { item: 'Shampoo sachets',  category: 'Amenities', stock: 120, reorder: 60 },
  { item: 'Soap bars',        category: 'Amenities', stock: 44, reorder: 50 },
  { item: 'Toilet paper',     category: 'Amenities', stock: 90, reorder: 40 },
  { item: 'All-purpose cleaner', category: 'Cleaning', stock: 12, reorder: 10 },
  { item: 'Disinfectant spray',  category: 'Cleaning', stock: 8,  reorder: 12 }
];

async function run() {
  await connectDB();
  console.log(DROP ? '→ Dropping existing SIROMS data…' : '→ Seeding (upsert)…');

  const models = [User, Room, Reservation, GuestRequest, HousekeepingTask, Inspection,
                  MaintenanceTicket, LostFoundItem, InventoryItem, RestockRequest,
                  Transaction, Notification];
  if (DROP) for (const M of models) await M.deleteMany({});

  /* staff */
  const users = {};
  for (const s of STAFF) {
    users[s.name] = await saveDoc(User, { staffId: s.staffId }, s);
  }
  console.log(`  ✔ ${Object.keys(users).length} staff accounts`);

  /* rooms */
  const rooms = {};
  for (const r of buildRooms()) {
    rooms[r.number] = await saveDoc(Room, { number: r.number }, r);
  }
  console.log(`  ✔ ${Object.keys(rooms).length} rooms`);

  /* in-house stays — reservation + room linked both ways, once */
  let stayCount = 0;
  for (const s of STAYS) {
    const room = rooms[s.room];
    const doc = {
      ref: s.ref, guest: s.guest, source: s.src, room: room._id, roomType: room.type,
      checkIn: day(s.in), checkOut: day(s.out), adults: s.a, kids: s.k,
      total: s.total, paid: s.paid, deposit: DEPOSIT, status: 'Checked in',
      checkedInAt: day(s.in), inspectionState: 'none',
      folio: [{ label: `Room ${s.room} accommodation`, amount: s.total }]
    };
    const res = await saveDoc(Reservation, { ref: s.ref }, doc);
    await saveDoc(Room, { _id: room._id }, { status: 'occupied', currentReservation: res._id });
    if (s.paid > 0) {
      await saveDoc(Transaction, { code: `TX-SEED-${s.ref}` }, {
        code: `TX-SEED-${s.ref}`, reservation: res._id, bookingRef: s.ref, guest: s.guest,
        room: room._id, roomNumber: s.room, type: 'Check-in payment', method: 'Cash',
        amount: s.paid, staffName: 'Anne Reyes', when: day(s.in)
      });
    }
    stayCount++;
  }

  for (const b of UPCOMING) {
    await saveDoc(Reservation, { ref: b.ref }, {
      ref: b.ref, guest: b.guest, contact: b.contact, source: b.src, roomType: b.type,
      checkIn: day(b.in), checkOut: day(b.out), adults: b.a, kids: b.k,
      total: b.total, paid: b.paid, deposit: DEPOSIT, status: b.status,
      folio: [{ label: 'Accommodation', amount: b.total }]
    });
  }
  console.log(`  ✔ ${stayCount} in-house stays + ${UPCOMING.length} upcoming reservations`);

  /* housekeeping tasks */
  const taskSeed = [
    { room: '102', type: 'Daily cleaning',    staff: 'Ana Cruz',  status: 'In Progress',          priority: 'Medium' },
    { room: '105', type: 'Checkout cleaning', staff: 'Joy Ramos', status: 'Ready for Inspection', priority: 'High' },
    { room: '202', type: 'Daily cleaning',    staff: 'Mika Ong',  status: 'Assigned',             priority: 'Low' },
    { room: '303', type: 'Checkout cleaning', staff: 'Ana Cruz',  status: 'Assigned',             priority: 'High' }
  ];
  for (const t of taskSeed) {
    const room = rooms[t.room], hk = users[t.staff];
    await saveDoc(HousekeepingTask,
      { room: room._id, type: t.type, status: t.status },
      { room: room._id, roomNumber: t.room, type: t.type, kind: 'cleaning',
        priority: t.priority, status: t.status, assignedTo: hk._id, assignedToName: hk.name,
        supervisor: users['Liza Mendoza']._id, supervisorName: 'Liza Mendoza' });
    // keep the room record in step with its task (single source of truth)
    const map = { 'In Progress': 'cleaning', 'Ready for Inspection': 'ready-for-inspection', Assigned: 'dirty' };
    if (map[t.status]) await saveDoc(Room, { _id: room._id }, { status: map[t.status] });
  }
  console.log(`  ✔ ${taskSeed.length} housekeeping tasks`);

  /* guest requests — includes the brief's Room 104 example, left Pending
     so a supervisor can assign it during the integration test */
  const reqSeed = [
    { room: '104', items: [{ name: 'Extra Mattress', qty: 1, price: 500 }], notes: '', status: 'Pending' },
    { room: '206', items: [{ name: 'Additional towels', qty: 2, price: 0 }, { name: 'Extra pillow', qty: 2, price: 0 }], notes: 'Family of five', status: 'Pending' },
    { room: '203', items: [{ name: 'Baby crib', qty: 1, price: 300 }], notes: 'Set up before 8 PM', status: 'Delivered' }
  ];
  for (const r of reqSeed) {
    const room = rooms[r.room];
    const res = await Reservation.findOne({ room: room._id, status: 'Checked in' });
    if (!res) continue;
    const existing = await GuestRequest.findOne({ room: room._id, 'items.name': r.items[0].name });
    if (existing) continue;
    await GuestRequest.create({
      room: room._id, roomNumber: r.room, reservation: res._id, guest: res.guest,
      items: r.items, notes: r.notes, status: r.status,
      createdBy: users['Anne Reyes']._id, createdByName: 'Anne Reyes',
      charge: r.items.reduce((s, i) => s + i.price * i.qty, 0),
      ...(r.status === 'Delivered'
        ? { assignedTo: users['Ana Cruz']._id, assignedToName: 'Ana Cruz',
            assignedBy: users['Liza Mendoza']._id, assignedByName: 'Liza Mendoza',
            assignedAt: day(-1), deliveredAt: day(-1), deliveredByName: 'Ana Cruz' }
        : {})
    });
  }
  console.log(`  ✔ ${reqSeed.length} guest requests (Room 104 left Pending for the demo)`);

  /* maintenance tickets */
  /* maintenance tickets — every record is a state the workflow could really
     produce:  Reported → Assessed → Assigned → In Progress → Resolved
       • pre-assessment  : no priority, no technician
       • assessed/assigned: priority AND technician set
       • resolved        : technician, repair notes and resolvedAt present     */
  const ticketSeed = [
    { code: 'MT-0001', room: '306', category: 'Air-conditioning',
      issue: 'Air-conditioning not cooling',
      stage: 'assigned', status: 'Repair in progress',
      priority: 'High', impact: 'Room must be taken offline',
      tech: 'Carlo Diaz', by: 'Ana Cruz', assessedBy: 'Liza Mendoza',
      parts: 'Compressor capacitor', eta: 1,
      notes: 'Capacitor replacement under way.',
      history: [
        [-2, 'Ana Cruz', 'Issue reported to supervisor'],
        [-2, 'Liza Mendoza', 'Assessed as High priority — room taken offline'],
        [-2, 'Liza Mendoza', 'Assigned to Carlo Diaz'],
        [-1, 'Carlo Diaz', 'Repair in progress — replacing compressor capacitor']
      ] },

    // Pre-assessment: deliberately NO priority and NO technician.
    { code: 'MT-0002', room: '204', category: 'Plumbing',
      issue: 'Loose bathroom faucet',
      stage: 'assessment', status: 'Awaiting assessment',
      by: 'Ana Cruz',
      history: [ [0, 'Ana Cruz', 'Issue reported to supervisor'] ] },

    { code: 'MT-0003', room: '203', category: 'Electrical',
      issue: 'Bedside lamp not switching on',
      stage: 'assigned', status: 'Waiting for parts',
      priority: 'Low', impact: 'Room can stay in use',
      tech: 'Rey Molina', by: 'Joy Ramos', assessedBy: 'Liza Mendoza',
      parts: 'Lamp switch', eta: 2,
      notes: 'Replacement switch on order.',
      history: [
        [-2, 'Joy Ramos', 'Issue reported to supervisor'],
        [-1, 'Liza Mendoza', 'Assessed as Low priority — room can stay in use'],
        [-1, 'Liza Mendoza', 'Assigned to Rey Molina'],
        [-1, 'Rey Molina', 'Waiting for replacement switch to arrive']
      ] },

    { code: 'MT-0004', room: '102', category: 'Furniture / Fixture',
      issue: 'Wobbly desk chair',
      stage: 'resolved', status: 'Resolved',
      priority: 'Medium', impact: 'Room can stay in use',
      tech: 'Carlo Diaz', by: 'Mika Ong', assessedBy: 'Liza Mendoza',
      parts: 'Chair bolts', resolved: -1,
      notes: 'Bolts tightened and seat base tested — chair is stable.',
      history: [
        [-3, 'Mika Ong', 'Issue reported to supervisor'],
        [-2, 'Liza Mendoza', 'Assessed as Medium priority'],
        [-2, 'Liza Mendoza', 'Assigned to Carlo Diaz'],
        [-1, 'Carlo Diaz', 'Resolved — bolts tightened and tested']
      ] }
  ];

  for (const t of ticketSeed) {
    const room = rooms[t.room];
    // Guard: never seed a technician onto a ticket that has not been assessed.
    if (t.stage !== 'assessment' && !t.priority)
      throw new Error(`Seed error: ${t.code} is "${t.stage}" but has no priority.`);
    if (t.stage === 'assessment' && (t.tech || t.priority))
      throw new Error(`Seed error: ${t.code} is pre-assessment but carries an assessment/technician.`);

    await saveDoc(MaintenanceTicket, { code: t.code }, {
      code: t.code, room: room._id, roomNumber: t.room,
      category: t.category, issue: t.issue,
      priority: t.priority || null, impact: t.impact || null,
      stage: t.stage, status: t.status,
      assignedTo: t.tech ? users[t.tech]._id : null,
      assignedToName: t.tech || '',
      reportedBy: users[t.by]._id, reportedByName: t.by,
      reportedAt: day(t.history[0][0]),
      eta: t.eta != null ? day(t.eta) : null,
      parts: t.parts || '',
      repairNotes: t.notes || '',
      resolvedAt: t.stage === 'resolved' ? day(t.resolved) : null,
      history: t.history.map(([d, who, what]) => ({ when: day(d), who, what }))
    });
  }

  /* Roll the room's maintenance state up from its unresolved tickets, so the
     Room record stays the single source of truth (no page recomputes it). */
  for (const t of ticketSeed) {
    if (t.stage === 'resolved') continue;
    const room = rooms[t.room];
    const takenOffline = /offline/i.test(t.impact || '');
    const fresh = await Room.findById(room._id);
    fresh.maintenance.state = takenOffline ? 'under-repair' : 'reported';
    fresh.maintenance.openTickets = (fresh.maintenance.openTickets || 0) + 1;
    // Only pull a room out of service when the assessment says so, and never
    // while a guest is still in it.
    if (takenOffline && !fresh.currentReservation) fresh.status = 'maintenance';
    await fresh.save();
  }

  console.log(`  ✔ ${ticketSeed.length} maintenance tickets`);

  /* lost & found */
  const lfSeed = [
    { code: 'LF-0001', item: 'Blue umbrella', category: 'Personal item', location: 'Lobby',    condition: 'Good', status: 'Stored', by: 'Anne Reyes' },
    { code: 'LF-0002', item: 'Silver wristwatch', category: 'Valuables', location: 'Room 205', condition: 'Good', status: 'Claim pending', by: 'Ana Cruz' },
    { code: 'LF-0003', item: 'Phone charger', category: 'Electronics',   location: 'Room 103', condition: 'Good', status: 'Released', by: 'Joy Ramos', claimant: 'Marta Yu' }
  ];
  for (const l of lfSeed) {
    await saveDoc(LostFoundItem, { code: l.code }, {
      code: l.code, item: l.item, category: l.category, location: l.location,
      condition: l.condition, status: l.status, reportedBy: users[l.by]._id,
      reportedByName: l.by, foundAt: day(-2), claimant: l.claimant || '',
      claimantContact: l.claimantContact || '',
      releasedByName: l.status === 'Released' ? l.by : '',
      releasedAt: l.status === 'Released' ? day(-1) : null,
      history: [{ when: day(-2), who: l.by, what: 'Item logged and stored' }]
    });
  }
  console.log(`  ✔ ${lfSeed.length} lost & found records`);

  /* inventory */
  for (const i of INVENTORY) {
    await saveDoc(InventoryItem, { item: i.item },
      { ...i, lastUpdated: T(), lastByName: 'Liza Mendoza' });
  }
  console.log(`  ✔ ${INVENTORY.length} inventory items`);

  const counts = {};
  for (const M of models) counts[M.modelName] = await M.countDocuments();
  console.log('\n✔ Seed complete:');
  Object.entries(counts).forEach(([k, v]) => console.log(`   ${k.padEnd(18)} ${v}`));
  console.log('\nSign in with any of these PINs:');
  STAFF.slice(0, 5).forEach((s) => console.log(`   ${s.pin}  ${s.name.padEnd(14)} ${s.title}`));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error('✖ Seed failed:', err); process.exit(1); });
