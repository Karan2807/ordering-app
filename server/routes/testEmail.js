import express from 'express';
import { authMiddleware } from '../auth.js';
import { sendGraphMail } from '../services/msSendMail.js';

const router = express.Router();

// POST /api/test-email
// admin-only endpoint to send a test email via Microsoft Graph
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { to, subject, text, html } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to is required' });

    const result = await sendGraphMail({
      to,
      subject: subject || 'Test Email',
      text: text || 'This is a test email from OrderManager via Microsoft Graph.',
      html,
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

export default router;

