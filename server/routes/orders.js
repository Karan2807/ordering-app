import express from 'express';
import { authMiddleware } from '../auth.js';
import { v4 as uuidv4 } from 'uuid';
import Order from '../models/order.js';
import Store from '../models/store.js';
import Supplier from '../models/supplier.js';
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

function listifyVendorInputs(input) {
  if (Array.isArray(input)) return input.slice();
  if (input && typeof input.values === 'function' && typeof input.size === 'number') {
    try {
      return Array.from(input.values());
    } catch (_err) {
      return [];
    }
  }
  if (input && typeof input === 'object') {
    if (input.vendorKey || input.id) return [input];
    return Object.keys(input).map((key) => {
      const value = input[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { vendorKey: value.vendorKey || key, ...value };
      }
      return { vendorKey: key };
    });
  }
  return input == null || input === '' ? [] : [input];
}

function extractVendorIdentifier(input) {
  if (input == null) return '';
  if (typeof input === 'string' || typeof input === 'number') {
    const value = String(input).trim();
    if (!value) return '';
    const lowered = value.toLowerCase();
    if (lowered === '[object object]' || lowered === '[object set]') return '';
    return value;
  }
  if (Array.isArray(input)) return extractVendorIdentifier(input[0]);
  if (typeof input === 'object') {
    const direct = extractVendorIdentifier(input.vendorKey);
    if (direct) return direct;
    const byId = extractVendorIdentifier(input.id);
    if (byId) return byId;
    const bySupplierId = extractVendorIdentifier(input.supplierId);
    if (bySupplierId) return bySupplierId;
    const byValue = extractVendorIdentifier(input.value);
    if (byValue) return byValue;
    const byKey = extractVendorIdentifier(input.key);
    if (byKey) return byKey;
  }
  return '';
}

function normalizeVendorKeys(input) {
  const list = listifyVendorInputs(input);
  const merged = list.map((value) => {
    return extractVendorIdentifier(value);
  }).filter(Boolean);
  return [...new Set(merged)];
}

function parseOptionalDay(value) {
  if (value == null || value === '') return null;
  const day = parseInt(value, 10);
  return Number.isNaN(day) || day < 0 || day > 6 ? null : day;
}

function normalizeVendorOrderConfigs(input) {
  const list = listifyVendorInputs(input);
  const byVendorKey = new Map();
  list.forEach((entry) => {
    const raw = entry && typeof entry === 'object' ? entry : { vendorKey: entry };
    const vendorKey = extractVendorIdentifier(raw);
    if (!vendorKey) return;
    let startDay = parseOptionalDay(raw.startDay);
    let endDay = parseOptionalDay(raw.endDay);
    if ((startDay == null) !== (endDay == null)) {
      startDay = null;
      endDay = null;
    }
    const rawSeq = parseInt(raw.seq, 10);
    byVendorKey.set(vendorKey, {
      vendorKey,
      startDay,
      endDay,
      enabled: raw.enabled !== false,
      temporaryOpenUntil: raw.temporaryOpenUntil || null,
      temporaryOpenCreatedAt: raw.temporaryOpenCreatedAt || null,
      temporaryOpenOnly: raw.temporaryOpenOnly === true || raw.temporaryOpenOnly === 'true' || raw.temporaryOpenOnly === 1 || raw.temporaryOpenOnly === '1',
      seq: rawSeq > 0 ? rawSeq : 1,
    });
  });
  return Array.from(byVendorKey.values());
}

async function persistVendorOrderConfigs(configs) {
  const normalizedConfigs = normalizeVendorOrderConfigs(configs);
  const vendorKeys = normalizeVendorKeys(
    normalizedConfigs
      .filter((config) => config.enabled !== false)
      .map((config) => config.vendorKey)
  );
  if (normalizedConfigs.length) {
    await Setting.updateOne(
      { key: 'vendorOrderConfigs' },
      { value: normalizedConfigs },
      { upsert: true }
    );
  } else {
    await Setting.deleteOne({ key: 'vendorOrderConfigs' });
  }
  if (vendorKeys.length) {
    await Setting.updateOne({ key: 'vendorOrdersOpenVendors' }, { value: vendorKeys }, { upsert: true });
    await Setting.updateOne({ key: 'vendorOrdersOpenVendor' }, { value: vendorKeys[0] }, { upsert: true });
  } else {
    await Setting.deleteMany({ key: { $in: ['vendorOrdersOpenVendor', 'vendorOrdersOpenVendors'] } });
  }
  await Setting.deleteMany({ key: { $in: ['vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'] } });
  return normalizedConfigs;
}

async function clearVendorOrdersOpenIfMatching(vendorKey) {
  const normalizedVendorKey = String(vendorKey || '').trim();
  if (!normalizedVendorKey) {
    return { vendorOrdersOpenVendor: null, vendorOrdersOpenVendors: [], vendorOrderConfigs: [] };
  }
  const docs = await Setting.find({ key: { $in: ['vendorOrderConfigs', 'vendorOrdersOpenVendor', 'vendorOrdersOpenVendors', 'vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'] } }).lean();
  let configsRaw = [];
  docs.forEach((doc) => {
    if (!doc) return;
    if (doc.key === 'vendorOrderConfigs') configsRaw = doc.value;
  });
  const configs = normalizeVendorOrderConfigs(configsRaw);
  const nextConfigs = configs.map((config) => {
    if (String(config.vendorKey || '').trim() !== normalizedVendorKey) return config;
    return {
      ...config,
      enabled: false,
      temporaryOpenUntil: null,
      temporaryOpenCreatedAt: null,
      temporaryOpenOnly: false,
    };
  });
  const persistedConfigs = await persistVendorOrderConfigs(nextConfigs);
  const nextVendors = normalizeVendorKeys(
    persistedConfigs
      .filter((config) => config.enabled !== false)
      .map((config) => config.vendorKey)
  );
  return {
    vendorOrdersOpenVendor: nextVendors[0] || null,
    vendorOrdersOpenVendors: nextVendors,
    vendorOrderConfigs: persistedConfigs,
  };
}

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

function makeExcelRow(cells, kind = 'data') {
  return {
    kind,
    cells: Array.isArray(cells) ? cells.slice() : [],
  };
}

function getExcelRowCells(row) {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object' && Array.isArray(row.cells)) return row.cells;
  return [];
}

function getExcelRowKind(row, index) {
  if (row && typeof row === 'object' && !Array.isArray(row) && row.kind) {
    return row.kind;
  }
  const cells = getExcelRowCells(row);
  const first = String(cells[0] || '').trim();
  const hasOtherValues = cells.slice(1).some((value) => String(value || '').trim());
  if (index > 1 && first && !hasOtherValues) return 'heading';
  if (index === 0) return 'date';
  if (index === 1) return 'header';
  return 'data';
}

function compareCatalogItems(a, b) {
  const aSort = Number.isFinite(Number(a && a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
  const bSort = Number.isFinite(Number(b && b.sortOrder)) ? Number(b && b.sortOrder) : Number.MAX_SAFE_INTEGER;
  if (aSort !== bSort) return aSort - bSort;
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), undefined, { sensitivity: 'base' });
}

function formatItemDisplayName(name, unit) {
  const trimmedName = String(name || '').trim();
  const trimmedUnit = String(unit || '').trim();
  if (!trimmedUnit) return trimmedName;
  if (!trimmedName) return trimmedUnit;
  const normalizedName = trimmedName.toLowerCase();
  const normalizedUnit = trimmedUnit.toLowerCase();
  if (normalizedName.endsWith(`(${normalizedUnit})`) || normalizedName.endsWith(`[${normalizedUnit}]`)) {
    return trimmedName;
  }
  return `${trimmedName} (${trimmedUnit})`;
}

