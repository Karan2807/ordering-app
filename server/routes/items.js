import express from 'express';
import { authMiddleware } from '../auth.js';
import Item from '../models/item.js';
import Setting from '../models/setting.js';
import { parseVendorDocxTemplate } from '../services/vendorDocxTemplate.js';

const router = express.Router();
const VALID_CATEGORIES = ['vegetables', 'leaves', 'vendor_orders', 'warehouse_inventory'];
const VALID_TEMPLATE_VARIANTS = ['default', 'supplier', 'monitor'];
const canManageItems = (user) => ['admin', 'warehouse'].includes(String(user && user.role || '').trim().toLowerCase());

function normalizeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_CATEGORIES.includes(raw) ? raw : 'vegetables';
}
function normalizeVendorKey(category, vendorKey) {
  return ['vendor_orders', 'warehouse_inventory'].includes(normalizeCategory(category))
    ? String(vendorKey || '').trim() || null
    : null;
}

function normalizeTemplateVariant(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_TEMPLATE_VARIANTS.includes(raw) ? raw : 'default';
}

function buildItemMasterCode(name, unit) {
  const resolvedName = String(name || '').trim().replace(/\s+/g, ' ');
  const resolvedUnit = String(unit || '').trim().replace(/\s+/g, ' ');
  if (!resolvedName) return '';
  return resolvedUnit ? `${resolvedName}:${resolvedUnit}` : resolvedName;
}

function makeTemplateSettingKey(category, vendorKey, templateVariant = 'default') {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  const resolvedTemplateVariant = normalizeTemplateVariant(templateVariant);
  return `orderTemplate:${resolvedCategory}${resolvedVendorKey ? `:${resolvedVendorKey}` : ''}${resolvedTemplateVariant !== 'default' ? `::${resolvedTemplateVariant}` : ''}`;
}

function makeTemplateSettingKeyPrefix(category, vendorKey) {
  const resolvedCategory = normalizeCategory(category);
  const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  return `orderTemplate:${resolvedCategory}${resolvedVendorKey ? `:${resolvedVendorKey}` : ''}`;
}

function normalizeTemplateRemovedCodes(template) {
  const rawCodes = Array.isArray(template && template.removedItemCodes) ? template.removedItemCodes : [];
  return Array.from(new Set(rawCodes.map((code) => String(code || '').trim()).filter(Boolean)));
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

function formatItemDetailName(name, unit) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return String(unit || '').trim() || '';
  const trimmedUnit = String(unit || '').trim().toLowerCase();
  if (trimmedUnit) {
    const lowerName = trimmedName.toLowerCase();
    if (lowerName.endsWith(`(${trimmedUnit})`)) return trimmedName.slice(0, -(trimmedUnit.length + 2)).trim();
    if (lowerName.endsWith(`[${trimmedUnit}]`)) return trimmedName.slice(0, -(trimmedUnit.length + 2)).trim();
  }
  return trimmedName;
}

function extractLooseLegacyTemplateAliasCandidates(code) {
  const normalizedCode = String(code || '').trim();
  const out = [];
  if (!normalizedCode) return out;
  if (normalizedCode.indexOf('XLS::') === 0) out.push(String(normalizedCode).slice(5));
  if (normalizedCode.indexOf('::') < 0) return out;
  const parts = String(normalizedCode).split('::').map((part) => String(part || '').trim()).filter(Boolean);
  if (parts.length < 2 || String(parts[0] || '').indexOf('__') < 0) return out;
  const legacyName = String(parts[1] || '').replace(/\s+/g, ' ').trim();
  const legacyUnit = normalizeLegacyAliasUnit(parts.slice(2).join(' '));
  if (legacyName) {
    out.push(legacyName);
    out.push(`XLS::${legacyName}`);
    if (legacyUnit) {
      out.push(buildItemMasterCode(legacyName, legacyUnit));
      out.push(formatItemDetailName(legacyName, legacyUnit));
    }
  }
  return out.filter((value, index, list) => !!value && list.indexOf(value) === index);
}

