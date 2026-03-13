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
import { sendGraphMail } from '../services/msSendMail.js';
import { renderVendorDocxTemplate } from '../services/vendorDocxTemplate.js';

// create a simple transporter; prefer Outlook settings, then generic SMTP URL,
// then Gmail credentials. Otherwise fall back to a console logger (jsonTransport).
let transportConfig = process.env.SMTP_URL;
if (
  !transportConfig &&
  process.env.OUTLOOK_USER &&
  process.env.OUTLOOK_CLIENT_ID &&
  process.env.OUTLOOK_CLIENT_SECRET &&
  process.env.OUTLOOK_REFRESH_TOKEN
) {
  const outlookPort = parseInt(process.env.OUTLOOK_PORT || '587', 10);
  transportConfig = {
    host: process.env.OUTLOOK_HOST || 'smtp.office365.com',
    port: Number.isNaN(outlookPort) ? 587 : outlookPort,
    secure: String(process.env.OUTLOOK_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      type: 'OAuth2',
      user: process.env.OUTLOOK_USER,
      clientId: process.env.OUTLOOK_CLIENT_ID,
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET,
      refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
      // Optional: provide when you already have a short-lived token.
      accessToken: process.env.OUTLOOK_ACCESS_TOKEN || undefined,
    },
  };
}
if (
  !transportConfig &&
  process.env.OUTLOOK_USER &&
  process.env.OUTLOOK_PASS &&
  (process.env.OUTLOOK_HOST || process.env.OUTLOOK_PORT)
) {
  const outlookPort = parseInt(process.env.OUTLOOK_PORT || '587', 10);
  transportConfig = {
    host: process.env.OUTLOOK_HOST || 'smtp.office365.com',
    port: Number.isNaN(outlookPort) ? 587 : outlookPort,
    secure: String(process.env.OUTLOOK_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.OUTLOOK_USER,
      pass: process.env.OUTLOOK_PASS,
    },
  };
}
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
    : JSON.parse(
        JSON.stringify(transportConfig, (k, v) =>
          ['pass', 'clientSecret', 'refreshToken', 'accessToken'].includes(k) ? '*****' : v
        )
      )
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
const VALID_CATEGORIES = ['vegetables', 'leaves', 'vendor_orders'];
const VALID_ORDER_STATUSES = new Set(['draft', 'draft_shared', 'submitted', 'processed']);
const displayOrderItemCode = (code) =>
  String(code || '').startsWith('XLS::') ? String(code).slice(5) : String(code || '');
const TEMPLATE_STORE_SLOTS = [
  { apna: 'Apna 1', city: 'Bellevue' },
  { apna: 'Apna 2', city: 'Bothell' },
  { apna: 'Apna 3', city: 'Sammamish' },
  { apna: 'Apna 4', city: 'Kent' },
  { apna: 'Apna 5', city: 'Redmond' },
];

function normalizeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_CATEGORIES.includes(raw) ? raw : 'vegetables';
}
function normalizeVendorKey(category, vendorKey) {
  return normalizeCategory(category) === 'vendor_orders'
    ? String(vendorKey || '').trim() || null
    : null;
}

function makeTemplateSettingKey(category, vendorKey = null) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  return `orderTemplate:${resolvedCategory}${resolvedVendorKey ? `:${resolvedVendorKey}` : ''}`;
}

async function getCategoryTemplate(category, vendorKey = null) {
  const doc = await Setting.findOne({ key: makeTemplateSettingKey(category, vendorKey) }).lean();
  return doc && doc.value ? doc.value : null;
}

function ensureRowCell(rows, rowIndex, colIndex) {
  while (rows.length <= rowIndex) rows.push([]);
  while (rows[rowIndex].length <= colIndex) rows[rowIndex].push('');
}

