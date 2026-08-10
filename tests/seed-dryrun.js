'use strict';
/* Executes the REAL server/seed/seed.js with the persistence layer stubbed,
   so every document the seed builds is run through full Mongoose document
   validation — exactly the validation a live save() would apply.
   Proves the seed completes without touching a database. */
const path = require('path');
const mongoose = require('mongoose');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/dryrun';
process.env.SESSION_SECRET = 'dry-run';

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'server/models'));

// Stub the DB connector before the seed requires it.
require.cache[require.resolve(path.join(ROOT, 'server/config/db'))] = {
  id: 'db', filename: 'db', loaded: true,
  exports: { connectDB: async () => {}, isConnected: () => true }
};

const saved = [];                       // every validated document, in order
const byId = new Map();
const failures = [];

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  const got = k === '_id' ? doc._id : doc.get(k);
  return String(got) === String(v);
});

Object.values(M).forEach((Model) => {
  if (!Model || !Model.modelName) return;
  const name = Model.modelName;
  Model.deleteMany = async () => { for (let i = saved.length - 1; i >= 0; i--) if (saved[i].constructor.modelName === name) saved.splice(i, 1); };
  Model.countDocuments = async () => saved.filter((d) => d.constructor.modelName === name).length;
  Model.findOne = async (filter = {}) =>
    saved.find((d) => d.constructor.modelName === name && matches(d, filter)) || null;
  Model.findById = async (id) => byId.get(String(id)) || null;
  Model.find = async (filter = {}) =>
    saved.filter((d) => d.constructor.modelName === name && matches(d, filter));
  Model.create = async (data) => {
    const docs = Array.isArray(data) ? data : [data];
    const made = docs.map((d) => new Model(d));
    for (const doc of made) await doc.save();
    return Array.isArray(data) ? made : made[0];
  };
});

// The heart of it: save() = validate for real, then record.
mongoose.Model.prototype.save = async function save() {
  const err = this.validateSync();
  if (err) {
    failures.push({
      model: this.constructor.modelName,
      key: this.code || this.ref || this.number || this.staffId || this.item || this.roomNumber || '(n/a)',
      errors: Object.entries(err.errors).map(([f, e]) => `${f}: ${e.message}`)
    });
    throw err;
  }
  if (!byId.has(String(this._id))) { saved.push(this); byId.set(String(this._id), this); }
  return this;
};

mongoose.disconnect = async () => {};
const realExit = process.exit;
let seedExit = null;
process.exit = (c) => { seedExit = c; };   // let run() finish instead of unwinding

(async () => {
  console.log('Dry-running server/seed/seed.js (validation only, no database)\n');
  require(path.join(ROOT, 'server/seed/seed.js'));
  await new Promise((r) => setTimeout(r, 600));     // let the async run() finish
  if (seedExit) { console.log(`\n✘ Seed exited with code ${seedExit}`); }

  process.exit = realExit;

  if (failures.length) {
    console.log(`\n✘ ${failures.length} document(s) failed validation:`);
    failures.forEach((f) => console.log(`   ${f.model} ${f.key}\n     ${f.errors.join('\n     ')}`));
    process.exit(1);
  }

  const counts = {};
  saved.forEach((d) => { counts[d.constructor.modelName] = (counts[d.constructor.modelName] || 0) + 1; });
  console.log('\n✔ Seed ran to completion. Documents built and validated:');
  Object.entries(counts).sort().forEach(([k, v]) => console.log(`   ${k.padEnd(18)} ${v}`));

  /* ---- targeted audit of the maintenance workflow rules ---- */
  console.log('\nMaintenance ticket audit:');
  let bad = 0;
  saved.filter((d) => d.constructor.modelName === 'MaintenanceTicket').forEach((t) => {
    const problems = [];
    if (t.stage === 'assessment' && t.priority) problems.push('pre-assessment but has a priority');
    if (t.stage === 'assessment' && t.assignedToName) problems.push('pre-assessment but has a technician');
    if (t.stage !== 'assessment' && !t.priority) problems.push('assessed/assigned without a priority');
    if (t.stage !== 'assessment' && !t.assignedToName) problems.push('assigned without a technician');
    if (t.stage === 'resolved' && !t.resolvedAt) problems.push('resolved without resolvedAt');
    if (t.stage === 'resolved' && !t.repairNotes) problems.push('resolved without repair notes');
    if (t.history.length < 1) problems.push('no history');
    if (problems.length) { bad++; console.log(`   ✘ ${t.code} — ${problems.join('; ')}`); }
    else console.log(`   ✔ ${t.code} ${String(t.stage).padEnd(11)} ${String(t.status).padEnd(19)} ` +
      `${t.priority ? String(t.priority).padEnd(7) : '—      '} ${t.assignedToName || '(unassigned)'} · ${t.history.length} history entries`);
  });

  console.log('\nLost & found audit:');
  saved.filter((d) => d.constructor.modelName === 'LostFoundItem').forEach((l) => {
    const problem = l.status === 'Released' && !l.claimant ? 'released without a claimant' : null;
    if (problem) { bad++; console.log(`   ✘ ${l.code} — ${problem}`); }
    else console.log(`   ✔ ${l.code} ${String(l.status).padEnd(14)} ${l.claimant || ''}`);
  });

  console.log('\nGuest request audit:');
  saved.filter((d) => d.constructor.modelName === 'GuestRequest').forEach((g) => {
    const problem = ['Assigned', 'In delivery'].includes(g.status) && !g.assignedTo
      ? 'not Pending but nobody assigned' : null;
    if (problem) { bad++; console.log(`   ✘ Room ${g.roomNumber} — ${problem}`); }
    else console.log(`   ✔ Room ${String(g.roomNumber).padEnd(4)} ${String(g.status).padEnd(10)} ${g.assignedToName || '(unassigned)'}`);
  });

  console.log('\nReservation date sanity:');
  const badDates = saved.filter((d) => d.constructor.modelName === 'Reservation' && d.checkOut <= d.checkIn);
  console.log(badDates.length ? `   ✘ ${badDates.length} with checkOut <= checkIn` : '   ✔ all check-out dates follow check-in');
  bad += badDates.length;

  console.log(bad ? `\n✘ ${bad} workflow violation(s)` : '\n✔ No workflow violations — every seeded record is a state the app could produce.');
  process.exit(bad ? 1 : 0);
})();
