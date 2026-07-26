import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer';
import { connect } from 'puppeteer-real-browser';

function envFlag(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).toLowerCase() === 'true';
}

async function resetZoom(page) {
  if (!page) return;
  await page.bringToFront().catch(() => {});
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('Digit0');
    await page.keyboard.up('Control');
  } catch (err) {}
}

async function safeClick(page, selector) {
  await page.waitForSelector(selector, { timeout: 60000 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }, selector);
  await page.click(selector);
}

async function scrollTimeline(page) {
  await new Promise((r) => setTimeout(r, 4500));
  await page.evaluate(() => window.scrollTo(0, Math.max(1200, window.innerHeight * 2)));
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.scrollTo(0, Math.max(2400, window.innerHeight * 4)));
  await new Promise((r) => setTimeout(r, 800));
}

async function typeIntoComposer(page, selector, text) {
  await page.bringToFront().catch(() => {});
  await safeClick(page, selector);

  const handle = await page.$(selector);
  if (!handle) throw new Error(`Composer not found: ${selector}`);

  await handle.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 25 });

  await new Promise((r) => setTimeout(r, 600));
}

async function waitForUploadToSettle(page, timeoutMs = 60000) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    await page.waitForSelector('button[aria-label="Remove media"]', { timeout: timeoutMs });
  } catch (err) {
    await page.waitForFunction(
      () => {
        const progress = document.querySelector('[role="progressbar"]');
        if (!progress) return true;
        const now = progress.getAttribute('aria-valuenow');
        if (now != null && Number(now) >= 100) return true;
        const bar = progress.querySelector('[data-testid="progressBar-bar"]');
        const width = bar?.style?.width;
        if (width && width.includes('%') && Number(width.replace('%', '')) >= 99) return true;
        return false;
      },
      { timeout: timeoutMs }
    );
  }
  await new Promise((r) => setTimeout(r, 400));
}

function getUserDataDir() {
  return process.env.CHROME_USER_DATA_DIR
    || process.env.BROWSER_PROFILE_DIR
    || path.join(os.homedir(), '.retweet-bot-chrome-profile');
}

function resolvePath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

async function resolveChromePath() {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const pptrPath = await puppeteer.executablePath();
  if (pptrPath && fs.existsSync(pptrPath)) return pptrPath;
  throw new Error('No Chrome executable found. Run `npx puppeteer browsers install chrome` or set PUPPETEER_EXECUTABLE_PATH.');
}

async function main() {
  const headless = envFlag('HEADLESS', false);
  const keepOpen = envFlag('KEEP_OPEN', true);
  const composeText = process.env.COMPOSE_TEXT || 'testing...';
  const mediaPath = resolvePath(process.env.MEDIA_PATH || 'assets/gifs/7.gif');

  if (!mediaPath || !fs.existsSync(mediaPath)) {
    throw new Error(`MEDIA_PATH missing or not found: ${mediaPath}`);
  }
  const mediaBytes = fs.statSync(mediaPath).size;

  const userDataDir = getUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  const chromePath = await resolveChromePath();
  const { browser, page } = await connect({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(headless ? ['--window-size=1920,1080'] : ['--start-maximized'])
    ],
    customConfig: {
      userDataDir,
      chromePath
    },
    turnstile: true,
    connectOption: {
      defaultViewport: null,
      protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000)
    }
  });

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    );

    console.log(`Media: ${mediaPath}`);
    console.log(`Media size: ${(mediaBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log('Opening home...');
    await resetZoom(page);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 60000 });
    await scrollTimeline(page);
    console.log('Opening composer modal...');
    await safeClick(page, 'a[data-testid="SideNav_NewTweet_Button"][href="/compose/post"]');
    await page.waitForSelector('[data-testid="toolBar"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 60000 });

    await page.waitForSelector('input[data-testid="fileInput"][type="file"]', { timeout: 60000 });
    const fileInputSelector = 'input[data-testid="fileInput"][type="file"]';

    let uploaded = false;
    try {
      console.log('Uploading via chooser...');
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 5000 }),
        page.click('button[aria-label="Add photos or video"]')
      ]);
      await chooser.accept([mediaPath]);
      uploaded = true;
    } catch (err) {}

    if (!uploaded) {
      console.log('Uploading via file input...');
      const input = await page.$(fileInputSelector);
      if (!input) throw new Error('fileInput not found');
      await input.uploadFile(mediaPath);
    }

    console.log('Waiting for upload to settle...');
    await waitForUploadToSettle(page, 60000);

    const imageFailed = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return text.includes('your image file could not be processed');
    });
    if (imageFailed) {
      throw new Error('X rejected the uploaded media: "Your image file could not be processed"');
    }

    console.log('Typing caption...');
    await typeIntoComposer(page, '[data-testid="tweetTextarea_0"]', composeText);

    await page.waitForSelector('button[data-testid="tweetButton"]', { timeout: 60000 });
    console.log('Waiting for post button to enable...');
    try {
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          return !(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
        },
        { timeout: 60000 },
        'button[data-testid="tweetButton"]'
      );
    } catch (err) {
      throw new Error('tweetButton never enabled (still uploading or X blocked posting)');
    }

    const btn = await page.$('button[data-testid="tweetButton"]');
    if (!btn) throw new Error('tweetButton not found');
    console.log('Clicking post...');
    await page.bringToFront().catch(() => {});
    await safeClick(page, 'button[data-testid="tweetButton"]');
    console.log('Waiting for composer to close...');
    try {
      const startedAt = Date.now();
      const closeReasonHandle = await page.waitForFunction(
        () => {
          if (!location.href.includes('/compose/post')) return 'url-changed';
          if (!document.querySelector('[data-testid="app-bar-close"]')) return 'close-button-gone';
          if (!document.querySelector('[data-testid="tweetTextarea_0"]')) return 'textbox-gone';
          return false;
        },
        { timeout: 15000 }
      );
      const closeReason = await closeReasonHandle.jsonValue().catch(() => null);
      console.log(`Composer close detected (${Date.now() - startedAt}ms): ${closeReason || 'unknown'}`);
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    if (keepOpen) {
      console.error(err);
      await new Promise(() => {});
    }
    throw err;
  } finally {
    if (!keepOpen) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
