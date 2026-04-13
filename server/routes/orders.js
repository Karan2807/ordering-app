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
import { notifyWarehouseVendorSubmission } from '../services/warehouseNotifications.js';

const ORDER_TIMEZONE = process.env.ORDER_TIMEZONE || 'America/Los_Angeles';
const VENDOR_CURRENT_CYCLE_MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

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

function canManageWarehouseOrders(user) {
  const role = String(user && user.role || '').trim().toLowerCase();
  return role === 'admin' || role === 'warehouse';
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
const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const displayOrderItemCode = (code) => {
  let c = String(code || '').trim();
  if (c.startsWith('XLS::')) c = c.slice(5);
  // Strip :Unit suffix from item-master codes (e.g. "Bread:Case" → "Bread")
  const colonIdx = c.lastIndexOf(':');
  if (colonIdx > 0) c = c.slice(0, colonIdx).trim();
  return c || String(code || '');
};
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

function isExcelContentType(value) {
  return String(value || '').trim().toLowerCase() === EXCEL_CONTENT_TYPE;
}

function contentTypeToFileExtension(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
  if (normalized === EXCEL_CONTENT_TYPE) return '.xlsx';
  return '.bin';
}

function makeTemplateSettingKey(category, vendorKey = null, templateVariant = 'default') {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const resolvedTemplateVariant = String(templateVariant || '').trim().toLowerCase();
  return `orderTemplate:${resolvedCategory}${resolvedVendorKey ? `:${resolvedVendorKey}` : ''}${resolvedTemplateVariant !== 'default' ? `::${resolvedTemplateVariant}` : ''}`;
}

async function getCategoryTemplate(category, vendorKey = null) {
  const candidateKeys = [
    makeTemplateSettingKey(category, vendorKey, 'default'),
    makeTemplateSettingKey(category, vendorKey, 'supplier'),
    makeTemplateSettingKey(category, vendorKey, 'monitor'),
  ];
  for (const key of candidateKeys) {
    const doc = await Setting.findOne({ key }).lean();
    if (doc && doc.value) return doc.value;
  }
  return null;
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
  if (!trimmedName) return String(unit || '').trim() || '';
  // Return just the item name without appending unit — documents should
  // show clean item names matching the uploaded template.
  // Strip any existing (unit) suffix that may already be present.
  const trimmedUnit = String(unit || '').trim().toLowerCase();
  if (trimmedUnit) {
    const lower = trimmedName.toLowerCase();
    if (lower.endsWith(`(${trimmedUnit})`)) return trimmedName.slice(0, -(trimmedUnit.length + 2)).trim();
    if (lower.endsWith(`[${trimmedUnit}]`)) return trimmedName.slice(0, -(trimmedUnit.length + 2)).trim();
  }
  return trimmedName;
}

function buildItemMasterCode(name, unit) {
  const trimmedName = String(name || '').trim().replace(/\s+/g, ' ');
  const trimmedUnit = String(unit || '').trim().replace(/\s+/g, ' ');
  if (!trimmedName) return '';
  return trimmedUnit ? `${trimmedName}:${trimmedUnit}` : trimmedName;
}

function normalizeLegacyAliasUnit(value) {
  return String(value || '')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .replace(/([a-z])([0-9])/gi, '$1 $2')
    .replace(/\bpcs?\b/gi, 'pc')
    .replace(/\bpieces?\b/gi, 'pc')
    .replace(/\bcases?\b/gi, 'case')
    .replace(/\bozs?\b/gi, 'oz')
    .replace(/\bcts?\b/gi, 'ct')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCatalogAliasToken(value) {
  return normalizeLegacyAliasUnit(String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePrefix(category) {
  return normalizeCategory(category).replace(/[^a-z0-9]/g, '_').toUpperCase();
}

function extractLegacyOrderAliasCandidates(code, category, vendorKey) {
  const normalizedCode = String(code || '').trim();
  const resolvedCategory = normalizeCategory(category || 'vegetables');
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const out = [];
  if (!normalizedCode) return out;
  if (normalizedCode.startsWith('XLS::')) out.push(normalizedCode.slice(5));
  if (resolvedCategory !== 'vendor_orders' || !resolvedVendorKey) return out;
  const prefix = `${safeCodePrefix(resolvedCategory)}__${String(resolvedVendorKey).replace(/[^a-z0-9]/gi, '_').toUpperCase()}::`;
  if (!normalizedCode.toUpperCase().startsWith(prefix)) return out;
  const parts = normalizedCode.split('::').map((part) => String(part || '').trim()).filter(Boolean);
  if (parts.length < 2) return out;
  const legacyName = String(parts[1] || '').replace(/\s+/g, ' ').trim();
  const legacyUnit = normalizeLegacyAliasUnit(parts.slice(2).join(' '));
  if (legacyName) {
    out.push(legacyName);
    out.push(`XLS::${legacyName}`);
    if (legacyUnit) {
      out.push(buildItemMasterCode(legacyName, legacyUnit));
      out.push(formatItemDisplayName(legacyName, legacyUnit));
    }
  }
  return out.filter((value, index, list) => value && list.indexOf(value) === index);
}

function buildCatalogAliasCodeMap(itemDocs, category, vendorKey) {
  const resolvedCategory = normalizeCategory(category || 'vegetables');
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const aliasBuckets = {};
  (Array.isArray(itemDocs) ? itemDocs : []).forEach((item) => {
    if (normalizeCategory(item && item.category || 'vegetables') !== resolvedCategory) return;
    if (normalizeVendorKey(resolvedCategory, item && item.vendorKey) !== resolvedVendorKey) return;
    const code = String(item && item.code || '').trim();
    const name = String(item && item.name || '').trim();
    const unit = String(item && item.unit || '').trim();
    if (!code) return;
    [
      code,
      name,
      buildItemMasterCode(name, unit),
      formatItemDisplayName(name, unit),
      name ? `XLS::${name}` : '',
    ].forEach((alias) => {
      const token = normalizeCatalogAliasToken(alias);
      if (!token) return;
      if (!aliasBuckets[token]) aliasBuckets[token] = {};
      aliasBuckets[token][code] = true;
    });
  });
  return Object.keys(aliasBuckets).reduce((out, token) => {
    const codes = Object.keys(aliasBuckets[token]);
    out[token] = codes.length === 1 ? codes[0] : null;
    return out;
  }, {});
}

function buildCatalogAliasTokensByCode(itemDocs, category, vendorKey) {
  const resolvedCategory = normalizeCategory(category || 'vegetables');
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const tokensByCode = {};
  (Array.isArray(itemDocs) ? itemDocs : []).forEach((item) => {
    if (normalizeCategory(item && item.category || 'vegetables') !== resolvedCategory) return;
    if (normalizeVendorKey(resolvedCategory, item && item.vendorKey) !== resolvedVendorKey) return;
    const code = String(item && item.code || '').trim();
    const name = String(item && item.name || '').trim();
    const unit = String(item && item.unit || '').trim();
    if (!code) return;
    const tokenSet = {};
    [
      code,
      name,
      buildItemMasterCode(name, unit),
      formatItemDisplayName(name, unit),
      name ? `XLS::${name}` : '',
      displayOrderItemCode(code),
    ].forEach((alias) => {
      const token = normalizeCatalogAliasToken(alias);
      if (token) tokenSet[token] = true;
    });
    tokensByCode[code] = Object.keys(tokenSet);
  });
  return tokensByCode;
}

function resolveLooseCatalogAliasCode(candidates, itemDocs, category, vendorKey) {
  const tokensByCode = buildCatalogAliasTokensByCode(itemDocs, category, vendorKey);
  const scores = {};
  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    const candidateToken = normalizeCatalogAliasToken(candidate);
    const compactCandidate = candidateToken.replace(/\s+/g, '');
    if (compactCandidate.length < 6) return;
    Object.keys(tokensByCode).forEach((code) => {
      (tokensByCode[code] || []).forEach((aliasToken) => {
        const compactAlias = String(aliasToken || '').replace(/\s+/g, '');
        const shortLen = Math.min(compactCandidate.length, compactAlias.length);
        if (shortLen < 6) return;
        if (aliasToken === candidateToken) return;
        if (!aliasToken.includes(candidateToken) && !candidateToken.includes(aliasToken)) return;
        scores[code] = Math.max(scores[code] || 0, shortLen);
      });
    });
  });
  const ranked = Object.keys(scores).sort((a, b) => {
    if ((scores[b] || 0) !== (scores[a] || 0)) return (scores[b] || 0) - (scores[a] || 0);
    return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
  });
  if (!ranked.length) return '';
  if (ranked.length === 1) return ranked[0];
  if ((scores[ranked[0]] || 0) > (scores[ranked[1]] || 0)) return ranked[0];
  return '';
}

function resolveCanonicalOrderCode(code, itemDocs, category, vendorKey, aliasCodeMap) {
  const normalizedCode = String(code || '').trim();
  const resolvedCategory = normalizeCategory(category || 'vegetables');
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  if (!normalizedCode) return '';
  const exact = (Array.isArray(itemDocs) ? itemDocs : []).some((item) => {
    return String(item && item.code || '').trim() === normalizedCode
      && normalizeCategory(item && item.category || 'vegetables') === resolvedCategory
      && normalizeVendorKey(resolvedCategory, item && item.vendorKey) === resolvedVendorKey;
  });
  if (exact) return normalizedCode;
  const suffixTrimmed = normalizedCode.replace(/\s*\(\d+\)$/, '');
  const candidates = [
    normalizedCode,
    normalizedCode.startsWith('XLS::') ? normalizedCode.slice(5) : '',
    suffixTrimmed,
    suffixTrimmed && !suffixTrimmed.startsWith('XLS::') ? `XLS::${suffixTrimmed}` : '',
    ...extractLegacyOrderAliasCandidates(normalizedCode, resolvedCategory, resolvedVendorKey),
  ].filter((value, index, list) => value && list.indexOf(value) === index);
  for (const candidate of candidates) {
    const token = normalizeCatalogAliasToken(candidate);
    if (token && aliasCodeMap && aliasCodeMap[token]) return aliasCodeMap[token];
  }
  const looseResolvedCode = resolveLooseCatalogAliasCode(candidates, itemDocs, resolvedCategory, resolvedVendorKey);
  if (looseResolvedCode) return looseResolvedCode;
  return normalizedCode;
}

function normalizeOrderItemValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      qty: Number(value.qty != null ? value.qty : value.quantity) || 0,
      unitType: String(value.unitType || value.type || 'cas').toLowerCase(),
      customUnit: String(value.customUnit || value.otherUnit || '').trim(),
    };
  }
  return { qty: Number(value) || 0, unitType: 'cas', customUnit: '' };
}

function mergeCanonicalOrderItemValues(currentValue, nextValue) {
  const current = normalizeOrderItemValue(currentValue);
  const next = normalizeOrderItemValue(nextValue);
  const unitType = current.qty > 0 ? current.unitType : next.unitType;
  return {
    qty: current.qty + next.qty,
    unitType,
    customUnit: unitType === 'other' ? (current.customUnit || next.customUnit || '') : '',
  };
}

function mergeCanonicalOrderNotes(currentNote, nextNote) {
  const current = String(currentNote || '').trim();
  const next = String(nextNote || '').trim();
  if (!current) return next;
  if (!next) return current;
  const parts = current.split(' | ');
  if (parts.includes(next)) return current;
  return `${current} | ${next}`;
}

function orderItemsToMaps(rawItems) {
  const items = {};
  const notes = {};
  orderItemsToList(rawItems).forEach((item) => {
    const code = String(item && item.itemCode || '').trim();
    if (!code) return;
    items[code] = {
      qty: Number(item.quantity) || 0,
      unitType: item.unitType || 'cas',
      customUnit: item.customUnit || '',
    };
    if (item.note) notes[code] = String(item.note || '').trim();
  });
  return { items, notes };
}

function sanitizeOrderCodeMaps(itemMap, noteMap, itemDocs, category, vendorKey) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const sanitizedItems = {};
  const sanitizedNotes = {};
  const aliasCodeMap = buildCatalogAliasCodeMap(itemDocs, category, vendorKey);
  const knownCodes = new Set(
    (Array.isArray(itemDocs) ? itemDocs : [])
      .filter((item) => normalizeCategory(item && item.category) === resolvedCategory && normalizeVendorKey(resolvedCategory, item && item.vendorKey) === resolvedVendorKey)
      .map((item) => String(item && item.code || '').trim())
      .filter(Boolean)
  );
  Object.keys(itemMap || {}).forEach((code) => {
    const resolvedCode = resolveCanonicalOrderCode(code, itemDocs, category, vendorKey, aliasCodeMap);
    if (!resolvedCode) return;
    sanitizedItems[resolvedCode] = sanitizedItems[resolvedCode] == null
      ? itemMap[code]
      : mergeCanonicalOrderItemValues(sanitizedItems[resolvedCode], itemMap[code]);
  });
  Object.keys(noteMap || {}).forEach((code) => {
    const resolvedCode = resolveCanonicalOrderCode(code, itemDocs, category, vendorKey, aliasCodeMap);
    if (!resolvedCode) return;
    sanitizedNotes[resolvedCode] = mergeCanonicalOrderNotes(sanitizedNotes[resolvedCode], noteMap[code]);
  });
  return { items: sanitizedItems, notes: sanitizedNotes };
}

function mergeStoreQtyMaps(currentMap = {}, nextMap = {}) {
  const merged = { ...currentMap };
  Object.entries(nextMap || {}).forEach(([storeId, qty]) => {
    const safeQty = Number(qty) || 0;
    if (!safeQty) return;
    merged[storeId] = (Number(merged[storeId]) || 0) + safeQty;
  });
  return merged;
}

