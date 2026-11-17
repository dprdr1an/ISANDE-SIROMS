'use strict';
/**
 * Single MongoDB connection for the whole app (Mongoose), plus detection of
 * multi-document transaction support. Atlas clusters are replica sets and
 * support transactions; a standalone/dev server may not.
 */
const mongoose = require('mongoose');
const { env } = require('./env');

let transactionsSupported = false;

async function connectDB(uri = env.MONGODB_URI, dbName = env.MONGODB_DB) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 10000,
    autoIndex: true
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 }).catch(() => ({}));
  const replica = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  if (env.MONGO_TRANSACTIONS === 'off') transactionsSupported = false;
  else if (env.MONGO_TRANSACTIONS === 'on') {
    if (!replica) throw new Error('MONGO_TRANSACTIONS=on but the MongoDB deployment is not a replica set.');
    transactionsSupported = true;
  } else transactionsSupported = replica;
  // Build indexes up front so unique constraints are in force before traffic.
  await Promise.all(Object.values(mongoose.models).map(m => m.init()));
  return mongoose.connection;
}

const supportsTransactions = () => transactionsSupported;

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB, supportsTransactions };