function buildRowsFromCategoryTemplate({ template, dateText, slots, qtyByCodeStoreId, noteByCode, itemNameByCode }) {
  const rows = Array.isArray(template && template.rows) ? template.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [];
  if (template && template.dateCell && template.dateCell.rowIndex != null && template.dateCell.colIndex != null) {
    ensureRowCell(rows, template.dateCell.rowIndex, template.dateCell.colIndex);
    rows[template.dateCell.rowIndex][template.dateCell.colIndex] = `${template.dateCell.prefix || ''}${dateText}`;
  }
  const slotByKey = Object.fromEntries((slots || []).map((slot) => [slot.apna, slot]));
  (template && Array.isArray(template.itemRows) ? template.itemRows : []).forEach((itemRow) => {
    ensureRowCell(rows, itemRow.rowIndex, itemRow.colIndex || 0);
    const code = String(itemRow.code || '').trim();
    const name = itemNameByCode[code] || itemRow.name || displayOrderItemCode(code);
    rows[itemRow.rowIndex][itemRow.colIndex || 0] = name;
    if (template.kind === 'tabular') {
      const qtyTotal = Object.values(qtyByCodeStoreId[code] || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      if (template.quantityColumn && template.quantityColumn.colIndex != null) {
        ensureRowCell(rows, itemRow.rowIndex, template.quantityColumn.colIndex);
        rows[itemRow.rowIndex][template.quantityColumn.colIndex] = qtyTotal > 0 ? String(qtyTotal) : '';
      }
      if (template.noteColumn && template.noteColumn.colIndex != null) {
        ensureRowCell(rows, itemRow.rowIndex, template.noteColumn.colIndex);
        rows[itemRow.rowIndex][template.noteColumn.colIndex] = noteByCode[code] || '';
      }
      return;
    }
    (template.storeColumns || []).forEach((col) => {
      ensureRowCell(rows, itemRow.rowIndex, col.colIndex);
      const slot = slotByKey[col.slotKey];
      const storeId = slot && slot.store ? slot.store.id : null;
      const qty = storeId && qtyByCodeStoreId[code] ? Number(qtyByCodeStoreId[code][storeId]) || 0 : 0;
      rows[itemRow.rowIndex][col.colIndex] = qty > 0 ? String(qty) : '';
    });
  });
  return rows;
}

async function buildWorkbookFromCategoryTemplate({ template, dateText, slots, qtyByCodeStoreId, noteByCode, itemNameByCode }) {
  if (!template || !template.originalFile || !template.originalFile.base64) return null;
  const filename = String(template.originalFile.filename || '').toLowerCase();
  if (!filename.endsWith('.xlsx')) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(template.originalFile.base64, 'base64'));
  const worksheet = template.sheetName
    ? workbook.getWorksheet(template.sheetName) || workbook.worksheets[0]
    : workbook.worksheets[0];
  if (!worksheet) return null;

  const slotByKey = Object.fromEntries((slots || []).map((slot) => [slot.apna, slot]));
  if (template.dateCell && template.dateCell.rowIndex != null && template.dateCell.colIndex != null) {
    worksheet.getCell(template.dateCell.rowIndex + 1, template.dateCell.colIndex + 1).value = `${template.dateCell.prefix || ''}${dateText}`;
  }
  (template.itemRows || []).forEach((itemRow) => {
    const code = String(itemRow.code || '').trim();
    const name = itemNameByCode[code] || itemRow.name || displayOrderItemCode(code);
    worksheet.getCell(itemRow.rowIndex + 1, (itemRow.colIndex || 0) + 1).value = name;
    if (template.kind === 'tabular') {
      const qtyTotal = Object.values(qtyByCodeStoreId[code] || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
      if (template.quantityColumn && template.quantityColumn.colIndex != null) {
        worksheet.getCell(itemRow.rowIndex + 1, template.quantityColumn.colIndex + 1).value = qtyTotal > 0 ? qtyTotal : null;
      }
      if (template.noteColumn && template.noteColumn.colIndex != null) {
        worksheet.getCell(itemRow.rowIndex + 1, template.noteColumn.colIndex + 1).value = noteByCode[code] || null;
      }
      return;
    }
    (template.storeColumns || []).forEach((col) => {
      const slot = slotByKey[col.slotKey];
      const storeId = slot && slot.store ? slot.store.id : null;
      const qty = storeId && qtyByCodeStoreId[code] ? Number(qtyByCodeStoreId[code][storeId]) || 0 : 0;
      worksheet.getCell(itemRow.rowIndex + 1, col.colIndex + 1).value = qty > 0 ? qty : null;
    });
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
async function sendEmailWithFallback({ to, subject, text, html, attachments = [] }) {
  try {
    // Prefer Microsoft Graph when Graph credentials are present.
    if (process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.SENDER_EMAIL) {
      return await sendGraphMail({ to, subject, text, html, attachments });
    }
  } catch (graphErr) {
    console.error('Graph send failed, falling back to SMTP:', graphErr.message || graphErr);
  }

  const mailOptions = {
    from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
    to,
    subject,
    text,
  };
  if (attachments && attachments.length) mailOptions.attachments = attachments;
  return transporter.sendMail(mailOptions);
}
function normalizeRecipientEmails(email, emails) {
  const fromArray = Array.isArray(emails) ? emails : [];
  const fromString = typeof emails === 'string' ? emails.split(/[,\n;]/) : [];
  const fromEmail = typeof email === 'string' ? email.split(/[,\n;]/) : [];
  const merged = [...fromArray, ...fromString, ...fromEmail]
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(merged)];
}

function getWeekKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getIsoWeekKeyForDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function weekWindowFilter(weekKey, weekBase) {
  return { week: weekKey };
}

function safeFilenamePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
}

async function getStoresForConsolidatedWindow(type, category, vendorKey, weekKey, weekBase = null) {
  const [stores, extraOrders] = await Promise.all([
    Store.find().sort({ id: 1 }).lean(),
    Order.find({
      type,
      category,
      vendorKey,
      ...weekWindowFilter(weekKey, weekBase),
    })
      .select({ storeId: 1, _id: 0 })
      .lean(),
  ]);

  const known = {};
  const list = [];
  stores.forEach((store) => {
    const id = String(store.id || '').trim();
    if (!id || known[id]) return;
    known[id] = true;
    list.push(store);
  });

  extraOrders.forEach((order) => {
    const storeId = String(order.storeId || '').trim();
    if (!storeId || known[storeId]) return;
    known[storeId] = true;
    list.push({ id: storeId, name: storeId });
  });

  return list.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { sensitivity: 'base' }));
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

async function findCurrentWeekOrder(storeId, type, weekKey, category = 'vegetables', vendorKey = null, weekBase = null) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const exact = await Order.findOne({ storeId, type, category: resolvedCategory, vendorKey: resolvedVendorKey, week: weekKey }).lean();
  if (exact) return exact;
  if (weekBase) {
    const windowOrder = await Order.findOne({
      storeId,
      type,
      category: resolvedCategory,
      vendorKey: resolvedVendorKey,
      ...weekWindowFilter(weekKey, weekBase),
    })
      .sort({ submittedAt: -1, createdAt: -1 })
      .lean();
    if (windowOrder) return windowOrder;
  }
  const latest = await Order.findOne({ storeId, type, category: resolvedCategory, vendorKey: resolvedVendorKey })
    .sort({ submittedAt: -1, createdAt: -1 })
    .lean();
  if (!latest) return null;
  const latestWeek = getIsoWeekKeyForDate(latest.submittedAt || latest.createdAt || new Date());
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

function orderItemsToList(rawItems) {
  if (Array.isArray(rawItems)) return rawItems;
  if (!rawItems || typeof rawItems !== 'object') return [];
  return Object.entries(rawItems).map(([itemCode, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        itemCode,
        quantity: Number(value.quantity) || 0,
        note: typeof value.note === 'string' ? value.note : '',
      };
    }
    return {
      itemCode,
      quantity: Number(value) || 0,
      note: '',
    };
  });
}

function isStoreOrderVisibleInConsolidated(status) {
  return status === 'submitted' || status === 'processed' || status === 'draft_shared';
}

function consolidatedHistoryKey(week, type, category, vendorKey) {
  const normalizedCategory = normalizeCategory(category);
  const normalizedVendorKey = normalizeVendorKey(normalizedCategory, vendorKey);
  return [String(week || ''), String(type || '').toUpperCase(), normalizedCategory, normalizedVendorKey || ''].join('::');
}

