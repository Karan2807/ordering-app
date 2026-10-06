import mongoose from 'mongoose';

const storeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Store', storeSchema);