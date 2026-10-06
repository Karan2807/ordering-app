import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  emails: { type: [String], default: [] },
  phone: { type: String },
  categories: { type: [String], default: [] },
  items: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Supplier', supplierSchema);