async function buildConsolidatedHistory({ days = 7 } = {}) {
  const parsedDays = Number(days);
  const safeDays = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(Math.floor(parsedDays), 60) : 7;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const [orders, stores, itemDocs, sentLogs] = await Promise.all([
    Order.find({
      $or: [{ submittedAt: { $gte: since } }, { createdAt: { $gte: since } }],
    }).lean(),
    Store.find().lean(),
    Item.find().lean(),
    SupplierOrder.find({ sentAt: { $gte: since } }).lean(),
  ]);

  const storeNameById = Object.fromEntries(stores.map((s) => [String(s.id || ''), s.name || s.id || '']));
  const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [String(it.code || ''), it.name || it.code || '']));

  const sentByGroup = {};
  sentLogs.forEach((log) => {
    const key = consolidatedHistoryKey(log.week, log.type, log.category, log.vendorKey);
    if (!sentByGroup[key]) {
      sentByGroup[key] = { sentCount: 0, lastSentAt: null };
    }
    sentByGroup[key].sentCount += 1;
    if (!sentByGroup[key].lastSentAt || new Date(log.sentAt || 0) > new Date(sentByGroup[key].lastSentAt)) {
      sentByGroup[key].lastSentAt = log.sentAt || null;
    }
  });

  const grouped = {};
  orders.forEach((order) => {
    const normalizedCategory = normalizeCategory(order.category);
    const normalizedVendorKey = normalizeVendorKey(normalizedCategory, order.vendorKey);
    const key = consolidatedHistoryKey(order.week, order.type, normalizedCategory, normalizedVendorKey);
    if (!grouped[key]) {
      grouped[key] = {
        week: order.week,
        type: String(order.type || '').toUpperCase(),
        category: normalizedCategory,
        vendorKey: normalizedVendorKey,
        latestAt: order.submittedAt || order.createdAt || new Date(0),
        storeOrders: [],
      };
    }
    const group = grouped[key];
    const candidateLatest = order.submittedAt || order.createdAt || new Date(0);
    if (new Date(candidateLatest) > new Date(group.latestAt || 0)) {
      group.latestAt = candidateLatest;
    }

    const normalizedItems = orderItemsToList(order.items)
      .filter((entry) => (Number(entry.quantity) || 0) > 0 || String(entry.note || '').trim())
      .map((entry) => ({
        itemCode: entry.itemCode,
        itemName: itemNameByCode[String(entry.itemCode || '')] || displayOrderItemCode(entry.itemCode),
        quantity: Number(entry.quantity) || 0,
        note: String(entry.note || '').trim(),
      }));

    group.storeOrders.push({
      storeId: order.storeId,
      storeName: storeNameById[String(order.storeId || '')] || order.storeId || '-',
      status: order.status || 'draft',
      submittedAt: order.submittedAt || order.createdAt || null,
      itemCount: normalizedItems.length,
      items: normalizedItems,
    });
  });

  return Object.values(grouped)
    .map((group) => {
      const key = consolidatedHistoryKey(group.week, group.type, group.category, group.vendorKey);
      const sentInfo = sentByGroup[key] || { sentCount: 0, lastSentAt: null };
      const sortedStoreOrders = (group.storeOrders || [])
        .slice()
        .sort((a, b) => String(a.storeName || '').localeCompare(String(b.storeName || '')));
      return {
        week: group.week,
        type: group.type,
        category: group.category,
        vendorKey: group.vendorKey || null,
        latestAt: group.latestAt,
        sent: sentInfo.sentCount > 0,
        sentCount: sentInfo.sentCount,
        lastSentAt: sentInfo.lastSentAt,
        storeCount: sortedStoreOrders.length,
        storeOrders: sortedStoreOrders,
      };
    })
    .sort((a, b) => new Date(b.latestAt || 0) - new Date(a.latestAt || 0));
}

async function buildConsolidatedHistoryExcelPayload({ week, type, category, vendorKey }) {
  const normalizedCategory = normalizeCategory(category);
  const normalizedVendorKey = normalizeVendorKey(normalizedCategory, vendorKey);
  const normalizedType = String(type || '').toUpperCase();
  const normalizedWeek = String(week || '').trim();

  const [orders, stores, itemDocs, sentLogs] = await Promise.all([
    Order.find({
      week: normalizedWeek,
      type: normalizedType,
      category: normalizedCategory,
      vendorKey: normalizedVendorKey,
    }).lean(),
    Store.find().lean(),
    Item.find({ category: normalizedCategory, vendorKey: normalizedVendorKey }).lean(),
    SupplierOrder.find({
      week: normalizedWeek,
      type: normalizedType,
      category: normalizedCategory,
      vendorKey: normalizedVendorKey,
    })
      .sort({ sentAt: -1 })
      .lean(),
  ]);

  const storeNameById = Object.fromEntries(stores.map((s) => [String(s.id || ''), s.name || s.id || '']));
  const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [String(it.code || ''), it.name || it.code || '']));
  const sentCount = sentLogs.length;
  const lastSentAt = sentLogs[0] ? sentLogs[0].sentAt : null;
  const sentLabel = sentCount > 0 ? 'Yes' : 'No';

  const rows = [];
  rows.push(['Consolidated Order History']);
  rows.push(['Week', normalizedWeek, 'Type', normalizedType, 'Category', normalizedCategory, 'Vendor', normalizedVendorKey || '-']);
  rows.push(['Sent', sentLabel, 'Sent Count', sentCount, 'Last Sent At', lastSentAt ? new Date(lastSentAt).toISOString() : '-']);
  rows.push([]);
  rows.push(['Store ID', 'Store Name', 'Order Status', 'Order Date', 'Item Code', 'Item Name', 'Quantity', 'Note']);

  const sortedOrders = (orders || []).slice().sort((a, b) => {
    const byStore = String(storeNameById[String(a.storeId || '')] || a.storeId || '').localeCompare(
      String(storeNameById[String(b.storeId || '')] || b.storeId || '')
    );
    if (byStore !== 0) return byStore;
    return new Date(a.submittedAt || a.createdAt || 0) - new Date(b.submittedAt || b.createdAt || 0);
  });

  sortedOrders.forEach((order) => {
    const storeId = order.storeId || '-';
    const storeName = storeNameById[String(order.storeId || '')] || order.storeId || '-';
    const orderDate = order.submittedAt || order.createdAt || null;
    const lines = orderItemsToList(order.items)
      .filter((entry) => (Number(entry.quantity) || 0) > 0 || String(entry.note || '').trim())
      .map((entry) => ({
        itemCode: entry.itemCode,
        itemName: itemNameByCode[String(entry.itemCode || '')] || displayOrderItemCode(entry.itemCode),
        quantity: Number(entry.quantity) || 0,
        note: String(entry.note || '').trim(),
      }));

    if (lines.length === 0) {
      rows.push([storeId, storeName, order.status || 'draft', orderDate ? new Date(orderDate).toISOString() : '-', '', '', '', '']);
      return;
    }

    lines.forEach((line) => {
      rows.push([
        storeId,
        storeName,
        order.status || 'draft',
        orderDate ? new Date(orderDate).toISOString() : '-',
        line.itemCode,
        line.itemName,
        line.quantity,
        line.note,
      ]);
    });
  });

  const excelBuffer = await rowsToPlainExcelBuffer(rows);
  const safeWeek = normalizedWeek.replace(/[^A-Za-z0-9_-]/g, '_');
  const excelFilename = `consolidated-history-${normalizedType}-${normalizedCategory}${normalizedVendorKey ? `-${normalizedVendorKey}` : ''}-${safeWeek}.xlsx`;
  return { excelBuffer, excelFilename };
}

