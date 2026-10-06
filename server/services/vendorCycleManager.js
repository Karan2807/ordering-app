import Setting from '../models/setting.js';
import Order from '../models/order.js';
import Store from '../models/store.js';
import SupplierOrder from '../models/supplierOrder.js';
import Supplier from '../models/supplier.js';

const ORDER_TIMEZONE = process.env.ORDER_TIMEZONE || 'America/Los_Angeles';

function nowInTimezone(tz) {
  const text = new Date().toLocaleString('en-US', { timeZone: tz });
  return new Date(text);
}

function parseOptionalDay(value) {
  if (value == null || value === '') return null;
  const day = parseInt(value, 10);
  return Number.isNaN(day) || day < 0 || day > 6 ? null : day;
}

function isDayWithinRange(day, startDay, endDay) {
  if (startDay == null || endDay == null) return false;
  if (startDay <= endDay) return day >= startDay && day <= endDay;
  return day >= startDay || day <= endDay;
}

function isVendorConfigActiveNow(config, now, today) {
  if (!config || config.enabled === false) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const tempUntilMs = config.temporaryOpenUntil ? new Date(config.temporaryOpenUntil).getTime() : NaN;
  const tempActive = Number.isFinite(tempUntilMs) && tempUntilMs > nowMs;
  if (config.temporaryOpenOnly) return tempActive;
  if (tempActive) return true;
  return isDayWithinRange(today, config.startDay, config.endDay);
}

function normalizeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  return ['vegetables', 'leaves', 'vendor_orders', 'warehouse_inventory'].includes(raw) ? raw : 'vegetables';
}

function normalizeVendorKey(category, vendorKey) {
  return ['vendor_orders', 'warehouse_inventory'].includes(normalizeCategory(category))
    ? String(vendorKey || '').trim() || null
    : null;
}

/**
 * Check all vendor order configs and close any cycles whose window has ended.
 * For each closed window:
 * 1. Archive unsent orders (consolidated + individual) to SupplierOrder with sentToSupplier=false
 * 2. Delete/reset the individual store orders so they don't linger
 * 3. Increment the seq so the next cycle gets a fresh week key
 */
async function closeExpiredVendorCycles() {
  const doc = await Setting.findOne({ key: 'vendorOrderConfigs' }).lean();
  if (!doc || !Array.isArray(doc.value) || doc.value.length === 0) return;

  const now = nowInTimezone(ORDER_TIMEZONE);
  const today = now.getDay();
  const configs = doc.value;
  let configsChanged = false;
  const updatedConfigs = [];

  for (const config of configs) {
    const vendorKey = String(config.vendorKey || '').trim();
    if (!vendorKey) {
      updatedConfigs.push(config);
      continue;
    }

    // Skip if currently active — window is still open
    if (isVendorConfigActiveNow(config, now, today)) {
      updatedConfigs.push(config);
      continue;
    }

    // Skip if already disabled (already closed or never opened)
    if (config.enabled === false) {
      updatedConfigs.push(config);
      continue;
    }

    // Window has ended (enabled=true but not active now). Check for unsent orders.
    const currentSeq = parseInt(config.seq, 10) || 1;
    const weekRegex = new RegExp(`-VS${currentSeq}$`, 'i');

    // Find all submitted/draft_shared orders for this vendor + seq that aren't processed
    const unsentOrders = await Order.find({
      category: 'vendor_orders',
      vendorKey,
      week: { $regex: weekRegex },
      status: { $in: ['submitted', 'draft_shared'] },
    }).lean();

    // Also handle draft orders that were never submitted
    const draftOrders = await Order.find({
      category: 'vendor_orders',
      vendorKey,
      week: { $regex: weekRegex },
      status: 'draft',
    }).lean();

    // If there are no orders at all for this seq, the cycle was already closed
    // or never had any activity — skip to avoid incrementing seq repeatedly
    if (unsentOrders.length === 0 && draftOrders.length === 0) {
      updatedConfigs.push(config);
      continue;
    }

    if (unsentOrders.length > 0) {
      // Check if a SupplierOrder already exists for this cycle (meaning it was sent)
      const existingSentOrder = await SupplierOrder.findOne({
        vendorKey,
        week: { $regex: weekRegex },
        sentToSupplier: { $ne: false },
      }).lean();

      if (!existingSentOrder) {
        // Orders were NOT sent — archive them
        await archiveUnsentVendorOrders(vendorKey, currentSeq, unsentOrders);
      }
    }

    // Delete draft orders (they were never submitted, no need to archive)
    if (draftOrders.length > 0) {
      const draftIds = draftOrders.map((o) => o.id);
      await Order.deleteMany({ id: { $in: draftIds } });
      console.log(`[VendorCycleManager] Deleted ${draftIds.length} draft orders for vendor ${vendorKey} seq ${currentSeq}`);
    }

    // Delete the submitted/draft_shared orders after archiving
    if (unsentOrders.length > 0) {
      const orderIds = unsentOrders.map((o) => o.id);
      await Order.deleteMany({ id: { $in: orderIds } });
      console.log(`[VendorCycleManager] Cleaned up ${orderIds.length} submitted orders for vendor ${vendorKey} seq ${currentSeq}`);
    }

    // Increment seq so next activation creates a fresh cycle
    const newSeq = currentSeq + 1;
    updatedConfigs.push({
      ...config,
      seq: newSeq,
      // Clear temporary open fields
      temporaryOpenUntil: null,
      temporaryOpenCreatedAt: null,
      temporaryOpenOnly: false,
    });
    configsChanged = true;
    console.log(`[VendorCycleManager] Closed expired cycle for vendor ${vendorKey}: seq ${currentSeq} → ${newSeq}`);
  }

  if (configsChanged) {
    await Setting.updateOne(
      { key: 'vendorOrderConfigs' },
      { value: updatedConfigs },
      { upsert: true }
    );
    console.log('[VendorCycleManager] Updated vendorOrderConfigs with new sequences');
  }
}

