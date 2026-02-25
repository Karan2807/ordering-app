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

// make sure required environment variables are present
const requiredEnv = ['MONGODB_URI', 'JWT_SECRET'];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Required environment variable ${key} is not set. Aborting.`);
    process.exit(1);
  }
});

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration: only allow client origin plus localhost during development
const allowedOrigins = [];

// permit a client URL provided via environment; useful for Render or other hosts
if (process.env.CLIENT_ORIGIN) {
  allowedOrigins.push(process.env.CLIENT_ORIGIN);
}

// for convenience, automatically allow our Render frontend when running in production
// this means you can deploy the frontend to "https://ordering-app-uu24.onrender.com" without
// needing to set CLIENT_ORIGIN, although it's still recommended for flexibility.
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Initialize database and start server
async function start() {
  try {
    await initializeDatabase();
    await seedDatabase();
    
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
