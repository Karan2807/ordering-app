/**
 * Diagnostic: Check Xpressions 2026-04-19-VS1 order data in MongoDB
 * Usage: node server/scripts/check_xpressions_order.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/databaseConfig.js';

const WEEK = '2026-04-19-VS1';
const VENDOR_NAME_PATTERN = /xpression/i;

// Allow passing URI directly: MONGODB_URI=xxx node scripts/check_xpressions_order.mjs
const uri = process.env.MONGODB_URI || getMongoUri();
console.log(`Connecting to: ${uri.replace(/\/\/[^@]+@/, '//<credentials>@')}\n`);
await mongoose.connect(uri);
console.log('Connected to MongoDB.\n');

// 1. Check SupplierOrder records for this week
const SupplierOrder = mongoose.model('SupplierOrder', new mongoose.Schema({
  supplierName: String,
  email: String,
  type: String,
  category: String,
  vendorKey: String,
  week: String,
  items: mongoose.Schema.Types.Mixed,
  storeBreakdown: mongoose.Schema.Types.Mixed,
  sentAt: Date,
  finished: Boolean,
  sentToSupplier: Boolean,
  snapshotLines: [String],
  excelBase64: String,
}, { strict: false }));

const supplierOrders = await SupplierOrder.find({ week: WEEK }).lean();
console.log(`=== SupplierOrders for week ${WEEK} ===`);
console.log(`Total found: ${supplierOrders.length}`);
if (supplierOrders.length === 0) {
  // Try broader search by supplier name
  const byName = await SupplierOrder.find({
    supplierName: { $regex: VENDOR_NAME_PATTERN }
  }).sort({ sentAt: -1 }).limit(5).lean();
  console.log(`\nSearching by name "xpression" (last 5):`);
  byName.forEach(o => {
    console.log(`  _id: ${o._id}  week: ${o.week}  sentAt: ${o.sentAt}  sentToSupplier: ${o.sentToSupplier}  storeBreakdown: ${o.storeBreakdown ? 'YES' : 'null'}`);
  });
} else {
  supplierOrders.forEach(o => {
    const hasBreakdown = o.storeBreakdown && Object.keys(o.storeBreakdown).length > 0;
    const hasExcel = !!o.excelBase64;
    const hasSnapshot = o.snapshotLines && o.snapshotLines.length > 0;
    console.log(`\n  _id:            ${o._id}`);
    console.log(`  supplierName:   ${o.supplierName}`);
    console.log(`  category:       ${o.category}`);
    console.log(`  vendorKey:      ${o.vendorKey}`);
    console.log(`  type:           ${o.type}`);
    console.log(`  sentAt:         ${o.sentAt}`);
    console.log(`  sentToSupplier: ${o.sentToSupplier}`);
    console.log(`  finished:       ${o.finished}`);
    console.log(`  storeBreakdown: ${hasBreakdown ? 'YES — ' + Object.keys(o.storeBreakdown).length + ' stores' : 'null / empty'}`);
    console.log(`  excelBase64:    ${hasExcel ? 'YES (' + Math.round(o.excelBase64.length / 1024) + ' KB)' : 'null'}`);
    console.log(`  snapshotLines:  ${hasSnapshot ? o.snapshotLines.length + ' lines' : 'empty'}`);
    if (hasBreakdown) {
      console.log(`  storeBreakdown stores:`);
      Object.entries(o.storeBreakdown).forEach(([storeId, data]) => {
        const items = data.items || {};
        const itemCount = Object.entries(items).filter(([, qty]) => (Number(qty) || 0) > 0).length;
        console.log(`    storeId: ${storeId}  storeName: ${data.storeName || '-'}  items: ${itemCount}`);
      });
    }
  });
}

// 2. Check live Order documents for this week
const Order = mongoose.model('Order', new mongoose.Schema({
  id: String,
  storeId: String,
  type: String,
  category: String,
  vendorKey: String,
  week: String,
  status: String,
  items: mongoose.Schema.Types.Mixed,
}, { strict: false }));

// Find any vendor_orders orders for this week
const liveOrders = await Order.find({ week: WEEK, category: 'vendor_orders' }).lean();
console.log(`\n=== Live Order documents for week ${WEEK} (category=vendor_orders) ===`);
console.log(`Total found: ${liveOrders.length}`);
liveOrders.forEach(o => {
  const nonZeroItems = (o.items || []).filter(i => (i.quantity || 0) > 0);
  console.log(`  storeId: ${o.storeId}  vendorKey: ${o.vendorKey}  status: ${o.status}  items with qty>0: ${nonZeroItems.length}`);
});

// 3. Also check for VS1 pattern in case week key differs slightly
const liveOrdersVS = await Order.find({ week: { $regex: 'VS1', $options: 'i' } }).lean();
if (liveOrdersVS.length !== liveOrders.length) {
  console.log(`\nNote: Found ${liveOrdersVS.length} orders matching '*VS1*' across all weeks — some may use a slightly different week key.`);
  const different = liveOrdersVS.filter(o => o.week !== WEEK);
  different.forEach(o => {
    console.log(`  week: "${o.week}"  storeId: ${o.storeId}  vendorKey: ${o.vendorKey}  status: ${o.status}`);
  });
}

await mongoose.disconnect();
console.log('\nDone.');
