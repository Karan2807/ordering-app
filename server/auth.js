import jwt from 'jsonwebtoken';

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, storeId: user.storeId },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.replace('Bearer ', '');
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.user = decoded;
  next();
}

// registration helper (public)
import User from './models/user.js';
import { v4 as uuidv4 } from 'uuid';

// NOTE: not exported, just used in route file

export async function registerUser({ username, password, name, phone, storeId }) {
  if (!username || !password || !name || !phone) {
    throw new Error('All fields required');
  }
  const existing = await User.findOne({ username });
  if (existing) {
    throw new Error('Username already exists');
  }
  const id = uuidv4();
  return await User.create({ id, username, password, name, phone, storeId, role: 'manager', active: true });
}
