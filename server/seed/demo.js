'use strict';
/**
 * DEMO STORYLINE SEED — "A Stay at Siesta Spaces"
 *
 *   npm run seed:demo
 *
 * Adds ONE coherent dataset (guest John Dela Cruz, Room 203) so the whole
 * SIROMS workflow can be demonstrated live. It does not touch the base seed
 * script and does not remove base demonstration data.
 *
 * It deliberately seeds only the STARTING state — a confirmed one-night
 * reservation. Check-in, checkout, inspection, damage, maintenance, cleaning,
 * supervisor verification and lost & found all happen live through the
 * existing workflows and business rules.
 *
 * Flags:
 *   --prepaid                     mark the accommodation as already settled
 *                                 (by default it is collected at check-in)
 *   --resolve-conflicting-ticket  close the pre-existing MT-0003 "Bedside lamp"
 *                                 ticket on Room 203 (normal workflow
 *                                 transition, nothing deleted) so the stage is
 *                                 clean. Off by default.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const {
  User, Room, Reservation, GuestRequest, HousekeepingTask, Inspection,
  MaintenanceTicket, LostFoundItem, Transaction, Notification
} = require('../models');
const { DEPOSIT } = require('../models/constants');

const PREPAID = process.argv.includes('--prepaid');   // settle accommodation up front
const RESOLVE_CONFLICT = process.argv.includes('--resolve-conflicting-ticket');

/* ---------------- stable demo identifiers ---------------- */
const DEMO = {
  ref: 'SSR-2026-9001',        // 9000-block = demo, same format as existing refs
  guest: 'John Dela Cruz',
  contact: '0917 888 9001',
  roomNumber: '203',
  txCode: 'TX-DEMO-9001',
  nights: 1
};

const day = (n) => new Date(Date.now() + n * 86400000);
const log = (m) => console.log(m);

/** Save through a document so every business rule is enforced (same approach
 *  the base seed uses — update validators cannot see sibling fields). */
async function saveDoc(Model, filter, data) {
  const doc = (await Model.findOne(filter)) || new Model();
  doc.set(data);
  await doc.save();
  return doc;
}

