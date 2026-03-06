import express from 'express';
import { authMiddleware } from '../auth.js';
import Setting from '../models/setting.js';

const router = express.Router();

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
    let vendorOrdersOpenVendor = null;

    docs.forEach((row) => {
      if (row.key.startsWith('schedule')) {
        const num = parseInt(row.value);
        schedules[row.key.replace('schedule', '')] = Number.isNaN(num) ? null : num;
      } else if (row.key.startsWith('message')) {
        messages[row.key.replace('message', '')] = row.value;
      } else if (row.key === 'logo') {
        // store raw base64 string (or empty) for client
        logoValue = row.value || null;
      } else if (row.key.startsWith('orderTemplate:')) {
        categoryTemplates[row.key.replace('orderTemplate:', '')] = row.value;
      } else if (row.key === 'manualOpenOrder') {
        manualOpen = row.value || null;
      } else if (row.key === 'manualOpenSeq') {
        const num = parseInt(row.value, 10);
        manualOpenSeq = Number.isNaN(num) ? null : num;
      } else if (row.key === 'vendorOrdersOpenVendor') {
        vendorOrdersOpenVendor = row.value || null;
      }
    });

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

    const result = {
      schedule: schedules,
      message: messages,
      logo: logoValue,
      manualOpenOrder: manualOpen,
      manualOpenSeq,
      vendorOrdersOpenVendor,
      categoryTemplates,
    };
    console.log('GET /settings returning', {
      schedule: result.schedule,
      messageKeys: Object.keys(result.message),
      hasLogo: Boolean(result.logo),
      manualOpenOrder: result.manualOpenOrder,
      manualOpenSeq: result.manualOpenSeq,
      vendorOrdersOpenVendor: result.vendorOrdersOpenVendor,
      categoryTemplateKeys: Object.keys(result.categoryTemplates),
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

router.patch('/vendor-orders-open', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const vendorKey = String((req.body && req.body.vendorKey) || '').trim();
    if (!vendorKey) {
      await Setting.deleteOne({ key: 'vendorOrdersOpenVendor' });
      return res.json({ success: true, vendorOrdersOpenVendor: null });
    }
    await Setting.updateOne(
      { key: 'vendorOrdersOpenVendor' },
      { value: vendorKey },
      { upsert: true }
    );
    res.json({ success: true, vendorOrdersOpenVendor: vendorKey });
  } catch (err) {
    console.error('Update vendor orders open error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
export default router;
