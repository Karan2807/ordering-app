import express from 'express';
import { authMiddleware } from '../auth.js';
import Item from '../models/item.js';

const router = express.Router();

// Get all items
router.get('/', async (req, res) => {
  try {
    const items = await Item.find().sort({ category: 1, name: 1 }).lean();
    res.json(items);
  } catch (err) {
    console.error('Get items error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create item
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { code, name, category, unit } = req.body;

    if (!code || !name) {
      return res.status(400).json({ error: 'Code and name required' });
    }

    const existing = await Item.findOne({ code });
    if (existing) {
      return res.status(400).json({ error: 'Code already exists' });
    }

    await Item.create({ code, name, category: category || '', unit: unit || '' });
    res.json({ success: true });
  } catch (err) {
    console.error('Create item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete item
router.delete('/:code', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await Item.deleteOne({ code: req.params.code });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk import items (via CSV)
router.post('/bulk/import', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { items, mode } = req.body; // mode: 'merge' or 'replace'

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items must be an array' });
    }

    if (mode === 'replace') {
      await Item.deleteMany({});
    }

    const toInsert = [];
    for (const item of items) {
      const { code, name, category, unit } = item;
      if (code && name) {
        toInsert.push({ code, name, category: category || '', unit: unit || '' });
      }
    }
    if (toInsert.length) {
      await Item.insertMany(toInsert, { ordered: false });
    }

    res.json({ success: true, imported: items.length });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