function buildConsolidatedExcelRows({ type, dateText, slots, slotOrders, itemNameByCode }) {
  const rows = [];
  rows.push([`Date: ${dateText}`, '', ...slots.map((slot) => `${slot.apna}${type}`), '']);
  rows.push(['PRODUCT', 'TOTAL QTY', ...slots.map(() => 'QUANTITY (case qty)'), 'NOTE']);

  const itemCodes = new Set();
  slots.forEach((slot) => {
    const order = slotOrders[slot.apna];
    if (order) {
      orderItemsToList(order.items).forEach((i) => itemCodes.add(i.itemCode));
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
      if (!order) return '';
      const found = orderItemsToList(order.items).find((i) => i.itemCode === it.code);
      return found && (Number(found.quantity) || 0) > 0 ? Number(found.quantity) : '';
    });
    const noteCols = slots
      .map((slot) => {
        const order = slotOrders[slot.apna];
        if (!order) return '';
        const found = orderItemsToList(order.items).find((i) => i.itemCode === it.code);
        const note = found && typeof found.note === 'string' ? found.note.trim() : '';
        return note ? `${slot.apna}: ${note}` : '';
      })
      .filter(Boolean);
    const total = qtyCols.reduce((acc, v) => acc + (Number(v) || 0), 0);
    rows.push([it.name, total > 0 ? total : '', ...qtyCols, noteCols.join(' | ')]);
  });

  return rows;
}

function cloneTemplateRowStyle(ws, targetRowNumber, sourceRowNumber = 5, startCol = 2, endCol = 7) {
  const srcRow = ws.getRow(sourceRowNumber);
  const dstRow = ws.getRow(targetRowNumber);
  dstRow.height = srcRow.height;
  for (let col = startCol; col <= endCol; col += 1) {
    const styleCol = Math.min(col, 7);
    const srcCell = ws.getCell(sourceRowNumber, styleCol);
    const dstCell = ws.getCell(targetRowNumber, col);
    dstCell.style = JSON.parse(JSON.stringify(srcCell.style || {}));
  }
}

