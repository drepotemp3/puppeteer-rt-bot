import 'dotenv/config';
import { Telegraf } from 'telegraf';
import express from 'express';
import { connectDB, Admin, BotUser } from './models/db.js';
import { setupBot } from './bot/handlers.js';
import launchBot from './bot/launchBot.js';
import { loginToX } from './helpers/puppeteer.js';

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

app.get('/ping', (req, res) => res.send('pong'));
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

async function autoLoginIfCredsExist() {
  // Find any BotUser with X credentials
  const userWithCreds = await BotUser.findOne({ 
    xEmail: { $exists: true, $ne: null }, 
    xPassword: { $exists: true, $ne: null } 
  });
  
  if (userWithCreds) {
    console.log('🔑 Found X credentials, attempting auto-login...');
    try {
      const loggedIn = await loginToX(userWithCreds.userId);
      if (loggedIn) {
        console.log('✅ Auto-login successful!');
      } else {
        console.log('⚠️ Auto-login failed, check credentials');
      }
    } catch (err) {
      console.error('❌ Auto-login error:', err.message);
    }
  } else {
    console.log('ℹ️ No X credentials found, skipping auto-login');
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

// Auto-login after bot is launched
autoLoginIfCredsExist();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
