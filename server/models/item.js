import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, default: 'vegetables' },
  vendorKey: { type: String, default: null },
  subheading: { type: String, default: '' },
  sortOrder: { type: Number, default: null },
  unit: { type: String },
  inventoryCount: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Item', itemSchema);
