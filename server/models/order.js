import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  itemCode: { type: String, required: true },
  quantity: { type: Number, default: 0 },
  unitType: {
    type: String,
    default: 'cas',
    enum: ['cas', 'pcs', 'pallet', 'master_case', 'other'],
  },
  customUnit: { type: String, default: '' },
  note: { type: String, default: '' },
});

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  storeId: { type: String, ref: 'Store' },
  type: { type: String, required: true },
  category: { type: String, default: 'vegetables' },
  vendorKey: { type: String, default: null },
  status: { type: String, default: 'draft' },
  week: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  submittedAt: { type: Date },
  items: [orderItemSchema],
});

orderSchema.index({ storeId: 1, type: 1, category: 1, vendorKey: 1, week: 1 }, { unique: true });
orderSchema.index({ submittedAt: -1, createdAt: -1 });
orderSchema.index({ category: 1, status: 1, submittedAt: -1 });
orderSchema.index({ category: 1, vendorKey: 1, week: 1, type: 1 });
orderSchema.index({ status: 1, category: 1, storeId: 1, type: 1 });

export default mongoose.model('Order', orderSchema);