async function run() {
  await connectDB();
  log('\n────────────────────────────────────────────────────────');
  log('  SIROMS demo storyline — "A Stay at Siesta Spaces"');
  log('────────────────────────────────────────────────────────\n');

  /* ---------- 1. prerequisites ---------- */
  const room203 = await Room.findOne({ number: DEMO.roomNumber });
  if (!room203) {
    console.error(`✖ Room ${DEMO.roomNumber} does not exist.\n  Run "npm run seed" first, then "npm run seed:demo".`);
    return process.exit(1);
  }
  const staff = {};
  for (const [key, role] of Object.entries({
    frontdesk: 'frontdesk', housekeeper: 'housekeeper',
    supervisor: 'supervisor', maintenance: 'maintenance', manager: 'manager'
  })) {
    staff[key] = await User.findOne({ role, status: 'active' }).sort({ staffId: 1 });
    if (!staff[key]) {
      console.error(`✖ No active ${role} account found.\n  Run "npm run seed" first, then "npm run seed:demo".`);
      return process.exit(1);
    }
  }
  log('✔ Reusing existing Room 203 and existing staff accounts (nothing new created).');

  /* ---------- 2. clean up artefacts from a PREVIOUS demo run ----------
     Scoped strictly to the demo reservation and Room 203 records created
     after it. Base seed data is older and is never touched.               */
  const existing = await Reservation.findOne({ ref: DEMO.ref });
  const cutoff = existing ? existing.createdAt : null;
  if (existing) {
    log('\n→ Previous demo run detected — resetting it to the starting state.');
    const removed = [];
    const del = async (Model, filter, label) => {
      const r = await Model.deleteMany(filter);
      if (r.deletedCount) removed.push(`${r.deletedCount} ${label}`);
    };
    await del(Inspection,        { reservation: existing._id }, 'inspection(s)');
    await del(HousekeepingTask,  { reservation: existing._id }, 'housekeeping task(s)');
    await del(GuestRequest,      { reservation: existing._id }, 'guest request(s)');
    await del(Transaction,       { reservation: existing._id }, 'transaction(s)');
    // Records raised against Room 203 during the previous demo (base seed
    // records are older than the demo reservation, so they are protected).
    if (cutoff) {
      await del(MaintenanceTicket, { room: room203._id, reportedAt: { $gt: cutoff } }, 'maintenance ticket(s)');
      await del(LostFoundItem,     { room: room203._id, foundAt:    { $gt: cutoff } }, 'lost & found record(s)');
      await del(Notification,      { entityId: existing._id }, 'notification(s)');
    }
    log(removed.length ? `  removed: ${removed.join(', ')}` : '  nothing left over to remove');
  }

  /* ---------- 3. make Room 203 free for the demo ----------
     Room 203 is occupied in the base seed (Ken Ong). checkIn() rejects any
     room that is not "available", so the blocking stay is relocated to an
     equivalent free room. Nothing is deleted; the guest keeps their booking. */
  const blocker = await Reservation.findOne({
    room: room203._id, status: { $nin: ['Checked Out', 'Cancelled'] }, ref: { $ne: DEMO.ref }
  });
  if (blocker) {
    const target = await Room.findOne({
      type: room203.type, status: 'available', currentReservation: null, _id: { $ne: room203._id }
    }).sort({ number: 1 });
    if (!target) {
      console.error(`✖ Room 203 is occupied by ${blocker.guest} (${blocker.ref}) and there is no free ` +
                    `${room203.type} room to move them to.\n  Free a room, or run "npm run seed:fresh" then "npm run seed:demo".`);
      return process.exit(1);
    }
    blocker.room = target._id;
    await blocker.save();
    target.status = 'occupied';
    target.currentReservation = blocker._id;
    await target.save();
    log(`\n→ Room 203 was occupied by ${blocker.guest} (${blocker.ref}).`);
    log(`  Moved that stay to Room ${target.number} so Room 203 is free for the demo.`);
    log('  (Their booking is intact — nothing was deleted.)');
  }

  // Release Room 203 itself.
  room203.status = 'available';
  room203.currentReservation = null;
  room203.housekeeping.state = 'clean';
  await room203.save();

  /* ---------- 4. the pre-existing lamp ticket on Room 203 ---------- */
  const conflictTicket = await MaintenanceTicket.findOne({
    room: room203._id, stage: { $ne: 'resolved' }, issue: /lamp/i
  });
  if (conflictTicket) {
    if (RESOLVE_CONFLICT) {
      conflictTicket.status = 'Resolved';
      conflictTicket.stage = 'resolved';
      conflictTicket.resolvedAt = new Date();
      conflictTicket.repairNotes = conflictTicket.repairNotes ||
        'Replacement switch fitted and tested.';
      conflictTicket.history.push({
        when: new Date(), who: conflictTicket.assignedToName || 'Maintenance',
        what: 'Resolved — replacement switch fitted and tested'
      });
      await conflictTicket.save();
      room203.maintenance.openTickets = Math.max(0, room203.maintenance.openTickets - 1);
      if (room203.maintenance.openTickets === 0) room203.maintenance.state = 'ok';
      await room203.save();
      log(`\n→ Closed the pre-existing ticket ${conflictTicket.code} ("${conflictTicket.issue}") on Room 203`);
      log('  so it will not be confused with the lamp you break during the demo.');
    } else {
      log(`\n⚠ Heads-up: Room 203 already has an OPEN maintenance ticket from the base seed:`);
      log(`    ${conflictTicket.code} — "${conflictTicket.issue}" (${conflictTicket.status})`);
      log('  Your demo raises a second, similar lamp ticket, so both will be visible.');
      log('  Re-run with  npm run seed:demo -- --resolve-conflicting-ticket  to close it first.');
    }
  }

  /* ---------- 5. the demo reservation (the ONLY record we pre-create) ---------- */
  /* Accommodation only — the ₱1,000 deposit is a separate amount collected at
     check-in, never part of the rate. Default leaves the accommodation unpaid
     so the front desk collects ₱1,800 + ₱1,000 = ₱2,800 live. */
  const rate = room203.rate;
  const total = rate * DEMO.nights;
  const paid = PREPAID ? total : 0;

  const reservation = await saveDoc(Reservation, { ref: DEMO.ref }, {
    ref: DEMO.ref,
    guest: DEMO.guest,
    contact: DEMO.contact,
    source: 'Front Desk',
    room: null,                       // assigned live at check-in
    roomType: room203.type,
    checkIn: day(0),
    checkOut: day(DEMO.nights),
    adults: 1,
    kids: 0,
    total,
    paid,
    deposit: DEPOSIT,
    depositCollected: false,
    status: 'Confirmed',
    inspectionState: 'none',
    checkedInAt: null,
    checkedOutAt: null,
    imported: true,
    folio: [{ label: `Room ${DEMO.roomNumber} accommodation × ${DEMO.nights} night`, amount: total }]
  });

  if (paid > 0) {
    await saveDoc(Transaction, { code: DEMO.txCode }, {
      code: DEMO.txCode,
      reservation: reservation._id,
      bookingRef: DEMO.ref,
      guest: DEMO.guest,
      type: 'Reservation payment',
      method: 'Card',
      amount: paid,
      staffName: staff.frontdesk.name,
      when: new Date()
    });
  }

  /* ---------- 6. report ---------- */
  const fresh203 = await Room.findOne({ number: DEMO.roomNumber });
  log('\n✔ Demo data ready.\n');
  log('  Guest        ' + DEMO.guest);
  log('  Reservation  ' + DEMO.ref + '   (status: ' + reservation.status + ')');
  log('  Room         ' + DEMO.roomNumber + '   (status: ' + fresh203.status + ')');
  log('  Stay         1 night · ' + reservation.checkIn.toDateString() + ' → ' + reservation.checkOut.toDateString());
  log('  Charge       ₱' + total.toLocaleString() + '   paid ₱' + paid.toLocaleString() +
      '   balance ₱' + (total - paid).toLocaleString());
  log('  Deposit      ₱' + DEPOSIT.toLocaleString() + ' (settled at checkout after inspection)');
  log('  Due at check-in  ₱' + ((total - paid) + DEPOSIT).toLocaleString() +
      '  (accommodation ₱' + (total - paid).toLocaleString() + ' + deposit ₱' + DEPOSIT.toLocaleString() + ')');

  log('\n  Sign in as:');
  log(`    Front Desk    ${staff.frontdesk.name}`);
  log(`    Housekeeper   ${staff.housekeeper.name}`);
  log(`    Supervisor    ${staff.supervisor.name}`);
  log(`    Maintenance   ${staff.maintenance.name}`);
  log(`    Manager       ${staff.manager.name}`);

  log('\n  Run the storyline live (nothing below is pre-created):');
  [
    'Front Desk    check in John Dela Cruz → assign Room 203        → room Occupied',
    'Front Desk    start checkout                                    → Pending Room Inspection',
    'Housekeeper   open Room 203 inspection, add finding',
    '              "Broken bedside lamp" + remark (+ photo)          → damages deducted from deposit',
    'Front Desk    settle deposit / damage charge, complete checkout → room Dirty',
    'Housekeeper   report room issue: "Broken bedside lamp"          → ticket Awaiting assessment',
    'Supervisor    assess (set priority) then assign a technician    → rule: assess BEFORE assign',
    'Maintenance   update progress → Resolved',
    'Housekeeper   open the checkout cleaning task → work the checklist → submit',
    'Supervisor    verify/approve the cleaning                       → room Available',
    'Housekeeper   record Lost & Found: Apple Watch, Room 203,',
    '              storage "Storage Cabinet A"                       → unclaimed',
    'Front Desk    search John Dela Cruz → verify → release the item',
    'Manager       dashboard reflects all of it from live data'
  ].forEach((s, i) => log(`    ${String(i + 1).padStart(2)}. ${s}`));

  log('\n  Re-runnable: "npm run seed:demo" resets this storyline without');
  log('  touching base seed data.\n');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => { console.error('✖ Demo seed failed:', err); process.exit(1); });
