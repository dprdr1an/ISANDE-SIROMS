'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');

const { connectDB, isConnected } = require('./config/db');
const { currentUser } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.error('✖ SESSION_SECRET is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  }
}));
app.use(currentUser);

// Health check — lets the frontend show a clear banner if the DB is down (§28)
app.get('/api/health', (req, res) => {
  res.status(isConnected() ? 200 : 503).json({
    status: isConnected() ? 'ok' : 'database-unavailable',
    db: isConnected()
  });
});

app.use('/api', apiRoutes);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use('/api', notFound);
app.use(errorHandler);

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`✔ SIROMS running on http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') console.log('  Run "npm run seed" once to load demonstration data.');
  });
}

if (require.main === module) start();
module.exports = { app, start };
