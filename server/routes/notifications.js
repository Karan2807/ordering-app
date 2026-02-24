import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import Notification from '../models/notification.js';

const router = express.Router();

// Get all notifications
router.get('/', async (req, res) => {
  try {
    const notifs = await Notification.find().sort({ createdAt: -1 }).lean();
    res.json(notifs.map((n) => ({ id: n.id, text: n.text, type: n.type, date: n.date })));
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create notification (admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { text, type } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text required' });
    }

    const id = uuidv4();
    await Notification.create({ id, text, type: type || 'info', date: new Date() });

    res.json({ success: true });
  } catch (err) {
    console.error('Create notification error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete notification (admin only)
router.delete('/:notifId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await Notification.deleteOne({ id: req.params.notifId });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete notification error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
