import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Supplier', supplierSchema);