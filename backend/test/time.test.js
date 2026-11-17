'use strict';
/**
 * Unit tests for the hotel-time helpers (no database needed).
 * Instants are stored as UTC Dates; labels are formatted in APP_TIMEZONE
 * (Asia/Manila, UTC+8, no daylight saving) regardless of the server's own TZ.
 */
process.env.APP_TIMEZONE = 'Asia/Manila';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromLocal, isoLocal, isoDate, timeLabel, clockLabel } = require('../src/utils/time');

// Mirrors frontend/app.js fmtInstant (browser formatting of a UTC instant).
const fmtInstant = d => new Date(d).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

test('5:58 PM Manila is stored as 09:58 UTC (no double +8 conversion)', () => {
  const login = fromLocal('2026-10-22T17:58');
  assert.equal(login.toISOString(), '2026-10-22T09:58:00.000Z');
  assert.equal(isoLocal(login), '2026-10-22T17:58');           // round-trips to the same wall-clock time
  assert.equal(timeLabel(login), '5:58 PM');
  assert.equal(timeLabel(login.toISOString()), '5:58 PM');     // ISO string with Z parses unambiguously
  assert.equal(fmtInstant(login.toISOString()), '5:58 PM');    // frontend formatting agrees with the server's
  assert.notEqual(timeLabel(login), '6:48 AM');
});

test('clockLabel: time only for the same Manila day, date + time otherwise', () => {
  const now = fromLocal('2026-10-22T17:58');
  assert.equal(clockLabel(now, now), '5:58 PM');
  assert.equal(clockLabel(fromLocal('2026-10-22T06:48'), now), '6:48 AM');           // earlier the same day
  assert.equal(clockLabel(fromLocal('2026-10-21T06:48'), now), 'Oct 21, 6:48 AM');   // stale shift from yesterday is visibly dated
  assert.equal(clockLabel(null, now), '—');
});

test('date boundaries use the Manila date, not the UTC date', () => {
  // 7:30 AM Manila is still the previous day in UTC.
  const morning = fromLocal('2026-10-22T07:30');
  assert.equal(morning.toISOString(), '2026-10-21T23:30:00.000Z');
  assert.equal(isoDate(morning), '2026-10-22');
  assert.equal(clockLabel(morning, fromLocal('2026-10-22T17:58')), '7:30 AM');
  // Just after midnight Manila (16:30 UTC the day before).
  const midnight = fromLocal('2026-10-22T00:30');
  assert.equal(midnight.toISOString(), '2026-10-21T16:30:00.000Z');
  assert.equal(clockLabel(midnight, fromLocal('2026-10-22T00:45')), '12:30 AM');
  // Overnight shift: started 11:30 PM, viewed at 12:30 AM the next Manila day.
  assert.equal(clockLabel(fromLocal('2026-10-21T23:30'), midnight), 'Oct 21, 11:30 PM');
  // Year boundary.
  assert.equal(clockLabel(fromLocal('2026-12-31T23:30'), fromLocal('2027-01-01T00:30')), 'Dec 31, 11:30 PM');
});

test('results do not depend on the server process timezone', () => {
  const original = process.env.TZ;
  const expected = { iso: '2026-10-22T09:58:00.000Z', label: '5:58 PM', day: '2026-10-22' };
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Manila', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      const d = fromLocal('2026-10-22T17:58');
      assert.equal(d.toISOString(), expected.iso, tz);
      assert.equal(timeLabel(d), expected.label, tz);
      assert.equal(isoDate(d), expected.day, tz);
      assert.equal(fmtInstant(d), expected.label, tz);
    }
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(new Date('2026-10-22T09:58:00Z').getHours(), 2, 'TZ switch took effect (2:58 AM PDT), so the loop above really varied the process timezone');
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});
