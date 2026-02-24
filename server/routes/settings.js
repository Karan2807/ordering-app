import express from 'express';
import { authMiddleware } from '../auth.js';
import Setting from '../models/setting.js';

const router = express.Router();

// Get all settings
router.get('/', async (req, res) => {
  try {
    const docs = await Setting.find().lean();
    const settings = {};
    docs.forEach((row) => {
      if (row.key.startsWith('schedule')) {
        settings[row.key.replace('schedule', '')] = parseInt(row.value);
      } else if (row.key.startsWith('message')) {
        settings[row.key.replace('message', '')] = row.value;
      }
    });
    res.json(settings);
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update schedule (admin only)
router.patch('/schedule/:type', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { day } = req.body;

    if (day === undefined || day < 0 || day > 6) {
      return res.status(400).json({ error: 'Invalid day' });
    }

    await Setting.updateOne({ key: `schedule${req.params.type}` }, { value: day.toString() });

    res.json({ success: true });
  } catch (err) {
    console.error('Update schedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update message (admin only)
router.patch('/message/:type', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    await Setting.updateOne({ key: `message${req.params.type}` }, { value: message });

    res.json({ success: true });
  } catch (err) {
    console.error('Update message error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
