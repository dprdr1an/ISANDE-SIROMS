'use strict';
/** Entry point: validate config → connect MongoDB (once) → start HTTP server. */
const { env, assertConfig } = require('./config/env');
require('./models');                                   // register every model once
const { connectDB, disconnectDB, supportsTransactions } = require('./config/db');
const { createApp } = require('./app');

async function main() {
  assertConfig();
  await connectDB();
  console.log(`[SIROMS] MongoDB connected (db: ${env.MONGODB_DB}; transactions: ${supportsTransactions() ? 'on' : 'off — retry-safe mode'})`);
  const app = createApp();
  const server = app.listen(env.PORT, () => console.log(`[SIROMS] http://localhost:${env.PORT}  (${env.NODE_ENV})`));
  const stop = async sig => {
    console.log(`[SIROMS] ${sig} received, shutting down…`);
    server.close(async () => { await disconnectDB(); process.exit(0); });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(err => {
  // Never print the connection string: it contains credentials.
  console.error('[SIROMS] Failed to start:', err.code === 'CONFIG' ? err.message : (err.message || err).toString().replace(/mongodb(\+srv)?:\/\/[^\s]+/g, 'mongodb://<redacted>'));
  process.exit(1);
});