function mergeStoreUnitMaps(currentMap = {}, nextMap = {}) {
  const merged = { ...currentMap };
  Object.entries(nextMap || {}).forEach(([storeId, meta]) => {
    if (!meta || typeof meta !== 'object') return;
    if (!merged[storeId]) {
      merged[storeId] = { unitType: meta.unitType || 'cas', customUnit: meta.customUnit || '' };
      return;
    }
    const existing = merged[storeId] || {};
    merged[storeId] = {
      unitType: existing.unitType || meta.unitType || 'cas',
      customUnit: existing.customUnit || meta.customUnit || '',
    };
  });
  return merged;
}

function sanitizeAggregatedOrderMaps({ qtyByCodeStoreId = {}, orderUnitByCodeStoreId = {}, noteByCode = {}, itemDocs = [], category, vendorKey }) {
  const aliasCodeMap = buildCatalogAliasCodeMap(itemDocs, category, vendorKey);
  const nextQtyByCodeStoreId = {};
  const nextOrderUnitByCodeStoreId = {};
  const nextNoteByCode = {};
  const allCodes = Array.from(new Set([
    ...Object.keys(qtyByCodeStoreId || {}),
    ...Object.keys(orderUnitByCodeStoreId || {}),
    ...Object.keys(noteByCode || {}),
  ].filter(Boolean)));

  allCodes.forEach((code) => {
    const resolvedCode = resolveCanonicalOrderCode(code, itemDocs, category, vendorKey, aliasCodeMap);
    if (!resolvedCode) return;
    nextQtyByCodeStoreId[resolvedCode] = mergeStoreQtyMaps(nextQtyByCodeStoreId[resolvedCode], qtyByCodeStoreId[code] || {});
    nextOrderUnitByCodeStoreId[resolvedCode] = mergeStoreUnitMaps(nextOrderUnitByCodeStoreId[resolvedCode], orderUnitByCodeStoreId[code] || {});
    nextNoteByCode[resolvedCode] = mergeCanonicalOrderNotes(nextNoteByCode[resolvedCode], noteByCode[code]);
  });

  return {
    qtyByCodeStoreId: nextQtyByCodeStoreId,
    orderUnitByCodeStoreId: nextOrderUnitByCodeStoreId,
    noteByCode: nextNoteByCode,
    aliasCodeMap,
  };
}

