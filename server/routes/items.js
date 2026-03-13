import express from 'express';
import { authMiddleware } from '../auth.js';
import Item from '../models/item.js';
import Setting from '../models/setting.js';
import { parseVendorDocxTemplate } from '../services/vendorDocxTemplate.js';

const router = express.Router();
const VALID_CATEGORIES = ['vegetables', 'leaves', 'vendor_orders'];

function normalizeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_CATEGORIES.includes(raw) ? raw : 'vegetables';
}
function normalizeVendorKey(category, vendorKey) {
  return normalizeCategory(category) === 'vendor_orders'
    ? String(vendorKey || '').trim() || null
    : null;
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
    return null;
  }
  return {
    kind: String(template.kind || 'matrix'),
    sourceFilename: String(template.sourceFilename || '').trim(),
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
    itemRows: template.itemRows
      .map((row) => ({
        code: String(row && row.code || '').trim(),
        name: String(row && row.name || '').trim(),
        rowIndex: Number.isInteger(row && row.rowIndex) ? row.rowIndex : null,
        colIndex: Number.isInteger(row && row.colIndex) ? row.colIndex : 0,
      }))
      .filter((row) => row.code && row.name && row.rowIndex != null),
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
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
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
    const items = await Item.find().sort({ category: 1, name: 1 }).lean();
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
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { code, name, category, vendorKey, unit } = req.body;

    if (!code || !name) {
      return res.status(400).json({ error: 'Code and name required' });
    }

    const existing = await Item.findOne({ code });
    if (existing) {
      return res.status(400).json({ error: 'Code already exists' });
    }

    const resolvedCategory = normalizeCategory(category);
    await Item.create({
      code,
      name,
      category: resolvedCategory,
      vendorKey: normalizeVendorKey(resolvedCategory, vendorKey),
      unit: unit || '',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Create item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete item
router.delete('/:code', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    await Item.deleteOne({ code: req.params.code });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk import items (via CSV)
router.post('/bulk/import', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { items, mode, category, vendorKey, template } = req.body; // mode: 'merge' or 'replace'

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Items must be an array' });
    }

    const resolvedCategory = normalizeCategory(category);
    const resolvedVendorKey = normalizeVendorKey(resolvedCategory, vendorKey);
    if (resolvedCategory === 'vendor_orders' && !resolvedVendorKey) {
      return res.status(400).json({ error: 'vendorKey is required for vendor orders' });
    }

    if (mode === 'replace') {
      await Item.deleteMany({ category: resolvedCategory, vendorKey: resolvedVendorKey });
    }

    const toInsert = [];
    const seenCodes = new Set();
    for (const item of items) {
      const { code, name, category: itemCategory, vendorKey: itemVendorKey, unit } = item;
      if (code && name) {
        const normalizedCode = String(code).trim();
        if (!normalizedCode || seenCodes.has(normalizedCode)) {
          continue;
        }
        seenCodes.add(normalizedCode);
        const nextCategory = normalizeCategory(itemCategory || resolvedCategory);
        toInsert.push({
          code: normalizedCode,
          name,
          category: nextCategory,
          vendorKey: normalizeVendorKey(nextCategory, itemVendorKey || resolvedVendorKey),
          unit: unit || '',
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
        { key: `orderTemplate:${resolvedCategory}${resolvedVendorKey ? `:${resolvedVendorKey}` : ''}` },
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
