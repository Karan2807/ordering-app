import express from 'express';
import { authMiddleware } from '../auth.js';
import Store from '../models/store.js';

const router = express.Router();

// Get all stores
router.get('/', async (req, res) => {
  try {
    const stores = await Store.find().sort({ name: 1 }).lean();
    res.json(stores.map((s) => ({ id: s.id, name: s.name })));
  } catch (err) {
    console.error('Get stores error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create store (admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { id, name } = req.body;

    if (!id || !name) {
      return res.status(400).json({ error: 'ID and name required' });
    }

    const existing = await Store.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'ID already exists' });
    }

    await Store.create({ id, name });
    res.json({ success: true });
  } catch (err) {
    console.error('Create store error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update store (admin only)
router.patch('/:storeId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }

    await Store.updateOne({ id: req.params.storeId }, { name });

    res.json({ success: true });
  } catch (err) {
    console.error('Update store error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete store (admin only)
router.delete('/:storeId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const storeCount = await Store.countDocuments();
    if (storeCount <= 1) {
      return res.status(400).json({ error: 'Must keep at least 1 store' });
    }

    await Store.deleteOne({ id: req.params.storeId });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete store error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