function resolveDocxTemplateSourceCode(row, itemDocs, category, vendorKey, aliasCodeMap, availableCodes = {}) {
  const templateCode = String(row && row.code || '').trim();
  const rowName = String(row && row.name || '').trim();
  const candidates = [
    templateCode,
    rowName,
    rowName ? `XLS::${rowName}` : '',
    buildItemMasterCode(rowName, ''),
    ...extractLegacyOrderAliasCandidates(templateCode, category, vendorKey),
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  for (const candidate of candidates) {
    const resolved = resolveCanonicalOrderCode(candidate, itemDocs, category, vendorKey, aliasCodeMap);
    if (resolved && Object.prototype.hasOwnProperty.call(availableCodes || {}, resolved)) return resolved;
  }
  return '';
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

function cleanTemplateHeaderToken(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function inferMatrixTemplateLayout(template, itemRows = []) {
  if (!template || template.kind === 'tabular' || !Array.isArray(template.storeColumns) || !template.storeColumns.length) return null;
  const rows = Array.isArray(template.rows) ? template.rows : [];
  const sortedStoreColumns = (template.storeColumns || [])
    .filter((col) => col && Number.isInteger(col.colIndex))
    .slice()
    .sort((a, b) => a.colIndex - b.colIndex);
  if (!sortedStoreColumns.length) return null;

  const firstStoreCol = sortedStoreColumns[0].colIndex;
  const lastStoreCol = sortedStoreColumns[sortedStoreColumns.length - 1].colIndex;
  const firstItemRowIndex = (Array.isArray(itemRows) ? itemRows : [])
    .filter((row) => row && Number.isInteger(row.rowIndex))
    .reduce((min, row) => Math.min(min, row.rowIndex), Number.MAX_SAFE_INTEGER);
  const hasItemRow = firstItemRowIndex !== Number.MAX_SAFE_INTEGER;
  const baseHeaderRow = Number.isInteger(template.headerRowIndex)
    ? template.headerRowIndex
    : (hasItemRow ? Math.max(0, firstItemRowIndex - 2) : 0);
  const bandStart = Math.max(0, baseHeaderRow - 2);
  const bandEnd = hasItemRow
    ? Math.max(bandStart, firstItemRowIndex - 1)
    : Math.min(rows.length - 1, baseHeaderRow + 2);

  const cellToken = (rowIndex, colIndex) => cleanTemplateHeaderToken(rows[rowIndex] && rows[rowIndex][colIndex]);
  const columnTokensMatch = (rowIndex, colIndex, rawValue) => {
    const token = cellToken(rowIndex, colIndex);
    const expected = cleanTemplateHeaderToken(rawValue);
    if (!token || !expected) return false;
    return token === expected || token.includes(expected) || expected.includes(token);
  };

  let itemCol = null;
  for (let c = 0; c < firstStoreCol; c++) {
    for (let r = bandStart; r <= bandEnd; r++) {
      const token = cellToken(r, c);
      if (token === 'item' || token === 'items' || token === 'itemname' || token === 'product' || token === 'products' || token === 'description' || token === 'name') {
        itemCol = c;
      }
    }
  }
  if (itemCol == null) {
    const itemColCounts = new Map();
    (Array.isArray(itemRows) ? itemRows : []).forEach((row) => {
      const colIndex = row && Number.isInteger(row.colIndex) ? row.colIndex : null;
      if (colIndex == null) return;
      itemColCounts.set(colIndex, (itemColCounts.get(colIndex) || 0) + 1);
    });
    for (const [colIndex, count] of itemColCounts.entries()) {
      if (itemCol == null || count > (itemColCounts.get(itemCol) || 0)) itemCol = colIndex;
    }
  }
  if (itemCol == null) itemCol = Math.max(0, firstStoreCol - 1);

  let codeCol = null;
  for (let c = 0; c < itemCol; c++) {
    for (let r = bandStart; r <= bandEnd; r++) {
      const token = cellToken(r, c);
      if (token === 'code' || token === 'itemcode' || token === 'sku') codeCol = c;
    }
  }

  let unitCol = null;
  for (let c = itemCol + 1; c < firstStoreCol; c++) {
    for (let r = bandStart; r <= bandEnd; r++) {
      const token = cellToken(r, c);
      if (token === 'unit' || token === 'uom' || token === 'pack' || token === 'size') unitCol = c;
    }
  }
  if (unitCol == null && firstStoreCol - itemCol === 2) unitCol = itemCol + 1;

  let totalCol = null;
  let totalDistance = Number.MAX_SAFE_INTEGER;
  for (let c = Math.max(0, firstStoreCol - 4); c <= lastStoreCol + 4; c++) {
    if (c >= firstStoreCol && c <= lastStoreCol) continue;
    for (let r = bandStart; r <= bandEnd; r++) {
      const token = cellToken(r, c);
      if (token === 'total' || token === 'totalqty' || token === 'grandtotal') {
        const distance = c < firstStoreCol ? firstStoreCol - c : c - lastStoreCol;
        if (distance < totalDistance) {
          totalDistance = distance;
          totalCol = c;
        }
      }
    }
  }

  let storeHeaderRow = baseHeaderRow;
  let bestStoreScore = -1;
  for (let r = bandStart; r <= bandEnd; r++) {
    let score = 0;
    sortedStoreColumns.forEach((col) => {
      const token = cellToken(r, col.colIndex);
      if (!token) return;
      if (columnTokensMatch(r, col.colIndex, col.header) || token === cleanTemplateHeaderToken(col.slotKey)) score += 3;
      else score += 1;
    });
    if (score > bestStoreScore) {
      bestStoreScore = score;
      storeHeaderRow = r;
    }
  }

  let qtyHeaderRow = null;
  let bestQtyScore = -1;
  for (let r = storeHeaderRow; r <= bandEnd; r++) {
    let score = 0;
    sortedStoreColumns.forEach((col) => {
      const token = cellToken(r, col.colIndex);
      if (token === 'qty' || token === 'quantity') score += 1;
    });
    if (totalCol != null) {
      const token = cellToken(r, totalCol);
      if (token === 'qty' || token === 'quantity') score += 1;
    }
    if (score > bestQtyScore) {
      bestQtyScore = score;
      qtyHeaderRow = score > 0 ? r : qtyHeaderRow;
    }
  }
  if (qtyHeaderRow == null && bandEnd > storeHeaderRow) qtyHeaderRow = bandEnd;

  let itemHeaderRow = storeHeaderRow;
  for (let r = bandStart; r <= bandEnd; r++) {
    const token = cellToken(r, itemCol);
    if (token === 'item' || token === 'items' || token === 'itemname' || token === 'product' || token === 'products' || token === 'description' || token === 'name') {
      itemHeaderRow = r;
      break;
    }
  }

  return {
    itemCol,
    codeCol,
    unitCol,
    totalCol,
    firstStoreCol,
    lastStoreCol,
    firstItemRowIndex: hasItemRow ? firstItemRowIndex : null,
    storeHeaderRow,
    qtyHeaderRow,
    itemHeaderRow,
  };
}

function inferWorksheetTemplateOffset(template, ws, itemRows = []) {
  if (!template || !ws) return { rowOffset: 0, colOffset: 0 };
  const rows = Array.isArray(template.rows) ? template.rows : [];
  const matrixLayout = inferMatrixTemplateLayout(template, itemRows);
  const candidateRowIndexes = [];
  const pushCandidate = (value) => {
    if (Number.isInteger(value) && value >= 0 && candidateRowIndexes.indexOf(value) === -1) candidateRowIndexes.push(value);
  };
  pushCandidate(template.headerRowIndex);
  if (matrixLayout) {
    pushCandidate(matrixLayout.itemHeaderRow);
    pushCandidate(matrixLayout.storeHeaderRow);
    pushCandidate(matrixLayout.qtyHeaderRow);
  }
  (Array.isArray(itemRows) ? itemRows : []).slice(0, 3).forEach((row) => pushCandidate(row && row.rowIndex));
  if (!candidateRowIndexes.length) return { rowOffset: 0, colOffset: 0 };

  let bestRowOffset = 0;
  let bestColOffset = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let rowOffset = 0; rowOffset <= 3; rowOffset += 1) {
    for (let colOffset = 0; colOffset <= 5; colOffset += 1) {
      let score = 0;
      candidateRowIndexes.forEach((rowIndex) => {
        const templateRow = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
        templateRow.forEach((value, colIndex) => {
          const expected = cleanTemplateHeaderToken(value);
          if (!expected) return;
          const actual = cleanTemplateHeaderToken(workbookCellText(ws.getCell(rowIndex + 1 + rowOffset, colIndex + 1 + colOffset).value));
          if (!actual) return;
          if (actual === expected) score += 3;
          else if (actual.includes(expected) || expected.includes(actual)) score += 1;
        });
      });
      if (score > bestScore) {
        bestScore = score;
        bestRowOffset = rowOffset;
        bestColOffset = colOffset;
      }
    }
  }
  return { rowOffset: bestRowOffset, colOffset: bestColOffset };
}

function buildRowsFromCategoryTemplate({ template, dateText, slots, qtyByCodeStoreId, noteByCode, itemNameByCode, orderUnitByCodeStoreId = {} }) {
  const rows = Array.isArray(template && template.rows) ? template.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [];
  if (template && template.dateCell && template.dateCell.rowIndex != null && template.dateCell.colIndex != null) {
    ensureRowCell(rows, template.dateCell.rowIndex, template.dateCell.colIndex);
    rows[template.dateCell.rowIndex][template.dateCell.colIndex] = `${template.dateCell.prefix || ''}${dateText}`;
  }
  const slotByKey = Object.fromEntries((slots || []).map((slot) => [slot.apna, slot]));
  const singleStoreSlot = Array.isArray(slots) && slots.length === 1 ? slots[0] : null;
  const matrixLayout = inferMatrixTemplateLayout(template, template && Array.isArray(template.itemRows) ? template.itemRows : []);

  if (matrixLayout) {
    const qtyHeaderText = String(template && template.uiHeaders && template.uiHeaders.quantity || 'Qty').trim() || 'Qty';
    const itemHeaderText = String(template && template.uiHeaders && template.uiHeaders.item || 'Name').trim() || 'Name';

    rows.forEach((row, rowIndex) => {
      if (matrixLayout.codeCol != null) {
        ensureRowCell(rows, rowIndex, matrixLayout.codeCol);
        rows[rowIndex][matrixLayout.codeCol] = '';
      }
    });

    if (matrixLayout.itemHeaderRow != null && matrixLayout.itemCol != null) {
      ensureRowCell(rows, matrixLayout.itemHeaderRow, matrixLayout.itemCol);
      rows[matrixLayout.itemHeaderRow][matrixLayout.itemCol] = itemHeaderText;
    }
    if (matrixLayout.qtyHeaderRow != null) {
      (template.storeColumns || []).forEach((col) => {
        ensureRowCell(rows, matrixLayout.qtyHeaderRow, col.colIndex);
        rows[matrixLayout.qtyHeaderRow][col.colIndex] = qtyHeaderText;
      });
      if (matrixLayout.totalCol != null) {
        ensureRowCell(rows, matrixLayout.qtyHeaderRow, matrixLayout.totalCol);
        rows[matrixLayout.qtyHeaderRow][matrixLayout.totalCol] = qtyHeaderText;
      }
    }
  }

  // For single-store documents, blank ALL rows in non-selected store columns
  // and write the selected store name into the header band.
  if (singleStoreSlot) {
    const selectedCol = (template.storeColumns || []).find((c) => c.slotKey === singleStoreSlot.apna);
    const storeDisplayName = String(
      (singleStoreSlot.store && (singleStoreSlot.store.name || singleStoreSlot.store.id))
      || (selectedCol && selectedCol.header)
      || singleStoreSlot.apna
    );

    // Determine which column indices to keep vs blank.
    const storeColIndices = (template.storeColumns || []).map((c) => c.colIndex);
    const selectedColIdx = selectedCol ? selectedCol.colIndex : null;
    const firstStoreIdx = storeColIndices.length > 0 ? Math.min(...storeColIndices) : 0;
    const maxRowLen = rows.reduce((mx, r) => Math.max(mx, r.length), 0);

    // Item-name column indices (keep set)
    const itemNameIdxSet = new Set(
      (template.itemRows || []).map((ir) => ir.colIndex || 0)
    );
    // Note column (keep)
    const noteIdx = template.noteColumn && template.noteColumn.colIndex != null
      ? template.noteColumn.colIndex : null;

    // Blank every column from firstStoreIdx to end-of-row that is NOT the
    // selected store column, item-name column, or note column.
    // This covers non-selected stores AND extra columns like "Total".
    rows.forEach((row, rowIndex) => {
      for (let ci = firstStoreIdx; ci < maxRowLen; ci++) {
        if (ci === selectedColIdx) continue;
        if (itemNameIdxSet.has(ci)) continue;
        if (ci === noteIdx) continue;
        ensureRowCell(rows, rowIndex, ci);
        rows[rowIndex][ci] = '';
      }
    });

    // Write the selected store name into the header row
    if (selectedCol && template.headerRowIndex != null) {
      ensureRowCell(rows, template.headerRowIndex, selectedCol.colIndex);
      rows[template.headerRowIndex][selectedCol.colIndex] = storeDisplayName;
    }
  }
  (template && Array.isArray(template.itemRows) ? template.itemRows : []).forEach((itemRow) => {
    const code = String(itemRow.code || '').trim();
    const name = itemNameByCode[code] || itemRow.name || displayOrderItemCode(code);
    if (template.kind === 'tabular') {
      ensureRowCell(rows, itemRow.rowIndex, itemRow.colIndex || 0);
      rows[itemRow.rowIndex][itemRow.colIndex || 0] = name;
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
      const unitMeta = storeId && orderUnitByCodeStoreId[code] ? orderUnitByCodeStoreId[code][storeId] : null;
      const displayValue = unitMeta ? formatQtyValueWithUnit(getQtyNumber(qtyValue), unitMeta) : getQtyCellValue(qtyValue);
      rows[itemRow.rowIndex][col.colIndex] = displayValue == null ? '' : String(displayValue);
    });
    if (matrixLayout && matrixLayout.totalCol != null) {
      ensureRowCell(rows, itemRow.rowIndex, matrixLayout.totalCol);
      const qtyByStore = qtyByCodeStoreId[code] || {};
      const totalDisplay = Object.values(orderUnitByCodeStoreId[code] || {}).length
        ? formatQtySummaryByUnit(
            Object.fromEntries(Object.entries(qtyByStore).map(([storeId, value]) => [storeId, getQtyNumber(value)])),
            orderUnitByCodeStoreId[code] || {}
          )
        : (() => {
            const total = Object.values(qtyByStore).reduce((sum, value) => sum + getQtyNumber(value), 0);
            return total > 0 ? String(total) : '';
          })();
      rows[itemRow.rowIndex][matrixLayout.totalCol] = totalDisplay || '';
    }
  });
  return rows;
}

// Generate a styled HTML table string from an Excel buffer using ExcelJS
async function excelBufferToStyledHtml(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return null;

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // ── Theme colour resolution ──────────────────────────────────────
    const defaultTheme = ['FFFFFF','000000','EEECE1','1F497D','4F81BD','C0504D','9BBB59','8064A2','4BACC6','F79646','0000FF','800080'];
    const ejsToXmlOrder = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11]; // ExcelJS theme idx → XML tag order
    let themeColors = defaultTheme; // fallback
    try {
      const themeXml = wb.model && wb.model.themes && (wb.model.themes.theme1 || wb.model.themes['theme1']);
      if (themeXml) {
        const schemeMatch = themeXml.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
        if (schemeMatch) {
          const tags = ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
          const xmlColors = {};
          tags.forEach((tag, idx) => {
            const block = schemeMatch[1].match(new RegExp('<a:' + tag + '>([\\s\\S]*?)<\\/a:' + tag + '>'));
            if (block) {
              const last = block[1].match(/lastClr="([A-Fa-f0-9]{6})"/);
              const val = block[1].match(/val="([A-Fa-f0-9]{6})"/);
              xmlColors[idx] = (last ? last[1] : (val ? val[1] : null));
            }
          });
          themeColors = ejsToXmlOrder.map((xmlIdx, i) => xmlColors[xmlIdx] || defaultTheme[i]);
        }
      }
    } catch (_te) { /* use defaultTheme */ }

    const applyTint = (hex6, tint) => {
      let r = parseInt(hex6.substring(0, 2), 16), g = parseInt(hex6.substring(2, 4), 16), b = parseInt(hex6.substring(4, 6), 16);
      if (tint > 0) { r = Math.round(r + (255 - r) * tint); g = Math.round(g + (255 - g) * tint); b = Math.round(b + (255 - b) * tint); }
      else { const f = 1 + tint; r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f); }
      const h = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
      return h(r) + h(g) + h(b);
    };

    const resolveColor = (c) => {
      if (!c) return null;
      if (c.argb) {
        const a = String(c.argb);
        if (a.length === 8) return '#' + a.substring(2);
        if (a.length === 6) return '#' + a;
      }
      if (c.theme != null && themeColors[c.theme]) {
        let hex = themeColors[c.theme];
        if (c.tint) hex = applyTint(hex, c.tint);
        return '#' + hex;
      }
      return null;
    };

    // ── Column-letter decoder ────────────────────────────────────────
    const colLetterToNum = (letters) => {
      let n = 0;
      for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
      return n;
    };

    // ── Simple formula evaluator (SUM, recursive with memoisation) ──
    const _evalCache = new Map();
    const evalCell = (cell, depth) => {
      if ((depth || 0) > 10) return '';
      const v = cell.value;
      if (v == null) return '';
      if (typeof v !== 'object') return v;
      if (!v.formula) return v.result != null ? v.result : '';
      // Memoise by cell address
      const addr = (cell.row || 0) + '_' + (cell.col || 0);
      if (_evalCache.has(addr)) return _evalCache.get(addr);
      // Evaluate SUM(range)
      const sumRe = /^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i;
      const sumM = String(v.formula).match(sumRe);
      if (sumM) {
        const c1 = colLetterToNum(sumM[1]), r1 = parseInt(sumM[2], 10);
        const c2 = colLetterToNum(sumM[3]), r2 = parseInt(sumM[4], 10);
        let total = 0;
        for (let rr = r1; rr <= r2; rr++) {
          for (let cc = c1; cc <= c2; cc++) {
            const refCell = ws.getCell(rr, cc);
            const rv = refCell.value;
            if (typeof rv === 'number') total += rv;
            else if (rv && typeof rv === 'object') total += Number(evalCell(refCell, (depth || 0) + 1)) || 0;
          }
        }
        _evalCache.set(addr, total);
        return total;
      }
      // Fallback to cached result (even if 0)
      const fallback = v.result != null ? v.result : '';
      _evalCache.set(addr, fallback);
      return fallback;
    };

    // ── Collect merge info ───────────────────────────────────────────
    const mergeMap = {};
    const coveredCells = {};
    if (ws.model && ws.model.merges) {
      ws.model.merges.forEach(rangeStr => {
        const parts = rangeStr.split(':');
        if (parts.length !== 2) return;
        const decode = (ref) => {
          const m = ref.match(/^([A-Z]+)(\d+)$/i);
          if (!m) return null;
          return { r: parseInt(m[2], 10), c: colLetterToNum(m[1]) };
        };
        const s = decode(parts[0]);
        const e = decode(parts[1]);
        if (!s || !e) return;
        const rs = Math.min(s.r, e.r), re = Math.max(s.r, e.r);
        const cs = Math.min(s.c, e.c), ce = Math.max(s.c, e.c);
        mergeMap[rs + '_' + cs] = { rowSpan: re - rs + 1, colSpan: ce - cs + 1 };
        for (let r = rs; r <= re; r++) {
          for (let c = cs; c <= ce; c++) {
            if (r !== rs || c !== cs) coveredCells[r + '_' + c] = true;
          }
        }
      });
    }

    // ── Determine dimensions ─────────────────────────────────────────
    let maxCol = 0;
    let maxRow = 0;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > maxRow) maxRow = rowNumber;
      row.eachCell({ includeEmpty: true }, (_cell, colNumber) => {
        if (colNumber > maxCol) maxCol = colNumber;
      });
    });
    if (maxCol === 0 || maxRow === 0) return null;

    const visibleCols = [];
    for (let colNumber = 1; colNumber <= maxCol; colNumber++) {
      const column = ws.getColumn(colNumber);
      if (!column || !column.hidden) visibleCols.push(colNumber);
    }
    if (visibleCols.length === 0) return null;

    // Column widths
    const colWidths = [];
    try {
      visibleCols.forEach((colNumber, idx) => {
        const col = ws.getColumn(colNumber);
        colWidths[idx] = col ? (col.width || null) : null;
      });
    } catch (_cw) { /* some worksheets have no column model */ }

    // ── Build HTML ───────────────────────────────────────────────────
    let html = '<table style="border-collapse:collapse;table-layout:fixed">';

    // Colgroup
    html += '<colgroup>';
    for (let i = 0; i < visibleCols.length; i++) {
      const w = colWidths[i];
      html += '<col style="width:' + (w ? Math.max(30, Math.round(w * 7.5)) + 'px' : '64px') + '">';
    }
    html += '</colgroup>';

    html += '<tbody>';
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber++) {
      const row = ws.getRow(rowNumber);
      const rh = row.height;
      html += '<tr style="' + (rh ? 'height:' + Math.round(rh * 1.33) + 'px' : '') + '">';
      for (const colNumber of visibleCols) {
        const key = rowNumber + '_' + colNumber;
        if (coveredCells[key]) continue;

        const cell = row.getCell(colNumber);
        let style = 'padding:3px 5px;overflow:hidden;text-overflow:ellipsis;';

        // Font
        const f = cell.font;
        if (f) {
          if (f.bold) style += 'font-weight:700;';
          if (f.italic) style += 'font-style:italic;';
          if (f.underline) style += 'text-decoration:underline;';
          if (f.size) style += 'font-size:' + Math.min(Math.max(Math.round(f.size * 0.95), 9), 16) + 'px;';
          if (f.name) style += 'font-family:' + esc(f.name) + ',sans-serif;';
          const fc = resolveColor(f.color);
          if (fc) style += 'color:' + fc + ';';
        }
        if (!f || !f.name) style += 'font-family:Calibri,sans-serif;';
        if (!f || !f.size) style += 'font-size:11px;';

        // Fill (with white default for consistent look)
        const fl = cell.fill;
        let hasBg = false;
        if (fl && fl.type === 'pattern' && fl.fgColor) {
          const bg = resolveColor(fl.fgColor);
          if (bg) { style += 'background-color:' + bg + ';'; hasBg = true; }
        }
        if (!hasBg) style += 'background-color:#FFFFFF;';

        // Alignment
        const al = cell.alignment;
        if (al) {
          if (al.horizontal) style += 'text-align:' + al.horizontal + ';';
          if (al.vertical) style += 'vertical-align:' + (al.vertical === 'center' ? 'middle' : al.vertical) + ';';
          if (al.wrapText) style += 'white-space:pre-wrap;word-break:break-word;';
        }
        if (!al || !al.vertical) style += 'vertical-align:middle;';
        if (!al || !al.wrapText) style += 'white-space:nowrap;';

        // Borders
        const bd = cell.border;
        const bSide = (side) => {
          if (!bd || !bd[side] || !bd[side].style) return 'border-' + side + ':1px solid #D0D5DD;';
          const bw = bd[side].style === 'thick' ? '2px' : (bd[side].style === 'medium' ? '1.5px' : '1px');
          const bc = bd[side].color ? (resolveColor(bd[side].color) || '#333') : '#333';
          return 'border-' + side + ':' + bw + ' solid ' + bc + ';';
        };
        style += bSide('top') + bSide('bottom') + bSide('left') + bSide('right');

        // Value — use evalCell for formula support
        const rawVal = evalCell(cell);
        const displayVal = (rawVal != null && rawVal !== '') ? String(rawVal) : '';
        const mg = mergeMap[key];
        let attrs = 'style="' + style + '"';
        if (mg && mg.colSpan > 1) attrs += ' colspan="' + mg.colSpan + '"';
        if (mg && mg.rowSpan > 1) attrs += ' rowspan="' + mg.rowSpan + '"';

        html += '<td ' + attrs + '>' + esc(displayVal) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';

    return html;
  } catch (_e) {
    console.error('excelBufferToStyledHtml error:', _e);
    return null;
  }
}

