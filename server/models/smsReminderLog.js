import mongoose from 'mongoose';

const smsReminderLogSchema = new mongoose.Schema({
  week: { type: String, required: true },
  type: { type: String, required: true },
  storeId: { type: String, required: true },
  slot: { type: Number, required: true }, // 0,1... within reminder window
  mode: { type: String, default: 'auto' }, // auto or manual
  sentAt: { type: Date, default: Date.now },
  phone: { type: String, default: '' },
  message: { type: String, default: '' },
});

smsReminderLogSchema.index({ week: 1, type: 1, storeId: 1, slot: 1, mode: 1 }, { unique: true });

export default mongoose.model('SmsReminderLog', smsReminderLogSchema);

