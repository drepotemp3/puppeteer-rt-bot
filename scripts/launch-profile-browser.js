
import puppeteer from 'puppeteer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_DIR = process.env.CHROME_USER_DATA_DIR 
  || path.join(os.homedir(), '.retweet-bot-chrome-profile');
const PROFILE_SEED_DIR = process.env.CHROME_PROFILE_SEED_DIR 
  || path.join(__dirname, '..', 'profile-seed');

// Make sure directories exist
[PROFILE_DIR, PROFILE_SEED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

console.log('========================================');
console.log('🚀 Manual Login Browser Launcher');
console.log('========================================');
console.log('\n📂 Using Profile Directory:', PROFILE_DIR);
console.log('📂 Profile Seed Directory:', PROFILE_SEED_DIR);
console.log('\nInstructions:');
console.log('1. Log in to X/Twitter manually in the opened browser');
console.log('2. Verify you are fully logged in (go to https://x.com/home)');
console.log('3. Close the browser completely');
console.log('4. Copy the contents of', PROFILE_DIR, 'to', PROFILE_SEED_DIR);
console.log('5. Commit and push your changes to deploy to Render');
console.log('\n========================================\n');

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
    defaultViewport: null
  });

  const page = await browser.newPage();
  await page.goto('https://x.com', { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('✅ Browser launched successfully!');
  console.log('   Waiting for you to log in manually...');
}

launchBrowser().catch(err => {
  console.error('❌ Error launching browser:', err);
  process.exit(1);
});

