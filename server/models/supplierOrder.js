import mongoose from 'mongoose';

const supplierOrderSchema = new mongoose.Schema({
  supplierName: { type: String, required: true },
  email: { type: String, required: true },
  emails: { type: [String], default: [] },
  type: { type: String, required: true }, // A, B, C etc
  week: { type: String, required: true },
  items: { type: mongoose.Schema.Types.Mixed, default: {} },
  reopenedFromId: { type: String, default: null },
  snapshotLines: { type: [String], default: [] },
  excelBase64: { type: String, default: null },
  excelFilename: { type: String, default: null },
  sentAt: { type: Date, default: Date.now },
  finished: { type: Boolean, default: true },
});

export default mongoose.model('SupplierOrder', supplierOrderSchema);
