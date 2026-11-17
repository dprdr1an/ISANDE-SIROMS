'use strict';
/**
 * Environment configuration. All secrets come from backend/.env (never
 * committed) or the process environment. Nothing here is sent to the browser.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function list(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}
function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const env = {
  NODE_ENV,
  isProd,
  PORT: Number(process.env.PORT) || 3000,
  MONGODB_URI: process.env.MONGODB_URI || '',
  MONGODB_DB: process.env.MONGODB_DB || 'siroms',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  SESSION_TTL_HOURS: Number(process.env.SESSION_TTL_HOURS) || 12,
  // 'native' uses a MongoDB TTL index (Atlas). 'interval' prunes expired
  // sessions periodically (for servers without TTL index support).
  SESSION_AUTO_REMOVE: process.env.SESSION_AUTO_REMOVE || 'native',
  // 'auto' detects replica-set support; 'on' requires it; 'off' disables.
  MONGO_TRANSACTIONS: (process.env.MONGO_TRANSACTIONS || 'auto').toLowerCase(),
  CORS_ORIGINS: list(process.env.CORS_ORIGINS),
  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  SERVE_FRONTEND: bool(process.env.SERVE_FRONTEND, true),
  // Lists development staff IDs on the login screen. Forced off in production.
  ENABLE_DEMO_DIRECTORY: !isProd && bool(process.env.ENABLE_DEMO_DIRECTORY, true),
  APP_TIMEZONE: process.env.APP_TIMEZONE || 'Asia/Manila',
  BCRYPT_ROUNDS: Number(process.env.BCRYPT_ROUNDS) || 12,
  // Sign-in attempts allowed per IP per 15 minutes.
  LOGIN_RATE_LIMIT: Number(process.env.LOGIN_RATE_LIMIT) || 20
};

function assertConfig() {
  const problems = [];
  if (!env.MONGODB_URI) problems.push('MONGODB_URI is not set.');
  if (!env.SESSION_SECRET) problems.push('SESSION_SECRET is not set.');
  else if (env.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be at least 32 characters.');
  if (env.isProd && env.SESSION_SECRET.includes('change-me')) problems.push('SESSION_SECRET still uses the placeholder value.');
  if (!['auto', 'on', 'off'].includes(env.MONGO_TRANSACTIONS)) problems.push('MONGO_TRANSACTIONS must be auto, on or off.');
  if (problems.length) {
    const err = new Error('Invalid configuration:\n  - ' + problems.join('\n  - ') + '\nCopy backend/.env.example to backend/.env and fill it in.');
    err.code = 'CONFIG';
    throw err;
  }
}

module.exports = { env, assertConfig };
