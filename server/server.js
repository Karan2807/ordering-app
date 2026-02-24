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

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
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
    
    app.listen(PORT, () => {
      console.log(`✓ Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