function getTemplateItemRows(template) {
  if (!template || typeof template !== 'object') return [];
  if (String(template.kind || '').trim() === 'docx_vendor_form') {
    return [
      ...(template.docxMap && Array.isArray(template.docxMap.outline) ? template.docxMap.outline : []),
      ...(template.docxMap && Array.isArray(template.docxMap.itemRows) ? template.docxMap.itemRows : []),
    ];
  }
  return [
    ...(Array.isArray(template.outline) ? template.outline : []),
    ...(Array.isArray(template.itemRows) ? template.itemRows : []),
    ...(Array.isArray(template.multiSheetItemRows) ? template.multiSheetItemRows : []),
  ];
}

function buildTemplateRowAliasCodeMap(rows) {
  const aliasBuckets = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const isOutlineItem = row && Object.prototype.hasOwnProperty.call(row, 'type');
    if (isOutlineItem && String(row.type || '').trim() !== 'item') return;
    const code = String(row && row.code || '').trim();
    const name = String(row && row.name || '').trim();
    const unit = String(row && row.unit || '').trim();
    if (!code) return;
    [
      code,
      name,
      buildItemMasterCode(name, unit),
      formatItemDetailName(name, unit),
      name ? `XLS::${name}` : '',
      ...extractLooseLegacyTemplateAliasCandidates(code),
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

function resolveTemplateReferenceCodes(template, codesToMatch) {
  const normalizedCodes = Array.from(new Set((Array.isArray(codesToMatch) ? codesToMatch : []).map((code) => String(code || '').trim()).filter(Boolean)));
  if (!template || !normalizedCodes.length) return [];

  const removedCodes = normalizeTemplateRemovedCodes(template);
  const rows = getTemplateItemRows(template).concat(removedCodes.map((code) => ({ type: 'item', code })));
  const existingRowCodes = new Set();
  rows.forEach((row) => {
    const isOutlineItem = row && Object.prototype.hasOwnProperty.call(row, 'type');
    if (isOutlineItem && String(row.type || '').trim() !== 'item') return;
    const rowCode = String(row && row.code || '').trim();
    if (rowCode) existingRowCodes.add(rowCode);
  });
  const aliasCodeMap = buildTemplateRowAliasCodeMap(rows);
  const resolvedCodes = new Set();

  normalizedCodes.forEach((code) => {
    if (existingRowCodes.has(code)) {
      resolvedCodes.add(code);
      return;
    }
    const suffixTrimmed = code.replace(/\s*\(\d+\)$/, '');
    const candidates = [
      code,
      code.indexOf('XLS::') === 0 ? code.slice(5) : '',
      suffixTrimmed,
      suffixTrimmed && suffixTrimmed.indexOf('XLS::') !== 0 ? `XLS::${suffixTrimmed}` : '',
      ...extractLooseLegacyTemplateAliasCandidates(code),
    ].filter((value, index, list) => !!value && list.indexOf(value) === index);
    candidates.forEach((candidate) => {
      const token = normalizeCatalogAliasToken(candidate);
      if (token && aliasCodeMap[token]) resolvedCodes.add(aliasCodeMap[token]);
    });
  });

  return Array.from(resolvedCodes);
}

function listTemplateKeysForItem(category, vendorKey) {
  const templateKeyPrefix = makeTemplateSettingKeyPrefix(category, vendorKey);
  return [templateKeyPrefix, `${templateKeyPrefix}::supplier`, `${templateKeyPrefix}::monitor`];
}

function scopedItemFilter(codeOrCodes, category, vendorKey, scopeProvided = false) {
  const filter = Array.isArray(codeOrCodes)
    ? { code: { $in: codeOrCodes } }
    : { code: String(codeOrCodes || '').trim() };
  if (!scopeProvided) return filter;
  const resolvedCategory = normalizeCategory(category);
  filter.category = resolvedCategory;
  filter.vendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
  return filter;
}

function updateTemplateItemReferences(template, oldCode, nextCode, nextName) {
  const normalizedOldCode = String(oldCode || '').trim();
  const normalizedNextCode = String(nextCode || '').trim();
  const normalizedNextName = String(nextName || '').trim();
  if (!normalizedOldCode || !normalizedNextCode || !template || typeof template !== 'object') {
    return template;
  }

  if (String(template.kind || '').trim() === 'docx_vendor_form') {
    const nextTemplate = {
      ...template,
      docxMap: template.docxMap && typeof template.docxMap === 'object'
        ? {
            ...template.docxMap,
            outline: Array.isArray(template.docxMap.outline)
              ? template.docxMap.outline.map((entry) => {
                  if (!entry || String(entry.code || '').trim() !== normalizedOldCode) return entry;
                  return {
                    ...entry,
                    code: normalizedNextCode,
                    name: normalizedNextName || String(entry.name || '').trim(),
                  };
                })
              : template.docxMap.outline,
            itemRows: Array.isArray(template.docxMap.itemRows)
              ? template.docxMap.itemRows.map((row) => {
                  if (!row || String(row.code || '').trim() !== normalizedOldCode) return row;
                  return {
                    ...row,
                    code: normalizedNextCode,
                    name: normalizedNextName || String(row.name || '').trim(),
                  };
                })
              : template.docxMap.itemRows,
          }
        : template.docxMap,
    };
    return nextTemplate;
  }

  return {
    ...template,
    outline: Array.isArray(template.outline)
      ? template.outline.map((entry) => {
          if (!entry || String(entry.code || '').trim() !== normalizedOldCode) return entry;
          return {
            ...entry,
            code: normalizedNextCode,
          };
        })
      : template.outline,
    itemRows: Array.isArray(template.itemRows)
      ? template.itemRows.map((row) => {
          if (!row || String(row.code || '').trim() !== normalizedOldCode) return row;
          return {
            ...row,
            code: normalizedNextCode,
            name: normalizedNextName || String(row.name || '').trim(),
          };
        })
      : template.itemRows,
    multiSheetItemRows: Array.isArray(template.multiSheetItemRows)
      ? template.multiSheetItemRows.map((row) => {
          if (!row || String(row.code || '').trim() !== normalizedOldCode) return row;
          return {
            ...row,
            code: normalizedNextCode,
            name: normalizedNextName || String(row.name || '').trim(),
          };
        })
      : template.multiSheetItemRows,
  };
}

function pruneTemplateItemReferences(template, codesToRemove) {
  const normalizedCodes = resolveTemplateReferenceCodes(template, codesToRemove);
  if (!template || !normalizedCodes.length) return template;

  const removedCodeSet = new Set(normalizedCodes);
  const removedItemCodes = Array.from(new Set(normalizeTemplateRemovedCodes(template).concat(normalizedCodes)));

  if (String(template.kind || '').trim() === 'docx_vendor_form') {
    return {
      ...template,
      removedItemCodes,
      docxMap: template.docxMap && typeof template.docxMap === 'object'
        ? {
            ...template.docxMap,
            outline: Array.isArray(template.docxMap.outline)
              ? template.docxMap.outline.filter((entry) => {
                  if (!entry || String(entry.type || '').trim() !== 'item') return true;
                  return !removedCodeSet.has(String(entry.code || '').trim());
                })
              : template.docxMap.outline,
            itemRows: Array.isArray(template.docxMap.itemRows)
              ? template.docxMap.itemRows.filter((row) => !removedCodeSet.has(String(row && row.code || '').trim()))
              : template.docxMap.itemRows,
          }
        : template.docxMap,
    };
  }

  return {
    ...template,
    removedItemCodes,
    outline: Array.isArray(template.outline)
      ? template.outline.filter((entry) => {
          if (!entry || String(entry.type || '').trim() !== 'item') return true;
          return !removedCodeSet.has(String(entry.code || '').trim());
        })
      : template.outline,
    itemRows: Array.isArray(template.itemRows)
      ? template.itemRows.filter((row) => !removedCodeSet.has(String(row && row.code || '').trim()))
      : template.itemRows,
    multiSheetItemRows: Array.isArray(template.multiSheetItemRows)
      ? template.multiSheetItemRows.filter((row) => !removedCodeSet.has(String(row && row.code || '').trim()))
      : template.multiSheetItemRows,
  };
}

function templateReferencesAnyCodes(template, codesToMatch) {
  return resolveTemplateReferenceCodes(template, codesToMatch).length > 0;
}

function normalizeTemplatePayload(template) {
  if (!template || typeof template !== 'object') return null;
  const kind = String(template.kind || '').trim();
  if (kind === 'docx_vendor_form') {
    const originalFile = template.originalFile && typeof template.originalFile === 'object'
      ? {
          filename: String(template.originalFile.filename || '').trim(),
          contentType: String(template.originalFile.contentType || '').trim(),
          base64: String(template.originalFile.base64 || '').trim(),
        }
      : null;
    const docxMap = template.docxMap && typeof template.docxMap === 'object'
      ? {
          storeParagraphIndex: Number.isInteger(template.docxMap.storeParagraphIndex) ? template.docxMap.storeParagraphIndex : null,
          dateParagraphIndex: Number.isInteger(template.docxMap.dateParagraphIndex) ? template.docxMap.dateParagraphIndex : null,
          outline: Array.isArray(template.docxMap.outline)
            ? template.docxMap.outline
                .map((entry) => ({
                  type: String(entry && entry.type || '').trim(),
                  text: String(entry && entry.text || '').trim(),
                  code: String(entry && entry.code || '').trim(),
                  name: String(entry && entry.name || '').trim(),
                  paragraphIndex: Number.isInteger(entry && entry.paragraphIndex) ? entry.paragraphIndex : null,
                }))
                .filter((entry) => (
                  entry.paragraphIndex != null &&
                  (
                    (entry.type === 'heading' && entry.text) ||
                    (entry.type === 'item' && entry.code && entry.name)
                  )
                ))
            : [],
          itemRows: Array.isArray(template.docxMap.itemRows)
            ? template.docxMap.itemRows
                .map((row) => ({
                  code: String(row && row.code || '').trim(),
                  name: String(row && row.name || '').trim(),
                  paragraphIndex: Number.isInteger(row && row.paragraphIndex) ? row.paragraphIndex : null,
                  sep1: String(row && row.sep1 || ''),
                  qty: String(row && row.qty || ''),
                  sep2: String(row && row.sep2 || ''),
                }))
                .filter((row) => row.code && row.name && row.paragraphIndex != null)
            : [],
        }
      : null;
    if (!originalFile || !originalFile.base64 || !docxMap || !Array.isArray(docxMap.itemRows) || docxMap.itemRows.length === 0) {
      return null;
    }
    return {
      kind: 'docx_vendor_form',
      sourceFilename: String(template.sourceFilename || '').trim(),
      removedItemCodes: normalizeTemplateRemovedCodes(template),
      uiHeaders: template.uiHeaders && typeof template.uiHeaders === 'object'
        ? {
            item: String(template.uiHeaders.item || '').trim(),
            quantity: String(template.uiHeaders.quantity || '').trim(),
            note: String(template.uiHeaders.note || '').trim(),
            total: String(template.uiHeaders.total || '').trim(),
            date: String(template.uiHeaders.date || '').trim(),
          }
        : null,
      docxMap,
      originalFile,
    };
  }
  if (!Array.isArray(template.rows) || !Array.isArray(template.itemRows) || !Array.isArray(template.storeColumns)) {
    if (String(template.kind || '').trim() !== 'raw_grid') {
      return null;
    }
  }
  const normalizedRawGrid = template.rawGrid && typeof template.rawGrid === 'object' && Array.isArray(template.rawGrid.sheets)
    ? {
        sheets: template.rawGrid.sheets
          .map((sheet, idx) => ({
            name: String(sheet && sheet.name || `Sheet ${idx + 1}`).trim() || `Sheet ${idx + 1}`,
            rows: Array.isArray(sheet && sheet.rows)
              ? sheet.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
              : [],
          }))
          .filter((sheet) => Array.isArray(sheet.rows) && sheet.rows.length > 0),
      }
    : null;
  return {
    kind: String(template.kind || 'matrix'),
    sourceFilename: String(template.sourceFilename || '').trim(),
    removedItemCodes: normalizeTemplateRemovedCodes(template),
    sheetName: String(template.sheetName || '').trim(),
    headerRowIndex: Number.isInteger(template.headerRowIndex) ? template.headerRowIndex : null,
    dateCell: template.dateCell && typeof template.dateCell === 'object'
      ? {
          rowIndex: Number.isInteger(template.dateCell.rowIndex) ? template.dateCell.rowIndex : null,
          colIndex: Number.isInteger(template.dateCell.colIndex) ? template.dateCell.colIndex : null,
          prefix: String(template.dateCell.prefix || ''),
        }
      : null,
    rows: template.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [])),
    outline: Array.isArray(template.outline)
      ? template.outline
          .map((entry) => ({
            type: String(entry && entry.type || '').trim(),
            text: String(entry && entry.text || '').trim(),
            code: String(entry && entry.code || '').trim(),
            rowIndex: Number.isInteger(entry && entry.rowIndex) ? entry.rowIndex : null,
            colIndex: Number.isInteger(entry && entry.colIndex) ? entry.colIndex : null,
          }))
          .filter((entry) => (
            (entry.type === 'heading' && entry.text) ||
            (entry.type === 'item' && entry.code)
          ))
      : [],
    itemRows: template.itemRows
      .map((row) => ({
        code: String(row && row.code || '').trim(),
        name: String(row && row.name || '').trim(),
        rowIndex: Number.isInteger(row && row.rowIndex) ? row.rowIndex : null,
        colIndex: Number.isInteger(row && row.colIndex) ? row.colIndex : 0,
      }))
      .filter((row) => row.code && row.name && row.rowIndex != null),
    multiSheetItemRows: Array.isArray(template.multiSheetItemRows) && template.multiSheetItemRows.length > 0
      ? template.multiSheetItemRows
          .map((row) => ({
            code: String(row && row.code || '').trim(),
            name: String(row && row.name || '').trim(),
            rowIndex: Number.isInteger(row && row.rowIndex) ? row.rowIndex : null,
            colIndex: Number.isInteger(row && row.colIndex) ? row.colIndex : 0,
            sheetIndex: Number.isInteger(row && row.sheetIndex) ? row.sheetIndex : 0,
            sheetName: String(row && row.sheetName || '').trim(),
          }))
          .filter((row) => row.code && row.name && row.rowIndex != null)
      : null,
    storeColumns: template.storeColumns
      .map((col) => ({
        slotKey: String(col && col.slotKey || '').trim(),
        header: String(col && col.header || '').trim(),
        colIndex: Number.isInteger(col && col.colIndex) ? col.colIndex : null,
      }))
      .filter((col) => col.slotKey && col.colIndex != null),
    quantityColumn: template.quantityColumn && typeof template.quantityColumn === 'object'
      ? {
          header: String(template.quantityColumn.header || '').trim(),
          colIndex: Number.isInteger(template.quantityColumn.colIndex) ? template.quantityColumn.colIndex : null,
        }
      : null,
    noteColumn: template.noteColumn && typeof template.noteColumn === 'object'
      ? {
          header: String(template.noteColumn.header || '').trim(),
          colIndex: Number.isInteger(template.noteColumn.colIndex) ? template.noteColumn.colIndex : null,
        }
      : null,
    uiHeaders: template.uiHeaders && typeof template.uiHeaders === 'object'
      ? {
          item: String(template.uiHeaders.item || '').trim(),
          quantity: String(template.uiHeaders.quantity || '').trim(),
          note: String(template.uiHeaders.note || '').trim(),
          total: String(template.uiHeaders.total || '').trim(),
          date: String(template.uiHeaders.date || '').trim(),
        }
      : null,
    rawGrid: normalizedRawGrid,
    originalFile: template.originalFile && typeof template.originalFile === 'object'
      ? {
          filename: String(template.originalFile.filename || '').trim(),
          contentType: String(template.originalFile.contentType || '').trim(),
          base64: String(template.originalFile.base64 || '').trim(),
        }
      : null,
  };
}

