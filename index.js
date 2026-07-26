import 'dotenv/config';
import { Telegraf } from 'telegraf';
import express from 'express';
import { connectDB, Admin, BotUser } from './models/db.js';
import { setupBot } from './bot/handlers.js';
import launchBot from './bot/launchBot.js';
import { loginToX } from './helpers/puppeteer.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
app.use(express.json({ limit: '512kb' }));

app.get('/ping', (req, res) => res.send('pong'));

// #region debug-point x-login-not-typing-server
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_LOG_PATH = path.join(__dirname, 'trae-debug-log-x-login-not-typing.ndjson');
app.post('/__debug', async (req, res) => {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...req.body });
    await fs.appendFile(DEBUG_LOG_PATH, `${line}\n`).catch(() => {});
  } catch (e) {}
  res.status(204).end();
});
// #endregion debug-point x-login-not-typing-server
const PORT = Number(process.env.port || process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

async function connectWithRetry() {
  while (true) {
    try {
      await connectDB();
      return;
    } catch (err) {
      console.error(`MongoDB connection failed: ${err.message} — retrying in 10s`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

async function seedAdmin() {
  const adminId = '1632962204';
  const adminUsername = 'endurenow';
  let admin = await Admin.findOne({ userId: adminId });
  if (!admin) {
    admin = new Admin({ userId: adminId, username: adminUsername });
    await admin.save();
    console.log(`✅ Seeded admin: @${adminUsername} (${adminId})`);
  }
}

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

await connectWithRetry();
await seedAdmin();
setupBot(bot);
launchBot(bot);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
