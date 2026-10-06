import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  text: { type: String, required: true },
  type: { type: String, default: 'info' },
  date: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Notification', notificationSchema);