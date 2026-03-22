import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Setting from '../models/setting.js';
import { getMongoUri } from '../config/databaseConfig.js';

dotenv.config();

const LEGACY_VENDOR_SETTING_KEYS = [
  'vendorOrdersOpenVendor',
  'vendorOrdersOpenVendors',
  'vendorOrdersWindowStartDay',
  'vendorOrdersWindowEndDay',
];

async function run() {
  const applyMode = process.argv.includes('--apply');
  const uri = getMongoUri();

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 12000,
    socketTimeoutMS: 45000,
    family: 4,
  });

  const docs = await Setting.find({ key: { $in: LEGACY_VENDOR_SETTING_KEYS } })
    .select({ _id: 1, key: 1, value: 1 })
    .lean();

  const byKey = LEGACY_VENDOR_SETTING_KEYS.reduce((acc, key) => {
    acc[key] = docs.find((doc) => doc.key === key) || null;
    return acc;
  }, {});

  console.log('Legacy vendor setting key scan:');
  LEGACY_VENDOR_SETTING_KEYS.forEach((key) => {
    const entry = byKey[key];
    if (!entry) {
      console.log(`- ${key}: not found`);
      return;
    }
    console.log(`- ${key}: found (id=${entry._id}) value=${JSON.stringify(entry.value)}`);
  });

  if (!applyMode) {
    console.log('\nDry-run complete. No data changed.');
    console.log('Run with --apply to delete these legacy keys.');
    return;
  }

  const result = await Setting.deleteMany({ key: { $in: LEGACY_VENDOR_SETTING_KEYS } });
  console.log(`\nDeleted ${result.deletedCount || 0} legacy setting document(s).`);
}

run()
  .catch((err) => {
    console.error('cleanup_vendor_legacy_settings failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_err) {
      // no-op
    }
  });
