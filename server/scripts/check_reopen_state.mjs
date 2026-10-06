/**
 * Check current state of Xpressions order restoration
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/databaseConfig.js';

const uri = process.env.MONGODB_URI || getMongoUri();
await mongoose.connect(uri);
console.log('Connected.\n');

const SupplierOrder = mongoose.model('SupplierOrder', new mongoose.Schema({}, { strict: false }));
const Order = mongoose.model('Order', new mongoose.Schema({}, { strict: false }));
const Store = mongoose.model('Store', new mongoose.Schema({}, { strict: false }));

// 1. Check the SupplierOrder record
const so = await SupplierOrder.findOne({ week: '2026-04-19-VS1', category: 'vendor_orders' }).lean();
console.log('=== SupplierOrder ===');
console.log(`  _id:            ${so?._id}`);
console.log(`  supplierName:   ${so?.supplierName}`);
console.log(`  type:           ${so?.type}`);
console.log(`  vendorKey:      ${so?.vendorKey}`);
console.log(`  week:           ${so?.week}`);
console.log(`  finished:       ${so?.finished}`);
console.log(`  sentToSupplier: ${so?.sentToSupplier}`);
console.log(`  storeBreakdown: ${so?.storeBreakdown && Object.keys(so.storeBreakdown).length > 0 ? 'YES' : 'null'}`);
console.log(`  snapshotLines:  ${(so?.snapshotLines||[]).length} lines`);

// 2. Check all stores in DB
const stores = await Store.find().lean();
console.log('\n=== Stores in DB ===');
stores.forEach(s => console.log(`  id: ${String(s.id||'').padEnd(6)}  name: ${s.name}`));

// Build name→id map
const storeIdByName = Object.fromEntries(stores.map(s => [String(s.name||s.id||'').toLowerCase(), String(s.id||'')]));
console.log('\n  storeIdByName map:', JSON.stringify(storeIdByName));

// 3. Check what Order documents exist for this vendor/week
const orders = await Order.find({ week: '2026-04-19-VS1' }).lean();
console.log(`\n=== Order documents for week 2026-04-19-VS1 ===`);
console.log(`  Found: ${orders.length}`);
orders.forEach(o => {
  const nonZero = (o.items||[]).filter(i => (i.quantity||0) > 0);
  console.log(`  storeId: ${o.storeId}  type: ${o.type}  vendorKey: ${o.vendorKey}  status: ${o.status}  items>0: ${nonZero.length}`);
});

// 4. Also check ALL orders for vendorKey=10
const allVendorOrders = await Order.find({ vendorKey: so?.vendorKey, category: 'vendor_orders' }).lean();
console.log(`\n=== All Order docs for vendorKey=${so?.vendorKey} ===`);
allVendorOrders.forEach(o => {
  const nonZero = (o.items||[]).filter(i => (i.quantity||0) > 0);
  console.log(`  week: ${o.week}  storeId: ${o.storeId}  type: ${o.type}  status: ${o.status}  items>0: ${nonZero.length}`);
});

// 5. Simulate snapshotLines parse with the real store map
console.log('\n=== Simulating parseVendorSnapshotLines with store name map ===');
const lines = so?.snapshotLines || [];
let currentKey = null;
const breakdown = {};
for (const line of lines) {
  if (!line.startsWith(' ') && !line.startsWith('\t') && line.endsWith(':')) {
    const match = line.match(/^(.+?)\s*\(([^)]+)\)\s*:$/);
    if (match) {
      const storeName = match[1].trim();
      const storeId = storeIdByName[storeName.toLowerCase()] || storeName;
      currentKey = storeId;
      breakdown[currentKey] = { storeName, storeId, items: {} };
    }
  } else if ((line.startsWith('  ') || line.startsWith('\t')) && currentKey) {
    const trimmed = line.trim();
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon === -1) continue;
    const itemCode = trimmed.substring(0, lastColon).trim();
    const qty = parseInt(trimmed.substring(lastColon + 1).trim(), 10);
    if (itemCode && !Number.isNaN(qty) && qty > 0) breakdown[currentKey].items[itemCode] = qty;
  }
}
Object.entries(breakdown).forEach(([storeId, data]) => {
  console.log(`  storeId: "${storeId}"  storeName: "${data.storeName}"  items: ${Object.keys(data.items).length}`);
});
if (Object.keys(breakdown).length === 0) console.log('  NO stores parsed!');

await mongoose.disconnect();
console.log('\nDone.');
