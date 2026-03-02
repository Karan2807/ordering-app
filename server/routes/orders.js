import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import Order from '../models/order.js';
import Store from '../models/store.js';
import SupplierOrder from '../models/supplierOrder.js';
import Item from '../models/item.js';
import Setting from '../models/setting.js';
import nodemailer from 'nodemailer';
import ExcelJS from 'exceljs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendManualReminders } from '../services/reminderScheduler.js';

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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONSOLIDATED_TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'consolidated-template.xlsx');
const displayOrderItemCode = (code) =>
  String(code || '').startsWith('XLS::') ? String(code).slice(5) : String(code || '');
const TEMPLATE_STORE_SLOTS = [
  { apna: 'Apna 1', city: 'Bellevue' },
  { apna: 'Apna 2', city: 'Bothell' },
  { apna: 'Apna 3', city: 'Sammamish' },
  { apna: 'Apna 4', city: 'Kent' },
  { apna: 'Apna 5', city: 'Redmond' },
];

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

async function getManualOpenState() {
  const docs = await Setting.find({ key: { $in: ['manualOpenOrder', 'manualOpenSeq'] } }).lean();
  const map = {};
  docs.forEach((d) => {
    map[d.key] = d.value;
  });
  const manualOpenOrder = map.manualOpenOrder || null;
  const parsedSeq = parseInt(map.manualOpenSeq, 10);
  const manualOpenSeq = Number.isNaN(parsedSeq) ? null : parsedSeq;
  return { manualOpenOrder, manualOpenSeq };
}

function composeWeekKeyForType(baseWeekKey, type, manualOpenOrder, manualOpenSeq) {
  if (manualOpenOrder && manualOpenSeq && manualOpenOrder === type) {
    return `${baseWeekKey}-M${manualOpenSeq}`;
  }
  return baseWeekKey;
}