function buildItemDisplayMaps(itemDocs, providedItemNames = {}, providedItemDetails = {}) {
  const itemNameByCode = {};
  const itemUnitByCode = {};

  (Array.isArray(itemDocs) ? itemDocs : []).forEach((item) => {
    const code = String(item && item.code || '').trim();
    if (!code) return;
    const unit = String(item && item.unit || '').trim();
    const name = String(item && item.name || code).trim();
    if (unit) itemUnitByCode[code] = unit;
    itemNameByCode[code] = formatItemDisplayName(name || code, unit);
  });

  Object.entries(providedItemNames && typeof providedItemNames === 'object' ? providedItemNames : {}).forEach(([code, name]) => {
    const trimmedCode = String(code || '').trim();
    const trimmedName = String(name || '').trim();
    if (!trimmedCode || !trimmedName) return;
    itemNameByCode[trimmedCode] = formatItemDisplayName(trimmedName, itemUnitByCode[trimmedCode]);
  });

  Object.entries(providedItemDetails && typeof providedItemDetails === 'object' ? providedItemDetails : {}).forEach(([code, detail]) => {
    const trimmedCode = String(code || '').trim();
    if (!trimmedCode) return;
    const trimmedUnit = String(detail && detail.unit || '').trim();
    const trimmedName = String(detail && detail.name || '').trim();
    if (trimmedUnit) itemUnitByCode[trimmedCode] = trimmedUnit;
    if (trimmedName) itemNameByCode[trimmedCode] = formatItemDisplayName(trimmedName, itemUnitByCode[trimmedCode]);
  });

  return { itemNameByCode, itemUnitByCode };
}

