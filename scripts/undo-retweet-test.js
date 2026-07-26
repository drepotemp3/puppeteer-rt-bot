import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer';
import { connect } from 'puppeteer-real-browser';

function getUserDataDir() {
  return process.env.CHROME_USER_DATA_DIR
    || process.env.BROWSER_PROFILE_DIR
    || path.join(os.homedir(), '.retweet-bot-chrome-profile');
}

function extractXPostId(url) {
  const match = String(url || '').match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function resolveChromePath() {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const pptrPath = await puppeteer.executablePath();
  if (pptrPath && fs.existsSync(pptrPath)) return pptrPath;
  throw new Error('No Chrome executable found. Run `npx puppeteer browsers install chrome` or set PUPPETEER_EXECUTABLE_PATH.');
}

async function findClickableHandle(page, selector) {
  const candidates = await page.$$(selector);
  for (const el of candidates) {
    const box = await el.boundingBox();
    if (!box || box.width < 2 || box.height < 2) continue;
    return el;
  }
  return null;
}

async function pickClickableHandle(page, selector) {
  await page.waitForSelector(selector, { timeout: 60000 });
  return await findClickableHandle(page, selector);
}

async function safeClick(page, selector) {
  await page.bringToFront().catch(() => {});
  const el = await pickClickableHandle(page, selector);
  if (!el) throw new Error(`Clickable element not found: ${selector}`);
  await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
  const box = await el.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function waitForTweetToBeStable(page) {
  try {
    await page.waitForSelector('article', { timeout: 10000 });
  } catch (err) {}
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
  } catch (err) {}
  await new Promise((r) => setTimeout(r, 800));
}

async function waitForUndoApplied(page) {
  await page.waitForFunction(
    () => {
      const hasUnretweet = Boolean(document.querySelector('button[data-testid="unretweet"]'));
      const hasRetweet = Boolean(document.querySelector('button[data-testid="retweet"]'));
      if (hasRetweet && !hasUnretweet) return true;
      const btn = document.querySelector('button[data-testid="retweet"]');
      const label = btn?.getAttribute('aria-label') || '';
      if (label.toLowerCase().includes('repost') && !label.toLowerCase().includes('reposted')) return true;
      return false;
    },
    { timeout: 60000 }
  );
  await new Promise((r) => setTimeout(r, 800));
  return await page.evaluate(() => {
    const hasUnretweet = Boolean(document.querySelector('button[data-testid="unretweet"]'));
    const hasRetweet = Boolean(document.querySelector('button[data-testid="retweet"]'));
    if (hasUnretweet) return false;
    if (hasRetweet) return true;
    return false;
  });
}

async function main() {
  const tweetUrl = process.env.TWEET_URL;
  if (!tweetUrl) throw new Error('Set TWEET_URL to the tweet link you want to undo-repost.');

  const postId = extractXPostId(tweetUrl);
  if (!postId) throw new Error(`Could not extract /status/<id> from: ${tweetUrl}`);

  const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
  const keepOpen = String(process.env.KEEP_OPEN || 'true').toLowerCase() === 'true';

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

    const url = `https://x.com/i/web/status/${postId}`;
    console.log(`Opening tweet: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Tweet navigation done.');

    await page.waitForSelector('button[data-testid="unretweet"], button[data-testid="retweet"]', { timeout: 60000 });
    console.log('Retweet controls detected.');

    const hasRetweet = await findClickableHandle(page, 'button[data-testid="retweet"]');
    const hasUnretweet = await findClickableHandle(page, 'button[data-testid="unretweet"]');
    if (hasRetweet && !hasUnretweet) {
      console.log('Tweet is not reposted in this session (already undone).');
      return;
    }
    if (!hasUnretweet) {
      throw new Error('Tweet does not appear reposted in this session (no unretweet button found).');
    }

    await waitForTweetToBeStable(page);

    console.log('Clicking reposted button (unretweet)...');
    await safeClick(page, 'button[data-testid="unretweet"]');

    console.log('Confirming undo repost...');
    await safeClick(page, '[data-testid="unretweetConfirm"], [data-testid="confirmationSheetConfirm"]');

    console.log('Waiting for repost to be undone...');
    const stable = await waitForUndoApplied(page);
    if (!stable) {
      console.log('Undo appeared to revert; retrying once after tweet settles...');
      await waitForTweetToBeStable(page);
      await safeClick(page, 'button[data-testid="unretweet"]');
      await safeClick(page, '[data-testid="unretweetConfirm"], [data-testid="confirmationSheetConfirm"]');
      const stableRetry = await waitForUndoApplied(page);
      if (!stableRetry) {
        throw new Error('Undo repost did not stick (likely optimistic UI revert).');
      }
    }

    console.log('Undo repost successful.');
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
