import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/user.js';
import RegistrationRequest from '../models/registrationRequest.js';

const router = express.Router();

// Get all users (admin only)
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const users = await User.find().sort({ name: 1 }).lean();
    res.json(
      users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        phone: u.phone,
        role: u.role,
        storeId: u.storeId,
        active: u.active,
      }))
    );
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { username, password, name, phone, role, storeId } = req.body;

    if (!username || !password || !name || !phone) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const id = uuidv4();
    await User.create({ id, username, password, name, phone, role, storeId, active: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle user active (admin only)
router.patch('/:userId/toggle', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const user = await User.findOne({ id: req.params.userId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    user.active = !user.active;
    await user.save();
    res.json({ success: true, active: user.active });
  } catch (err) {
    console.error('Toggle user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password (admin only)
router.post('/:userId/reset-password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ id: req.params.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = password;
    await user.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Registration requests (admin only)
router.get('/registration-requests', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const requests = await RegistrationRequest.find({ status: 'pending' }).sort({ createdAt: -1 }).lean();
    res.json(requests.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      phone: r.phone,
      storeId: r.storeId,
      createdAt: r.createdAt,
      status: r.status,
    })));
  } catch (err) {
    console.error('Get registration requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/registration-requests/:requestId/approve', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const reqDoc = await RegistrationRequest.findOne({ id: req.params.requestId, status: 'pending' });
    if (!reqDoc) return res.status(404).json({ error: 'Request not found' });

    const existing = await User.findOne({ username: reqDoc.username });
    if (existing) {
      reqDoc.status = 'rejected';
      reqDoc.reviewedAt = new Date();
      reqDoc.reviewedBy = req.user.username;
      await reqDoc.save();
      return res.status(400).json({ error: 'Username already exists' });
    }

    await User.create({
      id: uuidv4(),
      username: reqDoc.username,
      password: reqDoc.password,
      name: reqDoc.name,
      phone: reqDoc.phone,
      role: 'manager',
      storeId: reqDoc.storeId,
      active: true,
    });

    reqDoc.status = 'approved';
    reqDoc.reviewedAt = new Date();
    reqDoc.reviewedBy = req.user.username;
    await reqDoc.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Approve registration request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/registration-requests/:requestId/reject', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const reqDoc = await RegistrationRequest.findOne({ id: req.params.requestId, status: 'pending' });
    if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
    reqDoc.status = 'rejected';
    reqDoc.reviewedAt = new Date();
    reqDoc.reviewedBy = req.user.username;
    await reqDoc.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Reject registration request error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