function buildCatalogOutlineEntries({ itemDocs, selectedCodes, itemNameByCode, itemDetailsByCode }) {
  const selected = Array.from(new Set((selectedCodes || [])
    .map((code) => String(code || '').trim())
    .filter(Boolean)));
  if (!selected.length) return [];

  const selectedSet = new Set(selected);
  const detailsByCode = itemDetailsByCode && typeof itemDetailsByCode === 'object' ? itemDetailsByCode : {};
  const entries = [];
  const seenCodes = new Set();
  let lastHeading = null;

  (Array.isArray(itemDocs) ? itemDocs : [])
    .filter((doc) => selectedSet.has(String(doc && doc.code || '').trim()))
    .sort(compareCatalogItems)
    .forEach((doc) => {
      const code = String(doc && doc.code || '').trim();
      if (!code || seenCodes.has(code)) return;
      const detail = detailsByCode[code] && typeof detailsByCode[code] === 'object' ? detailsByCode[code] : null;
      const heading = String((detail && detail.subheading) || (doc && doc.subheading) || '').trim();
      if (heading && heading !== lastHeading) {
        entries.push({ type: 'heading', text: heading });
        lastHeading = heading;
      }
      entries.push({
        type: 'item',
        code,
        itemName: itemNameByCode[code] || (detail && detail.name) || doc.name || displayOrderItemCode(code),
      });
      seenCodes.add(code);
    });

  selected
    .filter((code) => !seenCodes.has(code))
    .sort((a, b) => String(itemNameByCode[a] || (detailsByCode[a] && detailsByCode[a].name) || displayOrderItemCode(a)).localeCompare(
      String(itemNameByCode[b] || (detailsByCode[b] && detailsByCode[b].name) || displayOrderItemCode(b)),
      undefined,
      { sensitivity: 'base' }
    ))
    .forEach((code) => {
      const detail = detailsByCode[code] && typeof detailsByCode[code] === 'object' ? detailsByCode[code] : null;
      const heading = String((detail && detail.subheading) || '').trim();
      if (heading && heading !== lastHeading) {
        entries.push({ type: 'heading', text: heading });
        lastHeading = heading;
      }
      entries.push({
        type: 'item',
        code,
        itemName: itemNameByCode[code] || (detail && detail.name) || displayOrderItemCode(code),
      });
    });

  return entries;
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
      const qtyTotal = Object.values(qtyByCodeStoreId[code] || {}).reduce((sum, value) => sum + getQtyNumber(value), 0);
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
      const qtyValue = storeId && qtyByCodeStoreId[code] ? qtyByCodeStoreId[code][storeId] : null;
      const displayValue = getQtyCellValue(qtyValue);
      rows[itemRow.rowIndex][col.colIndex] = displayValue == null ? '' : String(displayValue);
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

  const slotByKey = Object.fromEntries((slots || []).map((slot) => [slot.apna, slot]));

  // Use multiSheetItemRows if present (multi-sheet support), else fall back to itemRows
  const allItemRows = Array.isArray(template.multiSheetItemRows) && template.multiSheetItemRows.length > 0
    ? template.multiSheetItemRows
    : (Array.isArray(template.itemRows) ? template.itemRows.map((ir) => Object.assign({}, ir, {
        sheetIndex: 0,
        sheetName: String(template.sheetName || ''),
      })) : []);

  // Group items by sheet
  const itemsBySheet = {};
  allItemRows.forEach((itemRow) => {
    const shKey = String(itemRow.sheetName || itemRow.sheetIndex || 0);
    if (!itemsBySheet[shKey]) itemsBySheet[shKey] = { sheetName: itemRow.sheetName, sheetIndex: Number(itemRow.sheetIndex) || 0, rows: [] };
    itemsBySheet[shKey].rows.push(itemRow);
  });

  // Write to each sheet
  for (const sheetGroup of Object.values(itemsBySheet)) {
    const ws = sheetGroup.sheetName
      ? workbook.getWorksheet(sheetGroup.sheetName) || workbook.worksheets[sheetGroup.sheetIndex] || workbook.worksheets[0]
      : workbook.worksheets[sheetGroup.sheetIndex] || workbook.worksheets[0];
    if (!ws) continue;

    // Write date cell (only on first sheet)
    if (sheetGroup.sheetIndex === 0 && template.dateCell && template.dateCell.rowIndex != null && template.dateCell.colIndex != null) {
      ws.getCell(template.dateCell.rowIndex + 1, template.dateCell.colIndex + 1).value = `${template.dateCell.prefix || ''}${dateText}`;
    }

    sheetGroup.rows.forEach((itemRow) => {
      const code = String(itemRow.code || '').trim();
      const name = itemNameByCode[code] || itemRow.name || displayOrderItemCode(code);
      const nameCell = ws.getCell(itemRow.rowIndex + 1, (itemRow.colIndex || 0) + 1);
      nameCell.value = name;
      applyWrappedCellLayout(nameCell, name, 20);
      if (template.kind === 'tabular') {
        const qtyTotal = Object.values(qtyByCodeStoreId[code] || {}).reduce((sum, value) => sum + getQtyNumber(value), 0);
        if (template.quantityColumn && template.quantityColumn.colIndex != null) {
          ws.getCell(itemRow.rowIndex + 1, template.quantityColumn.colIndex + 1).value = qtyTotal > 0 ? qtyTotal : null;
        }
        if (template.noteColumn && template.noteColumn.colIndex != null) {
          ws.getCell(itemRow.rowIndex + 1, template.noteColumn.colIndex + 1).value = noteByCode[code] || null;
        }
        return;
      }
      (template.storeColumns || []).forEach((col) => {
        const slot = slotByKey[col.slotKey];
        const storeId = slot && slot.store ? slot.store.id : null;
        const qtyValue = storeId && qtyByCodeStoreId[code] ? qtyByCodeStoreId[code][storeId] : null;
        ws.getCell(itemRow.rowIndex + 1, col.colIndex + 1).value = getQtyCellValue(qtyValue);
      });
    });

    const touchedColumns = new Set();
    const touchedRows = new Set();
    if (sheetGroup.sheetIndex === 0 && template.dateCell && template.dateCell.colIndex != null && template.dateCell.rowIndex != null) {
      touchedColumns.add(template.dateCell.colIndex + 1);
      touchedRows.add(template.dateCell.rowIndex + 1);
    }
    sheetGroup.rows.forEach((itemRow) => {
      touchedColumns.add((itemRow.colIndex || 0) + 1);
      touchedRows.add(itemRow.rowIndex + 1);
      if (template.kind === 'tabular') {
        if (template.quantityColumn && template.quantityColumn.colIndex != null) touchedColumns.add(template.quantityColumn.colIndex + 1);
        if (template.noteColumn && template.noteColumn.colIndex != null) touchedColumns.add(template.noteColumn.colIndex + 1);
      } else {
        (template.storeColumns || []).forEach((col) => touchedColumns.add(col.colIndex + 1));
      }
    });
    normalizeWorksheetGrid(ws, {
      columnNumbers: Array.from(touchedColumns),
      rowNumbers: Array.from(touchedRows),
    });
  }

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
  // Use UTC so every country generates the same date-based week key.
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getIsoWeekKeyForDate(value) {
  const d = new Date(value);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function normalizeRequestedWeekKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}(?:-M\d+|-VS\d+)?$/.test(raw) ? raw : null;
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

async function getVendorSeqForKey(vendorKey) {
  if (!vendorKey) return 1;
  const doc = await Setting.findOne({ key: 'vendorOrderConfigs' }).lean();
  if (!doc || !Array.isArray(doc.value)) return 1;
  const config = (doc.value || []).find(
    (c) => c && String(c.vendorKey || '').trim() === String(vendorKey).trim()
  );
  const seq = config ? parseInt(config.seq, 10) : 0;
  return seq > 0 ? seq : 1;
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

function consolidatedFilenameDate(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function resolveConsolidatedSupplierName({ category, vendorKey, supplierName }) {
  const directName = String(supplierName || '').trim();
  if (directName) return directName;

  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  if (resolvedVendorKey) {
    const supplier = await Supplier.findOne({ id: resolvedVendorKey }).select({ name: 1, _id: 0 }).lean();
    if (supplier && String(supplier.name || '').trim()) return String(supplier.name || '').trim();
    return resolvedVendorKey;
  }

  return resolvedCategory === 'leaves' ? 'Leaves' : 'Supplier';
}

function buildConsolidatedFilename({ supplierName, dateValue }) {
  const supplierBase = safeFilenamePart(supplierName || 'Supplier');
  const dateBase = safeFilenamePart(consolidatedFilenameDate(dateValue));
  return `${supplierBase}_${dateBase}_consolidated.xlsx`;
}

async function getStoresForConsolidatedWindow(type, category, vendorKey, weekKey, weekBase = null) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const isVendorOrders = resolvedCategory === 'vendor_orders' && !!resolvedVendorKey;
  const resolvedWeekBase = weekBase || String(weekKey || '').split('-VS')[0] || String(weekKey || '').split('-M')[0];
  const vendorWeekRegex = isVendorOrders && resolvedWeekBase
    ? new RegExp(`^${escapeRegex(resolvedWeekBase)}-VS\\d+$`)
    : null;
  const [stores, extraOrders] = await Promise.all([
    Store.find().sort({ id: 1 }).lean(),
    Order.find({
      type,
      category: resolvedCategory,
      vendorKey: resolvedVendorKey,
      ...(vendorWeekRegex ? { week: { $regex: vendorWeekRegex } } : weekWindowFilter(weekKey, weekBase)),
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
  if (exact && !(
    resolvedCategory === 'vendor_orders' &&
    resolvedVendorKey &&
    !['submitted', 'processed', 'draft_shared'].includes(String(exact.status || '').toLowerCase())
  )) {
    return exact;
  }

  // Vendor orders can be submitted under earlier same-day VS sequences when settings
  // refresh lags behind UI state. Recover only the latest record for the SAME
  // VS sequence; if Settings opened a fresh cycle with a new seq, do not revive
  // the prior seq here.
  if (resolvedCategory === 'vendor_orders' && resolvedVendorKey) {
    const requestedWeek = String(weekKey || '').trim();
    const seqMatch = requestedWeek.match(/-VS(\d+)$/i);
    const requestedSeq = seqMatch ? parseInt(seqMatch[1], 10) : null;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sameSeqFilter = requestedSeq != null ? { week: { $regex: new RegExp(`-VS${requestedSeq}$`, 'i') } } : {};
    const submittedFallback = await Order.findOne({
      storeId,
      type,
      category: resolvedCategory,
      vendorKey: resolvedVendorKey,
      status: { $in: ['submitted', 'processed', 'draft_shared'] },
      ...sameSeqFilter,
      $or: [
        { submittedAt: { $gte: since } },
        { createdAt: { $gte: since } },
      ],
    })
      .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
      .lean();
    if (submittedFallback) return submittedFallback;

    const fallback = await Order.findOne({
      storeId,
      type,
      category: resolvedCategory,
      vendorKey: resolvedVendorKey,
      ...sameSeqFilter,
      $or: [
        { submittedAt: { $gte: since } },
        { createdAt: { $gte: since } },
      ],
    })
      .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
      .lean();
    if (fallback) return fallback;
  }

  return null;
}

function getQtyWithUnit(value) {
  // Handle both legacy (number) and new format (object with qty, unitType, customUnit)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const qty = Number(value.qty) || 0;
    const unitType = String(value.unitType || 'cas').toLowerCase();
    const customUnit = String(value.customUnit || '').trim();
    
    let unitLabel = 'CASE';
    if (unitType === 'pcs') unitLabel = 'PCS';
    else if (unitType === 'pallet') unitLabel = 'PALLET';
    else if (unitType === 'master_case') unitLabel = 'MASTER CASE';
    else if (unitType === 'other') unitLabel = customUnit || 'OTHER';
    
    return { qty, unitLabel, formatted: `${qty} ${unitLabel}` };
  }
  
  const qty = Number(value) || 0;
  return { qty, unitLabel: 'CASE', formatted: `${qty} CASE` };
}

function formatQtyValueWithUnit(qty, unitMeta) {
  const info = getQtyWithUnit({
    qty: Number(qty) || 0,
    unitType: unitMeta && unitMeta.unitType ? unitMeta.unitType : 'cas',
    customUnit: unitMeta && unitMeta.customUnit ? unitMeta.customUnit : '',
  });
  return info.qty > 0 ? info.formatted : '';
}

function formatQtySummaryByUnit(qtyByStoreId = {}, orderUnitByStoreId = {}) {
  const totals = {};
  Object.keys(qtyByStoreId || {}).forEach((storeId) => {
    const qty = Number(qtyByStoreId[storeId]) || 0;
    if (qty <= 0) return;
    const label = getQtyWithUnit({
      qty,
      unitType: orderUnitByStoreId[storeId] && orderUnitByStoreId[storeId].unitType ? orderUnitByStoreId[storeId].unitType : 'cas',
      customUnit: orderUnitByStoreId[storeId] && orderUnitByStoreId[storeId].customUnit ? orderUnitByStoreId[storeId].customUnit : '',
    }).unitLabel;
    totals[label] = (totals[label] || 0) + qty;
  });
  return Object.entries(totals).map(([label, qty]) => `${qty} ${label}`).join(', ');
}

function isStructuredQtyValue(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getQtyNumber(value) {
  return getQtyWithUnit(value).qty;
}

function getQtyCellValue(value) {
  const info = getQtyWithUnit(value);
  if (info.qty <= 0) return null;
  return isStructuredQtyValue(value) ? info.formatted : info.qty;
}

function normalizeOrderItems(itemsInput, notesInput = {}) {
  const itemsObj = itemsInput && typeof itemsInput === 'object' && !Array.isArray(itemsInput) ? itemsInput : {};
  const notesObj = notesInput && typeof notesInput === 'object' && !Array.isArray(notesInput) ? notesInput : {};

  return Object.entries(itemsObj)
    .map(([itemCode, rawValue]) => {
      // Handle both old format (number) and new format (object with qty, unitType, customUnit)
      let qty = 0;
      let unitType = 'cas';
      let customUnit = '';
      
      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        qty = Number(rawValue.qty) || 0;
        unitType = String(rawValue.unitType || 'cas').toLowerCase();
        customUnit = String(rawValue.customUnit || '').trim();
      } else {
        qty = Number(rawValue) || 0;
      }
      
      const note = typeof notesObj[itemCode] === 'string' ? notesObj[itemCode].trim() : '';
      return { itemCode, quantity: qty, unitType, customUnit, note };
    })
    .filter(({ quantity, note }) => quantity > 0 || note);
}

function orderItemsToList(rawItems) {
  if (Array.isArray(rawItems)) {
    return rawItems.map((item) => {
      if (!item || typeof item !== 'object') return { itemCode: '', quantity: 0, unitType: 'cas', customUnit: '', note: '' };
      return {
        itemCode: String(item.itemCode || ''),
        quantity: Number(item.qty != null ? item.qty : item.quantity) || 0,
        unitType: String(item.unitType || item.type || 'cas').toLowerCase(),
        customUnit: String(item.customUnit || item.otherUnit || '').trim(),
        note: String(item.note || ''),
      };
    });
  }
  if (!rawItems || typeof rawItems !== 'object') return [];
  return Object.entries(rawItems).map(([itemCode, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        itemCode,
        quantity: Number(value.qty != null ? value.qty : value.quantity) || 0,
        unitType: String(value.unitType || value.type || 'cas').toLowerCase(),
        customUnit: String(value.customUnit || value.otherUnit || '').trim(),
        note: typeof value.note === 'string' ? value.note : '',
      };
    }
    return {
      itemCode,
      quantity: Number(value) || 0,
      unitType: 'cas',
      customUnit: '',
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
  const { itemNameByCode } = buildItemDisplayMaps(itemDocs);

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
  const latestSentLog = await SupplierOrder.findOne({
    week: normalizedWeek,
    type: normalizedType,
    category: normalizedCategory,
    vendorKey: normalizedVendorKey,
  })
    .sort({ sentAt: -1, _id: -1 })
    .lean();

  // When a consolidated email was already sent, return the exact workbook that
  // was attached to the email so history matches what the supplier received.
  if (latestSentLog && latestSentLog.excelBase64) {
    const supplierDisplayName = await resolveConsolidatedSupplierName({
      category: normalizedCategory,
      vendorKey: normalizedVendorKey,
      supplierName: latestSentLog.supplierName,
    });
    return {
      excelBuffer: Buffer.from(latestSentLog.excelBase64, 'base64'),
      excelFilename: buildConsolidatedFilename({
        supplierName: supplierDisplayName,
        dateValue: latestSentLog.sentAt || latestSentLog.createdAt || new Date(),
      }),
    };
  }

  // For not-yet-sent groups (or older records without a stored workbook),
  // generate the same consolidated template workbook the email flow would use.
  const { excelBuffer, excelFilename } = await buildConsolidatedExcelPayload(
    normalizedType,
    normalizedCategory,
    normalizedVendorKey,
    null,
    normalizedWeek
  );
  return { excelBuffer, excelFilename };
}

function buildConsolidatedExcelRows({ type, dateText, slots, slotOrders, itemNameByCode }) {
  const rows = [];
  rows.push([`Date: ${dateText}`, '', ...slots.map((slot) => `${slot.apna}${type}`), '']);
  rows.push(['PRODUCT', 'TOTAL QTY', ...slots.map(() => 'QTY'), 'NOTE']);

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

function buildVendorRowsFromPreviewLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const dateLabel = String(layout.dateLabel || `Date: ${new Date().toLocaleDateString('en-US')}`).trim();
  const itemHeader = String(layout.itemHeader || 'PRODUCT').trim() || 'PRODUCT';
  const totalHeader = String(layout.totalHeader || 'TOTAL QTY').trim() || 'TOTAL QTY';
  const previewRows = Array.isArray(layout.rows) ? layout.rows : [];
  if (previewRows.length < 1) return null;

  const rows = [];
  // Vendor supplier attachment keeps item, item-master unit, and grouped total qty.
  // Keep template-compatible width so style rendering remains consistent.
  rows.push(makeExcelRow([dateLabel, '', '', '', '', '', ''], 'date'));
  rows.push(makeExcelRow([itemHeader, 'UNIT', totalHeader, '', '', '', ''], 'header'));

  previewRows.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'heading') {
      const heading = String(entry.text || '').trim();
      if (!heading) return;
      rows.push(makeExcelRow([heading, '', '', '', '', '', ''], 'heading'));
      return;
    }
    if (entry.type !== 'item') return;
    const itemName = String(entry.itemName || '').trim();
    if (!itemName) return;
    const itemUnit = String(entry.itemUnit || '').trim();
    const qtyMap = entry.qtyByStoreId && typeof entry.qtyByStoreId === 'object' ? entry.qtyByStoreId : {};
    const orderUnitByStoreId = entry.orderUnitByStoreId && typeof entry.orderUnitByStoreId === 'object' ? entry.orderUnitByStoreId : {};
    const totalDisplay = String(entry.totalDisplay || '').trim() || formatQtySummaryByUnit(qtyMap, orderUnitByStoreId);
    rows.push(makeExcelRow([itemName, itemUnit, totalDisplay, '', '', '', ''], 'data'));
  });

  return rows;
}

function buildVendorMonitorRowsFromPreviewLayout(layout) {
  if (!layout || typeof layout !== 'object') return null;
  const dateLabel = String(layout.dateLabel || `Date: ${new Date().toLocaleDateString('en-US')}`).trim();
  const itemHeader = String(layout.itemHeader || 'PRODUCT').trim() || 'PRODUCT';
  const totalHeader = String(layout.totalHeader || 'TOTAL QTY').trim() || 'TOTAL QTY';
  const slotHeaders = Array.isArray(layout.slotHeaders) ? layout.slotHeaders : [];
  const slotStoreIds = Array.isArray(layout.slotStoreIds) ? layout.slotStoreIds : [];
  const slotQtyHeaders = Array.isArray(layout.slotQtyHeaders) ? layout.slotQtyHeaders : [];
  const previewRows = Array.isArray(layout.rows) ? layout.rows : [];
  if (previewRows.length < 1) return null;

  const rows = [];
  rows.push(makeExcelRow([dateLabel, '', '', ...slotHeaders, ''], 'date'));
  rows.push(makeExcelRow([itemHeader, 'UNIT', totalHeader, ...slotQtyHeaders, 'NOTE'], 'header'));

  previewRows.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'heading') {
      const heading = String(entry.text || '').trim();
      if (!heading) return;
      rows.push(makeExcelRow([heading, '', '', ...slotHeaders.map(() => ''), ''], 'heading'));
      return;
    }
    if (entry.type !== 'item') return;
    const itemName = String(entry.itemName || '').trim();
    if (!itemName) return;
    const itemUnit = String(entry.itemUnit || '').trim();
    const qtyMap = entry.qtyByStoreId && typeof entry.qtyByStoreId === 'object' ? entry.qtyByStoreId : {};
    const orderUnitByStoreId = entry.orderUnitByStoreId && typeof entry.orderUnitByStoreId === 'object' ? entry.orderUnitByStoreId : {};
    const totalDisplay = String(entry.totalDisplay || '').trim() || formatQtySummaryByUnit(qtyMap, orderUnitByStoreId);
    const qtyCols = slotStoreIds.map((storeId) => {
      const qty = Number(qtyMap[storeId]) || 0;
      return formatQtyValueWithUnit(qty, orderUnitByStoreId[storeId] || { unitType: 'cas', customUnit: '' });
    });
    rows.push(makeExcelRow([itemName, itemUnit, totalDisplay, ...qtyCols, String(entry.note || '').trim()], 'data'));
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

function captureRowStyleSnapshot(ws, rowNumber, startCol = 2, endCol = 7) {
  const row = ws.getRow(rowNumber);
  const stylesByColumn = {};
  for (let col = startCol; col <= endCol; col += 1) {
    const styleCol = Math.min(col, 7);
    stylesByColumn[col] = JSON.parse(JSON.stringify(ws.getCell(rowNumber, styleCol).style || {}));
  }
  return {
    height: row.height,
    stylesByColumn,
  };
}

function applyRowStyleSnapshot(ws, targetRowNumber, snapshot, startCol = 2, endCol = 7) {
  const row = ws.getRow(targetRowNumber);
  row.height = snapshot && snapshot.height ? snapshot.height : row.height;
  for (let col = startCol; col <= endCol; col += 1) {
    const cell = ws.getCell(targetRowNumber, col);
    cell.style = JSON.parse(JSON.stringify((snapshot && snapshot.stylesByColumn && snapshot.stylesByColumn[col]) || {}));
  }
}

function applyWrappedCellLayout(cell, value, minHeight = 20) {
  const text = String(value || '').trim();
  if (!text) return;
  cell.alignment = Object.assign({}, cell.alignment || {}, {
    wrapText: true,
    vertical: 'middle',
  });
  const row = cell.worksheet.getRow(cell.row);
  const estimatedLines = Math.max(1, Math.ceil(text.length / 28));
  const targetHeight = Math.max(minHeight, Math.min(estimatedLines * 18, 72));
  if (!row.height || row.height < targetHeight) row.height = targetHeight;
}

function applyHeadingRowStyle(ws, targetRowNumber, startCol, endCol) {
  const dstRow = ws.getRow(targetRowNumber);
  const cell = ws.getCell(targetRowNumber, startCol);
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFEB9C' },
  };
  cell.font = Object.assign({}, cell.font || {}, {
    bold: true,
    size: 13,
    color: { argb: 'FF7F6000' },
  });
  cell.alignment = Object.assign({}, cell.alignment || {}, {
    vertical: 'middle',
    horizontal: 'left',
  });
  cell.border = {
    top: { style: 'thin', color: { argb: 'FFD6B656' } },
    bottom: { style: 'thin', color: { argb: 'FFD6B656' } },
    left: { style: 'thin', color: { argb: 'FFD6B656' } },
    right: { style: 'thin', color: { argb: 'FFD6B656' } },
  };
  if (!dstRow.height || dstRow.height < 22) dstRow.height = 22;
}

function normalizeWorksheetGrid(ws, { columnNumbers = null, rowNumbers = null } = {}) {
  if (!ws) return;
  const columns = Array.isArray(columnNumbers) && columnNumbers.length
    ? Array.from(new Set(columnNumbers.filter((value) => Number.isInteger(value) && value > 0))).sort((a, b) => a - b)
    : Array.from({ length: ws.columnCount || 0 }, (_, idx) => idx + 1);
  const rows = Array.isArray(rowNumbers) && rowNumbers.length
    ? Array.from(new Set(rowNumbers.filter((value) => Number.isInteger(value) && value > 0))).sort((a, b) => a - b)
    : Array.from({ length: ws.rowCount || 0 }, (_, idx) => idx + 1);
  if (!columns.length || !rows.length) return;

  columns.forEach((colNumber, idx) => {
    let maxLength = 0;
    rows.forEach((rowNumber) => {
      const text = String(excelCellToPreviewText(ws.getCell(rowNumber, colNumber).value) || '').trim();
      if (!text) return;
      maxLength = Math.max(maxLength, Math.min(text.length, idx === 0 ? 36 : 28));
    });
    if (!maxLength) return;
    const minWidth = idx === 0 ? 16 : 10;
    const maxWidth = idx === 0 ? 34 : 22;
    ws.getColumn(colNumber).width = Math.max(minWidth, Math.min(maxWidth, maxLength + 2));
  });

  rows.forEach((rowNumber) => {
    const row = ws.getRow(rowNumber);
    let targetHeight = 22;
    columns.forEach((colNumber) => {
      const cell = ws.getCell(rowNumber, colNumber);
      const text = String(excelCellToPreviewText(cell.value) || '').trim();
      if (!text) return;
      const existingAlignment = cell.alignment || {};
      const isNumeric = typeof cell.value === 'number' || /^-?\d+(?:\.\d+)?$/.test(text);
      const colWidth = Number(ws.getColumn(colNumber).width) || 10;
      const charsPerLine = Math.max(8, Math.floor(colWidth - 1));
      const lineCount = Math.max(1, Math.ceil(text.length / charsPerLine));
      targetHeight = Math.max(targetHeight, Math.min(54, 16 * lineCount + 4));
      cell.alignment = Object.assign({}, existingAlignment, {
        vertical: 'middle',
        horizontal: existingAlignment.horizontal || (isNumeric ? 'center' : 'left'),
        wrapText: lineCount > 1 || existingAlignment.wrapText === true,
      });
    });
    row.height = targetHeight;
  });
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
  const maxCols = rows.reduce((m, r) => Math.max(m, getExcelRowCells(r).length), 0);
  const writeCols = Math.max(6, maxCols);
  const endCol = startCol + writeCols - 1;
  const rowStyleSnapshots = {
    3: captureRowStyleSnapshot(ws, 3, startCol, endCol),
    4: captureRowStyleSnapshot(ws, 4, startCol, endCol),
    5: captureRowStyleSnapshot(ws, 5, startCol, endCol),
  };
  const clearToRow = Math.max(ws.rowCount || 0, startRow + rows.length + 200);

  for (let r = startRow; r <= clearToRow; r += 1) {
    for (let c = startCol; c <= endCol; c += 1) {
      ws.getCell(r, c).value = null;
    }
  }

  rows.forEach((row, idx) => {
    const rowCells = getExcelRowCells(row);
    const rowKind = getExcelRowKind(row, idx);
    const targetRow = startRow + idx;
    const styleSourceRow = rowKind === 'date' ? 3 : rowKind === 'header' ? 4 : 5;
    applyRowStyleSnapshot(ws, targetRow, rowStyleSnapshots[styleSourceRow], startCol, endCol);
    for (let j = 0; j < writeCols; j += 1) {
      const cell = ws.getCell(targetRow, startCol + j);
      const value = rowCells[j] ?? '';
      cell.value = value === '' ? null : value;
    }
    if (rowKind === 'heading') {
      applyHeadingRowStyle(ws, targetRow, startCol, endCol);
    }
  });

  normalizeWorksheetGrid(ws, {
    columnNumbers: Array.from({ length: writeCols }, (_, idx) => startCol + idx),
    rowNumbers: Array.from({ length: rows.length }, (_, idx) => startRow + idx),
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function rowsToPlainExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Order');
  (rows || []).forEach((row, idx) => {
    const added = ws.addRow(getExcelRowCells(row));
    if (getExcelRowKind(row, idx) === 'heading') {
      const firstCell = added.getCell(1);
      firstCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFEB9C' },
      };
      firstCell.font = Object.assign({}, firstCell.font || {}, { bold: true, size: 13, color: { argb: 'FF7F6000' } });
      firstCell.border = {
        top: { style: 'thin', color: { argb: 'FFD6B656' } },
        bottom: { style: 'thin', color: { argb: 'FFD6B656' } },
        left: { style: 'thin', color: { argb: 'FFD6B656' } },
        right: { style: 'thin', color: { argb: 'FFD6B656' } },
      };
    }
  });
  normalizeWorksheetGrid(ws);
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function excelCellToPreviewText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value.richText)) {
    return value.richText.map((part) => String((part && part.text) || '')).join('');
  }
  if (value.text != null) {
    return String(value.text);
  }
  if (value.result != null) {
    return String(value.result);
  }
  if (value.formula) {
    return `=${value.formula}`;
  }
  if (value.hyperlink) {
    return String(value.hyperlink);
  }
  return String(value);
}

async function buildExcelPreviewFromBuffer(excelBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBuffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { sheetName: 'Sheet1', rows: [] };
  }

  let maxRow = 0;
  let maxCol = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    let rowHasValue = false;
    const values = Array.isArray(row.values) ? row.values : [];
    for (let col = 1; col < values.length; col += 1) {
      const text = excelCellToPreviewText(values[col]);
      if (text !== '') {
        rowHasValue = true;
        if (col > maxCol) maxCol = col;
      }
    }
    if (rowHasValue && rowNumber > maxRow) {
      maxRow = rowNumber;
    }
  });

  const safeMaxRow = Math.min(maxRow, 300);
  const safeMaxCol = Math.min(maxCol, 40);
  const rows = [];
  for (let row = 1; row <= safeMaxRow; row += 1) {
    const outRow = [];
    for (let col = 1; col <= safeMaxCol; col += 1) {
      outRow.push(excelCellToPreviewText(worksheet.getCell(row, col).value));
    }
    rows.push(outRow);
  }

  return {
    sheetName: worksheet.name || 'Sheet1',
    rows,
  };
}

