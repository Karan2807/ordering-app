/**
 * Checks all archived unsent vendor orders across the DB.
 * Usage: node scripts/check_all_archived_orders.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/databaseConfig.js';

const uri = process.env.MONGODB_URI || getMongoUri();
await mongoose.connect(uri);
console.log('Connected.\n');

const SupplierOrder = mongoose.model('SupplierOrder', new mongoose.Schema({}, { strict: false }));

// All SupplierOrders for vendor_orders (sent OR unsent)
const all = await SupplierOrder.find({ category: 'vendor_orders' })
  .sort({ sentAt: -1 })
  .lean();

console.log(`Total vendor_orders SupplierOrder records: ${all.length}\n`);

let hasBreakdown = 0, hasSnapshotOnly = 0, hasExcel = 0, hasBoth = 0, hasNothing = 0;

all.forEach(o => {
  const bd = o.storeBreakdown && typeof o.storeBreakdown === 'object' && Object.keys(o.storeBreakdown).length > 0;
  const sn = o.snapshotLines && o.snapshotLines.length > 0;
  const xl = !!(o.excelBase64 || o.monitorExcelBase64);
  if (bd) hasBreakdown++;
  if (xl) hasExcel++;
  if (bd && sn) hasBoth++;
  if (!bd && sn) hasSnapshotOnly++;
  if (!bd && !sn && !xl) hasNothing++;
});

console.log(`  storeBreakdown stored (new code):  ${hasBreakdown}`);
console.log(`  snapshotLines only (old code):     ${hasSnapshotOnly}  ← fixed by parseVendorSnapshotLines`);
console.log(`  Excel/DOCX file attached:          ${hasExcel}  ← already worked`);
console.log(`  both breakdown + snapshot:         ${hasBoth}`);
console.log(`  nothing (no data at all):          ${hasNothing}`);

console.log('\n--- Per-record summary (unsent, sentToSupplier=false) ---');
const unsent = all.filter(o => o.sentToSupplier === false);
console.log(`Unsent archived records: ${unsent.length}\n`);
unsent.forEach(o => {
  const bd = o.storeBreakdown && Object.keys(o.storeBreakdown).length > 0;
  const sn = (o.snapshotLines || []).length;
  const xl = !!(o.excelBase64 || o.monitorExcelBase64);
  const dataSource = bd ? 'storeBreakdown' : sn > 0 ? `snapshotLines(${sn})` : xl ? 'excelFile' : 'NONE';
  console.log(`  ${String(o.sentAt||'').slice(0,10)}  ${(o.supplierName||'').padEnd(20)}  week: ${(o.week||'').padEnd(18)}  data: ${dataSource}`);
});

await mongoose.disconnect();
console.log('\nDone.');
