import nodemailer from 'nodemailer';
import User from '../models/user.js';
import Store from '../models/store.js';
import Supplier from '../models/supplier.js';
import { sendGraphMail } from './msSendMail.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let transportConfig = process.env.SMTP_URL;

if (
  !transportConfig &&
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  transportConfig = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };
}

if (
  !transportConfig &&
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.SMTP_USER &&
  process.env.SMTP_CLIENT_ID &&
  process.env.SMTP_CLIENT_SECRET &&
  process.env.SMTP_REFRESH_TOKEN
) {
  transportConfig = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: {
      type: 'OAuth2',
      user: process.env.SMTP_USER,
      clientId: process.env.SMTP_CLIENT_ID,
      clientSecret: process.env.SMTP_CLIENT_SECRET,
      refreshToken: process.env.SMTP_REFRESH_TOKEN,
    },
  };
}

if (!transportConfig && process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  transportConfig = {
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  };
}

const transporter = nodemailer.createTransport(
  transportConfig || {
    jsonTransport: true,
  }
);

function normalizeRecipientEmails(...inputs) {
  const merged = inputs
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => String(value || '').split(/[;,\n]/))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(merged)];
}

async function sendEmailWithFallback({ to, subject, text, html }) {
  try {
    if (process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.SENDER_EMAIL) {
      return await sendGraphMail({ to, subject, text, html });
    }
  } catch (graphErr) {
    console.error('Graph send failed, falling back to SMTP:', graphErr.message || graphErr);
  }

  return transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@ordermanager.local',
    to,
    subject,
    text,
    html,
  });
}

function formatDayRange(startDay, endDay) {
  if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) return 'the configured vendor window';
  return `${DAYS[startDay] || 'Selected day'} to ${DAYS[endDay] || 'Selected day'}`;
}

async function getWarehouseRecipients() {
  const users = await User.find({ role: 'warehouse', active: true }).select({ email: 1, _id: 0 }).lean();
  return normalizeRecipientEmails(users.map((user) => user && user.email));
}

async function getStoreRecipients() {
  const stores = await Store.find().select({ id: 1, email: 1, _id: 0 }).lean();
  const directRecipients = normalizeRecipientEmails(stores.map((store) => store && store.email));
  const storesMissingEmail = (stores || [])
    .filter((store) => normalizeRecipientEmails(store && store.email).length === 0)
    .map((store) => String(store && store.id || '').trim())
    .filter(Boolean);

  if (!storesMissingEmail.length) {
    return directRecipients;
  }

  const managers = await User.find({
    role: 'manager',
    active: true,
    storeId: { $in: storesMissingEmail },
  }).select({ email: 1, _id: 0 }).lean();

  return normalizeRecipientEmails(directRecipients, managers.map((user) => user && user.email));
}

export async function notifyWarehouseVendorSubmission({ storeId, vendorKey, week, submittedBy }) {
  const recipients = await getWarehouseRecipients();
  if (!recipients.length) return false;

  const [store, supplier] = await Promise.all([
    Store.findOne({ id: storeId }).select({ name: 1, id: 1, _id: 0 }).lean(),
    Supplier.findOne({ id: vendorKey }).select({ name: 1, id: 1, _id: 0 }).lean(),
  ]);

  const storeName = String(store && (store.name || store.id) || storeId || 'Unknown Store').trim();
  const supplierName = String(supplier && (supplier.name || supplier.id) || vendorKey || 'Vendor').trim();
  const actorName = String(submittedBy || '').trim() || 'A store user';

  await sendEmailWithFallback({
    to: recipients,
    subject: `Vendor order submitted: ${storeName} - ${supplierName}`,
    text: [
      `${storeName} submitted a vendor order for ${supplierName}.`,
      week ? `Week: ${week}` : '',
      `Submitted by: ${actorName}`,
    ].filter(Boolean).join('\n'),
  });

  return true;
}

export async function notifyStoresVendorAccess({ vendorKey, startDay, endDay, openToday24h, updatedBy }) {
  const recipients = await getStoreRecipients();
  if (!recipients.length) return false;

  const supplier = await Supplier.findOne({ id: vendorKey }).select({ name: 1, id: 1, _id: 0 }).lean();
  const supplierName = String(supplier && (supplier.name || supplier.id) || vendorKey || 'Vendor').trim();
  const actorName = String(updatedBy || '').trim() || 'Warehouse admin';
  const windowText = openToday24h
    ? 'opened for the next 24 hours'
    : `scheduled for ${formatDayRange(startDay, endDay)}`;

  await sendEmailWithFallback({
    to: recipients,
    subject: `Vendor order open: ${supplierName}`,
    text: [
      `${supplierName} has been ${windowText}.`,
      'You can now place the vendor order in OrderManager during that window.',
      `Updated by: ${actorName}`,
    ].join('\n'),
  });

  return true;
}