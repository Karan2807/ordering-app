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
