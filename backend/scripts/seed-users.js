'use strict';
/**
 * Staff-accounts-only seed.        npm run seed:users
 *
 * Creates the SIROMS staff login accounts and nothing else: no rooms,
 * reservations, transactions, tasks, tickets, inventory, notifications or
 * attendance. Safe to run against an existing database:
 *   - never drops, deletes or clears anything
 *   - an account whose Staff ID already exists is SKIPPED (its password and
 *     profile are left exactly as they are)
 *   - running it again creates nothing new
 *
 * Every account it creates gets the password in SEED_PASSWORD (backend/.env),
 * hashed with bcrypt exactly like scripts/seed.js. No password is stored here.
 * Like scripts/seed.js, it refuses to run when NODE_ENV=production, because a
 * shared password is only acceptable for development accounts.
 *
 * Note: `npm run seed` refuses to run on a database that already has users, so
 * after this script use `npm run seed:reset` if you later want the full sample
 * data (that command wipes the database).
 */
const bcrypt = require('bcryptjs');
const { env, assertConfig } = require('../src/config/env');
const { connectDB, disconnectDB } = require('../src/config/db');
// Only the User model is loaded, so connecting prepares the users collection only.
const User = require('../src/models/User');

// Same accounts as the staff list in scripts/seed.js (Staff ID, name, role).
const STAFF = [
  ['6767', 'Anne Reyes', 'frontdesk'], ['2211', 'Ana Cruz', 'housekeeper'], ['3344', 'Liza Mendoza', 'supervisor'],
  ['4455', 'Carlo Diaz', 'maintenance'], ['5566', 'Marco Santos', 'manager'],
  ['2212', 'Joy Ramos', 'housekeeper'], ['2213', 'Mika Ong', 'housekeeper'], ['2214', 'Carla Reyes', 'housekeeper'], ['4456', 'Rey Molina', 'maintenance']
];

/** Creates missing accounts. Returns { created, skipped, failed } lists of Staff IDs. */
async function seedUsers({ password = process.env.SEED_PASSWORD || '', log = console.log } = {}) {
  if (env.isProd) throw new Error('Refusing to seed: NODE_ENV=production.');
  if (password.length < 10) throw new Error('Set SEED_PASSWORD (at least 10 characters) in backend/.env. It becomes the password of each account this script creates.');

  const existing = new Set((await User.find({ staffId: { $in: STAFF.map(s => s[0]) } }, { staffId: 1 }).lean()).map(u => u.staffId));
  const result = { created: [], skipped: [], failed: [] };
  let hash = null;

  for (const [staffId, name, role] of STAFF) {
    if (existing.has(staffId)) { result.skipped.push(staffId); log(`  skip    ${staffId}  ${name.padEnd(14)} already exists (left unchanged)`); continue; }
    try {
      hash = hash || await bcrypt.hash(password, env.BCRYPT_ROUNDS);
      await User.create({ staffId, name, role, passwordHash: hash });
      result.created.push(staffId);
      log(`  create  ${staffId}  ${name.padEnd(14)} ${role}`);
    } catch (e) {
      if (e && e.code === 11000) {             // created by someone else in the meantime
        result.skipped.push(staffId);
        log(`  skip    ${staffId}  ${name.padEnd(14)} already exists (left unchanged)`);
      } else {
        const why = e && e.name === 'ValidationError' ? Object.values(e.errors).map(x => x.message).join('; ') : (e && e.message) || String(e);
        result.failed.push(staffId);
        log(`  ERROR   ${staffId}  ${name.padEnd(14)} ${why}`);
      }
    }
  }
  return result;
}

async function main() {
  assertConfig();
  // Check everything before connecting, so a refusal never touches the database.
  if (env.isProd) throw new Error('Refusing to seed: NODE_ENV=production.');
  if ((process.env.SEED_PASSWORD || '').length < 10) throw new Error('Set SEED_PASSWORD (at least 10 characters) in backend/.env. It becomes the password of each account this script creates.');
  await connectDB();
  console.log(`Seeding staff accounts into "${env.MONGODB_DB}" (users only):`);
  const r = await seedUsers();
  console.log(`Done: ${r.created.length} created, ${r.skipped.length} skipped (already existed), ${r.failed.length} failed.`);
  if (r.created.length) console.log('New accounts use the password in SEED_PASSWORD (backend/.env).');
  if (r.failed.length) process.exitCode = 1;
}

if (require.main !== module) module.exports = { seedUsers, STAFF };
else main().then(() => disconnectDB()).catch(async e => {
  console.error('Seeding staff accounts failed:', e.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
