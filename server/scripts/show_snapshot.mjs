import 'dotenv/config';
import mongoose from 'mongoose';
import { getMongoUri } from '../config/databaseConfig.js';

// Use MONGODB_URI directly so it works in dev mode too (same as check script)
const uri = process.env.MONGODB_URI || getMongoUri();
await mongoose.connect(uri);

const SupplierOrder = mongoose.model('SupplierOrder', new mongoose.Schema({
  snapshotLines: [String],
  items: mongoose.Schema.Types.Mixed,
}, { strict: false }));

const doc = await SupplierOrder.findOne({ week: '2026-04-19-VS1' }).lean();
if (!doc) { console.log('NOT FOUND'); await mongoose.disconnect(); process.exit(1); }
console.log('Found _id:', String(doc._id));
console.log('=== snapshotLines ===');
(doc.snapshotLines || []).forEach((l, i) => console.log(`${String(i+1).padStart(3)}: ${l}`));
console.log('\n=== items field ===');
console.log(JSON.stringify(doc.items, null, 2));
await mongoose.disconnect();
