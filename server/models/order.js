import mongoose from 'mongoose';

const orderItemSchema = new mongoose.Schema({
  itemCode: { type: String, required: true },
  quantity: { type: Number, default: 0 },
});

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  storeId: { type: String, ref: 'Store' },
  type: { type: String, required: true },
  status: { type: String, default: 'draft' },
  week: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  submittedAt: { type: Date },
  items: [orderItemSchema],
});

orderSchema.index({ storeId: 1, type: 1, week: 1 }, { unique: true });

export default mongoose.model('Order', orderSchema);