async function buildWorkbookFromCategoryTemplate({ template, dateText, slots, qtyByCodeStoreId, noteByCode, itemNameByCode, orderUnitByCodeStoreId = {} }) {
  if (!template || !template.originalFile || !template.originalFile.base64) return null;
  const filename = String(template.originalFile.filename || '').toLowerCase();
  if (!filename.endsWith('.xlsx')) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(template.originalFile.base64, 'base64'));

  const slotByKey = Object.fromEntries((slots || []).map((slot) => [slot.apna, slot]));
  const singleStoreSlot = Array.isArray(slots) && slots.length === 1 ? slots[0] : null;

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
    const matrixLayout = inferMatrixTemplateLayout(template, sheetGroup.rows);
    const { rowOffset: worksheetRowOffset, colOffset: worksheetColumnOffset } = inferWorksheetTemplateOffset(template, ws, sheetGroup.rows);

    // Write date cell (only on first sheet)
    if (sheetGroup.sheetIndex === 0 && template.dateCell && template.dateCell.rowIndex != null && template.dateCell.colIndex != null) {
      ws.getCell(template.dateCell.rowIndex + 1 + worksheetRowOffset, template.dateCell.colIndex + 1 + worksheetColumnOffset).value = `${template.dateCell.prefix || ''}${dateText}`;
    }

    // ── Step A: Unmerge ALL merges in the worksheet so every cell is
    //    independently writable.  For single-store docs this is essential;
    //    for consolidated it's harmless because we rewrite all cells anyway.
    //    Also pre-compute column geometry needed by later steps.
    let singleStoreSelectedColNum = null;
    let singleStoreFirstStoreCol = null;
    let singleStoreMaxCol = 0;
    if (singleStoreSlot) {
      const mergeRanges = ws.model && Array.isArray(ws.model.merges) ? [...ws.model.merges] : [];
      mergeRanges.forEach((rangeStr) => {
        try { ws.unMergeCells(rangeStr); } catch (_) { /* ignore */ }
      });

      const match = (template.storeColumns || []).find((c) => c.slotKey === singleStoreSlot.apna);
      singleStoreSelectedColNum = match ? match.colIndex + 1 + worksheetColumnOffset : null;
      const storeColNums = (template.storeColumns || []).map((c) => c.colIndex + 1);
      singleStoreFirstStoreCol = storeColNums.length > 0 ? Math.min(...storeColNums) + worksheetColumnOffset : 1 + worksheetColumnOffset;
      ws.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (_cell, colNumber) => {
          if (colNumber > singleStoreMaxCol) singleStoreMaxCol = colNumber;
        });
      });

      if (matrixLayout && matrixLayout.lastStoreCol != null) {
        singleStoreFirstStoreCol = matrixLayout.firstStoreCol + 1 + worksheetColumnOffset;
        singleStoreMaxCol = Math.max(singleStoreMaxCol, (matrixLayout.totalCol != null ? matrixLayout.totalCol : matrixLayout.lastStoreCol) + 1 + worksheetColumnOffset);
      }

      // ── Step A2: Blank ALL cells in columns from firstStoreCol to
      //    maxCol — INCLUDING the selected store column.  This wipes all
      //    stale template data (old store names, formulas, leftover text)
      //    before we write fresh values in Step B.
      ws.eachRow({ includeEmpty: true }, (row) => {
        const clearStartRow = matrixLayout && matrixLayout.qtyHeaderRow != null
          ? matrixLayout.qtyHeaderRow + 2 + worksheetRowOffset
          : (matrixLayout && matrixLayout.storeHeaderRow != null ? matrixLayout.storeHeaderRow + 1 + worksheetRowOffset : 1);
        if (row.number < clearStartRow) return;
        for (let c = singleStoreFirstStoreCol; c <= singleStoreMaxCol; c++) {
          try { row.getCell(c).value = null; } catch (_) {}
        }
        if (matrixLayout && matrixLayout.totalCol != null && matrixLayout.totalCol < matrixLayout.firstStoreCol) {
          try { row.getCell(matrixLayout.totalCol + 1 + worksheetColumnOffset).value = null; } catch (_) {}
        }
      });
    }

    if (matrixLayout) {
      const hiddenColIndices = [matrixLayout.codeCol]
        .filter((colIndex) => Number.isInteger(colIndex) && colIndex >= 0);
      hiddenColIndices.forEach((colIndex) => {
        ws.eachRow({ includeEmpty: true }, (row) => {
          try { row.getCell(colIndex + 1 + worksheetColumnOffset).value = null; } catch (_) {}
        });
      });
    }

    // ── Step B: Write item data (names + quantities) ─────────────────
    sheetGroup.rows.forEach((itemRow) => {
      const code = String(itemRow.code || '').trim();
      const name = itemNameByCode[code] || itemRow.name || displayOrderItemCode(code);
      if (template.kind === 'tabular') {
        const nameCell = ws.getCell(itemRow.rowIndex + 1 + worksheetRowOffset, (itemRow.colIndex || 0) + 1 + worksheetColumnOffset);
        nameCell.value = name;
        const qtyTotal = Object.values(qtyByCodeStoreId[code] || {}).reduce((sum, value) => sum + getQtyNumber(value), 0);
        if (template.quantityColumn && template.quantityColumn.colIndex != null) {
          ws.getCell(itemRow.rowIndex + 1 + worksheetRowOffset, template.quantityColumn.colIndex + 1 + worksheetColumnOffset).value = qtyTotal > 0 ? qtyTotal : null;
        }
        if (template.noteColumn && template.noteColumn.colIndex != null) {
          ws.getCell(itemRow.rowIndex + 1 + worksheetRowOffset, template.noteColumn.colIndex + 1 + worksheetColumnOffset).value = noteByCode[code] || null;
        }
        return;
      }
      (template.storeColumns || []).forEach((col) => {
        const slot = slotByKey[col.slotKey];
        const storeId = slot && slot.store ? slot.store.id : null;
        const qtyValue = storeId && qtyByCodeStoreId[code] ? qtyByCodeStoreId[code][storeId] : null;
        const unitMeta = storeId && orderUnitByCodeStoreId[code] ? orderUnitByCodeStoreId[code][storeId] : null;
        ws.getCell(itemRow.rowIndex + 1 + worksheetRowOffset, col.colIndex + 1 + worksheetColumnOffset).value = unitMeta ? formatQtyValueWithUnit(getQtyNumber(qtyValue), unitMeta) : getQtyCellValue(qtyValue);
      });
      if (matrixLayout && matrixLayout.totalCol != null) {
        const qtyByStore = qtyByCodeStoreId[code] || {};
        const totalDisplay = Object.values(orderUnitByCodeStoreId[code] || {}).length
          ? formatQtySummaryByUnit(
              Object.fromEntries(Object.entries(qtyByStore).map(([storeId, value]) => [storeId, getQtyNumber(value)])),
              orderUnitByCodeStoreId[code] || {}
            )
          : (() => {
              const total = Object.values(qtyByStore).reduce((sum, value) => sum + getQtyNumber(value), 0);
              return total > 0 ? total : null;
            })();
        ws.getCell(itemRow.rowIndex + 1 + worksheetRowOffset, matrixLayout.totalCol + 1 + worksheetColumnOffset).value = totalDisplay || null;
      }
    });

    // ── Step C: Single-store post-write cleanup ──────────────────────
    //    Hide non-selected columns, write header labels.
    if (singleStoreSlot) {
      const selectedColNum = singleStoreSelectedColNum;
      const firstStoreCol = singleStoreFirstStoreCol;
      const maxCol = singleStoreMaxCol;

      // Remove every non-selected store/total column instead of hiding it.
      // Hidden columns produce collapsed gaps in Excel (A,B,C,L,...) which
      // makes the exported sheet look broken even when the data is correct.
      const columnsToRemove = [];
      if (matrixLayout && Number.isInteger(matrixLayout.codeCol) && matrixLayout.codeCol >= 0) {
        columnsToRemove.push(matrixLayout.codeCol + 1 + worksheetColumnOffset);
      }
      for (let c = firstStoreCol; c <= maxCol; c++) {
        if (c !== selectedColNum) columnsToRemove.push(c);
      }
      if (matrixLayout && matrixLayout.totalCol != null && matrixLayout.totalCol < matrixLayout.firstStoreCol) {
        columnsToRemove.push(matrixLayout.totalCol + 1 + worksheetColumnOffset);
      }
      columnsToRemove
        .filter((value, index, list) => list.indexOf(value) === index)
        .sort((a, b) => b - a)
        .forEach((colNumber) => {
          try { ws.spliceColumns(colNumber, 1); } catch (_) {}
        });

      const storeName = String(
        (singleStoreSlot.store && (singleStoreSlot.store.name || singleStoreSlot.store.id))
        || singleStoreSlot.apna
      );
      const removedBeforeSelected = columnsToRemove.filter((colNumber) => colNumber < selectedColNum).length;
      const shiftedSelectedColNum = selectedColNum - removedBeforeSelected;
      if (shiftedSelectedColNum > 0 && matrixLayout && matrixLayout.storeHeaderRow != null) {
        ws.getCell(matrixLayout.storeHeaderRow + 1 + worksheetRowOffset, shiftedSelectedColNum).value = storeName;
      }

      for (let colNumber = 1; colNumber <= ws.columnCount; colNumber++) {
        try {
          const column = ws.getColumn(colNumber);
          column.hidden = false;
          column.outlineLevel = 0;
        } catch (_) {}
      }
      ws.eachRow({ includeEmpty: true }, (row) => {
        try {
          row.hidden = false;
          row.outlineLevel = 0;
        } catch (_) {}
      });

      console.log('[store-doc-sanitize] selected col:', selectedColNum, '| shiftedSelectedCol:', shiftedSelectedColNum, '| removedCols:', columnsToRemove, '| storeName:', storeName);
    }
  }

  workbook.worksheets.forEach((worksheet) => {
    normalizeWorksheetForExport(worksheet);
  });

  const exportWorkbook = compactWorkbookToUsedRange(workbook);

  // Tell Excel to recalculate all formulas on open (fixes stale SUM results)
  exportWorkbook.calcProperties = Object.assign({}, exportWorkbook.calcProperties || {}, { fullCalcOnLoad: true });

  const out = Buffer.from(await exportWorkbook.xlsx.writeBuffer());
  return Buffer.from(await withWorkbookDateLabel(out, dateText));
}
async function sendEmailWithFallback({ to, subject, text, html, attachments = [], category, senderEmail }) {
  const resolvedSenderEmail = String(senderEmail || resolveSenderEmailForCategory(category) || '').trim();
  try {
    // Prefer Microsoft Graph when Graph credentials are present.
    if (process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET && resolvedSenderEmail) {
      return await sendGraphMail({ to, subject, text, html, attachments, senderEmail: resolvedSenderEmail });
    }
  } catch (graphErr) {
    console.error('Graph send failed, falling back to SMTP:', graphErr.message || graphErr);
  }

  const mailOptions = {
    from: resolvedSenderEmail || process.env.EMAIL_FROM || 'noreply@ordermanager.local',
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

function resolveSenderEmailForCategory(category) {
  const resolvedCategory = normalizeCategory(category);
  if (resolvedCategory === 'vendor_orders') {
    return String(process.env.VENDOR_SENDER_EMAIL || process.env.SENDER_EMAIL || '').trim();
  }
  return String(process.env.SENDER_EMAIL || '').trim();
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

function resolveDocumentDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date() : value;
  }
  const raw = String(value || '').trim();
  if (!raw) return new Date();
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function datePartsInTimezone(value, timeZone = ORDER_TIMEZONE) {
  const safeDate = resolveDocumentDate(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(safeDate);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') map[part.type] = part.value;
  });
  return {
    year: map.year || String(safeDate.getFullYear()),
    month: map.month || String(safeDate.getMonth() + 1).padStart(2, '0'),
    day: map.day || String(safeDate.getDate()).padStart(2, '0'),
  };
}

function workbookDateLabel(value, timeZone = ORDER_TIMEZONE) {
  const { month, day, year } = datePartsInTimezone(value, timeZone);
  return `Date: ${month}/${day}/${year}`;
}

function formatDateTokenLike(value, sampleToken, timeZone = ORDER_TIMEZONE) {
  const match = String(sampleToken || '').match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{2}|\d{4})$/);
  if (!match) return workbookDateLabel(value, timeZone).replace(/^Date:\s*/, '');
  const { month, day, year } = datePartsInTimezone(value, timeZone);
  const [, sampleMonth, separator, sampleDay, sampleYear] = match;
  const monthText = sampleMonth.length === 1 ? String(Number(month)) : month;
  const dayText = sampleDay.length === 1 ? String(Number(day)) : day;
  const yearText = sampleYear.length === 2 ? year.slice(-2) : year;
  return `${monthText}${separator}${dayText}${separator}${yearText}`;
}

function consolidatedFilenameDate(value) {
  const { year, month, day } = datePartsInTimezone(value);
  return `${year}-${month}-${day}`;
}

function workbookCellText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => String(part && part.text || '')).join('');
    if (typeof value.text === 'string') return value.text;
    if (typeof value.result === 'string' || typeof value.result === 'number') return String(value.result);
    if (typeof value.formula === 'string') return String(value.formula);
  }
  return String(value);
}

function columnLettersToNumber(value) {
  return String(value || '').toUpperCase().split('').reduce((sum, ch) => (sum * 26) + (ch.charCodeAt(0) - 64), 0);
}

function parseA1CellRef(ref) {
  const match = String(ref || '').match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return { col: columnLettersToNumber(match[1]), row: Number(match[2]) };
}

