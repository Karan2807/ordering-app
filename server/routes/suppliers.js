import express from 'express';
import { authMiddleware } from '../auth.js';
import Supplier from '../models/supplier.js';

const router = express.Router();
function normalizeEmails(inputEmail, inputEmails) {
  const fromArray = Array.isArray(inputEmails) ? inputEmails : [];
  const fromString = typeof inputEmails === 'string' ? inputEmails.split(/[,\n;]/) : [];
  const fromEmail = typeof inputEmail === 'string' ? inputEmail.split(/[,\n;]/) : [];
  const merged = [...fromArray, ...fromString, ...fromEmail]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(merged)];
  return unique;
}

// Get all suppliers (authenticated users)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const suppliers = await Supplier.find().sort({ name: 1 }).lean();
    res.json(
      suppliers.map((s) => {
        const emails = normalizeEmails(s.email, s.emails);
        return { ...s, email: emails[0] || '', emails };
      })
    );
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

    const { id, name, email, emails, phone } = req.body;
    const emailList = normalizeEmails(email, emails);

    if (!id || !name || emailList.length === 0) {
      return res.status(400).json({ error: 'ID, name, and at least one email required' });
    }

    const existing = await Supplier.findOne({ id });
    if (existing) {
      return res.status(400).json({ error: 'ID already exists' });
    }

    await Supplier.create({ id, name, email: emailList[0], emails: emailList, phone });
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

    const { name, email, emails, phone } = req.body;
    const emailList = normalizeEmails(email, emails);

    if (!name || emailList.length === 0) {
      return res.status(400).json({ error: 'Name and at least one email required' });
    }

    await Supplier.updateOne({ id: req.params.supplierId }, { name, email: emailList[0], emails: emailList, phone });

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
