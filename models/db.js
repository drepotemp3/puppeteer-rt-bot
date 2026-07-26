import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  userId: { type: String, unique: true, sparse: true },
  username: { type: String, unique: true, sparse: true }
}, { timestamps: true });
export const Admin = mongoose.model('Admin', adminSchema);

const botUserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, default: null },
  xUsername: { type: String, default: null },
  xEmail: { type: String, default: null },
  xPassword: { type: String, default: null },
  isLoggedIn: { type: Boolean, default: false },
  lastLoginAt: { type: Date, default: null }
}, { timestamps: true });
export const BotUser = mongoose.model('BotUser', botUserSchema);

const botSettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
export const BotSettings = mongoose.model('BotSettings', botSettingsSchema);

const approvedGroupSchema = new mongoose.Schema({
  chatId: { type: String, required: true, unique: true },
  title: { type: String, default: null },
  username: { type: String, default: null },
  isApproved: { type: Boolean, default: false },
  lastGifUsed: { type: String, default: null }
}, { timestamps: true });
export const ApprovedGroup = mongoose.model('ApprovedGroup', approvedGroupSchema);

export async function connectDB() {
  mongoose.set('runValidators', true);
  const serverSelectionTimeoutMS = Math.max(10_000, Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 120_000));
  const connectTimeoutMS = Math.max(10_000, Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 120_000));
  const socketTimeoutMS = Math.max(10_000, Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 120_000));
  const heartbeatFrequencyMS = Math.max(5_000, Number(process.env.MONGO_HEARTBEAT_FREQUENCY_MS || 10_000));
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: 'retweetbot',
    serverSelectionTimeoutMS,
    connectTimeoutMS,
    socketTimeoutMS,
    heartbeatFrequencyMS,
  });
  console.log('✅ Connected to MongoDB');
}