function parseA1RangeRef(ref) {
  const match = String(ref || '').match(/^([A-Z]+\d+):([A-Z]+\d+)$/i);
  if (!match) return null;
  const start = parseA1CellRef(match[1]);
  const end = parseA1CellRef(match[2]);
  if (!start || !end) return null;
  return { start, end };
}

function getWorksheetUsedRange(worksheet) {
  let maxRow = 0;
  let maxCol = 0;
  for (let rowNumber = 1; rowNumber <= (worksheet.rowCount || 0); rowNumber += 1) {
    for (let colNumber = 1; colNumber <= (worksheet.columnCount || 0); colNumber += 1) {
      const cell = worksheet.getRow(rowNumber).getCell(colNumber);
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue;
      const text = workbookCellText(cell.value).trim();
      if (!text) continue;
      if (rowNumber > maxRow) maxRow = rowNumber;
      if (colNumber > maxCol) maxCol = colNumber;
    }
  }
  const mergeRanges = worksheet.model && Array.isArray(worksheet.model.merges) ? worksheet.model.merges : [];
  mergeRanges.forEach((rangeRef) => {
    const parsed = parseA1RangeRef(rangeRef);
    if (!parsed) return;
    const master = worksheet.getCell(parsed.start.row, parsed.start.col);
    const text = workbookCellText(master.value).trim();
    if (!text) return;
    if (parsed.end.row > maxRow) maxRow = parsed.end.row;
    if (parsed.end.col > maxCol) maxCol = parsed.end.col;
  });
  return { maxRow, maxCol };
}

function autoFitWorksheetColumns(worksheet, maxRow) {
  const safeMaxRow = Math.max(1, Math.min(maxRow || worksheet.rowCount || 0, 300));
  for (let colNumber = 1; colNumber <= worksheet.columnCount; colNumber += 1) {
    const column = worksheet.getColumn(colNumber);
    let widest = 0;
    for (let rowNumber = 1; rowNumber <= safeMaxRow; rowNumber += 1) {
      const cell = worksheet.getRow(rowNumber).getCell(colNumber);
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue;
      const text = workbookCellText(cell.value).trim();
      if (!text) continue;
      widest = Math.max(widest, text.length);
    }
    if (!widest) continue;
    const paddedWidth = Math.min(Math.max(widest + 2, 8), 28);
    const currentWidth = Number(column.width) || 0;
    if (paddedWidth > currentWidth) column.width = paddedWidth;
  }
}

function isWorksheetColumnEmpty(worksheet, colNumber) {
  const mergeRanges = worksheet.model && Array.isArray(worksheet.model.merges) ? worksheet.model.merges : [];
  for (let rowNumber = 1; rowNumber <= (worksheet.rowCount || 0); rowNumber += 1) {
    const cell = worksheet.getRow(rowNumber).getCell(colNumber);
    if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue;
    const text = workbookCellText(cell.value).trim();
    if (text) return false;
  }
  for (const rangeRef of mergeRanges) {
    const parsed = parseA1RangeRef(rangeRef);
    if (!parsed) continue;
    if (colNumber < parsed.start.col || colNumber > parsed.end.col) continue;
    const master = worksheet.getCell(parsed.start.row, parsed.start.col);
    const text = workbookCellText(master.value).trim();
    if (text) return false;
  }
  return true;
}

function normalizeWorksheetForExport(worksheet) {
  if (!worksheet) return;
  const { maxRow } = getWorksheetUsedRange(worksheet);
  for (let colNumber = 1; colNumber <= worksheet.columnCount; colNumber += 1) {
    try {
      const column = worksheet.getColumn(colNumber);
      column.hidden = false;
      column.outlineLevel = 0;
    } catch (_) {}
  }
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    try {
      row.hidden = false;
      row.outlineLevel = 0;
    } catch (_) {}
  });
  let trailingColumn = worksheet.columnCount;
  while (trailingColumn > 1 && isWorksheetColumnEmpty(worksheet, trailingColumn)) {
    try { worksheet.spliceColumns(trailingColumn, 1); } catch (_) { break; }
    trailingColumn -= 1;
  }
  while (trailingColumn > 1 && isWorksheetColumnEmpty(worksheet, trailingColumn)) {
    trailingColumn -= 1;
  }
  if (Array.isArray(worksheet._columns) && worksheet._columns.length > trailingColumn) {
    worksheet._columns = worksheet._columns.slice(0, trailingColumn);
  }
  autoFitWorksheetColumns(worksheet, maxRow);
}

function cloneStyleObject(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function compactWorkbookToUsedRange(sourceWorkbook) {
  const compactWorkbook = new ExcelJS.Workbook();
  compactWorkbook.calcProperties = Object.assign({}, sourceWorkbook.calcProperties || {});
  sourceWorkbook.worksheets.forEach((sourceSheet) => {
    const { maxRow, maxCol } = getWorksheetUsedRange(sourceSheet);
    const targetSheet = compactWorkbook.addWorksheet(sourceSheet.name || 'Sheet');
    if (sourceSheet.properties) targetSheet.properties = cloneStyleObject(sourceSheet.properties);
    if (sourceSheet.pageSetup) targetSheet.pageSetup = cloneStyleObject(sourceSheet.pageSetup);
    if (sourceSheet.headerFooter) targetSheet.headerFooter = cloneStyleObject(sourceSheet.headerFooter);
    if (Array.isArray(sourceSheet.views)) targetSheet.views = cloneStyleObject(sourceSheet.views);
    targetSheet.state = sourceSheet.state;

    for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
      const sourceColumn = sourceSheet.getColumn(colNumber);
      const targetColumn = targetSheet.getColumn(colNumber);
      if (sourceColumn.width != null) targetColumn.width = sourceColumn.width;
      if (sourceColumn.style) targetColumn.style = cloneStyleObject(sourceColumn.style);
      targetColumn.hidden = false;
      targetColumn.outlineLevel = 0;
    }

    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const sourceRow = sourceSheet.getRow(rowNumber);
      const targetRow = targetSheet.getRow(rowNumber);
      if (sourceRow.height != null) targetRow.height = sourceRow.height;
      if (sourceRow.style) targetRow.style = cloneStyleObject(sourceRow.style);
      targetRow.hidden = false;
      targetRow.outlineLevel = 0;
      for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
        const sourceCell = sourceRow.getCell(colNumber);
        if (sourceCell.isMerged && sourceCell.master && sourceCell.master.address !== sourceCell.address) continue;
        const targetCell = targetRow.getCell(colNumber);
        targetCell.value = sourceCell.value;
        targetCell.style = cloneStyleObject(sourceCell.style) || {};
        if (sourceCell.numFmt) targetCell.numFmt = sourceCell.numFmt;
        if (sourceCell.alignment) targetCell.alignment = cloneStyleObject(sourceCell.alignment);
        if (sourceCell.font) targetCell.font = cloneStyleObject(sourceCell.font);
        if (sourceCell.fill) targetCell.fill = cloneStyleObject(sourceCell.fill);
        if (sourceCell.border) targetCell.border = cloneStyleObject(sourceCell.border);
        if (sourceCell.protection) targetCell.protection = cloneStyleObject(sourceCell.protection);
      }
    }

    const mergeRanges = sourceSheet.model && Array.isArray(sourceSheet.model.merges) ? sourceSheet.model.merges : [];
    mergeRanges.forEach((rangeRef) => {
      const parsed = parseA1RangeRef(rangeRef);
      if (!parsed) return;
      if (parsed.end.row > maxRow || parsed.end.col > maxCol) return;
      try { targetSheet.mergeCells(rangeRef); } catch (_) {}
    });
  });
  return compactWorkbook;
}

async function withWorkbookDateLabel(excelBuffer, dateValue) {
  if (!excelBuffer || !dateValue) return excelBuffer;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelBuffer);
    const label = workbookDateLabel(dateValue);
    const labelText = label.replace(/^Date\s*[:\-]\s*/i, '');
    workbook.worksheets.forEach((worksheet) => {
      const maxRows = Math.min(Math.max(worksheet.rowCount || 0, 6), 12);
      for (let rowNum = 1; rowNum <= maxRows; rowNum += 1) {
        const row = worksheet.getRow(rowNum);
        for (let colNum = 1; colNum <= 12; colNum += 1) {
          const cell = row.getCell(colNum);
          const text = workbookCellText(cell.value).trim();
          const match = text.match(/^(Date\s*[:\-]\s*).*/i);
          if (match) {
            const prefix = match[1].replace(/\s+$/, '');
            cell.value = `${prefix}${prefix.endsWith('-') || prefix.endsWith(':') ? ' ' : ''}${labelText}`;
            continue;
          }
          const embeddedDateMatch = text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/);
          if (embeddedDateMatch) {
            cell.value = text.replace(embeddedDateMatch[0], formatDateTokenLike(dateValue, embeddedDateMatch[0]));
          }
        }
      }
    });
    return workbook.xlsx.writeBuffer();
  } catch (_err) {
    return excelBuffer;
  }
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

function buildConsolidatedFilenameForContent({ supplierName, dateValue, contentType, fallbackFilename = '' }) {
  if (!isExcelContentType(contentType) && String(fallbackFilename || '').trim()) {
    return String(fallbackFilename || '').trim();
  }
  const baseFilename = buildConsolidatedFilename({ supplierName, dateValue });
  if (isExcelContentType(contentType)) return baseFilename;
  return baseFilename.replace(/\.xlsx$/i, contentTypeToFileExtension(contentType));
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

  // Vendor orders can land on an adjacent UTC date while still belonging to the
  // same scheduled opening. Recover only the SAME VS sequence inside a short
  // boundary window; do not pull last week's unsent order into a fresh schedule.
  if (resolvedCategory === 'vendor_orders' && resolvedVendorKey) {
    const requestedWeek = String(weekKey || '').trim();
    const seqMatch = requestedWeek.match(/-VS(\d+)$/i);
    const requestedSeq = seqMatch ? parseInt(seqMatch[1], 10) : null;
    const since = new Date(Date.now() - VENDOR_CURRENT_CYCLE_MATCH_WINDOW_MS);
    const sameSeqFilter = requestedSeq != null && !Number.isNaN(requestedSeq) ? { week: { $regex: new RegExp(`-VS${requestedSeq}$`, 'i') } } : {};
    const timeFilter = (requestedSeq != null && !Number.isNaN(requestedSeq)) 
      ? {} 
      : {
          $or: [
            { submittedAt: { $gte: since } },
            { createdAt: { $gte: since } },
          ]
        };
    
    const submittedFallback = await Order.findOne({
      storeId,
      type,
      category: resolvedCategory,
      vendorKey: resolvedVendorKey,
      status: { $in: ['submitted', 'processed', 'draft_shared'] },
      ...sameSeqFilter,
      ...timeFilter,
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
      ...timeFilter,
    })
      .sort({ submittedAt: -1, createdAt: -1, _id: -1 })
      .lean();
    if (fallback) return fallback;
  }

  return null;
}

function pluralizeUnit(label, qty) {
  if (qty <= 1) return label;
  if (label === 'Case') return 'Cases';
  if (label === 'Piece') return 'Pieces';
  if (label === 'Pallet') return 'Pallets';
  if (label === 'Master Case') return 'Master Cases';
  return label;
}

function getQtyWithUnit(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const qty = Number(value.qty) || 0;
    const unitType = String(value.unitType || 'cas').toLowerCase();
    const customUnit = String(value.customUnit || '').trim();

    let unitLabel = 'Case';
    if (unitType === 'pcs') unitLabel = 'Piece';
    else if (unitType === 'pallet') unitLabel = 'Pallet';
    else if (unitType === 'master_case') unitLabel = 'Master Case';
    else if (unitType === 'other') unitLabel = customUnit || 'Other';

    return { qty, unitLabel, formatted: `${qty} ${pluralizeUnit(unitLabel, qty)}` };
  }

  const qty = Number(value) || 0;
  return { qty, unitLabel: 'Case', formatted: `${qty} ${pluralizeUnit('Case', qty)}` };
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
  return Object.entries(totals).map(([label, qty]) => `${qty} ${pluralizeUnit(label, qty)}`).join(', ');
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