async function rowsToExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(CONSOLIDATED_TEMPLATE_PATH);
  const ws = workbook.getWorksheet(1);
  if (!ws) throw new Error('Consolidated template worksheet not found');

  // Global title line on top of sheet
  const titleCell = ws.getCell(1, 2); // B1
  titleCell.value = 'Apna Bazar - Stores Order';
  titleCell.font = { name: 'Calibri', size: 18, bold: true };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' };

  const startRow = 3;
  const startCol = 2; // B
  const maxCols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const writeCols = Math.max(6, maxCols);
  const endCol = startCol + writeCols - 1;
  const clearToRow = Math.max(ws.rowCount || 0, startRow + rows.length + 200);

  for (let r = startRow; r <= clearToRow; r += 1) {
    for (let c = startCol; c <= endCol; c += 1) {
      ws.getCell(r, c).value = null;
    }
  }

  rows.forEach((row, idx) => {
    const targetRow = startRow + idx;
    const styleSourceRow = idx === 0 ? 3 : idx === 1 ? 4 : 5;
    if (targetRow > (ws.rowCount || 0)) {
      cloneTemplateRowStyle(ws, targetRow, 5, startCol, endCol);
    }
    for (let j = 0; j < writeCols; j += 1) {
      const cell = ws.getCell(targetRow, startCol + j);
      const styleSourceCol = Math.min(startCol + j, 7);
      const styleCell = ws.getCell(styleSourceRow, styleSourceCol);
      cell.style = JSON.parse(JSON.stringify(styleCell.style || {}));
      const value = row[j] ?? '';
      cell.value = value === '' ? null : value;
    }
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function rowsToPlainExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Order');
  (rows || []).forEach((row) => {
    ws.addRow(Array.isArray(row) ? row : []);
  });
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function buildConsolidatedExcelPayload(type, category, vendorKey, splitData) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const weekBase = getWeekKey();
  const mo = await getManualOpenState();
  const weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
  const stores = await getStoresForConsolidatedWindow(type, resolvedCategory, resolvedVendorKey, weekKey, weekBase);
  const itemDocs = await Item.find({ category: resolvedCategory, vendorKey: resolvedVendorKey }).lean();
  const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [it.code, it.name]));
  const template = await getCategoryTemplate(resolvedCategory, resolvedVendorKey);
  const slots = mapStoresToTemplateSlots(stores);
  const slotOrders = {};
  for (const slot of slots) {
    if (!slot.store) {
      slotOrders[slot.apna] = null;
      continue;
    }
    slotOrders[slot.apna] = await findCurrentWeekOrder(
      slot.store.id,
      type,
      weekKey,
      resolvedCategory,
      resolvedVendorKey,
      weekBase
    );
  }

  const now = new Date();
  const dateText = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
  let excelRows = [];
  let usePlainWorkbook = false;
  let excelBuffer = null;
  const qtyByCodeStoreId = {};
  const noteByCode = {};
  if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
    splitData.rows.forEach((r) => {
      const code = r.itemCode || `XLS::${String(r.itemName || '').trim()}`;
      qtyByCodeStoreId[code] = r.qtyByStoreId || {};
      noteByCode[code] = typeof r.note === 'string' ? r.note.trim() : '';
    });
  } else {
    slots.forEach((slot) => {
      const order = slotOrders[slot.apna];
      if (!order || !slot.store) return;
      orderItemsToList(order.items).forEach((item) => {
        if (!qtyByCodeStoreId[item.itemCode]) qtyByCodeStoreId[item.itemCode] = {};
        qtyByCodeStoreId[item.itemCode][slot.store.id] = Number(item.quantity) || 0;
        if (item.note) noteByCode[item.itemCode] = item.note;
      });
    });
  }

  // Leaves supplier exports should include only product + total qty (no store-wise columns).
  if (resolvedCategory === 'leaves') {
    excelRows.push([`Date: ${dateText}`, '', '', '', '', '', '']);
    excelRows.push(['PRODUCT', 'TOTAL QTY', '', '', '', '', '']);
    const leavesRows = splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0
      ? splitData.rows
      : Object.entries(qtyByCodeStoreId).map(([itemCode, qtyByStore]) => ({
          itemCode,
          itemName: itemNameByCode[itemCode] || displayOrderItemCode(itemCode),
          total: Object.values(qtyByStore || {}).reduce((acc, v) => acc + (Number(v) || 0), 0),
        }));
    leavesRows.forEach((r) => {
      const itemName = r.itemName || itemNameByCode[r.itemCode] || displayOrderItemCode(r.itemCode);
      const totalFromPayload = Number(r.total) || 0;
      const total =
        totalFromPayload > 0
          ? totalFromPayload
          : slots.reduce((acc, slot) => {
              if (!slot.store) return acc;
              return acc + (Number(r.qtyByStoreId && r.qtyByStoreId[slot.store.id]) || 0);
            }, 0);
      excelRows.push([itemName, total > 0 ? total : '', '', '', '', '', '']);
    });
    // Keep the template-based workbook so styling/format matches other consolidated files.
    usePlainWorkbook = false;
  } else if (template && Array.isArray(template.itemRows) && template.itemRows.length > 0) {
    excelRows = buildRowsFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
    });
    excelBuffer = await buildWorkbookFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
    });
    usePlainWorkbook = !excelBuffer;
  } else if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
    excelRows.push([`Date: ${dateText}`, '', ...slots.map((slot) => `${slot.apna}${type}`), '']);
    excelRows.push(['PRODUCT', 'TOTAL QTY', ...slots.map(() => 'QUANTITY (case qty)'), 'NOTE']);
    splitData.rows.forEach((r) => {
      const itemName = r.itemName || itemNameByCode[r.itemCode] || displayOrderItemCode(r.itemCode);
      const note = typeof r.note === 'string' ? r.note.trim() : '';
      const qtyCols = slots.map((slot) => {
        if (!slot.store) return '';
        const q = Number(r.qtyByStoreId && r.qtyByStoreId[slot.store.id]) || 0;
        return q > 0 ? q : '';
      });
      const totalFromPayload = Number(r.total) || 0;
      const total = totalFromPayload > 0 ? totalFromPayload : qtyCols.reduce((acc, v) => acc + (Number(v) || 0), 0);
      excelRows.push([itemName, total > 0 ? total : '', ...qtyCols, note]);
    });
  } else {
    excelRows = buildConsolidatedExcelRows({
      type,
      dateText,
      slots,
      slotOrders,
      itemNameByCode,
    });
  }

  const snapshotLines = excelRows.map((row) => row.join(' | '));
  const finalExcelBuffer = excelBuffer || (usePlainWorkbook ? await rowsToPlainExcelBuffer(excelRows) : await rowsToExcelBuffer(excelRows));
  const excelFilename = template && template.originalFile && template.originalFile.filename && String(template.originalFile.filename).toLowerCase().endsWith('.xlsx')
    ? template.originalFile.filename
    : `consolidated-order-${resolvedCategory}${resolvedVendorKey ? `-${resolvedVendorKey}` : ''}-${type}-${weekKey}.xlsx`;
  return { weekKey, stores, slots, slotOrders, snapshotLines, excelBuffer: finalExcelBuffer, excelFilename };
}

