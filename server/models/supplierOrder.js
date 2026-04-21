import mongoose from 'mongoose';

const supplierOrderSchema = new mongoose.Schema({
  supplierName: { type: String, required: true },
  email: { type: String, required: true },
  emails: { type: [String], default: [] },
  type: { type: String, required: true }, // A, B, C etc
  category: { type: String, default: 'vegetables' },
  vendorKey: { type: String, default: null },
  week: { type: String, required: true },
  items: { type: mongoose.Schema.Types.Mixed, default: {} },
  reopenedFromId: { type: String, default: null },
  snapshotLines: { type: [String], default: [] },
  excelBase64: { type: String, default: null },
  excelFilename: { type: String, default: null },
  excelContentType: { type: String, default: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  monitorSnapshotLines: { type: [String], default: [] },
  monitorExcelBase64: { type: String, default: null },
  monitorExcelFilename: { type: String, default: null },
  monitorExcelContentType: { type: String, default: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  sentAt: { type: Date, default: Date.now },
  finished: { type: Boolean, default: true },
  sentToSupplier: { type: Boolean, default: true },
  storeBreakdown: { type: mongoose.Schema.Types.Mixed, default: null },
});

export default mongoose.model('SupplierOrder', supplierOrderSchema);
