import express from 'express';
import User from '../models/user.js';
import RegistrationRequest from '../models/registrationRequest.js';
import { generateToken, verifyToken } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// public registration
router.post('/register', async (req, res) => {
  try {
    const { username, password, name, phone, storeId } = req.body;
    if (!username || !password || !name || !phone || !storeId) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const existingReq = await RegistrationRequest.findOne({ username, status: 'pending' });
    if (existingReq) {
      return res.status(400).json({ error: 'Registration request already pending approval' });
    }

    await RegistrationRequest.create({
      id: uuidv4(),
      username,
      password,
      name,
      phone,
      storeId,
      status: 'pending',
    });

    res.json({ success: true, pendingApproval: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(400).json({ error: err.message || 'Registration failed' });
  }
});


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
