// import dotenv early using the config shortcut; this module itself runs dotenv.config()
// before any other modules are evaluated, ensuring process.env is populated.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import { initializeDatabase, seedDatabase } from './database.js';
import authRoutes from './routes/auth.js';
import itemRoutes from './routes/items.js';
import orderRoutes from './routes/orders.js';
import userRoutes from './routes/users.js';
import supplierRoutes from './routes/suppliers.js';
import storeRoutes from './routes/stores.js';
import notificationRoutes from './routes/notifications.js';
import settingsRoutes from './routes/settings.js';
import testEmailRoutes from './routes/testEmail.js';
import { startReminderScheduler } from './services/reminderScheduler.js';

// make sure required environment variables are present
const requiredEnv = ['MONGODB_URI', 'JWT_SECRET'];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Required environment variable ${key} is not set. Aborting.`);
    process.exit(1);
  }
});

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// CORS configuration: only allow client origins listed in env + localhost during development
const allowedOrigins = [];

// permit one or more client URLs provided via environment; useful for Render or other hosts.
// multiple origins can be comma separated.
if (process.env.CLIENT_ORIGIN) {
  process.env.CLIENT_ORIGIN.split(',').forEach((o) => {
    const trimmed = o.trim();
    if (trimmed) allowedOrigins.push(trimmed);
  });
}

// always allow the official Render frontend URL when in production; this helps
// when deploying the backend by itself without remembering CLIENT_ORIGIN.
if (process.env.NODE_ENV === 'production') {
  allowedOrigins.push('https://ordering-app-uu24.onrender.com');
}

// during development we accept any localhost host/port combination
const devLocalRegexp = /^https?:\/\/localhost(:\d+)?$/;

if (process.env.NODE_ENV !== 'production') {
  // also allow the backend itself
  allowedOrigins.push('http://localhost:5000');
}

app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (curl, mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || devLocalRegexp.test(origin)) {
        return callback(null, true);
      }
      console.warn(`CORS denied for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: false,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/test-email', testEmailRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Initialize database and start server
async function start(port = PORT) {
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }
  try {
    await initializeDatabase();
    await seedDatabase();

    const serverInstance = app.listen(listenPort, "0.0.0.0", () => {
      console.log(`Server running on port ${listenPort}`);
    });
    startReminderScheduler();

    serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${listenPort} in use, trying ${listenPort + 1}...`);
        // try next port
        start(listenPort + 1);
      } else {
        console.error('Server error:', err);
        process.exit(1);
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