router.post('/template/parse', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }
    const { filename, contentType, base64, category, vendorKey } = req.body || {};
    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    if (resolvedCategory !== 'vendor_orders' || !resolvedVendorKey) {
      return res.status(400).json({ error: 'Word template parsing is supported only for vendor orders' });
    }
    const resolvedFilename = String(filename || '').trim();
    if (!resolvedFilename.toLowerCase().endsWith('.docx')) {
      return res.status(400).json({ error: 'Only .docx templates are supported' });
    }
    const buffer = Buffer.from(String(base64 || '').trim(), 'base64');
    if (!buffer.length) {
      return res.status(400).json({ error: 'Template file is empty' });
    }
    const parsed = await parseVendorDocxTemplate({
      buffer,
      filename: resolvedFilename,
      contentType: String(contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    });
    res.json(parsed);
  } catch (err) {
    console.error('Parse template error:', err);
    res.status(500).json({ error: 'Could not parse Word template' });
  }
});

// Get all items
router.get('/', async (req, res) => {
  try {
    const items = await Item.find().sort({ category: 1, vendorKey: 1, sortOrder: 1, createdAt: 1 }).lean();
    res.json(items.map((item) => ({
      ...item,
      category: normalizeCategory(item.category),
      vendorKey: item.vendorKey || null,
    })));
  } catch (err) {
    console.error('Get items error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create item
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }

    const { name, category, vendorKey, unit, subheading, sortOrder } = req.body;
    const resolvedCode = buildItemMasterCode(name, unit);

    if (!resolvedCode || !name) {
      return res.status(400).json({ error: 'Code and name required' });
    }

    const existing = await Item.findOne({ code: resolvedCode });
    if (existing) {
      return res.status(400).json({ error: 'Code already exists' });
    }

    const resolvedCategory = normalizeCategory(category);
    await Item.create({
      code: resolvedCode,
      name,
      category: resolvedCategory,
      vendorKey: normalizeVendorKey(resolvedCategory, vendorKey),
      subheading: String(subheading || '').trim(),
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : null,
      unit: unit || '',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Create item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update item
router.patch('/:code', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }

    const existingItem = await Item.findOne({ code: req.params.code }).lean();
    if (!existingItem) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const nextName = String(req.body && req.body.name || '').trim();
    const nextUnit = String(req.body && req.body.unit || '').trim();
    const nextSubheading = String(req.body && req.body.subheading || '').trim();
    const nextSortOrderRaw = req.body ? req.body.sortOrder : null;
    const nextInventoryCountRaw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'inventoryCount') ? req.body.inventoryCount : undefined;
    const nextCode = buildItemMasterCode(nextName, nextUnit);

    if (!nextCode || !nextName) {
      return res.status(400).json({ error: 'Name required' });
    }

    if (nextCode !== existingItem.code) {
      const duplicate = await Item.findOne({ code: nextCode }).lean();
      if (duplicate) {
        return res.status(400).json({ error: 'Code already exists' });
      }
    }

    const nextSortOrder = Number.isFinite(Number(nextSortOrderRaw)) ? Number(nextSortOrderRaw) : null;
    const nextInventoryCount = nextInventoryCountRaw !== undefined
      ? (nextInventoryCountRaw != null && Number.isFinite(Number(nextInventoryCountRaw)) && Number(nextInventoryCountRaw) >= 0 ? Number(nextInventoryCountRaw) : null)
      : existingItem.inventoryCount ?? null;

    const updateSet = {
      code: nextCode,
      name: nextName,
      unit: nextUnit,
      subheading: nextSubheading,
      sortOrder: nextSortOrder,
      inventoryCount: nextInventoryCount,
    };

    await Item.updateOne(
      { code: existingItem.code },
      { $set: updateSet }
    );

    const templateDocs = await Setting.find({
      key: {
        $in: listTemplateKeysForItem(existingItem.category, existingItem.vendorKey),
      },
    }).lean();
    for (const templateDoc of templateDocs) {
      if (!templateDoc || !templateDoc.value) continue;
      const nextTemplate = updateTemplateItemReferences(templateDoc.value, existingItem.code, nextCode, nextName);
      const normalizedTemplate = normalizeTemplatePayload(nextTemplate);
      if (!normalizedTemplate) continue;
      await Setting.updateOne(
        { key: templateDoc.key },
        { value: normalizedTemplate },
        { upsert: true }
      );
    }

    res.json({ success: true, code: nextCode });
  } catch (err) {
    console.error('Update item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete item
router.delete('/:code', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }

    const normalizedCode = String(req.params.code || '').trim();
    if (!normalizedCode) {
      return res.status(400).json({ error: 'Item code required' });
    }

    const scopeProvided = req.query && Object.prototype.hasOwnProperty.call(req.query, 'category');
    const requestedCategory = normalizeCategory(req.query && req.query.category);
    const requestedVendorKey = normalizeVendorKey(requestedCategory, req.query && req.query.vendorKey);
    const existingItem = await Item.findOne({ code: normalizedCode }).lean();
    const templateKeys = existingItem
      ? listTemplateKeysForItem(existingItem.category, existingItem.vendorKey)
      : (scopeProvided ? listTemplateKeysForItem(requestedCategory, requestedVendorKey) : null);
    const templateDocs = await Setting.find(templateKeys ? { key: { $in: templateKeys } } : { key: /^orderTemplate:/ }).lean();
    let prunedTemplateCount = 0;
    for (const templateDoc of templateDocs) {
      if (!templateDoc || !templateDoc.value) continue;
      if (!templateReferencesAnyCodes(templateDoc.value, [normalizedCode])) continue;
      const nextTemplate = pruneTemplateItemReferences(templateDoc.value, [normalizedCode]);
      const normalizedTemplate = normalizeTemplatePayload(nextTemplate);
      if (!normalizedTemplate) continue;
      await Setting.updateOne(
        { key: templateDoc.key },
        { value: normalizedTemplate },
        { upsert: true }
      );
      prunedTemplateCount += 1;
    }

    if (existingItem) {
      await Item.deleteOne({ code: normalizedCode });
    }

    if (!existingItem && !prunedTemplateCount) {
      return res.status(404).json({ error: 'No matching items found' });
    }

    res.json({ success: true, deletedCount: existingItem ? 1 : 0, prunedTemplateCount });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/bulk/delete', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }

    const codes = Array.isArray(req.body && req.body.codes)
      ? Array.from(new Set(req.body.codes.map((code) => String(code || '').trim()).filter(Boolean)))
      : [];

    if (!codes.length) {
      return res.status(400).json({ error: 'codes must be a non-empty array' });
    }

    const scopeProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, 'category');
    const requestedCategory = normalizeCategory(req.body && req.body.category);
    const requestedVendorKey = normalizeVendorKey(requestedCategory, req.body && req.body.vendorKey);
    const matchingItems = await Item.find({ code: { $in: codes } }).lean();
    const templateKeySet = new Set();
    matchingItems.forEach((item) => {
      listTemplateKeysForItem(item.category, item.vendorKey).forEach((key) => templateKeySet.add(key));
    });
    if (scopeProvided) {
      listTemplateKeysForItem(requestedCategory, requestedVendorKey).forEach((key) => templateKeySet.add(key));
    }
    const templateKeys = Array.from(templateKeySet);
    const templateDocs = await Setting.find(templateKeys.length ? { key: { $in: templateKeys } } : { key: /^orderTemplate:/ }).lean();
    let prunedTemplateCount = 0;
    for (const templateDoc of templateDocs) {
      if (!templateDoc || !templateDoc.value) continue;
      if (!templateReferencesAnyCodes(templateDoc.value, codes)) continue;
      const nextTemplate = pruneTemplateItemReferences(templateDoc.value, codes);
      const normalizedTemplate = normalizeTemplatePayload(nextTemplate);
      if (!normalizedTemplate) continue;
      await Setting.updateOne(
        { key: templateDoc.key },
        { value: normalizedTemplate },
        { upsert: true }
      );
      prunedTemplateCount += 1;
    }

    const result = await Item.deleteMany({ code: { $in: codes } });
    const deletedCount = Number(result && result.deletedCount || 0);
    if (!deletedCount && !prunedTemplateCount) {
      return res.status(404).json({ error: 'No matching items found' });
    }

    res.json({ success: true, deletedCount, prunedTemplateCount });
  } catch (err) {
    console.error('Bulk delete items error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk import items (via CSV)
router.post('/bulk/import', authMiddleware, async (req, res) => {
  try {
    if (!canManageItems(req.user)) {
      return res.status(403).json({ error: 'Admin or warehouse only' });
    }

    const { items, mode, category, vendorKey, template, templateVariant } = req.body; // mode: 'merge' or 'replace'

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items must be an array' });
    }

    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    const resolvedTemplateVariant = normalizeTemplateVariant(templateVariant);
    if (resolvedCategory === 'vendor_orders' && !resolvedVendorKey) {
      return res.status(400).json({ error: 'vendorKey is required for vendor orders' });
    }

    if (mode === 'replace') {
      await Item.deleteMany({ category: resolvedCategory, vendorKey: resolvedVendorKey });
    }

    const toInsert = [];
    const seenCodes = new Set();
    for (const item of items) {
      const { name, category: itemCategory, vendorKey: itemVendorKey, unit, subheading, sortOrder, inventoryCount } = item;
      if (name) {
        const normalizedCode = buildItemMasterCode(name, unit);
        if (!normalizedCode || seenCodes.has(normalizedCode)) {
          continue;
        }
        seenCodes.add(normalizedCode);
        const nextCategory = normalizeCategory(itemCategory || resolvedCategory);
        const parsedInventoryCount = inventoryCount != null && Number.isFinite(Number(inventoryCount)) && Number(inventoryCount) >= 0 ? Number(inventoryCount) : null;
        toInsert.push({
          code: normalizedCode,
          name,
          category: nextCategory,
          vendorKey: normalizeVendorKey(nextCategory, itemVendorKey || resolvedVendorKey),
          subheading: String(subheading || '').trim(),
          sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : null,
          unit: unit || '',
          inventoryCount: parsedInventoryCount,
        });
      }
    }
    if (toInsert.length) {
      await Item.bulkWrite(
        toInsert.map((item) => ({
          updateOne: {
            filter: { code: item.code },
            update: { $set: item },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }

    const normalizedTemplate = normalizeTemplatePayload(template);
    if (normalizedTemplate) {
      await Setting.updateOne(
        { key: makeTemplateSettingKey(resolvedCategory, resolvedVendorKey, resolvedTemplateVariant) },
        { value: normalizedTemplate },
        { upsert: true }
      );
    }

    res.json({ success: true, imported: toInsert.length, category: resolvedCategory, vendorKey: resolvedVendorKey });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