function mapStoresToTemplateSlots(stores = []) {
  const list = Array.isArray(stores) ? stores : [];
  const used = new Set();
  const slots = TEMPLATE_STORE_SLOTS.map((slot) => {
    const idx = list.findIndex((s, i) => !used.has(i) && String(s.name || '').toLowerCase().includes(slot.city.toLowerCase()));
    if (idx >= 0) {
      used.add(idx);
      return { ...slot, store: list[idx] };
    }
    return { ...slot, store: null };
  });
  const remaining = list.filter((_, i) => !used.has(i));
  let r = 0;
  return slots.map((slot) => {
    if (slot.store) return slot;
    const next = remaining[r++] || null;
    return { ...slot, store: next };
  });
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

function buildConsolidatedExcelRows({ type, dateText, slots, slotOrders, itemNameByCode }) {
  const rows = [];
  rows.push([`Date: ${dateText}`, ...slots.map((slot) => `${slot.apna}${type}`)]);
  rows.push(['PRODUCT', ...slots.map(() => 'QUANTITY (case qty)')]);

  const itemCodes = new Set();
  slots.forEach((slot) => {
    const order = slotOrders[slot.apna];
    if (order && order.items) {
      order.items.forEach((i) => itemCodes.add(i.itemCode));
    }
  });

  const itemRows = Array.from(itemCodes)
    .map((code) => ({
      code,
      name: itemNameByCode[code] || displayOrderItemCode(code),
    }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));

  itemRows.forEach((it) => {
    const qtyCols = slots.map((slot) => {
      const order = slotOrders[slot.apna];
      if (!order || !order.items) return '';
      const found = order.items.find((i) => i.itemCode === it.code);
      return found && (Number(found.quantity) || 0) > 0 ? Number(found.quantity) : '';
    });
    rows.push([it.name, ...qtyCols]);
  });

  return rows;
}

function cloneTemplateRowStyle(ws, targetRowNumber, sourceRowNumber = 5, startCol = 2, endCol = 7) {
  const srcRow = ws.getRow(sourceRowNumber);
  const dstRow = ws.getRow(targetRowNumber);
  dstRow.height = srcRow.height;
  for (let col = startCol; col <= endCol; col += 1) {
    const srcCell = ws.getCell(sourceRowNumber, col);
    const dstCell = ws.getCell(targetRowNumber, col);
    dstCell.style = JSON.parse(JSON.stringify(srcCell.style || {}));
  }
}

async function rowsToExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(CONSOLIDATED_TEMPLATE_PATH);
  const ws = workbook.getWorksheet(1);
  if (!ws) throw new Error('Consolidated template worksheet not found');

  const startRow = 3;
  const startCol = 2; // B
  const endCol = 7; // G
  const clearToRow = Math.max(ws.rowCount || 0, startRow + rows.length + 200);

  for (let r = startRow; r <= clearToRow; r += 1) {
    for (let c = startCol; c <= endCol; c += 1) {
      ws.getCell(r, c).value = null;
    }
  }

  rows.forEach((row, idx) => {
    const targetRow = startRow + idx;
    if (targetRow > (ws.rowCount || 0)) {
      cloneTemplateRowStyle(ws, targetRow, 5, startCol, endCol);
    }
    for (let j = 0; j < 6; j += 1) {
      const cell = ws.getCell(targetRow, startCol + j);
      const value = row[j] ?? '';
      cell.value = value === '' ? null : value;
    }
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
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

    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);

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

    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, req.params.type, mo.manualOpenOrder, mo.manualOpenSeq);
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
    const { email, supplierName, reopenedFromId, splitData } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    // supplierName is optional here; frontend will send when available

    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, req.params.type, mo.manualOpenOrder, mo.manualOpenSeq);
    const stores = await Store.find().sort({ id: 1 }).lean();
    const itemDocs = await Item.find().lean();
    const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [it.code, it.name]));
    const supplierDisplayName = (supplierName || 'Supplier').trim();
    let body = `Dear ${supplierDisplayName},\n\nPlease find attached the consolidated order in Excel format for all five stores for Order ${req.params.type} (Week ${weekKey}).\n\nStores included: ${stores.map((s) => s.name).join(', ')}.\n\nRegards,\nApna Bazar Team`;
    const slots = mapStoresToTemplateSlots(stores);
    const slotOrders = {};
    for (const slot of slots) {
      if (!slot.store) {
        slotOrders[slot.apna] = null;
        continue;
      }
      slotOrders[slot.apna] = await findCurrentWeekOrder(slot.store.id, req.params.type, weekKey);
    }
    const now = new Date();
    const dateText = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    let excelRows = [];
    if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
      excelRows.push([`Date: ${dateText}`, ...slots.map((slot) => `${slot.apna}${req.params.type}`)]);
      excelRows.push(['PRODUCT', ...slots.map(() => 'QUANTITY (case qty)')]);
      splitData.rows.forEach((r) => {
        const itemName = r.itemName || itemNameByCode[r.itemCode] || displayOrderItemCode(r.itemCode);
        const qtyCols = slots.map((slot) => {
          if (!slot.store) return '';
          const q = Number(r.qtyByStoreId && r.qtyByStoreId[slot.store.id]) || 0;
          return q > 0 ? q : '';
        });
        excelRows.push([itemName, ...qtyCols]);
      });
    } else {
      excelRows = buildConsolidatedExcelRows({
        type: req.params.type,
        dateText,
        slots,
        slotOrders,
        itemNameByCode,
      });
    }
    const snapshotLines = excelRows.map((row) => row.join(' | '));
    const excelBuffer = await rowsToExcelBuffer(excelRows);
    const excelFilename = `consolidated-order-${req.params.type}-${weekKey}.xlsx`;

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
      to: email,
      subject: `Consolidated Order ${req.params.type} (Week ${weekKey})`,
      text: body,
      attachments: [
        {
          filename: excelFilename,
          content: excelBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    let supplierOrder = null;
    try {
      const totalObj = {};
      if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
        splitData.rows.forEach((r) => {
          const code = r.itemCode || `XLS::${String(r.itemName || '').trim()}`;
          const sum = slots.reduce((acc, slot) => {
            if (!slot.store) return acc;
            return acc + (Number(r.qtyByStoreId && r.qtyByStoreId[slot.store.id]) || 0);
          }, 0);
          if (sum > 0) totalObj[code] = (totalObj[code] || 0) + sum;
        });
      } else {
        slots.forEach((slot) => {
          const order = slotOrders[slot.apna];
          if (order && order.items) {
            order.items.forEach((i) => {
              totalObj[i.itemCode] = (totalObj[i.itemCode] || 0) + (i.quantity || 0);
            });
          }
        });
      }
      const finishedFlag = splitData && typeof splitData.finished === 'boolean' ? splitData.finished : true;
      supplierOrder = await SupplierOrder.create({
        supplierName: supplierDisplayName,
        email,
        type: req.params.type,
        week: weekKey,
        items: totalObj,
        reopenedFromId: reopenedFromId ? String(reopenedFromId) : null,
        snapshotLines,
        excelBase64: excelBuffer.toString('base64'),
        excelFilename,
        finished: finishedFlag,
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
            reopenedFromId: supplierOrder.reopenedFromId || null,
            snapshotLines: supplierOrder.snapshotLines,
            sentAt: supplierOrder.sentAt,
            finished: supplierOrder.finished,
            hasExcel: !!supplierOrder.excelBase64,
          }
        : null,
    });
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
      list.map(({ excelBase64, ...row }) => ({
        ...row,
        hasExcel: !!excelBase64,
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

// Send SMS reminders manually (admin only)
router.post('/reminders/:type/send', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const type = String(req.params.type || '').toUpperCase();
    if (!['A', 'B', 'C'].includes(type)) {
      return res.status(400).json({ error: 'Invalid order type' });
    }
    const storeId = req.body && req.body.storeId ? String(req.body.storeId) : null;
    const result = await sendManualReminders({ type, storeId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Manual reminder send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/supplier-orders/:id/excel', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const doc = await SupplierOrder.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    if (!doc.excelBase64) return res.status(404).json({ error: 'Excel file not stored for this record' });
    const excelBuffer = Buffer.from(doc.excelBase64, 'base64');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.excelFilename || `consolidated-order-${doc.type || 'X'}.xlsx`}"`);
    res.send(excelBuffer);
  } catch (err) {
    console.error('Download supplier order Excel error:', err);
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