async function buildConsolidatedExcelPayload(type, category, vendorKey, splitData, requestedWeekKey = null) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const weekBase = getWeekKey();
  const mo = await getManualOpenState();
  const resolvedRequestedWeekKey = normalizeRequestedWeekKey(requestedWeekKey);
  let weekKey = resolvedRequestedWeekKey || composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
  if (!resolvedRequestedWeekKey && resolvedCategory === 'vendor_orders' && resolvedVendorKey) {
    const vendorSeq = await getVendorSeqForKey(resolvedVendorKey);
    weekKey = weekBase + '-VS' + vendorSeq;
  }
  let stores;
  if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
    // When frontend sends split/consolidated payload rows, preserve the same full store layout
    // used in preview rather than narrowing to only submitted stores.
    stores = await Store.find().sort({ id: 1 }).lean();
  } else {
    stores = await getStoresForConsolidatedWindow(type, resolvedCategory, resolvedVendorKey, weekKey, weekBase);
  }
  const itemDocs = await Item.find({ category: resolvedCategory, vendorKey: resolvedVendorKey }).lean();
  const { itemNameByCode } = buildItemDisplayMaps(itemDocs);
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
  const vendorMonitorRows =
    resolvedCategory === 'vendor_orders' && splitData && splitData.documentMode === 'monitor' && splitData.previewLayout
      ? buildVendorMonitorRowsFromPreviewLayout(splitData.previewLayout)
      : null;
  const vendorPreviewRows =
    resolvedCategory === 'vendor_orders' && splitData && splitData.documentMode !== 'monitor' && splitData.previewLayout
      ? buildVendorRowsFromPreviewLayout(splitData.previewLayout)
      : null;
  const qtyByCodeStoreId = {};
  const orderUnitByCodeStoreId = {};
  const noteByCode = {};
  if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
    splitData.rows.forEach((r) => {
      const code = r.itemCode || `XLS::${String(r.itemName || '').trim()}`;
      qtyByCodeStoreId[code] = r.qtyByStoreId || {};
      orderUnitByCodeStoreId[code] = r.orderUnitByStoreId || {};
      noteByCode[code] = typeof r.note === 'string' ? r.note.trim() : '';
    });
  } else {
    slots.forEach((slot) => {
      const order = slotOrders[slot.apna];
      if (!order || !slot.store) return;
      orderItemsToList(order.items).forEach((item) => {
        if (!qtyByCodeStoreId[item.itemCode]) qtyByCodeStoreId[item.itemCode] = {};
        if (!orderUnitByCodeStoreId[item.itemCode]) orderUnitByCodeStoreId[item.itemCode] = {};
        qtyByCodeStoreId[item.itemCode][slot.store.id] = Number(item.quantity) || 0;
        orderUnitByCodeStoreId[item.itemCode][slot.store.id] = {
          unitType: item.unitType || 'cas',
          customUnit: item.customUnit || '',
        };
        if (item.note) noteByCode[item.itemCode] = item.note;
      });
    });
  }

  // Vendor supplier attachment must include only product + total qty.
  // When preview layout exists, use it to preserve product order/headings while dropping
  // store-wise columns.
  if (resolvedCategory === 'vendor_orders' && vendorMonitorRows && vendorMonitorRows.length > 0) {
    excelRows = vendorMonitorRows;
  } else if (resolvedCategory === 'vendor_orders' && vendorPreviewRows && vendorPreviewRows.length > 0) {
    excelRows = vendorPreviewRows;
  } else if (resolvedCategory === 'vendor_orders') {
    const vendorRows = splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0
      ? splitData.rows
      : Object.entries(qtyByCodeStoreId).map(([itemCode, qtyByStore]) => ({
          itemCode,
          itemName: itemNameByCode[itemCode] || displayOrderItemCode(itemCode),
          itemUnit: '',
          total: Object.values(qtyByStore || {}).reduce((acc, v) => acc + (Number(v) || 0), 0),
          totalDisplay: formatQtySummaryByUnit(qtyByStore || {}, orderUnitByCodeStoreId[itemCode] || {}),
          orderUnitByStoreId: orderUnitByCodeStoreId[itemCode] || {},
        }));
    const vendorRowByCode = Object.fromEntries(vendorRows.map((row) => [String(row.itemCode || '').trim(), row]));
    const vendorEntries = buildCatalogOutlineEntries({
      itemDocs,
      selectedCodes: vendorRows.map((row) => row.itemCode),
      itemNameByCode,
    });
    excelRows.push(makeExcelRow([`Date: ${dateText}`, '', '', '', '', '', ''], 'date'));
    excelRows.push(makeExcelRow(['PRODUCT', 'UNIT', 'TOTAL QTY', '', '', '', ''], 'header'));
    vendorEntries.forEach((entry) => {
      if (entry.type === 'heading') {
        excelRows.push(makeExcelRow([entry.text, '', '', '', '', '', ''], 'heading'));
        return;
      }
      const sourceRow = vendorRowByCode[entry.code] || {};
      const itemUnit = String(sourceRow.itemUnit || '').trim();
      const totalDisplay = String(sourceRow.totalDisplay || '').trim() || formatQtySummaryByUnit(sourceRow.qtyByStoreId || {}, sourceRow.orderUnitByStoreId || orderUnitByCodeStoreId[entry.code] || {});
      excelRows.push(makeExcelRow([entry.itemName, itemUnit, totalDisplay, '', '', '', ''], 'data'));
    });
  // Leaves supplier exports should include only product + total qty (no store-wise columns).
  } else if (resolvedCategory === 'leaves') {
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
    excelRows.push(['PRODUCT', 'TOTAL QTY', ...slots.map(() => 'QTY'), 'NOTE']);
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

  const snapshotLines = excelRows.map((row) => getExcelRowCells(row).join(' | '));
  const finalExcelBuffer = excelBuffer || (usePlainWorkbook ? await rowsToPlainExcelBuffer(excelRows) : await rowsToExcelBuffer(excelRows));
  const supplierDisplayName = await resolveConsolidatedSupplierName({
    category: resolvedCategory,
    vendorKey: resolvedVendorKey,
    supplierName: splitData && typeof splitData === 'object' ? splitData.supplierName : '',
  });
  const excelFilename = buildConsolidatedFilename({
    supplierName: supplierDisplayName,
    dateValue: now,
  });
  return { weekKey, stores, slots, slotOrders, snapshotLines, excelBuffer: finalExcelBuffer, excelFilename };
}

