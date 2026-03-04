import mongoose from 'mongoose';
import Store from './models/store.js';
import User from './models/user.js';
import Item from './models/item.js';
import Supplier from './models/supplier.js';
import Order from './models/order.js';
import Notification from './models/notification.js';
import Setting from './models/setting.js';

// In mongo version we don't need explicit table creation; Mongoose handles it
export async function initializeDatabase() {
  try {
    const uri = process.env.MONGODB_URI;

    if (!uri) {
      throw new Error('MONGODB_URI is missing. Create server/.env and set MONGODB_URI=...');
    }

    // Connect only if not already connected
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 12000,
        socketTimeoutMS: 45000,
        family: 4,
      });
      console.log('MongoDB connected');
    }

    console.log('✓ Database initialized (MongoDB)');
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || String(err.message || '').includes('ENOTFOUND'))) {
      console.error('MongoDB DNS resolution failed. Check MONGODB_URI host and local DNS/network access.');
    }
    console.error('Error initializing database:', err);
    throw err;
  }
}

export async function seedDatabase() {
  try {
    const count = await Store.countDocuments();
    if (count > 0) {
      console.log('Database already seeded');
      return;
    }

    const stores = [
      { id: 'S1', name: 'Downtown Central' },
      { id: 'S2', name: 'Westside Mall' },
      { id: 'S3', name: 'Eastgate Plaza' },
      { id: 'S4', name: 'North Market' },
      { id: 'S5', name: 'Southpoint Hub' },
    ];
    await Store.insertMany(stores);

    const items = [
      { code: 'ITM001', name: 'Basmati Rice 5kg', category: 'Grains', unit: 'Bags' },
      { code: 'ITM002', name: 'Sunflower Oil 1L', category: 'Oils', unit: 'Bottles' },
      { code: 'ITM003', name: 'Whole Wheat Flour 2kg', category: 'Grains', unit: 'Packs' },
      { code: 'ITM004', name: 'Sugar 1kg', category: 'Essentials', unit: 'Packs' },
      { code: 'ITM005', name: 'Toor Dal 1kg', category: 'Pulses', unit: 'Packs' },
      { code: 'ITM006', name: 'Salt 1kg', category: 'Essentials', unit: 'Packs' },
      { code: 'ITM007', name: 'Tea Powder 500g', category: 'Beverages', unit: 'Packs' },
      { code: 'ITM008', name: 'Milk 1L', category: 'Dairy', unit: 'Packets' },
      { code: 'ITM009', name: 'Bread Loaf', category: 'Bakery', unit: 'Pieces' },
      { code: 'ITM010', name: 'Butter 500g', category: 'Dairy', unit: 'Packs' },
      { code: 'ITM011', name: 'Eggs 12 pack', category: 'Dairy', unit: 'Trays' },
      { code: 'ITM012', name: 'Tomato Ketchup 500g', category: 'Condiments', unit: 'Bottles' },
      { code: 'ITM013', name: 'Mixed Spice Box', category: 'Spices', unit: 'Boxes' },
      { code: 'ITM014', name: 'Dish Soap 750ml', category: 'Cleaning', unit: 'Bottles' },
      { code: 'ITM015', name: 'Paper Towels 6 roll', category: 'Cleaning', unit: 'Packs' },
    ];
    await Item.insertMany(items);

    const suppliers = [
      { id: 'SUP1', name: 'Fresh Foods Co', email: 'orders@freshfoods.com', phone: '555-9001' },
      { id: 'SUP2', name: 'Pacific Beverages', email: 'supply@pacbev.com', phone: '555-9002' },
      { id: 'SUP3', name: 'Metro Supplies', email: 'orders@metrosup.com', phone: '555-9003' },
    ];
    await Supplier.insertMany(suppliers);

    const settings = [
      { key: 'scheduleA', value: '0' },
      { key: 'scheduleB', value: '1' },
      { key: 'scheduleC', value: '5' },
      { key: 'messageA', value: 'Order A has to send by Sunday, Monday pickup from Supplier in LA. Delivery to store will be on Wednesday.' },
      { key: 'messageB', value: 'Order B has to send by Monday, Tuesday pickup from Supplier. Delivery to store will be on Thursday.' },
      { key: 'messageC', value: 'Order C has to send by Friday, Saturday pickup from Supplier. Delivery to store will be on Monday.' },
    ];
    await Setting.insertMany(settings);

    const users = [
      { id: 'admin', username: 'admin', password: 'admin123', name: 'System Admin', phone: '555-0100', role: 'admin', storeId: null },
      { id: 'store1', username: 'store1', password: 'pass123', name: 'Ravi Kumar', phone: '555-0101', role: 'manager', storeId: 'S1' },
      { id: 'store2', username: 'store2', password: 'pass123', name: 'Priya Sharma', phone: '555-0102', role: 'manager', storeId: 'S2' },
      { id: 'store3', username: 'store3', password: 'pass123', name: 'Amit Patel', phone: '555-0103', role: 'manager', storeId: 'S3' },
      { id: 'store4', username: 'store4', password: 'pass123', name: 'Sara Nair', phone: '555-0104', role: 'manager', storeId: 'S4' },
      { id: 'store5', username: 'store5', password: 'pass123', name: 'Vikram Singh', phone: '555-0105', role: 'manager', storeId: 'S5' },
    ];
    await User.insertMany(users);

    const notifications = [
      { id: 'notif1', text: "Weekend Sale - extra beverages and snacks for Saturday rush!", type: 'promo', date: new Date('2026-02-06') },
      { id: 'notif2', text: 'Delivery schedule changed: Tuesday orders arrive Wednesday this week.', type: 'info', date: new Date('2026-02-05') },
    ];
    await Notification.insertMany(notifications);

    console.log('✓ Database seeded with demo data');
  } catch (err) {
    console.error('Error seeding database:', err);
    throw err;
  }
}

