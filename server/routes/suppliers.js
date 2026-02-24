import express from 'express';
import { authMiddleware } from '../auth.js';
import Supplier from '../models/supplier.js';

const router = express.Router();

// Get all suppliers (admin only)
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const suppliers = await Supplier.find().sort({ name: 1 }).lean();
    res.json(suppliers);
  } catch (err) {
    console.error('Get suppliers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create supplier
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { id, name, email, phone } = req.body;

    if (!id || !name || !email) {
      return res.status(400).json({ error: 'ID, name, and email required' });
    }

    const existing = await Supplier.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'ID already exists' });
    }

    await Supplier.create({ id, name, email, phone });
    res.json({ success: true });
  } catch (err) {
    console.error('Create supplier error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update supplier
router.patch('/:supplierId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { name, email, phone } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email required' });
    }

    await Supplier.updateOne({ id: req.params.supplierId }, { name, email, phone });

    res.json({ success: true });
  } catch (err) {
    console.error('Update supplier error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete supplier
router.delete('/:supplierId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await Supplier.deleteOne({ id: req.params.supplierId });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete supplier error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Assign items to supplier
router.post('/:supplierId/items', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { items } = req.body; // array of item codes
    await Supplier.updateOne({ id: req.params.supplierId }, { items });
    res.json({ success: true });
  } catch (err) {
    console.error('Assign items error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