async function buildStoreOrderDocumentPayload({ type, category, vendorKey, storeId, itemsObj, notesObj, dateOverride, itemNamesObj }) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const stores = await Store.find().sort({ id: 1 }).lean();
  const itemDocs = await Item.find({ category: resolvedCategory, vendorKey: resolvedVendorKey }).lean();
  const itemNameByCode = Object.fromEntries(itemDocs.map((it) => [it.code, it.name]));
  const providedItemNames = itemNamesObj && typeof itemNamesObj === 'object' ? itemNamesObj : {};
  Object.entries(providedItemNames).forEach(([code, name]) => {
    const trimmedCode = String(code || '').trim();
    const trimmedName = String(name || '').trim();
    if (trimmedCode && trimmedName) itemNameByCode[trimmedCode] = trimmedName;
  });
  const template = await getCategoryTemplate(resolvedCategory, resolvedVendorKey);
  const slots = mapStoresToTemplateSlots(stores);
  const now = dateOverride ? new Date(dateOverride) : new Date();
  const dateText = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
  const normalizedItems = itemsObj && typeof itemsObj === 'object' ? itemsObj : {};
  const normalizedNotes = notesObj && typeof notesObj === 'object' ? notesObj : {};
  const codes = Array.from(
    new Set([...Object.keys(normalizedItems), ...Object.keys(normalizedNotes)].filter((code) => {
      const qty = Number(normalizedItems[code]) || 0;
      const note = String(normalizedNotes[code] || '').trim();
      return qty > 0 || note;
    }))
  ).sort((a, b) =>
    String(itemNameByCode[a] || displayOrderItemCode(a)).localeCompare(
      String(itemNameByCode[b] || displayOrderItemCode(b)),
      undefined,
      { sensitivity: 'base' }
    )
  );

  const qtyByCodeStoreId = {};
  const noteByCode = {};
  codes.forEach((code) => {
    qtyByCodeStoreId[code] = { [storeId]: Math.max(0, Number(normalizedItems[code]) || 0) };
    noteByCode[code] = String(normalizedNotes[code] || '').trim();
  });

  let rows;
  let usePlainWorkbook = false;
  let excelBuffer = null;
  const storeDoc = stores.find((st) => String(st.id || '') === String(storeId || '')) || { id: storeId, name: storeId };
  if (template && template.kind === 'docx_vendor_form' && template.docxMap && template.originalFile && template.originalFile.base64) {
    const quantitiesByCode = {};
    codes.forEach((code) => {
      const qty = Math.max(0, Number(normalizedItems[code]) || 0);
      if (qty > 0) quantitiesByCode[code] = qty;
    });
    const rendered = await renderVendorDocxTemplate({
      template,
      storeName: storeDoc.name || storeDoc.id || storeId,
      dateText,
      quantitiesByCode,
    });
    const stamp = now.toISOString().slice(0, 10);
    const sourceBase = safeFilenamePart(String(template.originalFile.filename || '').replace(/\.docx$/i, ''));
    const storeBase = safeFilenamePart(storeDoc.name || storeDoc.id || storeId);
    return {
      fileBuffer: rendered.buffer,
      filename: `${sourceBase}_${storeBase}_${stamp}.docx`,
      contentType: rendered.contentType,
      snapshotLines: codes.map((code) => {
        const qty = Math.max(0, Number(normalizedItems[code]) || 0);
        const note = String(normalizedNotes[code] || '').trim();
        return [storeDoc.name || storeDoc.id || storeId, code, itemNameByCode[code] || displayOrderItemCode(code), qty || '', note].join(' | ');
      }),
    };
  }
  if (template && Array.isArray(template.itemRows) && template.itemRows.length > 0) {
    rows = buildRowsFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
    });
    excelBuffer = await buildWorkbookFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
    });
    usePlainWorkbook = !excelBuffer;
  } else {
    rows = [];
    rows.push([`Date: ${dateText}`, ...slots.map((slot) => `${slot.apna}${type}`), '', '']);
    rows.push(['PRODUCT', ...slots.map(() => 'QUANTITY (case qty)'), 'TOTAL QTY', 'NOTE']);
    codes.forEach((code) => {
      const itemName = itemNameByCode[code] || displayOrderItemCode(code);
      const qty = Math.max(0, Number(normalizedItems[code]) || 0);
      const note = String(normalizedNotes[code] || '').trim();
      const qtyCols = slots.map((slot) => {
        if (!slot.store) return '';
        return slot.store.id === storeId && qty > 0 ? qty : '';
      });
      rows.push([itemName, ...qtyCols, qty > 0 ? qty : '', note]);
    });
  }

  const finalExcelBuffer = excelBuffer || (usePlainWorkbook ? await rowsToPlainExcelBuffer(rows) : await rowsToExcelBuffer(rows));
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const excelFilename = template && template.originalFile && template.originalFile.filename && String(template.originalFile.filename).toLowerCase().endsWith('.xlsx')
    ? template.originalFile.filename
    : `store-order-${resolvedCategory}${resolvedVendorKey ? `-${resolvedVendorKey}` : ''}-${type}-${storeId}-${stamp}.xlsx`;
  return {
    fileBuffer: finalExcelBuffer,
    filename: excelFilename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    snapshotLines: (rows || []).map((row) => (Array.isArray(row) ? row.join(' | ') : String(row || ''))),
  };
}