async function buildStoreOrderDocumentPayload({ type, category, vendorKey, storeId, itemsObj, notesObj, dateOverride, itemNamesObj, itemDetailsObj }) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const stores = await Store.find().sort({ id: 1 }).lean();
  const itemDocs = await Item.find({ category: resolvedCategory, vendorKey: resolvedVendorKey }).lean();
  const providedItemDetails = itemDetailsObj && typeof itemDetailsObj === 'object' ? itemDetailsObj : {};
  const providedItemNames = itemNamesObj && typeof itemNamesObj === 'object' ? itemNamesObj : {};
  const { itemNameByCode, itemUnitByCode } = buildItemDisplayMaps(itemDocs, providedItemNames, providedItemDetails);
  const itemDocByCode = Object.fromEntries((itemDocs || []).map((item) => [String(item && item.code || '').trim(), item]));
  const getStoreDocumentItemName = (code) => {
    const trimmedCode = String(code || '').trim();
    const itemDoc = itemDocByCode[trimmedCode];
    if (itemDoc && String(itemDoc.name || '').trim()) return String(itemDoc.name || '').trim();
    const detail = providedItemDetails && providedItemDetails[trimmedCode] && typeof providedItemDetails[trimmedCode] === 'object'
      ? providedItemDetails[trimmedCode]
      : null;
    if (detail && String(detail.name || '').trim()) {
      const detailName = String(detail.name || '').trim();
      const detailUnit = String(detail.unit || '').trim();
      if (detailUnit) {
        const suffix = ` (${detailUnit})`;
        if (detailName.endsWith(suffix)) return detailName.slice(0, -suffix.length).trim();
      }
      return detailName;
    }
    return itemNameByCode[trimmedCode] || displayOrderItemCode(trimmedCode);
  };
  const template = await getCategoryTemplate(resolvedCategory, resolvedVendorKey);
  const hasDocxStoreTemplate = !!(template && template.kind === 'docx_vendor_form' && template.docxMap && template.originalFile && template.originalFile.base64);
  const useStandardStoreTemplate = resolvedCategory === 'vendor_orders' && !hasDocxStoreTemplate;
  const storeDoc = stores.find((st) => String(st.id || '') === String(storeId || '')) || { id: storeId, name: storeId };
  const slots = mapStoresToTemplateSlots(stores);
  const singleStoreSlots = slots.filter((slot) => slot && slot.store && String(slot.store.id || '') === String(storeId || ''));
  const documentSlots = singleStoreSlots.length > 0
    ? singleStoreSlots
    : [{ apna: storeDoc.name || storeDoc.id || storeId, city: '', store: storeDoc }];
  const now = dateOverride ? new Date(dateOverride) : new Date();
  const dateText = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
  const normalizedItems = itemsObj && typeof itemsObj === 'object' ? itemsObj : {};
  const normalizedNotes = notesObj && typeof notesObj === 'object' ? notesObj : {};
  const codes = Array.from(
    new Set([...Object.keys(normalizedItems), ...Object.keys(normalizedNotes)].filter((code) => {
      const qtyInfo = getQtyWithUnit(normalizedItems[code]);
      const note = String(normalizedNotes[code] || '').trim();
      return qtyInfo.qty > 0 || note;
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
    qtyByCodeStoreId[code] = { [storeId]: normalizedItems[code] };
    noteByCode[code] = String(normalizedNotes[code] || '').trim();
  });
  const outlineEntries = buildCatalogOutlineEntries({
    itemDocs,
    selectedCodes: codes,
    itemNameByCode,
    itemDetailsByCode: providedItemDetails,
  });
  const hasStructuredHeadings = outlineEntries.some((entry) => entry && entry.type === 'heading');

  let rows;
  let usePlainWorkbook = false;
  let excelBuffer = null;
  if (hasDocxStoreTemplate) {
    const quantitiesByCode = {};
    codes.forEach((code) => {
      const qtyInfo = getQtyWithUnit(normalizedItems[code]);
      if (qtyInfo.qty > 0) quantitiesByCode[code] = qtyInfo.formatted;
    });
    const rendered = await renderVendorDocxTemplate({
      template,
      storeName: storeDoc.name || storeDoc.id || storeId,
      dateText,
      quantitiesByCode,
    });
    const stamp = now.toISOString().slice(0, 10);
    const storeBase = safeFilenamePart(storeDoc.name || storeDoc.id || storeId);
    const vendorBase = safeFilenamePart(resolvedVendorKey || resolvedCategory || type);
    return {
      fileBuffer: rendered.buffer,
      filename: `${storeBase}_${vendorBase}_${stamp}.docx`,
      contentType: rendered.contentType,
      snapshotLines: codes.map((code) => {
        const qtyInfo = getQtyWithUnit(normalizedItems[code]);
        const note = String(normalizedNotes[code] || '').trim();
        return [storeDoc.name || storeDoc.id || storeId, code, itemNameByCode[code] || displayOrderItemCode(code), qtyInfo.formatted || '', note].join(' | ');
      }),
    };
  }
  if (!useStandardStoreTemplate && template && Array.isArray(template.itemRows) && template.itemRows.length > 0 && !hasStructuredHeadings) {
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
    const dateRow = [
      `Date: ${dateText}`,
      ...documentSlots.map((slot) => {
        if (useStandardStoreTemplate) {
          return slot && slot.store ? String(slot.store.name || slot.store.id || slot.apna) : String(slot.apna || '');
        }
        return `${slot.apna}${type}`;
      }),
      '',
    ];
    const headerRow = useStandardStoreTemplate
      ? ['PRODUCT', 'UNIT', ...documentSlots.map(() => 'QUANTITY'), 'NOTE']
      : ['PRODUCT', ...documentSlots.map(() => 'QTY'), 'NOTE'];
    rows = [
      makeExcelRow(dateRow, 'date'),
      makeExcelRow(headerRow, 'header'),
    ];
    if (useStandardStoreTemplate || hasStructuredHeadings) {
      outlineEntries.forEach((entry) => {
        if (entry.type === 'heading') {
          rows.push(makeExcelRow(useStandardStoreTemplate ? [entry.text, '', ...documentSlots.map(() => ''), ''] : [entry.text, ...documentSlots.map(() => ''), ''], 'heading'));
          return;
        }
        const qtyInfo = getQtyWithUnit(normalizedItems[entry.code]);
        const note = String(normalizedNotes[entry.code] || '').trim();
        const qtyCols = documentSlots.map((slot) => {
          if (!slot.store) return '';
          return slot.store.id === storeId && qtyInfo.qty > 0 ? qtyInfo.formatted : '';
        });
        rows.push(makeExcelRow(useStandardStoreTemplate ? [getStoreDocumentItemName(entry.code), itemUnitByCode[entry.code] || '', ...qtyCols, note] : [entry.itemName, ...qtyCols, note], 'data'));
      });
    } else {
      codes.forEach((code) => {
        const qtyValue = normalizedItems[code];
        const qtyInfo = getQtyWithUnit(qtyValue);
        const qtyDisplay = getQtyCellValue(qtyValue);
        const note = String(normalizedNotes[code] || '').trim();
        const qtyCols = documentSlots.map((slot) => {
          if (!slot.store) return '';
          return slot.store.id === storeId && qtyInfo.qty > 0 ? qtyDisplay : '';
        });
        rows.push(makeExcelRow(useStandardStoreTemplate ? [getStoreDocumentItemName(code), itemUnitByCode[code] || '', ...qtyCols, note] : [itemNameByCode[code] || displayOrderItemCode(code), ...qtyCols, note], 'data'));
      });
    }
  }

  const finalExcelBuffer = excelBuffer || (usePlainWorkbook ? await rowsToPlainExcelBuffer(rows) : await rowsToExcelBuffer(rows));
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const storeBase = safeFilenamePart(storeDoc.name || storeDoc.id || storeId);
  const vendorBase = safeFilenamePart(resolvedVendorKey || resolvedCategory || type);
  const excelFilename = `${storeBase}_${vendorBase}_${stamp}.xlsx`;
  return {
    fileBuffer: finalExcelBuffer,
    filename: excelFilename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    snapshotLines: (rows || []).map((row) => getExcelRowCells(row).join(' | ')),
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
        acc[i.itemCode] = {
          qty: Number(i.quantity) || 0,
          unitType: i.unitType || 'cas',
          customUnit: i.customUnit || '',
        };
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
    const { type, category, vendorKey, items = {}, notes = {}, status, storeId: bodyStoreId, week: bodyWeek } = req.body;
    // allow admin to specify a different store when creating/updating
    const storeId = req.user.role === 'admin' && bodyStoreId ? bodyStoreId : req.user.storeId;
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    const requestedWeekKey = normalizeRequestedWeekKey(bodyWeek);
    if (bodyWeek && !requestedWeekKey) {
      return res.status(400).json({ error: 'Invalid week key' });
    }
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

    // Guardrail: once a store has submitted a vendor order within the past 48 h, block
    // creating any new order (including drafts) under a DIFFERENT week key.
    // This prevents the UTC-day boundary from creating a fresh draft that hides the
    // already-submitted order from the admin consolidated view and unlocks the form.
    // NOTE: place this AFTER computing weekKey so we can compare week keys.

    let weekKey;
    if (req.user.role === 'admin' && requestedWeekKey) {
      weekKey = requestedWeekKey;
    } else if (resolvedCategory === 'vendor_orders' && resolvedVendorKey) {
      const vendorSeq = await getVendorSeqForKey(resolvedVendorKey);
      weekKey = weekBase + '-VS' + vendorSeq;
    } else {
      weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
    }

    if (resolvedCategory === 'vendor_orders' && resolvedVendorKey && req.user.role !== 'admin') {
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const submittedRecently = await Order.findOne({
        storeId,
        type,
        category: resolvedCategory,
        vendorKey: resolvedVendorKey,
        status: { $in: ['submitted', 'processed'] },
        $or: [
          { submittedAt: { $gte: since } },
          { createdAt: { $gte: since } },
        ],
      })
        .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
        .lean();
      // Week keys include date + VS sequence (e.g. 2026-03-30-VS12). Across UTC-day
      // boundaries, the date part can change while still being the same VS cycle.
      // In that case, keep writing to the existing submitted week so reopen/edit flows
      // continue to work. If sequence changed, it's a new cycle and should be allowed.
      if (submittedRecently && String(submittedRecently.week) !== String(weekKey)) {
        const existingWeek = String(submittedRecently.week || '').trim();
        const requestedWeek = String(weekKey || '').trim();
        const existingSeqMatch = existingWeek.match(/-VS(\d+)$/i);
        const requestedSeqMatch = requestedWeek.match(/-VS(\d+)$/i);
        const existingSeq = existingSeqMatch ? parseInt(existingSeqMatch[1], 10) : NaN;
        const requestedSeq = requestedSeqMatch ? parseInt(requestedSeqMatch[1], 10) : NaN;

        if (Number.isFinite(existingSeq) && Number.isFinite(requestedSeq)) {
          if (existingSeq === requestedSeq) {
            weekKey = existingWeek;
          }
        } else if (!existingWeek) {
          // Legacy rows may miss week. Allow write on requested week instead of
          // hard-blocking reopen flows with an unrecoverable 409.
          weekKey = requestedWeek;
        } else {
          return res.status(409).json({
            error: 'Order already submitted for this vendor. Reload the page to see your submitted order.',
            existingWeek: submittedRecently.week,
            existingStatus: submittedRecently.status,
            orderId: submittedRecently.id || null,
          });
        }
      }
    }
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

    // Return week key so frontend can recompute the correct order lookup key
    // This is critical for vendor orders where the seq might have changed between API calls
    const vendorSeqMatch = weekKey.match(/-VS(\d+)/);
    const returnedVendorSeq = resolvedCategory === 'vendor_orders' && vendorSeqMatch ? parseInt(vendorSeqMatch[1], 10) : null;
    
    if (resolvedCategory === 'vendor_orders') {
      console.log(`Vendor order created/updated: vendorKey=${resolvedVendorKey}, week=${weekKey}, seq=${returnedVendorSeq}, status=${status}`);
    }
    
    res.json({ 
      success: true, 
      orderId: order && order.id ? order.id : orderId,
      week: weekKey,
      vendorSeq: returnedVendorSeq
    });
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
    const requestedWeekKey = normalizeRequestedWeekKey(req.query.week);
    if (req.query.week && !requestedWeekKey) {
      return res.status(400).json({ error: 'Invalid week key' });
    }
    const weekBase = getWeekKey();
    const mo = await getManualOpenState();
    let weekKey = requestedWeekKey || composeWeekKeyForType(weekBase, req.params.type, mo.manualOpenOrder, mo.manualOpenSeq);
    if (!requestedWeekKey && category === 'vendor_orders' && vendorKey) {
      const vendorSeq = await getVendorSeqForKey(vendorKey);
      weekKey = weekBase + '-VS' + vendorSeq;
    }
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
    const { email, emails, supplierName, reopenedFromId, splitData, category, vendorKey, week } = req.body;
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    const requestedWeekKey = normalizeRequestedWeekKey(week);
    if (week && !requestedWeekKey) {
      return res.status(400).json({ error: 'Invalid week key' });
    }
    const recipients = normalizeRecipientEmails(email, emails);
    if (recipients.length === 0) return res.status(400).json({ error: 'At least one recipient email is required' });
    // supplierName is optional here; frontend will send when available

    const effectiveSplitData = splitData && typeof splitData === 'object'
      ? { ...splitData, supplierName: splitData.supplierName || supplierName || '' }
      : splitData;

    const { weekKey, stores, slots, slotOrders, snapshotLines, excelBuffer, excelFilename } =
      await buildConsolidatedExcelPayload(req.params.type, resolvedCategory, resolvedVendorKey, effectiveSplitData, requestedWeekKey);
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

    const finishedFlag = splitData && typeof splitData.finished === 'boolean' ? splitData.finished : true;
    const vendorOrdersOpenVendorState =
      resolvedCategory === 'vendor_orders' && finishedFlag
        ? await clearVendorOrdersOpenIfMatching(resolvedVendorKey)
        : undefined;
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
      vendorOrdersOpenVendor: vendorOrdersOpenVendorState ? vendorOrdersOpenVendorState.vendorOrdersOpenVendor : null,
      vendorOrdersOpenVendors: vendorOrdersOpenVendorState ? vendorOrdersOpenVendorState.vendorOrdersOpenVendors : undefined,
      vendorOrderConfigs: vendorOrdersOpenVendorState ? vendorOrdersOpenVendorState.vendorOrderConfigs : undefined,
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
    const { splitData, category, vendorKey, week } = req.body || {};
    const requestedWeekKey = normalizeRequestedWeekKey(week);
    if (week && !requestedWeekKey) {
      return res.status(400).json({ error: 'Invalid week key' });
    }
    const { excelBuffer, excelFilename } = await buildConsolidatedExcelPayload(
      req.params.type,
      normalizeCategory(category),
      normalizeVendorKey(category, vendorKey),
      splitData,
      requestedWeekKey
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
    const { type, category, vendorKey, items = {}, notes = {}, storeId, date, itemNames = {}, itemDetails = {} } = req.body || {};
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
      itemDetailsObj: itemDetails,
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
    const { category, vendorKey, items = {}, notes = {}, storeId, date, itemNames = {}, itemDetails = {} } = body;
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
      itemDetailsObj: itemDetails,
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
    let weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
    if (category === 'vendor_orders' && vendorKey) {
      const vendorSeq = await getVendorSeqForKey(vendorKey);
      weekKey = weekBase + '-VS' + vendorSeq;
    }
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
    const vendorOrdersOpenVendorState = await clearVendorOrdersOpenIfMatching(vendorKey);
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
      vendorOrdersOpenVendor: vendorOrdersOpenVendorState.vendorOrdersOpenVendor,
      vendorOrdersOpenVendors: vendorOrdersOpenVendorState.vendorOrdersOpenVendors,
      vendorOrderConfigs: vendorOrdersOpenVendorState.vendorOrderConfigs,
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

router.post('/consolidated-history/sheet-preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { week, type, category, vendorKey } = req.body || {};
    if (!week || !type) {
      return res.status(400).json({ error: 'week and type are required' });
    }
    const { excelBuffer } = await buildConsolidatedHistoryExcelPayload({
      week: String(week),
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
    });
    const preview = await buildExcelPreviewFromBuffer(excelBuffer);
    res.json(preview);
  } catch (err) {
    console.error('Consolidated history sheet preview error:', err);
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
    const downloadFilename = buildConsolidatedFilename({
      supplierName: doc.supplierName || doc.vendorKey || doc.category || 'Supplier',
      dateValue: doc.sentAt || doc.createdAt || new Date(),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.send(excelBuffer);
  } catch (err) {
    console.error('Download supplier order Excel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/supplier-orders/:id/excel-preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const doc = await SupplierOrder.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    if (!doc.excelBase64) return res.status(404).json({ error: 'Excel file not stored for this record' });

    const excelBuffer = Buffer.from(doc.excelBase64, 'base64');
    const preview = await buildExcelPreviewFromBuffer(excelBuffer);
    res.json({
      success: true,
      filename: buildConsolidatedFilename({
        supplierName: doc.supplierName || doc.vendorKey || doc.category || 'Supplier',
        dateValue: doc.sentAt || doc.createdAt || new Date(),
      }),
      sheetName: preview.sheetName,
      rows: preview.rows,
    });
  } catch (err) {
    console.error('Supplier order Excel preview error:', err);
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
