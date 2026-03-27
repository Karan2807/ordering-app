import express from 'express';
import { authMiddleware } from '../auth.js';
import Setting from '../models/setting.js';
import Supplier from '../models/supplier.js';
import { parseVendorDocxTemplate } from '../services/vendorDocxTemplate.js';

const router = express.Router();
const ORDER_TIMEZONE = process.env.ORDER_TIMEZONE || 'America/Los_Angeles';

function nowInTimezone(tz) {
  const text = new Date().toLocaleString('en-US', { timeZone: tz });
  return new Date(text);
}

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

function parseOptionalTimestamp(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isDayWithinRange(day, startDay, endDay) {
  if (startDay == null || endDay == null) return false;
  if (startDay <= endDay) return day >= startDay && day <= endDay;
  return day >= startDay || day <= endDay;
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
    const temporaryOpenUntil = parseOptionalTimestamp(raw.temporaryOpenUntil);
    const temporaryOpenCreatedAt = parseOptionalTimestamp(raw.temporaryOpenCreatedAt);
    const temporaryOpenOnly = raw.temporaryOpenOnly === true || raw.temporaryOpenOnly === 'true' || raw.temporaryOpenOnly === 1 || raw.temporaryOpenOnly === '1';
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
      temporaryOpenUntil,
      temporaryOpenCreatedAt,
      temporaryOpenOnly,
      seq: rawSeq > 0 ? rawSeq : 1,
    });
  });
  return Array.from(byVendorKey.values());
}

async function clearLegacyVendorOrderSettings() {
  await Setting.deleteMany({
    key: { $in: ['vendorOrdersOpenVendor', 'vendorOrdersOpenVendors', 'vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'] },
  });
}

function isVendorConfigActive(config, now, today) {
  if (!config || config.enabled === false) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const tempUntilMs = config.temporaryOpenUntil ? new Date(config.temporaryOpenUntil).getTime() : NaN;
  const tempActive = Number.isFinite(tempUntilMs) && tempUntilMs > nowMs;
  if (config.temporaryOpenOnly) return tempActive;
  if (tempActive) return true;
  return isDayWithinRange(today, config.startDay, config.endDay);
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
    await Setting.updateOne({ key: 'vendorOrdersOpenVendor' }, { value: vendorKeys[0] }, { upsert: true });
    await Setting.updateOne({ key: 'vendorOrdersOpenVendors' }, { value: vendorKeys }, { upsert: true });
  } else {
    await Setting.deleteMany({ key: { $in: ['vendorOrdersOpenVendor', 'vendorOrdersOpenVendors'] } });
  }
  await Setting.deleteMany({ key: { $in: ['vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'] } });
  return normalizedConfigs;
}

function buildVendorOrdersState({ docs, today, now }) {
  let vendorOrderConfigs = [];

  (docs || []).forEach((row) => {
    if (!row) return;
    if (row.key === 'vendorOrderConfigs') {
      vendorOrderConfigs = normalizeVendorOrderConfigs(row.value);
    }
  });

  const configuredVendorConfigs = vendorOrderConfigs.filter((config) => config.enabled !== false);
  const configuredVendorKeys = normalizeVendorKeys(configuredVendorConfigs.map((config) => config.vendorKey));
  const activeVendorOrders = configuredVendorConfigs
    .filter((config) => isVendorConfigActive(config, now, today))
    .map((config) => config.vendorKey);
  const windowOpen = activeVendorOrders.length > 0;
  return {
    vendorOrderConfigs,
    vendorOrdersOpenVendors: activeVendorOrders,
    vendorOrdersConfiguredVendors: configuredVendorKeys,
    vendorOrdersOpenVendor: activeVendorOrders[0] || null,
    vendorOrdersWindowStartDay: null,
    vendorOrdersWindowEndDay: null,
    vendorOrdersWindowOpen: windowOpen,
    activeVendorOrders,
  };
}

async function getSupplierIdSet() {
  const suppliers = await Supplier.find().select({ id: 1, _id: 0 }).lean();
  return new Set(
    (suppliers || [])
      .map((supplier) => String(supplier && supplier.id || '').trim())
      .filter(Boolean)
  );
}

