import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import Order from '../models/order.js';
import Store from '../models/store.js';
import SupplierOrder from '../models/supplierOrder.js';
import Item from '../models/item.js';
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
const displayOrderItemCode = (code) =>
  String(code || '').startsWith('XLS::') ? String(code).slice(5) : String(code || '');

function getWeekKey() {
  // Match frontend ISO-week logic so admin dashboard/consolidated keys line up.
  const d = new Date();
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getIsoWeekKeyForDate(value) {
  const d = new Date(value);
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function findCurrentWeekOrder(storeId, type, weekKey) {
  const exact = await Order.findOne({ storeId, type, week: weekKey }).lean();
  if (exact) return exact;
  const latest = await Order.findOne({ storeId, type }).sort({ createdAt: -1 }).lean();
  if (!latest) return null;
  const latestWeek = getIsoWeekKeyForDate(latest.createdAt || latest.submittedAt || new Date());
  return latestWeek === weekKey ? latest : null;
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

function escapePdfText(s = '') {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function splitPdfLines(lines, maxChars = 95) {
  const out = [];
  for (const line of lines) {
    const txt = String(line ?? '');
    if (txt.length <= maxChars) {
      out.push(txt);
      continue;
    }
    let rem = txt;
    while (rem.length > maxChars) {
      let cut = rem.lastIndexOf(' ', maxChars);
      if (cut < 10) cut = maxChars;
      out.push(rem.slice(0, cut));
      rem = rem.slice(cut).trimStart();
    }
    if (rem) out.push(rem);
  }
  return out;
}

function buildSimplePdf(lines) {
  const pageLines = 48;
  const pages = [];
  const normalized = splitPdfLines(lines);
  for (let i = 0; i < normalized.length; i += pageLines) {
    pages.push(normalized.slice(i, i + pageLines));
  }
  if (!pages.length) pages.push(['']);

  const objects = [''];
  const addObj = (s) => {
    objects.push(s);
    return objects.length - 1;
  };

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageEntries = [];

  for (const page of pages) {
    const contentLines = ['BT', '/F1 10 Tf', '14 TL', '40 770 Td'];
    page.forEach((line, idx) => {
      contentLines.push(`(${escapePdfText(line)}) Tj`);
      if (idx !== page.length - 1) contentLines.push('T*');
    });
    contentLines.push('ET');
    const content = contentLines.join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent __PAGES__ 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageEntries.push(pageId);
  }

  const pagesId = addObj(`<< /Type /Pages /Kids [${pageEntries.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageEntries.length} >>`);
  pageEntries.forEach((id) => {
    objects[id] = objects[id].replace('__PAGES__', String(pagesId));
  });
  const rootId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
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
      const order = await findCurrentWeekOrder(store.id, req.params.type, weekKey);
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
    const itemDocs = await Item.find().lean();
    const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [it.code, it.name]));
    const supplierDisplayName = (supplierName || 'Supplier').trim();
    let body = `Dear ${supplierDisplayName},\n\nPlease find attached the consolidated order for all five stores for Order ${req.params.type} (Week ${weekKey}).\n\nStores included: ${stores.map((s) => s.name).join(', ')}.\n\nRegards,\nApna Bazar Team`;
    const pdfLines = [
      `Consolidated Order ${req.params.type}`,
      `Week: ${weekKey}`,
      supplierName ? `Supplier: ${supplierName}` : '',
      `Generated: ${new Date().toLocaleString()}`,
      '',
      'Consolidated order for all five stores',
      ''.padEnd(75, '-'),
    ].filter(Boolean);
    for (const store of stores) {
      const order = await findCurrentWeekOrder(store.id, req.params.type, weekKey);
      pdfLines.push(`Store: ${store.name} (${store.id})`);
      if (order && order.items && order.items.length) {
        order.items.forEach((i) => {
          const cleanCode = displayOrderItemCode(i.itemCode);
          const itemLabel = itemNameByCode[i.itemCode] ? `${itemNameByCode[i.itemCode]} (${cleanCode})` : cleanCode;
          let line = `  ${itemLabel} - Qty: ${i.quantity}`;
          if (i.note) line += ` | Note: ${i.note}`;
          pdfLines.push(line);
        });
      } else {
        pdfLines.push('  (no order)');
      }
      pdfLines.push('');
    }
    const pdfBuffer = buildSimplePdf(pdfLines);

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
      to: email,
      subject: `Consolidated Order ${req.params.type} (Week ${weekKey})`,
      text: body,
      attachments: [
        {
          filename: `consolidated-order-${req.params.type}-${weekKey}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
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
    res.json(
      list.map(({ pdfBase64, ...row }) => ({
        ...row,
        hasPdf: !!pdfBase64,
      }))
    );
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

router.get('/supplier-orders/:id/pdf', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const doc = await SupplierOrder.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    if (!doc.pdfBase64) return res.status(404).json({ error: 'PDF not stored for this record' });
    const pdfBuffer = Buffer.from(doc.pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.pdfFilename || `consolidated-order-${doc.type || 'X'}.pdf`}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Download supplier order PDF error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/supplier-orders/:id/reopen', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const doc = await SupplierOrder.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    doc.finished = false;
    await doc.save();
    res.json({ success: true, supplierOrder: doc });
  } catch (err) {
    console.error('Reopen supplier order error:', err);
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

    let supplierOrder = null;
    try {
      const totalObj = {};
      for (const store of stores) {
        const order = await findCurrentWeekOrder(store.id, req.params.type, weekKey);
        if (order && order.items) {
          order.items.forEach((i) => {
            totalObj[i.itemCode] = (totalObj[i.itemCode] || 0) + (i.quantity || 0);
          });
        }
      }
      supplierOrder = await SupplierOrder.create({
        supplierName: supplierDisplayName,
        email,
        type: req.params.type,
        week: weekKey,
        items: totalObj,
        snapshotLines: pdfLines,
        pdfBase64: pdfBuffer.toString('base64'),
        pdfFilename: `consolidated-order-${req.params.type}-${weekKey}.pdf`,
        finished: true,
      });
    } catch (historyErr) {
      console.error('Supplier email history save error:', historyErr);
    }

    res.json({
      success: true,
      supplierOrder: supplierOrder
        ? {
            _id: supplierOrder._id,
            supplierName: supplierOrder.supplierName,
            email: supplierOrder.email,
            type: supplierOrder.type,
            week: supplierOrder.week,
            items: supplierOrder.items,
            snapshotLines: supplierOrder.snapshotLines,
            sentAt: supplierOrder.sentAt,
            finished: supplierOrder.finished,
            hasPdf: !!supplierOrder.pdfBase64,
          }
        : null,
    });
  } catch (err) {
    console.error('Generic email send error:', err);
    if (err.response) {
      console.error('SMTP response:', err.response);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

