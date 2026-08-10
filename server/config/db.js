'use strict';
const mongoose = require('mongoose');

/**
 * Connect to MongoDB. Fails loudly — requirement 28 forbids silently falling
 * back to hardcoded data, so a failed connection must stop the server.
 */
async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('✖ MONGO_URI is not set. Copy .env.example to .env and set it.');
    process.exit(1);
  }
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, family: 4 });
    const { host, name } = mongoose.connection;
    console.log(`✔ Connected to MongoDB — ${host}/${name}`);
  } catch (err) {
    console.error('✖ Failed to connect to MongoDB:', err.message);
    console.error('  Check MONGO_URI in .env and that the server is reachable.');
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () =>
    console.warn('⚠ MongoDB disconnected — API requests will fail until it returns.'));
  mongoose.connection.on('reconnected', () =>
    console.log('✔ MongoDB reconnected.'));
  mongoose.connection.on('error', (e) =>
    console.error('✖ MongoDB error:', e.message));
}

/** True when a query can actually be served. Used by the health check. */
const isConnected = () => mongoose.connection.readyState === 1;

module.exports = { connectDB, isConnected };
