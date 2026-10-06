import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { getMongoUri } from './config/databaseConfig.js';

dotenv.config();

let mongoUri;
try {
  mongoUri = getMongoUri();
} catch (err) {
  console.error(`Database configuration error: ${err.message}`);
  process.exit(1);
}

if (!mongoUri) {
  console.error('Database URI is not set. Cannot connect to database.');
  process.exit(1);
}

mongoose.set('strictQuery', false); // optional to silence deprecation warnings

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;

db.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

db.once('open', () => {
  console.log('MongoDB connected');
});

export default mongoose;
