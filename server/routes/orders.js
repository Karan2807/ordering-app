import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import Order from '../models/order.js';
import Store from '../models/store.js';
import SupplierOrder from '../models/supplierOrder.js';
import nodemailer from 'nodemailer';

// create a simple transporter; configure via SMTP_URL env var or Gmail credentials
// if provided.  Otherwise fall back to a console logger (jsonTransport)
let transportConfig = process.env.SMTP_URL;
if (!transportConfig && process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  transportConfig = {
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  };
}

// log what configuration we're about to use (sensitive fields masked)
const maskedConfig = transportConfig
  ? typeof transportConfig === 'string'
    ? transportConfig.replace(/:(.*?)@/, ':*****@')
    : JSON.parse(JSON.stringify(transportConfig, (k, v) => (k === 'pass' ? '*****' : v)))
  : transportConfig;
console.log('Email transport configuration:', maskedConfig);

const transporter = nodemailer.createTransport(
  transportConfig || {
    jsonTransport: true,
  },
  {
    logger: true,
    debug: true,
  }
);

// log transporter status at startup so we can catch configuration errors early
transporter.verify((err, success) => {
  if (err) {
    console.error('Email transporter verification failed:', err);
  } else {
    console.log('Email transporter ready to send messages');
  }
});

const router = express.Router();

function getWeekKey() {
  // Match frontend ISO-week logic so admin dashboard/consolidated keys line up.
  const d = new Date();
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeOrderItems(itemsInput, notesInput = {}) {
  const itemsObj = itemsInput && typeof itemsInput === 'object' && !Array.isArray(itemsInput) ? itemsInput : {};
  const notesObj = notesInput && typeof notesInput === 'object' && !Array.isArray(notesInput) ? notesInput : {};

  return Object.entries(itemsObj)
    .map(([itemCode, rawQty]) => {
      const qty = Number(rawQty) || 0;
      const note = typeof notesObj[itemCode] === 'string' ? notesObj[itemCode].trim() : '';
      return { itemCode, quantity: qty, note };
    })
    .filter(({ quantity, note }) => quantity > 0 || note);
}

// Get orders for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const storeId = req.user.role === 'admin' ? req.query.storeId : req.user.storeId;
    const filter = {};
    if (storeId) filter.storeId = storeId;

    let orders = await Order.find(filter).sort({ createdAt: -1 }).lean();

    const result = orders.map((order) => ({
      id: order.id,
      storeId: order.storeId,
      type: order.type,
      status: order.status,
      week: order.week,
      items: (order.items || []).reduce((acc, i) => {
        acc[i.itemCode] = i.quantity;
        return acc;
      }, {}),
      notes: (order.items || []).reduce((acc, i) => {
        if (i.note) acc[i.itemCode] = i.note;
        return acc;
      }, {}),
      date: order.createdAt,
      itemCount: order.items ? order.items.length : 0,
    }));

    res.json(result);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create or update order
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type, items = {}, notes = {}, status, storeId: bodyStoreId } = req.body;
    // allow admin to specify a different store when creating/updating
    const storeId = req.user.role === 'admin' && bodyStoreId ? bodyStoreId : req.user.storeId;
    if (!type || !storeId) {
      return res.status(400).json({ error: 'Type and store required' });
    }

    const weekKey = getWeekKey();

    let order = await Order.findOne({ storeId, type, week: weekKey });
    if (order) {
      order.status = status;
      if (status === 'submitted') order.submittedAt = new Date();
      order.items = normalizeOrderItems(items, notes);
      await order.save();
    } else {
      const orderId = uuidv4();
      order = new Order({
        id: orderId,
        storeId,
        type,
        status,
        week: weekKey,
        submittedAt: status === 'submitted' ? new Date() : null,
        items: normalizeOrderItems(items, notes),
      });
      await order.save();
    }

    res.json({ success: true, orderId: order.id });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Process order (admin only)
router.post('/:orderId/process', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await Order.updateOne({ id: req.params.orderId }, { status: 'processed' });

    res.json({ success: true });
  } catch (err) {
    console.error('Process order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Consolidated view (admin only)
router.get('/consolidated/:type', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const weekKey = getWeekKey();
    const stores = await Store.find().sort({ id: 1 }).lean();
    const response = [];

    for (const store of stores) {
      const order = await Order.findOne({ storeId: store.id, type: req.params.type, week: weekKey }).lean();
      const itemsObj = {};
      if (order && order.items) {
        order.items.forEach((i) => {
          itemsObj[i.itemCode] = i.quantity;
        });
      }
      const notesObj = {};
      if (order && order.items) {
        order.items.forEach((i) => {
          if (i.note) notesObj[i.itemCode] = i.note;
        });
      }
      response.push({
        id: store.id,
        name: store.name,
        order_id: order ? order.id : null,
        status: order ? order.status : null,
        items: itemsObj,
        notes: notesObj,
      });
    }

    res.json(response);
  } catch (err) {
    console.error('Consolidated view error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// send consolidated order summary via email (admin only)
router.post('/consolidated/:type/email', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { email, supplierName } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    // supplierName is optional here; frontend will send when available

    const weekKey = getWeekKey();
    const stores = await Store.find().sort({ id: 1 }).lean();
    let body = `Consolidated Order ${req.params.type} - week ${weekKey}\n\n`;
    for (const store of stores) {
      const order = await Order.findOne({ storeId: store.id, type: req.params.type, week: weekKey }).lean();
      body += `Store: ${store.name} (id: ${store.id})\n`;
      if (order && order.items && order.items.length) {
        order.items.forEach((i) => {
          body += `  ${i.itemCode}: ${i.quantity}`;
          if (i.note) body += ` | note: ${i.note}`;
          body += '\n';
        });
      } else {
        body += '  (no order)\n';
      }
      body += '\n';
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
      to: email,
      subject: `Consolidated Order ${req.params.type}`,
      text: body,
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('Email consolidated error:', err);
    if (err.response) {
      console.error('SMTP response:', err.response);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// supplier order history endpoints (admin only)
router.get('/supplier-orders', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const list = await SupplierOrder.find().sort({ sentAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    console.error('Get supplier orders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/supplier-orders', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { supplierName, email, type, week, items } = req.body;
    if (!supplierName || !email || !type || !week) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const so = new SupplierOrder({ supplierName, email, type, week, items });
    await so.save();
    res.json({ success: true, supplierOrder: so });
  } catch (err) {
    console.error('Create supplier order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// generic email-sending endpoint (admin only)
router.post('/email', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { to, subject, text } = req.body;
    if (!to || !subject || !text) {
      return res.status(400).json({ error: 'to, subject and text are required' });
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
      to,
      subject,
      text,
    };

    // transporter may be configured with an SMTP_URL; if not it will 
    // use jsonTransport which only logs the message (development fallback).
    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('Generic email send error:', err);
    if (err.response) {
      console.error('SMTP response:', err.response);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