/**
 * Archive unsent vendor orders to SupplierOrder history.
 * Creates a SupplierOrder record with sentToSupplier=false and
 * stores both the consolidated totals and per-store breakdown.
 */
async function archiveUnsentVendorOrders(vendorKey, seq, orders) {
  const supplier = await Supplier.findOne({ id: vendorKey }).lean();
  const stores = await Store.find().lean();
  const storeNameById = {};
  stores.forEach((s) => { storeNameById[String(s.id || '')] = s.name || s.id || ''; });

  // Compute consolidated totals (same as what the email endpoint computes)
  const totalObj = {};
  const storeBreakdown = {};

  orders.forEach((order) => {
    const storeId = order.storeId;
    const storeName = storeNameById[storeId] || storeId || 'Unknown';
    const storeItems = {};

    const items = Array.isArray(order.items) ? order.items : [];
    items.forEach((item) => {
      const code = String(item.itemCode || '').trim();
      const qty = Number(item.quantity) || 0;
      if (!code || qty <= 0) return;
      totalObj[code] = (totalObj[code] || 0) + qty;
      storeItems[code] = (storeItems[code] || 0) + qty;
    });

    storeBreakdown[storeId] = {
      storeName,
      status: order.status,
      submittedAt: order.submittedAt || order.createdAt,
      items: storeItems,
    };
  });

  // Build snapshot lines for history display
  const snapshotLines = [];
  snapshotLines.push(`UNSENT VENDOR ORDER - Auto-archived on cycle close`);
  snapshotLines.push(`Vendor: ${supplier ? supplier.name : vendorKey}`);
  snapshotLines.push(`Cycle Sequence: VS${seq}`);
  snapshotLines.push(`Stores: ${orders.length}`);
  snapshotLines.push('---');
  Object.entries(storeBreakdown).forEach(([storeId, data]) => {
    snapshotLines.push(`${data.storeName} (${data.status}):`);
    Object.entries(data.items).forEach(([code, qty]) => {
      snapshotLines.push(`  ${code}: ${qty}`);
    });
  });

  const week = orders[0] ? orders[0].week : `unknown-VS${seq}`;

  try {
    await SupplierOrder.create({
      supplierName: supplier ? supplier.name : vendorKey,
      email: supplier ? (supplier.email || '') : '',
      emails: supplier ? (supplier.emails || []) : [],
      type: orders[0] ? orders[0].type : 'A',
      category: 'vendor_orders',
      vendorKey,
      week,
      items: totalObj,
      snapshotLines,
      sentToSupplier: false,
      finished: true,
      sentAt: new Date(),
      storeBreakdown,
    });
    console.log(`[VendorCycleManager] Archived unsent orders for vendor ${vendorKey} seq ${seq}: ${orders.length} store orders, week=${week}`);
  } catch (err) {
    console.error(`[VendorCycleManager] Failed to archive unsent orders for vendor ${vendorKey}:`, err);
  }
}

/**
 * Run cycle check tick — called periodically from the scheduler.
 */
