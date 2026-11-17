'use strict';
/** Express application (no listen() here so tests can mount it). */
const path = require('path');
const express = require('express');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const helmet = require('helmet');
const cors = require('cors');
const mongoose = require('mongoose');
const { env } = require('./config/env');
const { requireCsrfHeader } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],          // the UI uses inline style attributes
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': env.isProd ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  // CORS only matters when the frontend is served from a different origin.
  if (env.CORS_ORIGINS.length) {
    app.use('/api', cors({
      origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-SIROMS-Request']
    }));
  }

  app.use(express.json({ limit: '100kb' }));

  app.use(session({
    name: 'siroms.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      dbName: env.MONGODB_DB,
      collectionName: 'sessions',
      ttl: env.SESSION_TTL_HOURS * 3600,
      autoRemove: env.SESSION_AUTO_REMOVE,
      autoRemoveInterval: 10
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,                 // HTTPS-only cookie in production
      maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
      path: '/'
    }
  }));

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', requireCsrfHeader);
  app.get('/api/health', (_req, res) => res.json({ ok: true, data: { status: 'up', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' } }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api', require('./routes/api'));
  app.use('/api', notFoundHandler);

  if (env.SERVE_FRONTEND) {
    const dir = path.join(__dirname, '..', '..', 'frontend');
    app.use(express.static(dir, { index: 'index.html', extensions: ['html'], maxAge: env.isProd ? '1h' : 0 }));
  }
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
