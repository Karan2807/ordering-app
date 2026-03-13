import Setting from '../models/setting.js';
import Store from '../models/store.js';
import User from '../models/user.js';
import Order from '../models/order.js';
import SmsReminderLog from '../models/smsReminderLog.js';
import { sendSms } from './sms.js';

function isoWeekKeyForDateLocal(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function nowInTimezone(tz) {
  const text = new Date().toLocaleString('en-US', { timeZone: tz });
  return new Date(text);
}

async function getSettingsMap(keys) {
  const docs = await Setting.find({ key: { $in: keys } }).lean();
  const map = {};
  docs.forEach((d) => {
    map[d.key] = d.value;
  });
  return map;
}

async function getPendingManagersForOrder(type, weekKey, category = 'vegetables', vendorKey = null) {
  const stores = await Store.find().lean();
  const orders = await Order.find({ type, week: weekKey, category, vendorKey: vendorKey || null }).lean();
  const users = await User.find({ role: 'manager', active: true }).lean();
  const orderByStore = {};
  orders.forEach((o) => {
    orderByStore[o.storeId] = o;
  });
  return stores
    .map((st) => {
      const mgr = users.find((u) => u.storeId === st.id);
      const o = orderByStore[st.id];
      const isPending = !o || (o.status !== 'submitted' && o.status !== 'processed' && o.status !== 'draft_shared');
      if (!mgr || !isPending) return null;
      return { store: st, manager: mgr };
    })
    .filter(Boolean);
}

function reminderMessage(type, storeName, category = 'vegetables', vendorKey = null) {
  if (category === 'vendor_orders') {
    return `Reminder: Vendor order${vendorKey ? ` for ${vendorKey}` : ''} for ${storeName} is still pending. Please submit before close time.`;
  }
  return `Reminder: Order ${type} for ${storeName} is still pending. Please submit before close time.`;
}

function composeWeekKeyForType(baseWeekKey, type, manualOpenOrder, manualOpenSeq) {
  if (manualOpenOrder && manualOpenSeq && manualOpenOrder === type) {
    return `${baseWeekKey}-M${manualOpenSeq}`;
  }
  return baseWeekKey;
}

export async function sendManualReminders({ type, storeId = null, category = 'vegetables', vendorKey = null }) {
  const map = await getSettingsMap(['manualOpenOrder', 'manualOpenSeq']);
  const seq = parseInt(map.manualOpenSeq, 10);
  const weekKey = composeWeekKeyForType(
    isoWeekKeyForDateLocal(new Date()),
    type,
    map.manualOpenOrder || null,
    Number.isNaN(seq) ? null : seq
  );
  const pending = await getPendingManagersForOrder(type, weekKey, category, vendorKey);
  const targets = storeId ? pending.filter((x) => x.store.id === storeId) : pending;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];
  for (const t of targets) {
    const msg = reminderMessage(type, t.store.name, category, vendorKey);
    const res = await sendSms({ to: t.manager.phone, body: msg });
    if (res.ok) {
      sent += 1;
      await SmsReminderLog.create({
        week: weekKey,
        type,
        category,
        vendorKey: vendorKey || null,
        storeId: t.store.id,
        slot: -1,
        mode: 'manual',
        phone: t.manager.phone || '',
        message: msg,
      }).catch(() => {});
    } else {
      failed += 1;
      if (res.skipped) skipped += 1;
      errors.push({
        storeId: t.store.id,
        store: t.store.name,
        phone: t.manager.phone || '',
        error: res.error || 'SMS failed',
      });
    }
  }
  return { sent, failed, skipped, total: targets.length, errors };
}

async function runAutoReminderTick() {
  const tz = process.env.ORDER_TIMEZONE || 'America/Los_Angeles';
  const closeHour = Number(process.env.ORDER_CLOSE_HOUR_LOCAL || 23);
  const closeMinute = Number(process.env.ORDER_CLOSE_MINUTE_LOCAL || 0);
  const now = nowInTimezone(tz);
  const day = now.getDay();
  const minsNow = now.getHours() * 60 + now.getMinutes();
  const closeMins = closeHour * 60 + closeMinute;
  const windowStart = closeMins - 60;
  if (minsNow < windowStart || minsNow > closeMins) return;
  const slot = Math.floor((minsNow - windowStart) / 30); // 0 or 1 (or 2 if exact close + drift)

  const map = await getSettingsMap(['scheduleA', 'scheduleB', 'scheduleC', 'manualOpenOrder', 'manualOpenSeq']);
  const sched = {
    A: parseInt(map.scheduleA, 10),
    B: parseInt(map.scheduleB, 10),
    C: parseInt(map.scheduleC, 10),
  };
  let type = null;
  if (map.manualOpenOrder && ['A', 'B', 'C'].includes(String(map.manualOpenOrder))) {
    type = String(map.manualOpenOrder);
  } else {
    type = ['A', 'B', 'C'].find((t) => sched[t] === day) || null;
  }
  if (!type) return;

  const weekBase = isoWeekKeyForDateLocal(now);
  const manualType = map.manualOpenOrder || null;
  const seq = parseInt(map.manualOpenSeq, 10);
  const weekKey = composeWeekKeyForType(weekBase, type, manualType, Number.isNaN(seq) ? null : seq);
  const pending = await getPendingManagersForOrder(type, weekKey, 'vegetables', null);
  for (const t of pending) {
    const exists = await SmsReminderLog.findOne({ week: weekKey, type, storeId: t.store.id, slot, mode: 'auto' }).lean();
    if (exists) continue;
    const msg = reminderMessage(type, t.store.name);
    const res = await sendSms({ to: t.manager.phone, body: msg });
    if (res.ok) {
      await SmsReminderLog.create({
        week: weekKey,
        type,
        storeId: t.store.id,
        slot,
        mode: 'auto',
        phone: t.manager.phone || '',
        message: msg,
      }).catch(() => {});
    }
  }
}

export function startReminderScheduler() {
  const intervalMs = 60 * 1000;
  setInterval(() => {
    runAutoReminderTick().catch((e) => {
      console.error('Auto reminder tick failed:', e);
    });
  }, intervalMs);
  // run once on startup too
  runAutoReminderTick().catch((e) => {
    console.error('Initial auto reminder tick failed:', e);
  });
}
