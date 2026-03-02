import express from 'express';
import User from '../models/user.js';
import { generateToken, verifyToken } from '../auth.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await User.findOne({ username, active: true }).lean();
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        phone: user.phone,
        role: user.role,
        storeId: user.storeId,
        active: user.active,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({ valid: true, user: decoded });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