function supplierGroupKey(week, type, category, vendorKey) {
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
      sentByGroup[key] = { sentCount: 0, lastSentAt: null, sentLogs: [] };
    }
    sentByGroup[key].sentCount += 1;
    if (!sentByGroup[key].lastSentAt || new Date(log.sentAt || 0) > new Date(sentByGroup[key].lastSentAt)) {
      sentByGroup[key].lastSentAt = log.sentAt || null;
    }
    sentByGroup[key].sentLogs.push({
      _id: log._id,
      week: log.week,
      type: String(log.type || '').toUpperCase(),
      supplierName: log.supplierName || '',
      email: normalizeRecipientEmails(log.email, log.emails).join(', '),
      emails: normalizeRecipientEmails(log.email, log.emails),
      sentAt: log.sentAt || null,
      category: normalizeCategory(log.category),
      vendorKey: normalizeVendorKey(log.category, log.vendorKey),
      hasExcel: !!(log.excelBase64 || log.monitorExcelBase64),
      fileContentType: String(log.excelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE,
      monitorFileContentType: String(log.monitorExcelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE,
    });
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

    const rawOrderMaps = orderItemsToMaps(order.items);
    const relevantItems = itemDocs.filter((item) => normalizeCategory(item && item.category) === normalizedCategory && normalizeVendorKey(normalizedCategory, item && item.vendorKey) === normalizedVendorKey);
    const sanitizedOrderMaps = sanitizeOrderCodeMaps(rawOrderMaps.items, rawOrderMaps.notes, relevantItems, normalizedCategory, normalizedVendorKey);
    const normalizedItems = orderItemsToList(sanitizedOrderMaps.items)
      .map((entry) => ({
        ...entry,
        note: sanitizedOrderMaps.notes[entry.itemCode] || entry.note,
      }))
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
      const sentInfo = sentByGroup[key] || { sentCount: 0, lastSentAt: null, sentLogs: [] };
      const displayLatestAt =
        sentInfo.lastSentAt && new Date(sentInfo.lastSentAt || 0) > new Date(group.latestAt || 0)
          ? sentInfo.lastSentAt
          : group.latestAt;
      const sortedStoreOrders = (group.storeOrders || [])
        .slice()
        .sort((a, b) => String(a.storeName || '').localeCompare(String(b.storeName || '')));
      const sortedSentLogs = (sentInfo.sentLogs || [])
        .slice()
        .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
        .map((log) => ({
          ...log,
          latestAt: displayLatestAt,
        }));
      return {
        week: group.week,
        type: group.type,
        category: group.category,
        vendorKey: group.vendorKey || null,
        latestAt: displayLatestAt,
        sent: sentInfo.sentCount > 0,
        sentCount: sentInfo.sentCount,
        lastSentAt: sentInfo.lastSentAt,
        sentLogs: sortedSentLogs,
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

  // Vendor completed history should show the full monitor workbook with store
  // details, not the supplier-facing total-only attachment.
  if ((normalizedCategory === 'vendor_orders' || normalizedCategory === 'leaves') && latestSentLog && latestSentLog.monitorExcelBase64) {
    const contentType = String(latestSentLog.monitorExcelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE;
    const renderDate = new Date();
    const fileBuffer = isExcelContentType(contentType)
      ? await withWorkbookDateLabel(
          Buffer.from(latestSentLog.monitorExcelBase64, 'base64'),
          renderDate
        )
      : Buffer.from(latestSentLog.monitorExcelBase64, 'base64');
    const fileFilename = buildConsolidatedFilenameForContent({
      supplierName: latestSentLog.supplierName || latestSentLog.vendorKey || latestSentLog.category || 'Supplier',
      dateValue: renderDate,
      contentType,
      fallbackFilename: latestSentLog.monitorExcelFilename || '',
    });
    return {
      fileBuffer,
      fileFilename,
      contentType,
      excelBuffer: fileBuffer,
      excelFilename: fileFilename,
    };
  }

  // When a consolidated email was already sent, return the exact workbook that
  // was attached to the email so history matches what the supplier received.
  if (normalizedCategory !== 'vendor_orders' && normalizedCategory !== 'leaves' && latestSentLog && latestSentLog.excelBase64) {
    const supplierDisplayName = await resolveConsolidatedSupplierName({
      category: normalizedCategory,
      vendorKey: normalizedVendorKey,
      supplierName: latestSentLog.supplierName,
    });
    const contentType = String(latestSentLog.excelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE;
    const renderDate = new Date();
    const fileBuffer = isExcelContentType(contentType)
      ? await withWorkbookDateLabel(
          Buffer.from(latestSentLog.excelBase64, 'base64'),
          renderDate
        )
      : Buffer.from(latestSentLog.excelBase64, 'base64');
    const fileFilename = buildConsolidatedFilenameForContent({
      supplierName: supplierDisplayName,
      dateValue: renderDate,
      contentType,
      fallbackFilename: latestSentLog.excelFilename || '',
    });
    return {
      fileBuffer,
      fileFilename,
      contentType,
      excelBuffer: fileBuffer,
      excelFilename: fileFilename,
    };
  }

  // For not-yet-sent groups (or older records without a stored workbook),
  // generate the same consolidated template workbook the email flow would use.
  const { fileBuffer, fileFilename, contentType, excelBuffer, excelFilename } = await buildConsolidatedExcelPayload(
    normalizedType,
    normalizedCategory,
    normalizedVendorKey,
    (normalizedCategory === 'vendor_orders' || normalizedCategory === 'leaves') ? { documentMode: 'monitor' } : null,
    normalizedWeek,
    new Date()
  );
  return { fileBuffer, fileFilename, contentType, excelBuffer, excelFilename };
}

async function buildConsolidatedHistoryExcelPayloadWithDate({ week, type, category, vendorKey, dateValue }) {
  const payload = await buildConsolidatedHistoryExcelPayload({ week, type, category, vendorKey });
  if (!dateValue || !payload || !payload.fileBuffer || !isExcelContentType(payload.contentType)) return payload;
  const excelBuffer = await withWorkbookDateLabel(payload.fileBuffer, dateValue);
  return {
    ...payload,
    fileBuffer: excelBuffer,
    excelBuffer,
  };
}

function buildConsolidatedExcelRows({ type, dateText, slots, slotOrders, itemNameByCode }) {
  const rows = [];
  rows.push([`Date: ${dateText}`, '', ...slots.map((slot) => `${slot.apna}${type}`), '']);
  rows.push(['Product', 'Total Qty', ...slots.map(() => 'Qty'), 'Note']);

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
  const dateLabel = String(layout.dateLabel || workbookDateLabel()).trim();
  const itemHeader = String(layout.itemHeader || 'Product').trim() || 'Product';
  const totalHeader = String(layout.totalHeader || 'Total Qty').trim() || 'Total Qty';
  const previewRows = Array.isArray(layout.rows) ? layout.rows : [];
  if (previewRows.length < 1) return null;

  const rows = [];
  // Vendor supplier attachment keeps item, item-master unit, and grouped total qty.
  // Keep template-compatible width so style rendering remains consistent.
  rows.push(makeExcelRow([dateLabel, '', '', '', '', '', ''], 'date'));
  rows.push(makeExcelRow([itemHeader, 'Unit', totalHeader, '', '', '', ''], 'header'));

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
  const dateLabel = String(layout.dateLabel || workbookDateLabel()).trim();
  const itemHeader = String(layout.itemHeader || 'Product').trim() || 'Product';
  const totalHeader = String(layout.totalHeader || 'Total Qty').trim() || 'Total Qty';
  const slotHeaders = Array.isArray(layout.slotHeaders) ? layout.slotHeaders : [];
  const slotStoreIds = Array.isArray(layout.slotStoreIds) ? layout.slotStoreIds : [];
  const slotQtyHeaders = Array.isArray(layout.slotQtyHeaders) ? layout.slotQtyHeaders : [];
  const previewRows = Array.isArray(layout.rows) ? layout.rows : [];
  if (previewRows.length < 1) return null;

  const rows = [];
  rows.push(makeExcelRow([dateLabel, '', '', ...slotHeaders, ''], 'date'));
  rows.push(makeExcelRow([itemHeader, 'Unit', totalHeader, ...slotQtyHeaders, 'Note'], 'header'));

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

function buildVendorMonitorRows({ dateText, slots, itemDocs, itemNameByCode, qtyByCodeStoreId, orderUnitByCodeStoreId, noteByCode }) {
  const slotHeaders = (slots || []).map((slot) => {
    if (slot && slot.store && slot.store.name) return String(slot.store.name);
    if (slot && slot.store && slot.store.id) return String(slot.store.id);
    return String((slot && slot.apna) || '');
  });
  const slotStoreIds = (slots || []).map((slot) => String(slot && slot.store && slot.store.id || ''));
  const slotQtyHeaders = (slots || []).map(() => 'Qty');
  const vendorEntries = buildCatalogOutlineEntries({
    itemDocs,
    selectedCodes: Object.keys(qtyByCodeStoreId || {}),
    itemNameByCode,
  });
  const rows = [];

  rows.push(makeExcelRow([`Date: ${dateText}`, '', '', ...slotHeaders, ''], 'date'));
  rows.push(makeExcelRow(['Product', 'Unit', 'Total Qty', ...slotQtyHeaders, 'Note'], 'header'));

  vendorEntries.forEach((entry) => {
    if (entry.type === 'heading') {
      rows.push(makeExcelRow([entry.text, '', '', ...slotHeaders.map(() => ''), ''], 'heading'));
      return;
    }

    const qtyMap = qtyByCodeStoreId[entry.code] || {};
    const unitMap = orderUnitByCodeStoreId[entry.code] || {};
    const qtyCols = slotStoreIds.map((storeId) => {
      const qty = Number(qtyMap[storeId]) || 0;
      return formatQtyValueWithUnit(qty, unitMap[storeId] || { unitType: 'cas', customUnit: '' });
    });

    rows.push(makeExcelRow([
      entry.itemName,
      '',
      formatQtySummaryByUnit(qtyMap, unitMap),
      ...qtyCols,
      String((noteByCode && noteByCode[entry.code]) || '').trim(),
    ], 'data'));
  });

  return rows;
}

function formatVendorDocxMonitorValue({ slots, qtyByStoreId = {}, orderUnitByStoreId = {} }) {
  const parts = [];
  (slots || []).forEach((slot) => {
    const store = slot && slot.store ? slot.store : null;
    const storeId = String(store && store.id || '').trim();
    if (!storeId) return;
    const qty = Number(qtyByStoreId[storeId]) || 0;
    if (qty <= 0) return;
    const storeLabel = String(store && (store.name || store.id) || slot.apna || '').trim();
    const qtyLabel = formatQtyValueWithUnit(qty, orderUnitByStoreId[storeId] || { unitType: 'cas', customUnit: '' });
    if (!qtyLabel) return;
    parts.push(`${storeLabel} ${qtyLabel}`);
  });
  return parts.join('; ');
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

async function buildConsolidatedExcelPayload(type, category, vendorKey, splitData, requestedWeekKey = null, renderDateValue = null) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const requestedDocumentMode =
    splitData && typeof splitData === 'object' ? String(splitData.documentMode || '').trim().toLowerCase() : '';
  const useDetailedLeavesWorkbook = resolvedCategory === 'leaves' && requestedDocumentMode === 'monitor';
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

  const now = resolveDocumentDate(renderDateValue);
  const dateText = workbookDateLabel(now).replace(/^Date:\s*/, '');
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
  let qtyByCodeStoreId = {};
  let orderUnitByCodeStoreId = {};
  let noteByCode = {};
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
      const rawOrderMaps = orderItemsToMaps(order.items);
      const sanitizedOrderMaps = sanitizeOrderCodeMaps(rawOrderMaps.items, rawOrderMaps.notes, itemDocs, resolvedCategory, resolvedVendorKey);
      orderItemsToList(sanitizedOrderMaps.items).map((item) => ({
        ...item,
        note: sanitizedOrderMaps.notes[item.itemCode] || item.note,
      })).forEach((item) => {
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
  ({ qtyByCodeStoreId, orderUnitByCodeStoreId, noteByCode } = sanitizeAggregatedOrderMaps({
    qtyByCodeStoreId,
    orderUnitByCodeStoreId,
    noteByCode,
    itemDocs,
    category: resolvedCategory,
    vendorKey: resolvedVendorKey,
  }));
  const supplierDisplayName = await resolveConsolidatedSupplierName({
    category: resolvedCategory,
    vendorKey: resolvedVendorKey,
    supplierName: splitData && typeof splitData === 'object' ? splitData.supplierName : '',
  });
  const template = await getCategoryTemplate(resolvedCategory, resolvedVendorKey);

  // Vendor supplier attachment must include only product + total qty.
  // When preview layout exists, use it to preserve product order/headings while dropping
  // store-wise columns.
  if (
    resolvedCategory === 'vendor_orders' &&
    requestedDocumentMode !== 'monitor' &&
    template &&
    template.kind === 'docx_vendor_form' &&
    template.docxMap &&
    template.originalFile &&
    template.originalFile.base64
  ) {
    const templateItemRows = Array.isArray(template.docxMap.itemRows) ? template.docxMap.itemRows : [];
    const aliasCodeMap = buildCatalogAliasCodeMap(itemDocs, resolvedCategory, resolvedVendorKey);
    const quantitiesByCode = {};
    templateItemRows.forEach((row) => {
      const templateCode = String(row && row.code || '').trim();
      if (!templateCode) return;
      const resolvedSourceCode = resolveDocxTemplateSourceCode(row, itemDocs, resolvedCategory, resolvedVendorKey, aliasCodeMap, qtyByCodeStoreId);
      let totalDisplay = requestedDocumentMode === 'monitor'
        ? formatVendorDocxMonitorValue({
            slots,
            qtyByStoreId: qtyByCodeStoreId[resolvedSourceCode || templateCode] || {},
            orderUnitByStoreId: orderUnitByCodeStoreId[resolvedSourceCode || templateCode] || {},
          })
        : formatQtySummaryByUnit(qtyByCodeStoreId[resolvedSourceCode || templateCode] || {}, orderUnitByCodeStoreId[resolvedSourceCode || templateCode] || {});
      if (totalDisplay) quantitiesByCode[templateCode] = totalDisplay;
    });
    Object.keys(qtyByCodeStoreId).forEach((code) => {
      if (quantitiesByCode[code]) return;
      const totalDisplay = requestedDocumentMode === 'monitor'
        ? formatVendorDocxMonitorValue({
            slots,
            qtyByStoreId: qtyByCodeStoreId[code] || {},
            orderUnitByStoreId: orderUnitByCodeStoreId[code] || {},
          })
        : formatQtySummaryByUnit(qtyByCodeStoreId[code] || {}, orderUnitByCodeStoreId[code] || {});
      if (totalDisplay) quantitiesByCode[code] = totalDisplay;
    });
    const rendered = await renderVendorDocxTemplate({
      template,
      storeName: requestedDocumentMode === 'monitor'
        ? 'All Stores'
        : (supplierDisplayName || resolvedVendorKey || 'All Stores'),
      dateText,
      quantitiesByCode,
    });
    const docFilename = buildConsolidatedFilenameForContent({
      supplierName: supplierDisplayName,
      dateValue: now,
      contentType: rendered.contentType,
      fallbackFilename: rendered.filename,
    });
    const snapshotLines = Object.keys(quantitiesByCode).map((code) => [
      requestedDocumentMode === 'monitor' ? 'Detailed Monitor' : (supplierDisplayName || resolvedVendorKey || 'All Stores'),
      code,
      itemNameByCode[code] || displayOrderItemCode(code),
      quantitiesByCode[code] || '',
    ].join(' | '));
    return {
      weekKey,
      stores,
      slots,
      slotOrders,
      snapshotLines,
      fileBuffer: rendered.buffer,
      fileFilename: docFilename,
      contentType: rendered.contentType,
      excelBuffer: rendered.buffer,
      excelFilename: docFilename,
    };
  } else if (template && Array.isArray(template.itemRows) && template.itemRows.length > 0) {
    excelRows = buildRowsFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
      orderUnitByCodeStoreId,
    });
    excelBuffer = await buildWorkbookFromCategoryTemplate({
      template,
      dateText,
      slots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
      orderUnitByCodeStoreId,
    });
    usePlainWorkbook = !excelBuffer;
  } else if (resolvedCategory === 'vendor_orders' && vendorMonitorRows && vendorMonitorRows.length > 0) {
    excelRows = vendorMonitorRows;
  } else if (resolvedCategory === 'vendor_orders' && splitData && splitData.documentMode === 'monitor') {
    excelRows = buildVendorMonitorRows({
      dateText,
      slots,
      itemDocs,
      itemNameByCode,
      qtyByCodeStoreId,
      orderUnitByCodeStoreId,
      noteByCode,
    });
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
    excelRows.push(makeExcelRow(['Product', 'Unit', 'Total Qty', '', '', '', ''], 'header'));
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
  } else if (resolvedCategory === 'leaves' && !useDetailedLeavesWorkbook) {
    excelRows.push([`Date: ${dateText}`, '', '', '', '', '', '']);
    excelRows.push(['Product', 'Total Qty', '', '', '', '', '']);
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
  } else if (splitData && Array.isArray(splitData.rows) && splitData.rows.length > 0) {
    excelRows.push([`Date: ${dateText}`, '', ...slots.map((slot) => `${slot.apna}${type}`), '']);
    excelRows.push(['Product', 'Total Qty', ...slots.map(() => 'Qty'), 'Note']);
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
  const excelFilename = buildConsolidatedFilename({
    supplierName: supplierDisplayName,
    dateValue: now,
  });
  return {
    weekKey,
    stores,
    slots,
    slotOrders,
    snapshotLines,
    fileBuffer: finalExcelBuffer,
    fileFilename: excelFilename,
    contentType: EXCEL_CONTENT_TYPE,
    excelBuffer: finalExcelBuffer,
    excelFilename,
  };
}

async function buildStoreOrderDocumentPayload({ type, category, vendorKey, storeId, itemsObj, notesObj, dateOverride, itemNamesObj, itemDetailsObj }) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const supplierDisplayName = await resolveConsolidatedSupplierName({ category: resolvedCategory, vendorKey: resolvedVendorKey, supplierName: '' });
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
  const hasExcelCategoryTemplate = !!(template && Array.isArray(template.itemRows) && template.itemRows.length > 0 && template.originalFile && template.originalFile.base64);
  const useUploadedExcelStoreTemplate = hasExcelCategoryTemplate && !hasDocxStoreTemplate;
  const useStandardStoreTemplate = resolvedCategory === 'vendor_orders' && !hasDocxStoreTemplate && !useUploadedExcelStoreTemplate;
  const storeDoc = stores.find((st) => String(st.id || '') === String(storeId || '')) || { id: storeId, name: storeId };
  const mappedSlots = mapStoresToTemplateSlots(stores);
  // For individual store documents, keep only the selected store, but preserve
  // its real template slot key so quantities continue to land in the correct column.
  const singleStoreSlot = mappedSlots.find((slot) => slot && slot.store && String(slot.store.id || '') === String(storeId || ''))
    || { apna: storeDoc.name || storeDoc.id || storeId, city: '', store: storeDoc };
  const documentSlots = [singleStoreSlot];
  const now = resolveDocumentDate(dateOverride);
  const dateText = workbookDateLabel(now).replace(/^Date:\s*/, '');
  let normalizedItems = itemsObj && typeof itemsObj === 'object' ? itemsObj : {};
  let normalizedNotes = notesObj && typeof notesObj === 'object' ? notesObj : {};
  ({ items: normalizedItems, notes: normalizedNotes } = sanitizeOrderCodeMaps(
    normalizedItems,
    normalizedNotes,
    itemDocs,
    resolvedCategory,
    resolvedVendorKey
  ));
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
  const orderUnitByCodeStoreId = {};
  const noteByCode = {};
  codes.forEach((code) => {
    qtyByCodeStoreId[code] = { [storeId]: normalizedItems[code] };
    orderUnitByCodeStoreId[code] = {
      [storeId]: {
        unitType: getQtyWithUnit(normalizedItems[code]).unitLabel === 'Case'
          ? (isStructuredQtyValue(normalizedItems[code]) && normalizedItems[code].unitType ? normalizedItems[code].unitType : 'cas')
          : (isStructuredQtyValue(normalizedItems[code]) && normalizedItems[code].unitType ? normalizedItems[code].unitType : 'cas'),
        customUnit: isStructuredQtyValue(normalizedItems[code]) && normalizedItems[code].customUnit
          ? String(normalizedItems[code].customUnit || '')
          : '',
      },
    };
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
    const aliasCodeMap = buildCatalogAliasCodeMap(itemDocs, resolvedCategory, resolvedVendorKey);

    const templateItemRows =
      template.docxMap && Array.isArray(template.docxMap.itemRows)
        ? template.docxMap.itemRows
        : [];

    const quantitiesByCode = {};
    templateItemRows.forEach((row) => {
      const templateCode = String(row && row.code || '').trim();
      if (!templateCode) return;
      const resolvedSourceCode = resolveDocxTemplateSourceCode(row, itemDocs, resolvedCategory, resolvedVendorKey, aliasCodeMap, normalizedItems);

      // 1. Direct lookup: template code already matches item master code (reconciled).
      let qtyInfo = getQtyWithUnit(normalizedItems[resolvedSourceCode || templateCode]);

      if (qtyInfo.qty > 0) quantitiesByCode[templateCode] = qtyInfo.formatted;
    });

    // Also include any items stored directly under template codes (edge-case).
    codes.forEach((code) => {
      if (!quantitiesByCode[code]) {
        const qtyInfo = getQtyWithUnit(normalizedItems[code]);
        if (qtyInfo.qty > 0) quantitiesByCode[code] = qtyInfo.formatted;
      }
    });
    const rendered = await renderVendorDocxTemplate({
      template,
      storeName: storeDoc.name || storeDoc.id || storeId,
      dateText,
      quantitiesByCode,
    });
    const stamp = now.toISOString().slice(0, 10);
    const storeBase = safeFilenamePart(storeDoc.name || storeDoc.id || storeId);
    const vendorBase = safeFilenamePart(supplierDisplayName || resolvedVendorKey || resolvedCategory || type);
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
  if (useUploadedExcelStoreTemplate && template && Array.isArray(template.itemRows) && template.itemRows.length > 0) {
    rows = buildRowsFromCategoryTemplate({
      template,
      dateText,
      slots: documentSlots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
      orderUnitByCodeStoreId,
    });
    excelBuffer = await buildWorkbookFromCategoryTemplate({
      template,
      dateText,
      slots: documentSlots,
      qtyByCodeStoreId,
      noteByCode,
      itemNameByCode,
      orderUnitByCodeStoreId,
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
      ? ['Product', 'Unit', ...documentSlots.map(() => 'Quantity'), 'Note']
      : ['Product', ...documentSlots.map(() => 'Qty'), 'Note'];
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
        const qtyCols = documentSlots.map(() => qtyInfo.qty > 0 ? qtyInfo.formatted : '');
        rows.push(makeExcelRow(useStandardStoreTemplate ? [getStoreDocumentItemName(entry.code), itemUnitByCode[entry.code] || '', ...qtyCols, note] : [entry.itemName, ...qtyCols, note], 'data'));
      });
    } else {
      codes.forEach((code) => {
        const qtyValue = normalizedItems[code];
        const qtyInfo = getQtyWithUnit(qtyValue);
        const qtyDisplay = getQtyCellValue(qtyValue);
        const note = String(normalizedNotes[code] || '').trim();
        const qtyCols = documentSlots.map(() => qtyInfo.qty > 0 ? qtyDisplay : '');
        rows.push(makeExcelRow(useStandardStoreTemplate ? [getStoreDocumentItemName(code), itemUnitByCode[code] || '', ...qtyCols, note] : [itemNameByCode[code] || displayOrderItemCode(code), ...qtyCols, note], 'data'));
      });
    }
  }

  const finalExcelBuffer = excelBuffer || (usePlainWorkbook ? await rowsToPlainExcelBuffer(rows) : await rowsToExcelBuffer(rows));
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const storeBase = safeFilenamePart(storeDoc.name || storeDoc.id || storeId);
  const vendorBase = safeFilenamePart(supplierDisplayName || resolvedVendorKey || resolvedCategory || type);
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
    const storeId = canManageWarehouseOrders(req.user) ? req.query.storeId : req.user.storeId;
    const filter = {};
    if (storeId) filter.storeId = storeId;

    let orders = await Order.find(filter).sort({ submittedAt: -1, createdAt: -1 }).lean();
    const allItemDocs = await Item.find().select({ code: 1, name: 1, unit: 1, category: 1, vendorKey: 1, _id: 0 }).lean();

    const groupKeys = new Set(
      orders.map((order) => supplierGroupKey(order.week, order.type, order.category, order.vendorKey))
    );
    const supplierSentByGroup = new Map();
    if (groupKeys.size > 0) {
      const sentLogs = await SupplierOrder.find({ finished: true })
        .select({ week: 1, type: 1, category: 1, vendorKey: 1, sentAt: 1, _id: 0 })
        .lean();
      sentLogs.forEach((log) => {
        const key = supplierGroupKey(log.week, log.type, log.category, log.vendorKey);
        if (!groupKeys.has(key)) return;
        const prev = supplierSentByGroup.get(key);
        const currentSentAt = log.sentAt || null;
        if (!prev || new Date(currentSentAt || 0) > new Date(prev.sentAt || 0)) {
          supplierSentByGroup.set(key, { sent: true, sentAt: currentSentAt });
        }
      });
    }

    const result = orders.map((order) => {
      const category = normalizeCategory(order.category);
      const vendorKey = normalizeVendorKey(category, order.vendorKey);
      const rawMaps = orderItemsToMaps(order.items);
      const relevantItems = allItemDocs.filter((item) => normalizeCategory(item && item.category) === category && normalizeVendorKey(category, item && item.vendorKey) === vendorKey);
      const sanitized = sanitizeOrderCodeMaps(rawMaps.items, rawMaps.notes, relevantItems, category, vendorKey);
      return {
      ...(function() {
        const sentInfo = supplierSentByGroup.get(
          supplierGroupKey(order.week, order.type, order.category, order.vendorKey)
        ) || { sent: false, sentAt: null };
        return {
          supplierSent: !!sentInfo.sent,
          supplierSentAt: sentInfo.sentAt,
        };
      })(),
      id: order.id,
      storeId: order.storeId,
      type: order.type,
      category,
      vendorKey: vendorKey || null,
      status: order.status,
      week: order.week,
      items: orderItemsToList(sanitized.items).reduce((acc, i) => {
        acc[i.itemCode] = {
          qty: Number(i.quantity) || 0,
          unitType: i.unitType || 'cas',
          customUnit: i.customUnit || '',
        };
        return acc;
      }, {}),
      notes: Object.keys(sanitized.notes || {}).reduce((acc, code) => {
        if (sanitized.notes[code]) acc[code] = sanitized.notes[code];
        return acc;
      }, {}),
      date: order.submittedAt || order.createdAt,
      createdAt: order.createdAt,
      submittedAt: order.submittedAt || null,
      itemCount: order.items ? order.items.length : 0,
    };});

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
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    const canManageAcrossStores = canManageWarehouseOrders(req.user);
    const canManageVendorOrders = resolvedCategory === 'vendor_orders' && canManageAcrossStores;
    // allow warehouse/admin to target a specific store when managing consolidated edits
    const storeId = canManageAcrossStores && bodyStoreId ? bodyStoreId : req.user.storeId;
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
    if (canManageAcrossStores && requestedWeekKey) {
      weekKey = requestedWeekKey;
    } else if (resolvedCategory === 'vendor_orders' && resolvedVendorKey) {
      const vendorSeq = await getVendorSeqForKey(resolvedVendorKey);
      weekKey = weekBase + '-VS' + vendorSeq;
    } else {
      weekKey = composeWeekKeyForType(weekBase, type, mo.manualOpenOrder, mo.manualOpenSeq);
    }

    const existingOrder = await Order.findOne({ storeId, type, category: resolvedCategory, vendorKey: resolvedVendorKey, week: weekKey })
      .select({ status: 1, items: 1, _id: 0 })
      .lean();

    if (resolvedCategory === 'vendor_orders' && resolvedVendorKey && !canManageVendorOrders) {
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
    let normalizedItems = normalizeOrderItems(items, notes);
    if (resolvedCategory !== 'vendor_orders' && normalizedItems.length) {
      const validItemCodes = new Set(
        (await Item.find({ category: resolvedCategory, vendorKey: resolvedVendorKey })
          .select({ code: 1, _id: 0 })
          .lean())
          .map((item) => String(item && item.code || '').trim())
          .filter(Boolean)
      );
      normalizedItems = normalizedItems.filter((entry) => {
        const itemCode = String(entry && entry.itemCode || '').trim();
        if (!itemCode) return false;
        if (validItemCodes.has(itemCode)) return true;
        return !/^\d+$/.test(itemCode);
      });
    }
    if (status === 'submitted' && normalizedItems.length === 0) {
      const allowEmptySubmittedUpdate = canManageAcrossStores && !!existingOrder;
      if (allowEmptySubmittedUpdate) {
        normalizedItems = [];
      } else {
      const existingItems = Array.isArray(existingOrder && existingOrder.items) ? existingOrder.items : [];
      const existingVisibleItems = existingItems.filter((entry) => {
        return (Number(entry && entry.quantity) || 0) > 0 || String(entry && entry.note || '').trim();
      });
      if (existingVisibleItems.length > 0) {
        normalizedItems = existingVisibleItems;
      } else {
        return res.status(400).json({ error: 'Cannot submit an empty order. Add at least one quantity or note.' });
      }
      }
    }
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

    if (
      resolvedCategory === 'vendor_orders' &&
      status === 'submitted' &&
      (!existingOrder || existingOrder.status !== 'submitted')
    ) {
      try {
        await notifyWarehouseVendorSubmission({
          storeId,
          vendorKey: resolvedVendorKey,
          week: weekKey,
          submittedBy: req.user.name || req.user.username || req.user.id,
        });
      } catch (notificationErr) {
        console.error('Warehouse vendor submission notification failed:', notificationErr);
      }
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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

    const { weekKey, stores, slots, slotOrders, snapshotLines, fileBuffer, fileFilename, contentType, excelBuffer, excelFilename } =
      await buildConsolidatedExcelPayload(req.params.type, resolvedCategory, resolvedVendorKey, effectiveSplitData, requestedWeekKey);
    const monitorHistory = (resolvedCategory === 'vendor_orders' || resolvedCategory === 'leaves')
      ? await buildConsolidatedExcelPayload(
          req.params.type,
          resolvedCategory,
          resolvedVendorKey,
          effectiveSplitData && typeof effectiveSplitData === 'object'
            ? { ...effectiveSplitData, documentMode: 'monitor' }
            : { documentMode: 'monitor' },
          requestedWeekKey
        )
      : null;
    const supplierDisplayName = (supplierName || 'Supplier').trim();
    let body = 'Please find attached the consolidated order';

    await sendEmailWithFallback({
      to: recipients,
      subject: `Consolidated Order ${req.params.type} (Week ${weekKey})`,
      text: body,
      category: resolvedCategory,
      attachments: [
        {
          filename: fileFilename || excelFilename,
          content: fileBuffer || excelBuffer,
          contentType: contentType || EXCEL_CONTENT_TYPE,
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
        excelBase64: (fileBuffer || excelBuffer).toString('base64'),
        excelFilename: fileFilename || excelFilename,
        excelContentType: contentType || EXCEL_CONTENT_TYPE,
        monitorSnapshotLines: monitorHistory ? monitorHistory.snapshotLines : [],
        monitorExcelBase64: monitorHistory ? (monitorHistory.fileBuffer || monitorHistory.excelBuffer).toString('base64') : null,
        monitorExcelFilename: monitorHistory ? (monitorHistory.fileFilename || monitorHistory.excelFilename) : null,
        monitorExcelContentType: monitorHistory ? (monitorHistory.contentType || EXCEL_CONTENT_TYPE) : EXCEL_CONTENT_TYPE,
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const { splitData, category, vendorKey, week } = req.body || {};
    const requestedWeekKey = normalizeRequestedWeekKey(week);
    if (week && !requestedWeekKey) {
      return res.status(400).json({ error: 'Invalid week key' });
    }
    const { fileBuffer, fileFilename, contentType, excelBuffer, excelFilename } = await buildConsolidatedExcelPayload(
      req.params.type,
      normalizeCategory(category),
      normalizeVendorKey(category, vendorKey),
      splitData,
      requestedWeekKey
    );
    const buf = fileBuffer || excelBuffer;
    const ct = contentType || EXCEL_CONTENT_TYPE;
    let previewHtml = null;
    if (isExcelContentType(ct)) {
      try { previewHtml = await excelBufferToStyledHtml(buf); } catch (_e) { console.error('excelBufferToStyledHtml err:', _e); }
    }
    res.json({
      success: true,
      filename: fileFilename || excelFilename,
      contentType: ct,
      fileBase64: buf.toString('base64'),
      excelBase64: isExcelContentType(ct) ? buf.toString('base64') : null,
      previewHtml,
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
    const resolvedStoreId = canManageWarehouseOrders(req.user) && storeId ? String(storeId) : String(req.user.storeId || '');
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

    let previewHtml = null;
    if (isExcelContentType(contentType)) {
      try { previewHtml = await excelBufferToStyledHtml(fileBuffer); } catch (_e) { /* ignore */ }
    }
    res.json({
      success: true,
      filename,
      contentType,
      fileBase64: fileBuffer.toString('base64'),
      excelBase64: contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? fileBuffer.toString('base64') : null,
      previewHtml,
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
    const resolvedStoreId = canManageWarehouseOrders(req.user) && storeId ? String(storeId) : String(req.user.storeId || '');
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

    let previewHtml = null;
    if (isExcelContentType(contentType)) {
      try { previewHtml = await excelBufferToStyledHtml(fileBuffer); } catch (_e) { /* ignore */ }
    }
    res.json({
      success: true,
      filename,
      contentType,
      fileBase64: fileBuffer.toString('base64'),
      excelBase64: contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? fileBuffer.toString('base64') : null,
      previewHtml,
    });
  } catch (err) {
    console.error('Store order Excel preview alias error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/vendor-orders/:vendorKey/email-individual', authMiddleware, async (req, res) => {
  try {
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
        if (line.unitType && line.unitType !== 'cas') {
          itemsObj[line.itemCode] = { qty: Number(line.quantity) || 0, unitType: line.unitType, customUnit: line.customUnit || '' };
        } else {
          itemsObj[line.itemCode] = Number(line.quantity) || 0;
        }
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
        dateOverride: new Date(),
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
      category,
      attachments,
    });

    let supplierOrder = null;
    const vendorOrdersOpenVendorState = await clearVendorOrdersOpenIfMatching(vendorKey);
    const resolvedSupplierName = await resolveConsolidatedSupplierName({ category, vendorKey, supplierName: '' });
    try {
      supplierOrder = await SupplierOrder.create({
        supplierName: resolvedSupplierName,
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const { week, type, category, vendorKey, dateValue } = req.body || {};
    if (!week || !type) {
      return res.status(400).json({ error: 'week and type are required' });
    }
    const { fileBuffer, fileFilename, contentType, excelBuffer, excelFilename } = await buildConsolidatedHistoryExcelPayload({
      week: String(week),
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
    }).then((payload) => {
      if (!dateValue) return payload;
      return buildConsolidatedHistoryExcelPayloadWithDate({
        week: String(week),
        type: String(type),
        category: normalizeCategory(category),
        vendorKey: normalizeVendorKey(category, vendorKey),
        dateValue,
      });
    });
    res.json({
      success: true,
      filename: fileFilename || excelFilename,
      contentType: contentType || EXCEL_CONTENT_TYPE,
      fileBase64: (fileBuffer || excelBuffer).toString('base64'),
      excelBase64: isExcelContentType(contentType || EXCEL_CONTENT_TYPE) ? (fileBuffer || excelBuffer).toString('base64') : null,
    });
  } catch (err) {
    console.error('Consolidated history Excel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/consolidated-history/sheet-preview', authMiddleware, async (req, res) => {
  try {
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const { week, type, category, vendorKey, dateValue } = req.body || {};
    if (!week || !type) {
      return res.status(400).json({ error: 'week and type are required' });
    }
    const { contentType, excelBuffer } = await buildConsolidatedHistoryExcelPayload({
      week: String(week),
      type: String(type),
      category: normalizeCategory(category),
      vendorKey: normalizeVendorKey(category, vendorKey),
    }).then((payload) => {
      if (!dateValue) return payload;
      return buildConsolidatedHistoryExcelPayloadWithDate({
        week: String(week),
        type: String(type),
        category: normalizeCategory(category),
        vendorKey: normalizeVendorKey(category, vendorKey),
        dateValue,
      });
    });
    if (!isExcelContentType(contentType || EXCEL_CONTENT_TYPE)) {
      return res.status(400).json({ error: 'Sheet preview is only available for Excel documents' });
    }
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const list = await SupplierOrder.find().sort({ sentAt: -1 }).lean();
    res.json(
      list.map(({ excelBase64, monitorExcelBase64, ...row }) => {
        const emails = normalizeRecipientEmails(row.email, row.emails);
        return {
          ...row,
          email: emails.join(', '),
          emails,
          category: normalizeCategory(row.category),
          vendorKey: row.vendorKey || null,
          hasExcel: !!excelBase64,
          fileContentType: String(row.excelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE,
          monitorFileContentType: String(row.monitorExcelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE,
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const doc = await SupplierOrder.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    const requestedDateValue = String(req.query && req.query.dateValue || '').trim() || null;
    const normalizedCategory = normalizeCategory(doc.category);
    let fileBuffer = null;
    let contentType = EXCEL_CONTENT_TYPE;
    if (normalizedCategory === 'leaves') {
      const detailedHistory = await buildConsolidatedHistoryExcelPayload({
        week: doc.week,
        type: doc.type,
        category: normalizedCategory,
        vendorKey: doc.vendorKey,
      });
      fileBuffer = detailedHistory && (detailedHistory.fileBuffer || detailedHistory.excelBuffer)
        ? (detailedHistory.fileBuffer || detailedHistory.excelBuffer)
        : null;
      contentType = detailedHistory && detailedHistory.contentType ? detailedHistory.contentType : EXCEL_CONTENT_TYPE;
    } else {
      const storedExcelBase64 = doc.excelBase64;
      if (storedExcelBase64) {
        contentType = String(doc.excelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE;
        const renderDate = requestedDateValue || new Date();
        fileBuffer = isExcelContentType(contentType)
          ? await withWorkbookDateLabel(
              Buffer.from(storedExcelBase64, 'base64'),
              renderDate
            )
          : Buffer.from(storedExcelBase64, 'base64');
      }
    }
    if (!fileBuffer) return res.status(404).json({ error: 'Document not stored for this record' });
    if (normalizedCategory === 'leaves' && requestedDateValue && isExcelContentType(contentType)) {
      fileBuffer = await withWorkbookDateLabel(fileBuffer, requestedDateValue);
    }
    const downloadFilename = buildConsolidatedFilenameForContent({
      supplierName: doc.supplierName || doc.vendorKey || doc.category || 'Supplier',
      dateValue: requestedDateValue || new Date(),
      contentType,
      fallbackFilename: doc.excelFilename || '',
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.send(fileBuffer);
  } catch (err) {
    console.error('Download supplier order Excel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/supplier-orders/:id/excel-preview', authMiddleware, async (req, res) => {
  try {
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const doc = await SupplierOrder.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Supplier order not found' });
    const requestedDateValue = String(req.query && req.query.dateValue || '').trim() || null;
    const normalizedCategory = normalizeCategory(doc.category);
    let excelBuffer = null;
    let contentType = EXCEL_CONTENT_TYPE;
    if (normalizedCategory === 'leaves') {
      const detailedHistory = await buildConsolidatedHistoryExcelPayload({
        week: doc.week,
        type: doc.type,
        category: normalizedCategory,
        vendorKey: doc.vendorKey,
      });
      excelBuffer = detailedHistory && detailedHistory.excelBuffer ? detailedHistory.excelBuffer : null;
      contentType = detailedHistory && detailedHistory.contentType ? detailedHistory.contentType : EXCEL_CONTENT_TYPE;
    } else if (doc.excelBase64) {
      contentType = String(doc.excelContentType || EXCEL_CONTENT_TYPE).trim() || EXCEL_CONTENT_TYPE;
      if (isExcelContentType(contentType)) {
        const renderDate = requestedDateValue || new Date();
        excelBuffer = await withWorkbookDateLabel(
          Buffer.from(doc.excelBase64, 'base64'),
          renderDate
        );
      }
    }
    if (!excelBuffer && doc.excelBase64 && !isExcelContentType(contentType)) {
      return res.json({
        success: true,
        filename: buildConsolidatedFilenameForContent({
          supplierName: doc.supplierName || doc.vendorKey || doc.category || 'Supplier',
          dateValue: requestedDateValue || new Date(),
          contentType,
          fallbackFilename: doc.excelFilename || '',
        }),
        contentType,
        fileBase64: doc.excelBase64,
      });
    }
    if (!excelBuffer) return res.status(404).json({ error: 'Excel file not stored for this record' });
    if (normalizedCategory === 'leaves' && requestedDateValue) {
      excelBuffer = await withWorkbookDateLabel(excelBuffer, requestedDateValue);
    }

    const preview = await buildExcelPreviewFromBuffer(excelBuffer);
    res.json({
      success: true,
      filename: buildConsolidatedFilename({
        supplierName: doc.supplierName || doc.vendorKey || doc.category || 'Supplier',
        dateValue: requestedDateValue || new Date(),
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
    if (!canManageWarehouseOrders(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
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
