import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, default: 'vegetables' },
  vendorKey: { type: String, default: null },
  unit: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Item', itemSchema);