async function runVendorCycleTick() {
  try {
    await closeExpiredVendorCycles();
  } catch (err) {
    console.error('[VendorCycleManager] Cycle tick failed:', err);
  }
}

/**
 * Start the vendor cycle manager — runs every 5 minutes.
 */
export function startVendorCycleManager() {
  const intervalMs = 5 * 60 * 1000; // 5 minutes
  setInterval(() => {
    runVendorCycleTick();
  }, intervalMs);
  // Run once on startup after a short delay to let DB connections settle
  setTimeout(() => {
    runVendorCycleTick();
  }, 10 * 1000);
  console.log('[VendorCycleManager] Started — checking every 5 minutes for expired vendor cycles');
}

/**
 * One-time function to fix currently stuck vendor orders.
 * Call this manually or via a route to clean up existing stuck data.
 */
export async function fixStuckVendorOrders() {
  console.log('[VendorCycleManager] Running one-time fix for stuck vendor orders...');

  const doc = await Setting.findOne({ key: 'vendorOrderConfigs' }).lean();
  if (!doc || !Array.isArray(doc.value)) {
    console.log('[VendorCycleManager] No vendor order configs found');
    return { fixed: 0, archived: 0 };
  }

  const now = nowInTimezone(ORDER_TIMEZONE);
  const today = now.getDay();
  const configs = doc.value;
  let totalFixed = 0;
  let totalArchived = 0;
  const updatedConfigs = [];

  for (const config of configs) {
    const vendorKey = String(config.vendorKey || '').trim();
    if (!vendorKey) {
      updatedConfigs.push(config);
      continue;
    }

    const currentSeq = parseInt(config.seq, 10) || 1;
    const isActive = isVendorConfigActiveNow(config, now, today);

    // Find ALL vendor orders for this vendor that are stuck in submitted status
    // with an old seq (not the current or future seq)
    const allVendorOrders = await Order.find({
      category: 'vendor_orders',
      vendorKey,
      status: { $in: ['submitted', 'draft_shared', 'draft'] },
    }).lean();

    // Group by seq
    const bySeq = {};
    allVendorOrders.forEach((order) => {
      const weekStr = String(order.week || '');
      const seqMatch = weekStr.match(/-VS(\d+)$/i);
      const orderSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;
      if (!bySeq[orderSeq]) bySeq[orderSeq] = [];
      bySeq[orderSeq].push(order);
    });

    for (const [seqStr, orders] of Object.entries(bySeq)) {
      const orderSeq = parseInt(seqStr, 10);

      // Skip current active cycle
      if (isActive && orderSeq === currentSeq) continue;

      // For past sequences: check if they were already sent
      const weekRegex = new RegExp(`-VS${orderSeq}$`, 'i');
      const existingSent = await SupplierOrder.findOne({
        vendorKey,
        week: { $regex: weekRegex },
        sentToSupplier: { $ne: false },
      }).lean();

      const submittedOrders = orders.filter((o) => o.status === 'submitted' || o.status === 'draft_shared');
      const draftOrders = orders.filter((o) => o.status === 'draft');

      if (!existingSent && submittedOrders.length > 0) {
        // Archive the unsent submitted orders
        await archiveUnsentVendorOrders(vendorKey, orderSeq, submittedOrders);
        totalArchived += submittedOrders.length;
      }

      // Delete all these old orders
      const allIds = orders.map((o) => o.id);
      if (allIds.length > 0) {
        await Order.deleteMany({ id: { $in: allIds } });
        totalFixed += allIds.length;
        console.log(`[VendorCycleManager] Fixed: deleted ${allIds.length} stuck orders for vendor ${vendorKey} seq ${orderSeq}`);
      }
    }

    // If the window is not active but enabled, increment seq for fresh start
    if (!isActive && config.enabled !== false) {
      const newSeq = currentSeq + 1;
      updatedConfigs.push({
        ...config,
        seq: newSeq,
        temporaryOpenUntil: null,
        temporaryOpenCreatedAt: null,
        temporaryOpenOnly: false,
      });
      console.log(`[VendorCycleManager] Fix: incremented seq for vendor ${vendorKey}: ${currentSeq} → ${newSeq}`);
    } else {
      updatedConfigs.push(config);
    }
  }

  if (updatedConfigs.length > 0) {
    await Setting.updateOne(
      { key: 'vendorOrderConfigs' },
      { value: updatedConfigs },
      { upsert: true }
    );
  }

  console.log(`[VendorCycleManager] Fix complete: ${totalFixed} orders cleaned up, ${totalArchived} archived`);
  return { fixed: totalFixed, archived: totalArchived };
}