function filterVendorConfigsBySuppliers(configs, supplierIdSet) {
  const allowed = supplierIdSet instanceof Set ? supplierIdSet : new Set();
  return normalizeVendorOrderConfigs(configs).filter((config) => allowed.has(String(config.vendorKey || '').trim()));
}

// Get all settings
router.get('/', async (req, res) => {
  try {
    const docs = await Setting.find().lean();
    const schedules = {};
    const messages = {};
    const categoryTemplates = {};
    let logoValue = null;
    let manualOpen = null;
    let manualOpenSeq = null;
    let manualOpenLeaves = false;
    const today = nowInTimezone(ORDER_TIMEZONE).getDay();
    const now = nowInTimezone(ORDER_TIMEZONE);

    for (const row of docs) {
      if (row.key.startsWith('schedule')) {
        const num = parseInt(row.value);
        schedules[row.key.replace('schedule', '')] = Number.isNaN(num) ? null : num;
      } else if (row.key.startsWith('message')) {
        messages[row.key.replace('message', '')] = row.value;
      } else if (row.key === 'logo') {
        // store raw base64 string (or empty) for client
        logoValue = row.value || null;
      } else if (row.key.startsWith('orderTemplate:')) {
        let templateValue = row.value;
        if (
          templateValue &&
          typeof templateValue === 'object' &&
          String(templateValue.kind || '').trim() === 'docx_vendor_form' &&
          templateValue.originalFile &&
          templateValue.originalFile.base64
        ) {
          try {
            const reparsed = await parseVendorDocxTemplate({
              buffer: Buffer.from(String(templateValue.originalFile.base64 || ''), 'base64'),
              filename: String(templateValue.originalFile.filename || templateValue.sourceFilename || 'template.docx'),
              contentType: String(
                templateValue.originalFile.contentType ||
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              ),
            });
            if (reparsed && reparsed.template && reparsed.template.docxMap) {
              const nextTemplateValue = {
                ...templateValue,
                uiHeaders: reparsed.template.uiHeaders || templateValue.uiHeaders || null,
                docxMap: reparsed.template.docxMap,
              };
              const changed = JSON.stringify(templateValue.docxMap || null) !== JSON.stringify(nextTemplateValue.docxMap || null);
              templateValue = nextTemplateValue;
              if (changed) {
                await Setting.updateOne(
                  { key: row.key },
                  { value: templateValue },
                  { upsert: true }
                );
              }
            }
          } catch (templateErr) {
            console.error('Template reparse error for setting', row.key, templateErr);
          }
        }
        categoryTemplates[row.key.replace('orderTemplate:', '')] = templateValue;
      } else if (row.key === 'manualOpenOrder') {
        manualOpen = row.value || null;
      } else if (row.key === 'manualOpenSeq') {
        const num = parseInt(row.value, 10);
        manualOpenSeq = Number.isNaN(num) ? null : num;
      } else if (row.key === 'manualOpenLeaves') {
        manualOpenLeaves = String(row.value || '').toLowerCase() === 'true' || String(row.value || '') === '1';
      }
    }

    // ensure A/B/C always exist and persist defaults when missing
    const defaultSched = { A: 0, B: 1, C: 5 };
    for (const t of ['A', 'B', 'C']) {
      if (!(t in schedules) || schedules[t] === null) {
        schedules[t] = schedules[t] != null ? schedules[t] : defaultSched[t];
        await Setting.updateOne(
          { key: `schedule${t}` },
          { value: schedules[t].toString() },
          { upsert: true }
        );
      }
    }

    const supplierIdSet = await getSupplierIdSet();
    const vendorOrdersStateRaw = buildVendorOrdersState({ docs, today, now });
    let vendorOrdersState = vendorOrdersStateRaw;
    const sanitizedVendorConfigs = filterVendorConfigsBySuppliers(vendorOrdersStateRaw.vendorOrderConfigs, supplierIdSet);
    const hasLegacyVendorDocs = docs.some((row) => row && ['vendorOrdersOpenVendor', 'vendorOrdersOpenVendors', 'vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'].includes(row.key));
    if (!vendorOrdersStateRaw.vendorOrderConfigs.length && hasLegacyVendorDocs) {
      await clearLegacyVendorOrderSettings();
    }
    if (sanitizedVendorConfigs.length !== vendorOrdersStateRaw.vendorOrderConfigs.length) {
      const persistedConfigs = await persistVendorOrderConfigs(sanitizedVendorConfigs);
      vendorOrdersState = buildVendorOrdersState({
        docs: [{ key: 'vendorOrderConfigs', value: persistedConfigs }],
        today,
        now,
      });
    }
    const result = {
      schedule: schedules,
      message: messages,
      logo: logoValue,
      manualOpenOrder: manualOpen,
      manualOpenSeq,
      manualOpenLeaves,
      vendorOrderConfigs: vendorOrdersState.vendorOrderConfigs,
      vendorOrdersOpenVendor: vendorOrdersState.vendorOrdersOpenVendor,
      vendorOrdersOpenVendors: vendorOrdersState.vendorOrdersOpenVendors,
      vendorOrdersWindowStartDay: vendorOrdersState.vendorOrdersWindowStartDay,
      vendorOrdersWindowEndDay: vendorOrdersState.vendorOrdersWindowEndDay,
      vendorOrdersWindowOpen: vendorOrdersState.vendorOrdersWindowOpen,
      activeVendorOrders: vendorOrdersState.activeVendorOrders,
      categoryTemplates,
      scheduleToday: today,
      orderTimezone: ORDER_TIMEZONE,
    };
    console.log('GET /settings returning', {
      schedule: result.schedule,
      messageKeys: Object.keys(result.message),
      hasLogo: Boolean(result.logo),
      manualOpenOrder: result.manualOpenOrder,
      manualOpenSeq: result.manualOpenSeq,
      manualOpenLeaves: result.manualOpenLeaves,
      vendorOrderConfigs: result.vendorOrderConfigs,
      vendorOrdersOpenVendor: result.vendorOrdersOpenVendor,
      vendorOrdersOpenVendors: result.vendorOrdersOpenVendors,
      vendorOrdersWindowStartDay: result.vendorOrdersWindowStartDay,
      vendorOrdersWindowEndDay: result.vendorOrdersWindowEndDay,
      vendorOrdersWindowOpen: result.vendorOrdersWindowOpen,
      categoryTemplateKeys: Object.keys(result.categoryTemplates),
      scheduleToday: result.scheduleToday,
      orderTimezone: result.orderTimezone,
    });
    res.json(result);
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update schedule (admin only)
// NOTE: use upsert so the setting is created when it doesn't yet exist.  Previously
// calling this endpoint when the schedule key was missing would silently succeed but
// not persist anything, which is why the UI would revert back to "Unset" after a
// refresh.
router.patch('/schedule/:type', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { day } = req.body;

    if (day === undefined || day < 0 || day > 6) {
      return res.status(400).json({ error: 'Invalid day' });
    }

    console.log('PATCH /settings/schedule', req.params.type, '->', day);
    await Setting.updateOne(
      { key: `schedule${req.params.type}` },
      { value: day.toString() },
      { upsert: true }
    );

    // return entire settings object so frontend can stay in sync
    const docs2 = await Setting.find().lean();
    const schedules = {};
    const messages = {};
    docs2.forEach((row) => {
      if (row.key.startsWith('schedule')) {
        var num = parseInt(row.value);
        schedules[row.key.replace('schedule', '')] = Number.isNaN(num) ? null : num;
      } else if (row.key.startsWith('message')) {
        messages[row.key.replace('message', '')] = row.value;
      }
    });
    res.json({ success: true, settings: { schedule: schedules, message: messages } });
  } catch (err) {
    console.error('Update schedule error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update message (admin only)
// also use upsert so creating a new message works without needing a prior record
router.patch('/message/:type', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    await Setting.updateOne(
      { key: `message${req.params.type}` },
      { value: message },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update message error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update logo (admin only)
// setting value stored as base64 string; empty/null means remove
router.patch('/logo', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { logo } = req.body;
    // allow null/empty to clear
    if (logo == null) {
      await Setting.deleteOne({ key: 'logo' });
      return res.json({ success: true, logo: null });
    }
    // ensure size limit enforced on client
    await Setting.updateOne(
      { key: 'logo' },
      { value: logo },
      { upsert: true }
    );
    res.json({ success: true, logo });
  } catch (err) {
    console.error('Update logo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual open override (admin only): allow stores to place a selected order type
// regardless of scheduled day. Pass null to clear.
router.patch('/manual-open', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { type } = req.body;
    if (type == null || type === '') {
      await Setting.deleteOne({ key: 'manualOpenOrder' });
      const seqDoc = await Setting.findOne({ key: 'manualOpenSeq' }).lean();
      const seqNum = seqDoc ? parseInt(seqDoc.value, 10) : null;
      return res.json({ success: true, manualOpenOrder: null, manualOpenSeq: Number.isNaN(seqNum) ? null : seqNum });
    }
    if (!['A', 'B', 'C'].includes(type)) {
      return res.status(400).json({ error: 'Invalid order type' });
    }
    const seqDoc = await Setting.findOne({ key: 'manualOpenSeq' }).lean();
    const prev = seqDoc ? parseInt(seqDoc.value, 10) : 0;
    const nextSeq = (Number.isNaN(prev) ? 0 : prev) + 1;
    await Setting.updateOne({ key: 'manualOpenOrder' }, { value: type }, { upsert: true });
    await Setting.updateOne({ key: 'manualOpenSeq' }, { value: String(nextSeq) }, { upsert: true });
    res.json({ success: true, manualOpenOrder: type, manualOpenSeq: nextSeq });
  } catch (err) {
    console.error('Update manual open error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Leaves manual open override (admin only): controls Leaves availability independent of A/B/C override.
router.patch('/manual-open-leaves', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const enabled = !!(req.body && req.body.enabled);
    if (!enabled) {
      await Setting.deleteOne({ key: 'manualOpenLeaves' });
      return res.json({ success: true, manualOpenLeaves: false });
    }
    await Setting.updateOne(
      { key: 'manualOpenLeaves' },
      { value: '1' },
      { upsert: true }
    );
    res.json({ success: true, manualOpenLeaves: true });
  } catch (err) {
    console.error('Update leaves manual open error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/vendor-orders-open', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const now = nowInTimezone(ORDER_TIMEZONE);
    const today = now.getDay();
    const docs = await Setting.find({
      key: { $in: ['vendorOrderConfigs', 'vendorOrdersOpenVendor', 'vendorOrdersOpenVendors', 'vendorOrdersWindowStartDay', 'vendorOrdersWindowEndDay'] },
    }).lean();
    const supplierIdSet = await getSupplierIdSet();
    const currentState = buildVendorOrdersState({ docs, today, now });
    let nextConfigs = filterVendorConfigsBySuppliers(currentState.vendorOrderConfigs.slice(), supplierIdSet);

    if (req.body && (req.body.vendorKey != null || req.body.enabled != null)) {
      const vendorKey = extractVendorIdentifier(req.body.vendorKey);
      const enabled = req.body.enabled !== false;
      const startDayRaw = req.body.startDay;
      const endDayRaw = req.body.endDay;
      const openToday24h = !!req.body.openToday24h;
      const startDay = parseOptionalDay(startDayRaw);
      const endDay = parseOptionalDay(endDayRaw);
      if (!vendorKey) {
        return res.status(400).json({ error: 'vendorKey is required' });
      }
      if (enabled && !supplierIdSet.has(vendorKey)) {
        return res.status(400).json({ error: 'Unknown supplier for vendor order settings' });
      }
      if (enabled && ((startDayRaw != null && startDay == null) || (endDayRaw != null && endDay == null))) {
        return res.status(400).json({ error: 'Invalid vendor order day range' });
      }
      if (enabled && ((startDay == null) !== (endDay == null))) {
        return res.status(400).json({ error: 'Select both start and end day for vendor order range' });
      }
      if (enabled && !openToday24h && startDay == null && endDay == null) {
        return res.status(400).json({ error: 'Select both start and end day for vendor order range, or use 24-hour open' });
      }
      const existingVendorConfig = nextConfigs.find((config) => config.vendorKey === vendorKey) || null;
      const existingVendorSeq = existingVendorConfig ? (parseInt(existingVendorConfig.seq, 10) || 0) : 0;
      nextConfigs = nextConfigs.filter((config) => config.vendorKey !== vendorKey);
      if (enabled) {
        const temporaryOpenUntil = openToday24h ? new Date(now.getTime() + (24 * 60 * 60 * 1000)).toISOString() : null;
        const temporaryOpenCreatedAt = openToday24h ? now.toISOString() : null;
        const newSeq = existingVendorSeq + 1;
        nextConfigs.push({
          vendorKey,
          startDay: openToday24h ? null : startDay,
          endDay: openToday24h ? null : endDay,
          enabled: true,
          temporaryOpenUntil,
          temporaryOpenCreatedAt,
          temporaryOpenOnly: openToday24h,
          seq: newSeq,
        });
      } else {
        // Preserve config with enabled:false so seq survives across cancel/reopen cycles
        if (existingVendorConfig) {
          nextConfigs.push({
            ...existingVendorConfig,
            enabled: false,
            temporaryOpenUntil: null,
            temporaryOpenCreatedAt: null,
          });
        }
      }
    } else {
      const vendorKeys = normalizeVendorKeys(req.body && req.body.vendorKeys);
      const invalidVendorKeys = vendorKeys.filter((vendorKey) => !supplierIdSet.has(vendorKey));
      if (invalidVendorKeys.length) {
        return res.status(400).json({ error: 'Unknown suppliers in vendor order settings' });
      }
      const startDayRaw = req.body ? req.body.startDay : null;
      const endDayRaw = req.body ? req.body.endDay : null;
      const startDay = parseOptionalDay(startDayRaw);
      const endDay = parseOptionalDay(endDayRaw);
      if ((startDayRaw != null && startDay == null) || (endDayRaw != null && endDay == null)) {
        return res.status(400).json({ error: 'Invalid vendor order day range' });
      }
      if ((startDay == null) !== (endDay == null)) {
        return res.status(400).json({ error: 'Select both start and end day for vendor order range' });
      }
      if (vendorKeys.length > 0 && startDay == null && endDay == null) {
        return res.status(400).json({ error: 'Select both start and end day for vendor order range, or use 24-hour open' });
      }
      nextConfigs = vendorKeys.map((vendorKey) => {
        const prevConfig = currentState.vendorOrderConfigs.find((c) => c.vendorKey === vendorKey);
        const prevSeq = prevConfig ? (parseInt(prevConfig.seq, 10) || 0) : 0;
        return {
          vendorKey,
          startDay,
          endDay,
          enabled: true,
          temporaryOpenUntil: null,
          temporaryOpenCreatedAt: null,
          temporaryOpenOnly: false,
          seq: prevSeq + 1,
        };
      });
    }
    const persistedConfigs = await persistVendorOrderConfigs(nextConfigs);
    const result = buildVendorOrdersState({
      docs: [{ key: 'vendorOrderConfigs', value: persistedConfigs }],
      today,
      now,
    });
    res.json({
      success: true,
      vendorOrderConfigs: result.vendorOrderConfigs,
      vendorOrdersOpenVendor: result.vendorOrdersOpenVendor,
      vendorOrdersOpenVendors: result.vendorOrdersOpenVendors,
      vendorOrdersWindowStartDay: result.vendorOrdersWindowStartDay,
      vendorOrdersWindowEndDay: result.vendorOrdersWindowEndDay,
      vendorOrdersWindowOpen: result.vendorOrdersWindowOpen,
      activeVendorOrders: result.activeVendorOrders,
      reopenedSupplierOrderId: null,
      reopenedSupplierOrderIds: [],
    });
  } catch (err) {
    console.error('Update vendor orders open error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
export default router;
