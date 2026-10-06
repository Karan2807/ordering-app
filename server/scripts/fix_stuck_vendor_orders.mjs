/**
 * One-time migration script to fix stuck vendor orders from previous weeks.
 *
 * What it does:
 * 1. Finds vendor orders that are in 'submitted'/'draft_shared' status
 *    from expired cycles (where the schedule window has closed)
 * 2. Archives them to SupplierOrder history with sentToSupplier=false
 * 3. Deletes the stuck orders so stores see fresh forms next cycle
 * 4. Increments the seq in vendorOrderConfigs for inactive vendors
 *
 * Usage:
 *   node server/scripts/fix_stuck_vendor_orders.mjs
 *
 * Safe to run multiple times — it won't re-archive orders that already
 * have a SupplierOrder record.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/databaseConfig.js';

async function main() {
  const uri = getMongoUri();
  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('Connected.');

  // Import after connection
  const { fixStuckVendorOrders } = await import('../services/vendorCycleManager.js');

  const result = await fixStuckVendorOrders();
  console.log('Result:', JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
