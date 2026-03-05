import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import User from '../models/user.js';

const router = express.Router();
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const usernameRegex = (value) => new RegExp(`^${escapeRegex(String(value || '').trim())}$`, 'i');
const normalizeUsername = (value) => String(value || '').trim();
const findUserByIdOrUsername = (userId) =>
  User.findOne({ $or: [{ id: userId }, { username: usernameRegex(userId) }] });

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

    const existing = await User.findOne({ username: usernameRegex(username) });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const id = uuidv4();
    await User.create({ id, username: normalizeUsername(username), password, name, phone, role, storeId, active: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin only)
router.patch('/:userId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const user = await findUserByIdOrUsername(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { username, name, phone, role, storeId, active } = req.body || {};

    if (username && String(username).trim().toLowerCase() !== String(user.username || '').trim().toLowerCase()) {
      const exists = await User.findOne({ username: usernameRegex(username) });
      if (exists) return res.status(400).json({ error: 'Username already exists' });
      user.username = normalizeUsername(username);
    }
    if (name != null) user.name = name;
    if (phone != null) user.phone = phone;
    if (role != null) user.role = role;
    if (storeId !== undefined) user.storeId = storeId || null;
    if (active !== undefined) user.active = !!active;

    await user.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle user active (admin only)
router.patch('/:userId/toggle', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const user = await findUserByIdOrUsername(req.params.userId);
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

    const user = await findUserByIdOrUsername(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.password = password;
    await user.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only)
router.delete('/:userId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const user = await findUserByIdOrUsername(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(user.username || '').trim().toLowerCase() === String(req.user.username || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'Cannot delete currently logged-in user' });
    }
    await User.deleteOne({ _id: user._id });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