// Get orders for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const storeId = req.user.role === 'admin' ? req.query.storeId : req.user.storeId;
    const filter = {};
    if (storeId) filter.storeId = storeId;

    let orders = await Order.find(filter).sort({ submittedAt: -1, createdAt: -1 }).lean();

    const result = orders.map((order) => ({
      id: order.id,
      storeId: order.storeId,
      type: order.type,
      category: normalizeCategory(order.category),
      vendorKey: order.vendorKey || null,
      status: order.status,
      week: order.week,
      items: orderItemsToList(order.items).reduce((acc, i) => {
        acc[i.itemCode] = i.quantity;
        return acc;
      }, {}),
      notes: orderItemsToList(order.items).reduce((acc, i) => {
        if (i.note) acc[i.itemCode] = i.note;
        return acc;
      }, {}),
      date: order.submittedAt || order.createdAt,
      createdAt: order.createdAt,
      submittedAt: order.submittedAt || null,
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
    const { type, category, vendorKey, items = {}, notes = {}, status, storeId: bodyStoreId } = req.body;
    // allow admin to specify a different store when creating/updating
    const storeId = req.user.role === 'admin' && bodyStoreId ? bodyStoreId : req.user.storeId;
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    if (resolvedCategory === 'vendor_orders' && !resolvedVendorKey) {
      return res.status(400).json({ error: 'vendorKey is required for vendor orders' });
    }
    if (!type || !storeId) {
      return res.status(400).json({ error: 'Type and store required' });
    }
    if (!VALID_ORDER_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
    const normalizedItems = normalizeOrderItems(items, notes);
    const now = new Date();
    const orderId = uuidv4();
    const query = { storeId, type, category: resolvedCategory, vendorKey: resolvedVendorKey, week: weekKey };
    const update = {
      $set: {
        category: resolvedCategory,
        vendorKey: resolvedVendorKey,
        status,
        items: normalizedItems,
      },
      $setOnInsert: {
        id: orderId,
        storeId,
        type,
        week: weekKey,
        createdAt: now,
      },
    };
    if (status === 'submitted') {
      update.$set.submittedAt = now;
    } else if (status === 'draft') {
      update.$unset = { submittedAt: 1 };
    }

    let order;
    try {
      order = await Order.findOneAndUpdate(query, update, { upsert: true, new: true });
    } catch (err) {
      // Rare race on first insert under high concurrency; retry as plain update.
      if (err && err.code === 11000) {
        order = await Order.findOneAndUpdate(
          query,
          {
            $set: {
              category: resolvedCategory,
              vendorKey: resolvedVendorKey,
              status,
              items: normalizedItems,
              ...(status === 'submitted' ? { submittedAt: now } : {}),
            },
            ...(status === 'draft' ? { $unset: { submittedAt: 1 } } : {}),
          },
          { new: true }
        );
      } else {
        throw err;
      }
    }

    res.json({ success: true, orderId: order && order.id ? order.id : orderId });
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

    const category = normalizeCategory(req.query.category);
    const vendorKey = normalizeVendorKey(category, req.query.vendorKey);
    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, req.params.type, mo.manualOpenOrder, mo.manualOpenSeq);
    const stores = await getStoresForConsolidatedWindow(req.params.type, category, vendorKey, weekKey, weekBase);
    const response = [];

    for (const store of stores) {
      const order = await findCurrentWeekOrder(store.id, req.params.type, weekKey, category, vendorKey, weekBase);
      const visibleOrder = order && isStoreOrderVisibleInConsolidated(order.status) ? order : null;
      const visibleItems = visibleOrder ? orderItemsToList(visibleOrder.items) : [];
      const itemsObj = {};
      if (visibleOrder && visibleItems.length > 0) {
        visibleItems.forEach((i) => {
          itemsObj[i.itemCode] = i.quantity;
        });
      }
      const notesObj = {};
      if (visibleOrder && visibleItems.length > 0) {
        visibleItems.forEach((i) => {
          if (i.note) notesObj[i.itemCode] = i.note;
        });
      }
      response.push({
        id: store.id,
        name: store.name,
        order_id: visibleOrder ? visibleOrder.id : null,
        status: visibleOrder ? visibleOrder.status : null,
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
    const { email, emails, supplierName, reopenedFromId, splitData, category, vendorKey } = req.body;
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    const recipients = normalizeRecipientEmails(email, emails);
    if (recipients.length === 0) return res.status(400).json({ error: 'At least one recipient email is required' });
    // supplierName is optional here; frontend will send when available

    const { weekKey, stores, slots, slotOrders, snapshotLines, excelBuffer, excelFilename } =
      await buildConsolidatedExcelPayload(req.params.type, resolvedCategory, resolvedVendorKey, splitData);
    const supplierDisplayName = (supplierName || 'Supplier').trim();
    let body = 'Please find attached the consolidated order';

    await sendEmailWithFallback({
      to: recipients,
      subject: `Consolidated Order ${req.params.type} (Week ${weekKey})`,
      text: body,
      attachments: [
        {
          filename: excelFilename,
          content: excelBuffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    });

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
          if (order) {
            orderItemsToList(order.items).forEach((i) => {
              totalObj[i.itemCode] = (totalObj[i.itemCode] || 0) + (i.quantity || 0);
            });
          }
        });
      }
      const finishedFlag = splitData && typeof splitData.finished === 'boolean' ? splitData.finished : true;
      supplierOrder = await SupplierOrder.create({
        supplierName: supplierDisplayName,
        email: recipients.join(', '),
        emails: recipients,
        type: req.params.type,
        category: resolvedCategory,
        vendorKey: resolvedVendorKey,
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
            emails: supplierOrder.emails || [],
            type: supplierOrder.type,
            category: normalizeCategory(supplierOrder.category),
            vendorKey: supplierOrder.vendorKey || null,
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

// build consolidated Excel preview without sending email (admin only)
router.post('/consolidated/:type/excel-preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { splitData, category, vendorKey } = req.body || {};
    const { excelBuffer, excelFilename } = await buildConsolidatedExcelPayload(
      req.params.type,
      normalizeCategory(category),
      normalizeVendorKey(category, vendorKey),
      splitData
    );
    res.json({
      success: true,
      filename: excelFilename,
      excelBase64: excelBuffer.toString('base64'),
    });
  } catch (err) {
    console.error('Excel preview error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// build single-store order Excel preview (manager/admin)
router.post('/store-order/excel-preview', authMiddleware, async (req, res) => {
  try {
    const { type, category, vendorKey, items = {}, notes = {}, storeId, date, itemNames = {} } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type is required' });
    const resolvedStoreId = req.user.role === 'admin' && storeId ? String(storeId) : String(req.user.storeId || '');
    if (!resolvedStoreId) return res.status(400).json({ error: 'storeId is required' });

    const { fileBuffer, filename, contentType } = await buildStoreOrderDocumentPayload({
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
      storeId: resolvedStoreId,
      itemsObj: items,
      notesObj: notes,
      dateOverride: date,
      itemNamesObj: itemNames,
    });

    res.json({
      success: true,
      filename,
      contentType,
      fileBase64: fileBuffer.toString('base64'),
      excelBase64: contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? fileBuffer.toString('base64') : null,
    });
  } catch (err) {
    console.error('Store order Excel preview error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// backward-compatible alias: POST /store-order/:type/excel-preview
router.post('/store-order/:type/excel-preview', authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type || req.params.type;
    const { category, vendorKey, items = {}, notes = {}, storeId, date, itemNames = {} } = body;
    if (!type) return res.status(400).json({ error: 'type is required' });
    const resolvedStoreId = req.user.role === 'admin' && storeId ? String(storeId) : String(req.user.storeId || '');
    if (!resolvedStoreId) return res.status(400).json({ error: 'storeId is required' });

    const { fileBuffer, filename, contentType } = await buildStoreOrderDocumentPayload({
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
      storeId: resolvedStoreId,
      itemsObj: items,
      notesObj: notes,
      dateOverride: date,
      itemNamesObj: itemNames,
    });

    res.json({
      success: true,
      filename,
      contentType,
      fileBase64: fileBuffer.toString('base64'),
      excelBase64: contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? fileBuffer.toString('base64') : null,
    });
  } catch (err) {
    console.error('Store order Excel preview alias error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/vendor-orders/:vendorKey/email-individual', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const vendorKey = String(req.params.vendorKey || '').trim();
    const { email, emails, supplierName } = req.body || {};
    const recipients = normalizeRecipientEmails(email, emails);
    if (!vendorKey) return res.status(400).json({ error: 'vendorKey is required' });
    if (recipients.length === 0) return res.status(400).json({ error: 'At least one recipient email is required' });

    const category = 'vendor_orders';
    const type = 'VENDOR';
    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    const weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
    const stores = await getStoresForConsolidatedWindow(type, category, vendorKey, weekKey, weekBase);
    const attachments = [];
    const snapshotLines = [];
    const totalObj = {};

    for (const store of stores) {
      const order = await findCurrentWeekOrder(store.id, type, weekKey, category, vendorKey, weekBase);
      if (!order || !isStoreOrderVisibleInConsolidated(order.status)) continue;
      const orderList = orderItemsToList(order.items);
      const hasLines = orderList.some((line) => (Number(line.quantity) || 0) > 0 || String(line.note || '').trim());
      if (!hasLines) continue;

      const itemsObj = {};
      const notesObj = {};
      orderList.forEach((line) => {
        itemsObj[line.itemCode] = Number(line.quantity) || 0;
        if (line.note) notesObj[line.itemCode] = line.note;
        totalObj[line.itemCode] = (totalObj[line.itemCode] || 0) + (Number(line.quantity) || 0);
      });

      const doc = await buildStoreOrderDocumentPayload({
        type,
        category,
        vendorKey,
        storeId: store.id,
        itemsObj,
        notesObj,
        dateOverride: order.submittedAt || order.createdAt || new Date(),
        itemNamesObj: {},
      });

      attachments.push({
        filename: doc.filename,
        content: doc.fileBuffer,
        contentType: doc.contentType,
      });
      snapshotLines.push(`${store.name || store.id} | ${doc.filename} | ${order.status}`);
    }

    if (attachments.length === 0) {
      return res.status(400).json({ error: 'No submitted vendor store documents available to send' });
    }

    await sendEmailWithFallback({
      to: recipients,
      subject: `Vendor Orders - Individual Store Documents (${weekKey})`,
      text: 'Please find attached the individual store order documents.',
      attachments,
    });

    let supplierOrder = null;
    try {
      supplierOrder = await SupplierOrder.create({
        supplierName: String(supplierName || vendorKey).trim(),
        email: recipients.join(', '),
        emails: recipients,
        type,
        category,
        vendorKey,
        week: weekKey,
        items: totalObj,
        snapshotLines,
        finished: true,
      });
    } catch (historyErr) {
      console.error('Vendor individual email history save error:', historyErr);
    }

    res.json({
      success: true,
      attachmentsCount: attachments.length,
      supplierOrder: supplierOrder
        ? {
            _id: supplierOrder._id,
            supplierName: supplierOrder.supplierName,
            email: supplierOrder.email,
            emails: supplierOrder.emails || [],
            type: supplierOrder.type,
            category: normalizeCategory(supplierOrder.category),
            vendorKey: supplierOrder.vendorKey || null,
            week: supplierOrder.week,
            items: supplierOrder.items,
            snapshotLines: supplierOrder.snapshotLines,
            sentAt: supplierOrder.sentAt,
            finished: supplierOrder.finished,
          }
        : null,
    });
  } catch (err) {
    console.error('Vendor individual email error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/consolidated-history', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const days = parseInt(req.query.days, 10);
    const history = await buildConsolidatedHistory({ days: Number.isNaN(days) ? 7 : days });
    res.json(history);
  } catch (err) {
    console.error('Get consolidated history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/consolidated-history/excel', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { week, type, category, vendorKey } = req.body || {};
    if (!week || !type) {
      return res.status(400).json({ error: 'week and type are required' });
    }
    const { excelBuffer, excelFilename } = await buildConsolidatedHistoryExcelPayload({
      week: String(week),
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
    });
    res.json({
      success: true,
      filename: excelFilename,
      excelBase64: excelBuffer.toString('base64'),
    });
  } catch (err) {
    console.error('Consolidated history Excel error:', err);
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
      list.map(({ excelBase64, ...row }) => {
        const emails = normalizeRecipientEmails(row.email, row.emails);
        return {
          ...row,
          email: emails.join(', '),
          emails,
          category: normalizeCategory(row.category),
          vendorKey: row.vendorKey || null,
          hasExcel: !!excelBase64,
        };
      })
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
    const { supplierName, email, emails, type, category, vendorKey, week, items } = req.body;
    const recipients = normalizeRecipientEmails(email, emails);
    if (!supplierName || recipients.length === 0 || !type || !week) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    const so = new SupplierOrder({
      supplierName,
      email: recipients.join(', '),
      emails: recipients,
      type,
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
      week,
      items,
    });
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
    if (!['A', 'B', 'C', 'VENDOR'].includes(type)) {
      return res.status(400).json({ error: 'Invalid order type' });
    }
    const storeId = req.body && req.body.storeId ? String(req.body.storeId) : null;
    const category = normalizeCategory(req.body && req.body.category);
    const vendorKey = normalizeVendorKey(category, req.body && req.body.vendorKey);
    if (type === 'VENDOR' && (!vendorKey || category !== 'vendor_orders')) {
      return res.status(400).json({ error: 'vendorKey is required for vendor reminders' });
    }
    const result = await sendManualReminders({ type, storeId, category, vendorKey });
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

    await sendEmailWithFallback({ to, subject, text });

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
