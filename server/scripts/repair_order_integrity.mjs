import mongoose from 'mongoose';
import Order from '../models/order.js';
import SupplierOrder from '../models/supplierOrder.js';
import Store from '../models/store.js';
import { getMongoUri } from '../config/databaseConfig.js';

const APPLY = process.argv.includes('--apply');
const CUTOFF_MS = 48 * 60 * 60 * 1000;

function groupKey(parts) {
  return parts.map((part) => String(part ?? '')).join('::');
}

function itemListToMap(items = []) {
  const out = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    const code = String(item && item.itemCode || '').trim();
    const qty = Number(item && item.quantity) || 0;
    if (!code || qty <= 0) return;
    out[code] = (Number(out[code]) || 0) + qty;
  });
  return out;
}

function mapToItemList(items = {}) {
  return Object.entries(items)
    .filter(([, qty]) => (Number(qty) || 0) > 0)
    .map(([itemCode, quantity]) => ({
      itemCode,
      quantity: Number(quantity) || 0,
      unitType: 'cas',
      customUnit: '',
      note: '',
    }));
}

async function expireStaleVegetableOrders() {
  const cutoff = new Date(Date.now() - CUTOFF_MS);
  const orders = await Order.find({
    category: { $in: ['vegetables', 'leaves'] },
    status: { $in: ['submitted', 'draft_shared', 'processed'] },
    $or: [
      { submittedAt: { $lt: cutoff } },
      { submittedAt: null, createdAt: { $lt: cutoff } },
      { submittedAt: { $exists: false }, createdAt: { $lt: cutoff } },
    ],
  }).lean();
  const sent = await SupplierOrder.find({ category: { $in: ['vegetables', 'leaves'] }, finished: true })
    .select({ week: 1, type: 1, category: 1, vendorKey: 1 })
    .lean();
  const sentKeys = new Set(sent.map((log) => groupKey([log.week, log.type, log.category, log.vendorKey || ''])));
  const staleIds = orders
    .filter((order) => !sentKeys.has(groupKey([order.week, order.type, order.category, order.vendorKey || ''])))
    .map((order) => order._id);
  if (APPLY && staleIds.length) {
    await Order.updateMany({ _id: { $in: staleIds } }, { $set: { status: 'expired' } });
  }
  return staleIds.length;
}

async function normalizeWarehouseOrders() {
  const orders = await Order.find({ category: 'warehouse_inventory' }).sort({ submittedAt: -1, createdAt: -1, _id: -1 }).lean();
  const byStoreGroup = new Map();
  orders.forEach((order) => {
    const key = groupKey([order.storeId, order.week, order.category, order.vendorKey || '']);
    if (!byStoreGroup.has(key)) byStoreGroup.set(key, []);
    byStoreGroup.get(key).push(order);
  });

  let mergedGroups = 0;
  let removedDuplicates = 0;
  for (const list of byStoreGroup.values()) {
    if (!list.length) continue;
    const keep = list[0];
    const mergedItems = {};
    list.forEach((order) => {
      const map = itemListToMap(order.items);
      Object.entries(map).forEach(([code, qty]) => {
        mergedItems[code] = (Number(mergedItems[code]) || 0) + (Number(qty) || 0);
      });
    });
    const duplicateIds = list.slice(1).map((order) => order._id);
    if (APPLY) {
      await Order.updateOne(
        { _id: keep._id },
        {
          $set: {
            type: 'INVENTORY',
            items: mapToItemList(mergedItems),
            status: keep.status || 'submitted',
          },
        }
      );
      if (duplicateIds.length) await Order.deleteMany({ _id: { $in: duplicateIds } });
    }
    mergedGroups += 1;
    removedDuplicates += duplicateIds.length;
  }
  return { mergedGroups, removedDuplicates };
}

async function rebuildWarehouseHistory() {
  const stores = await Store.find().lean();
  const storeNameById = Object.fromEntries(stores.map((store) => [String(store.id || ''), store.name || store.id || '']));
  const orders = await Order.find({ category: 'warehouse_inventory' }).lean();
  const byGroup = new Map();
  orders.forEach((order) => {
    const key = groupKey([order.week, order.category, order.vendorKey || '']);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(order);
  });

  let backfilled = 0;
  for (const list of byGroup.values()) {
    if (!list.length) continue;
    const first = list[0];
    const breakdown = {};
    const totals = {};
    list.forEach((order) => {
      const storeId = String(order.storeId || '').trim();
      if (!storeId) return;
      const items = itemListToMap(order.items);
      if (!Object.keys(items).length) return;
      breakdown[storeId] = {
        storeName: storeNameById[storeId] || storeId,
        status: order.status || 'submitted',
        submittedAt: order.submittedAt || order.createdAt || null,
        items,
      };
      Object.entries(items).forEach(([code, qty]) => {
        totals[code] = (Number(totals[code]) || 0) + (Number(qty) || 0);
      });
    });
    if (!Object.keys(breakdown).length) continue;
    if (APPLY) {
      await SupplierOrder.findOneAndUpdate(
        {
          week: first.week,
          category: 'warehouse_inventory',
          vendorKey: first.vendorKey || null,
          sentToSupplier: false,
        },
        {
          $set: {
            supplierName: first.vendorKey || 'Warehouse Inventory',
            email: '',
            emails: [],
            type: 'INVENTORY',
            category: 'warehouse_inventory',
            vendorKey: first.vendorKey || null,
            week: first.week,
            items: totals,
            storeBreakdown: breakdown,
            finished: true,
            sentToSupplier: false,
            sentAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
      const dupes = await SupplierOrder.find({
        week: first.week,
        category: 'warehouse_inventory',
        vendorKey: first.vendorKey || null,
        sentToSupplier: false,
      }).sort({ sentAt: -1, _id: -1 }).lean();
      if (dupes.length > 1) {
        await SupplierOrder.deleteMany({ _id: { $in: dupes.slice(1).map((doc) => doc._id) } });
      }
    }
    backfilled += 1;
  }
  return backfilled;
}

async function main() {
  await mongoose.connect(getMongoUri(), { serverSelectionTimeoutMS: 12000, socketTimeoutMS: 45000, family: 4 });
  const expiredVegetableOrders = await expireStaleVegetableOrders();
  const warehouseOrders = await normalizeWarehouseOrders();
  const warehouseHistoryGroups = await rebuildWarehouseHistory();
  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    expiredVegetableOrders,
    warehouseOrders,
    warehouseHistoryGroups,
  }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
