import puppeteer from 'puppeteer';
import { connect } from 'puppeteer-real-browser';
import { Admin, BotUser } from '../models/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { mkdir } from 'fs/promises';

let browser = null;
let page = null;
let isLoggedInGlobal = false;
let retweetQueue = [];
let isProcessingQueue = false;
let browserConnecting = false;
let stopRequested = false;
const LOGIN_BLOCK_ERROR_TEXT = 'Please use X.com or official X apps to proceed with log in/sign up.';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// #region debug-point x-login-not-typing-client
async function dbg(event, data = {}) {
  try {
    await fetch('http://127.0.0.1:3000/__debug', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'x-login-not-typing', event, data })
    });
  } catch (e) {}
}
// #endregion debug-point x-login-not-typing-client

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function moveMouseSmoothly(targetPage, targetX, targetY) {
  const mouse = targetPage.mouse;
  const currentPos = {
    x: randomBetween(100, 800),
    y: randomBetween(100, 600)
  };

  const steps = randomBetween(50, 100);
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const wobbleFactor = Math.sin(progress * Math.PI * 2) * 10;
    const easingProgress = 1 - Math.pow(1 - progress, 3);
    const nextX = currentPos.x + (targetX - currentPos.x) * easingProgress + wobbleFactor;
    const nextY = currentPos.y + (targetY - currentPos.y) * easingProgress + wobbleFactor;
    await mouse.move(nextX, nextY);
    await sleep(randomBetween(1, 5));
  }

  await mouse.move(targetX, targetY);
  await sleep(randomBetween(50, 150));
}

async function moveMouseToElementCoords(targetPage, selector) {
  const element = await targetPage.$(selector);
  if (!element) return null;

  const box = await element.boundingBox();
  if (!box) return null;

  const targetX = box.x + box.width / 2 + randomBetween(Math.floor(-box.width * 0.2), Math.floor(box.width * 0.2));
  const targetY = box.y + box.height / 2 + randomBetween(Math.floor(-box.height * 0.2), Math.floor(box.height * 0.2));
  await moveMouseSmoothly(targetPage, targetX, targetY);
  return { x: targetX, y: targetY };
}

function getUserDataDir() {
  return process.env.CHROME_USER_DATA_DIR
    || process.env.BROWSER_PROFILE_DIR
    || path.join(os.homedir(), '.retweet-bot-chrome-profile');
}

function shouldRunHeadless() {
  const raw = process.env.HEADLESS;
  if (raw != null && String(raw).trim() !== '') {
    const value = String(raw).trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'yes';
  }

  if (process.platform !== 'win32' && !process.env.DISPLAY) {
    return true;
  }

  return false;
}

function findExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.F_OK);
      return candidate;
    } catch (error) {}
  }
  return null;
}

async function getBundledChromePath() {
  try {
    const chromePath = await puppeteer.executablePath();
    if (chromePath && findExistingPath([chromePath])) {
      console.log('Using Puppeteer-managed Chrome:', chromePath);
      return chromePath;
    }
  } catch (error) {
    console.warn(`Puppeteer-managed Chrome not available yet: ${error.message}`);
  }
  return null;
}

async function resolveChromePath() {
  const configuredChromePath = findExistingPath([
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH
  ]);
  if (configuredChromePath) {
    console.log('Using configured Chrome:', configuredChromePath);
    return configuredChromePath;
  }

  const bundledChromePath = await getBundledChromePath();
  if (bundledChromePath) {
    return bundledChromePath;
  }

  throw new Error(
    'No supported Chrome executable found. Install the Puppeteer-managed browser with `npx puppeteer browsers install chrome`, or explicitly set PUPPETEER_EXECUTABLE_PATH.'
  );
}

async function preparePage(targetPage) {
  await targetPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ]
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);

    window.chrome = {
      runtime: {},
      loadTimes: () => {},
      csi: () => {},
      app: {}
    };

    const pluginArray = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];

    Object.defineProperty(navigator, 'plugins', {
      get: () => pluginArray,
      enumerable: false
    });
  });

  await targetPage.setUserAgent(DEFAULT_USER_AGENT);
}

async function isLoggedInPage(targetPage) {
  try {
    return await targetPage.evaluate(() => {
      const selectors = [
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        '[data-testid="AppTabBar_Home_Link"]',
        '[data-testid="primaryColumn"]',
        '[data-testid="ScrollSnap-List"]'
      ];

      return selectors.some(selector => document.querySelector(selector));
    });
  } catch (error) {
    return false;
  }
}

async function findLoggedInPage() {
  if (!browser) return null;

  const openPages = await browser.pages();
  for (const candidatePage of openPages) {
    if (!candidatePage || candidatePage.isClosed()) continue;
    if (await isLoggedInPage(candidatePage)) {
      return candidatePage;
    }
  }

  return null;
}

async function waitForLoggedInPage(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const loggedInPage = await findLoggedInPage();
    if (loggedInPage) {
      return loggedInPage;
    }
    await sleep(1000);
  }

  return null;
}

async function clickMatchingSubmitButton(targetPage, keywords) {
  const buttons = await targetPage.$$('button[type="submit"]');
  for (const button of buttons) {
    const text = await button.evaluate(el => el.textContent?.toLowerCase() || '');
    if (keywords.some(keyword => text.includes(keyword))) {
      await button.click();
      return true;
    }
  }

  return false;
}

async function waitForPageToSettle(targetPage, minimumDelayMs = 3000) {
  await sleep(minimumDelayMs + randomBetween(400, 1600));

  try {
    await targetPage.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 15000 }
    );
  } catch (error) {}

  await sleep(randomBetween(1200, 3200));
}

async function waitForPageToSettleFast(targetPage) {
  try {
    await targetPage.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 15000 }
    );
  } catch (error) {}
}

async function fastTypeInput(targetPage, selector, value) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 20000 });
  try {
    await targetPage.click(selector, { clickCount: 3 });
  } catch (e) {}
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await targetPage.keyboard.down(modifier);
  await targetPage.keyboard.press('KeyA');
  await targetPage.keyboard.up(modifier);
  await targetPage.keyboard.press('Backspace');
  await targetPage.type(selector, String(value || ''), { delay: 0 });
}

async function clickSubmitButtonFast(targetPage, keywords) {
  const buttons = await targetPage.$$('button[type="submit"]');
  for (const button of buttons) {
    const ok = await button
      .evaluate((el, words) => {
        const text = (el.textContent || '').toLowerCase();
        if (!words.some(w => text.includes(w))) return false;
        const ariaDisabled = el.getAttribute('aria-disabled');
        const isDisabled = Boolean(el.disabled) || ariaDisabled === 'true';
        if (isDisabled) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 6 || rect.height < 6) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0)) return false;
        return true;
      }, keywords)
      .catch(() => false);
    if (!ok) continue;
    try {
      await button.click();
      return true;
    } catch (e) {}
  }
  return false;
}

async function moveMouseToElement(targetPage, selector) {
  const element = await targetPage.$(selector);
  if (!element) return false;

  const box = await element.boundingBox();
  if (!box) return false;

  const targetX = box.x + box.width / 2 + randomBetween(Math.floor(-box.width * 0.2), Math.floor(box.width * 0.2));
  const targetY = box.y + box.height / 2 + randomBetween(Math.floor(-box.height * 0.2), Math.floor(box.height * 0.2));
  await moveMouseSmoothly(targetPage, targetX, targetY);
  await sleep(randomBetween(120, 420));
  return true;
}

async function focusInput(targetPage, selector) {
  await targetPage.waitForSelector(selector, { visible: true, timeout: 20000 });
  const element = await targetPage.$(selector);
  if (!element) {
    throw new Error(`Input not found for selector: ${selector}`);
  }

  const box = await element.boundingBox();
  if (box) {
    const targetX = box.x + box.width / 2 + randomBetween(Math.floor(-box.width * 0.2), Math.floor(box.width * 0.2));
    const targetY = box.y + box.height / 2 + randomBetween(Math.floor(-box.height * 0.2), Math.floor(box.height * 0.2));
    await moveMouseSmoothly(targetPage, targetX, targetY);
    await sleep(randomBetween(180, 350));
  }

  await element.click({ clickCount: 1, delay: randomBetween(60, 180) });
  await sleep(randomBetween(180, 700));
  return element;
}

async function clearFocusedInput(targetPage) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await targetPage.keyboard.down(modifier);
  await targetPage.keyboard.press('KeyA');
  await targetPage.keyboard.up(modifier);
  await sleep(randomBetween(80, 220));
  await targetPage.keyboard.press('Backspace');
  await sleep(randomBetween(120, 260));
}

// Generate a plausible typo for a character
function getRandomTypo(char) {
  const QWERTY_MAP = {
    'q': ['1','2','w','a','s'],
    'w': ['q','2','3','e','s','a'],
    'e': ['w','3','4','r','d','s'],
    'r': ['e','4','5','t','f','d'],
    't': ['r','5','6','y','g','f'],
    'y': ['t','6','7','u','h','g'],
    'u': ['y','7','8','i','j','h'],
    'i': ['u','8','9','o','k','j'],
    'o': ['i','9','0','p','l','k'],
    'p': ['o','0','[',']','l'],
    'a': ['q','w','s','z'],
    's': ['a','w','e','d','x','z'],
    'd': ['s','e','r','f','c','x'],
    'f': ['d','r','t','g','v','c'],
    'g': ['f','t','y','h','b','v'],
    'h': ['g','y','u','j','n','b'],
    'j': ['h','u','i','k','m','n'],
    'k': ['j','i','o','l',',','m'],
    'l': ['k','o','p',';','.',','],
    'z': ['a','s','x'],
    'x': ['z','s','d','c'],
    'c': ['x','d','f','v'],
    'v': ['c','f','g','b'],
    'b': ['v','g','h','n'],
    'n': ['b','h','j','m'],
    'm': ['n','j','k',','],
  };

  const lowerChar = char.toLowerCase();
  if (QWERTY_MAP[lowerChar]) {
    const typo = QWERTY_MAP[lowerChar][randomBetween(0, QWERTY_MAP[lowerChar].length - 1)];
    return char === char.toUpperCase() ? typo.toUpperCase() : typo;
  }
  return char;
}

async function humanType(targetPage, selector, value) {
  await focusInput(targetPage, selector);
  await clearFocusedInput(targetPage);
  await sleep(randomBetween(100, 300));

  const inputBox = await (await targetPage.$(selector)).boundingBox();
  const inputBaseX = inputBox ? inputBox.x + inputBox.width / 2 : 0;
  const inputBaseY = inputBox ? inputBox.y + inputBox.height / 2 : 0;

  let i = 0;
  while (i < value.length) {
    const character = value[i];
    const shouldTypo = Math.random() < 0.06 && i > 1 && i < value.length - 2;

    if (shouldTypo) {
      const typoChar = getRandomTypo(character);
      await targetPage.keyboard.type(typoChar, { delay: randomBetween(70, 260) });
      await sleep(randomBetween(150, 400));
      await targetPage.keyboard.press('Backspace');
      await sleep(randomBetween(100, 280));
      await targetPage.keyboard.type(character, { delay: randomBetween(80, 250) });
    } else {
      await targetPage.keyboard.type(character, { delay: randomBetween(60, 320) });
    }

    if (Math.random() < 0.25) {
      await moveMouseSmoothly(targetPage, inputBaseX + randomBetween(-20, 20), inputBaseY + randomBetween(-20, 20));
      await sleep(randomBetween(50, 120));
      await moveMouseSmoothly(targetPage, inputBaseX, inputBaseY);
    }

    if (Math.random() < 0.15 || (character === ' ' && Math.random() < 0.4)) {
      await sleep(randomBetween(250, 800));
    }

    i++;
  }

  await sleep(randomBetween(400, 1400));
}

async function humanTypeQuick(targetPage, selector, value) {
  await focusInput(targetPage, selector);
  await clearFocusedInput(targetPage);
  await sleep(randomBetween(30, 90));
  await targetPage.type(selector, String(value || ''), { delay: randomBetween(12, 28) });
  await sleep(randomBetween(60, 180));
}

async function clickSubmitNearInput(targetPage, inputSelector, keywords) {
  await targetPage.waitForSelector(inputSelector, { visible: true, timeout: 20000 });
  const input = await targetPage.$(inputSelector);
  if (!input) return false;
  const clicked = await input
    .evaluate((el, words) => {
      const root = el.closest('form') || el.closest('[role="dialog"]') || document;
      const candidates = Array.from(root.querySelectorAll('button[type="submit"]'))
        .map((btn) => {
          const text = (btn.textContent || '').toLowerCase();
          const okText = words.some((w) => text.includes(w));
          if (!okText) return null;
          const ariaDisabled = btn.getAttribute('aria-disabled');
          const isDisabled = Boolean(btn.disabled) || ariaDisabled === 'true';
          if (isDisabled) return null;
          const rect = btn.getBoundingClientRect();
          if (!rect || rect.width < 6 || rect.height < 6) return null;
          const style = window.getComputedStyle(btn);
          if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0)) return null;
          return btn;
        })
        .filter(Boolean);
      if (candidates.length === 0) return false;
      let best = null;
      for (const btn of candidates) {
        const pos = el.compareDocumentPosition(btn);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          best = btn;
          break;
        }
      }
      (best || candidates[0]).click();
      return true;
    }, keywords)
    .catch(() => false);
  return Boolean(clicked);
}

async function clickSubmitButton(targetPage, keywords) {
  const buttons = await targetPage.$$('button[type="submit"]');
  for (const button of buttons) {
    const text = await button.evaluate(el => el.textContent?.toLowerCase() || '');
    if (!keywords.some(keyword => text.includes(keyword))) continue;

    const box = await button.boundingBox();
    if (box) {
      const targetX = box.x + box.width / 2 + randomBetween(Math.floor(-box.width * 0.2), Math.floor(box.width * 0.2));
      const targetY = box.y + box.height / 2 + randomBetween(Math.floor(-box.height * 0.2), Math.floor(box.height * 0.2));
      await moveMouseSmoothly(targetPage, targetX, targetY);
      await sleep(randomBetween(250, 600));
    }

    await button.click({ delay: randomBetween(80, 200) });
    await sleep(randomBetween(800, 2000));
    return true;
  }

  return false;
}

async function navigateByTypingUrl(targetPage, url) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await targetPage.keyboard.down(modifier);
  await targetPage.keyboard.press('KeyL');
  await targetPage.keyboard.up(modifier);
  await sleep(randomBetween(280, 750));

  // Clear existing URL completely (just in case)
  await targetPage.keyboard.down('Control');
  await targetPage.keyboard.press('KeyA');
  await targetPage.keyboard.up('Control');
  await sleep(randomBetween(120, 300));
  await targetPage.keyboard.press('Backspace');
  await sleep(randomBetween(80, 220));

  for (const character of url) {
    await targetPage.keyboard.type(character, { delay: randomBetween(50, 230) });
    // Random tiny pause
    if (Math.random() < 0.1) {
      await sleep(randomBetween(150, 450));
    }
  }
  await sleep(randomBetween(350, 850));
  await targetPage.keyboard.press('Enter');
  await waitForPageToSettle(targetPage, 3800);
}

async function manualNewTabRetry(originalPage, botUser) {
  const retryPage = await browser.newPage();
  await preparePage(retryPage);
  await retryPage.bringToFront();
  await retryPage.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPageToSettle(retryPage, 2000);

  return await submitLoginFlow(retryPage, botUser);
}

async function hasLoginBlockError(targetPage) {
  try {
    return await targetPage.evaluate((errorText) => {
      const bodyText = document.body?.innerText || '';
      if (bodyText.includes(errorText)) return true;

      return Array.from(document.querySelectorAll('p, span, div')).some((node) =>
        node.textContent?.includes(errorText)
      );
    }, LOGIN_BLOCK_ERROR_TEXT);
  } catch (error) {
    return false;
  }
}

async function submitLoginFlow(targetPage, botUser) {
  await dbg('submitLoginFlow.start', {
    url: (() => { try { return targetPage.url(); } catch (e) { return null; } })(),
    hasEmail: Boolean(botUser?.xEmail),
    hasUsername: Boolean(botUser?.xUsername),
    hasPassword: Boolean(botUser?.xPassword)
  });
  await targetPage.bringToFront();
  await targetPage.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPageToSettle(targetPage, 2000);

  let hasEmailInput = false;
  try {
    await targetPage.waitForSelector('input[name="text"], input[name="username_or_email"], input[type="email"]', { visible: true, timeout: 20000 });
    hasEmailInput = true;
  } catch (error) {}

  if (!hasEmailInput) {
    try {
      await targetPage.waitForSelector('input[type="email"]', { visible: true, timeout: 15000 });
    } catch (err) {}
  }

  const loginId = botUser.xEmail || botUser.xUsername;
  await dbg('submitLoginFlow.afterGoto', {
    url: (() => { try { return targetPage.url(); } catch (e) { return null; } })(),
    loginIdLen: String(loginId || '').length
  });
  const hasUsernameOrEmail = await targetPage.$('input[name="username_or_email"]');
  const hasTextInput = await targetPage.$('input[name="text"]');
  if (hasUsernameOrEmail) {
    await humanTypeQuick(targetPage, 'input[name="username_or_email"]', loginId);
    const clicked = await clickSubmitNearInput(targetPage, 'input[name="username_or_email"]', ['continue', 'next']);
    await dbg('submitLoginFlow.userStep', { mode: 'username_or_email', clicked });
    if (!clicked) await targetPage.keyboard.press('Enter');
  } else if (hasTextInput) {
    await humanTypeQuick(targetPage, 'input[name="text"]', loginId);
    const clicked = await clickSubmitNearInput(targetPage, 'input[name="text"]', ['continue', 'next']);
    await dbg('submitLoginFlow.userStep', { mode: 'text', clicked });
    if (!clicked) await targetPage.keyboard.press('Enter');
  } else {
    await humanTypeQuick(targetPage, 'input[type="email"]', loginId);
    const clicked = await clickSubmitNearInput(targetPage, 'input[type="email"]', ['continue', 'next']);
    await dbg('submitLoginFlow.userStep', { mode: 'email', clicked });
    if (!clicked) await targetPage.keyboard.press('Enter');
  }

  const stepReached = await Promise.race([
    targetPage
      .waitForSelector('input[name="password"]', { visible: true, timeout: 12000 })
      .then(() => 'password')
      .catch(() => null),
    targetPage
      .waitForSelector('input[name="username"]', { visible: true, timeout: 12000 })
      .then(() => 'username')
      .catch(() => null),
  ]);
  await dbg('submitLoginFlow.afterContinue', {
    url: (() => { try { return targetPage.url(); } catch (e) { return null; } })(),
    stepReached: stepReached || null
  });

  try {
    await targetPage.waitForSelector('input[name="password"]', { visible: true, timeout: 20000 });
    await dbg('submitLoginFlow.passwordVisible', { url: (() => { try { return targetPage.url(); } catch (e) { return null; } })() });
    await humanTypeQuick(targetPage, 'input[name="password"]', botUser.xPassword);
    await targetPage.keyboard.press('Enter');
    await clickSubmitNearInput(targetPage, 'input[name="password"]', ['continue', 'log', 'sign']);
  } catch (error) {
    await dbg('submitLoginFlow.passwordPrimaryFailed', { message: String(error?.message || error) });
    await targetPage.waitForSelector('input[name="username"]', { timeout: 5000 });
    await humanTypeQuick(targetPage, 'input[name="username"]', botUser.xUsername || botUser.xEmail);
    await targetPage.waitForSelector('input[name="password"]', { timeout: 10000 });
    await humanTypeQuick(targetPage, 'input[name="password"]', botUser.xPassword);
    await targetPage.keyboard.press('Enter');
    await clickSubmitNearInput(targetPage, 'input[name="password"]', ['continue', 'log', 'sign']);
  }

  await waitForPageToSettle(targetPage, 2200);
  const blocked = await hasLoginBlockError(targetPage);
  if (blocked) {
    await dbg('submitLoginFlow.blocked', { url: (() => { try { return targetPage.url(); } catch (e) { return null; } })() });
    return { loggedIn: false, blocked: true, source: 'x-block-error' };
  }

  const loggedInPage = await waitForLoggedInPage(20000);
  if (loggedInPage) {
    await dbg('submitLoginFlow.success', { url: (() => { try { return loggedInPage.url(); } catch (e) { return null; } })() });
    return { loggedIn: true, blocked: false, source: 'post-submit-detection', page: loggedInPage };
  }

  await dbg('submitLoginFlow.notDetected', { url: (() => { try { return targetPage.url(); } catch (e) { return null; } })() });
  return { loggedIn: false, blocked: false, source: 'login-not-detected' };
}

async function getBrowser() {
  if (browser) return browser;
  if (browserConnecting) {
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (!browserConnecting) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
    return browser;
  }

  browserConnecting = true;
  try {
    const isHeadless = shouldRunHeadless();
    const userDataDir = getUserDataDir();
    
    // Create profile dir if not exists
    if (!fs.existsSync(userDataDir)) {
      await mkdir(userDataDir, { recursive: true });
    }
    console.log('Using browser profile:', userDataDir);
    
    const chromePath = await resolveChromePath();

    console.log('Launching browser...');
    const { browser: realBrowser, page: realPage } = await connect({
      headless: isHeadless,
      disableXvfb: !isHeadless && process.platform === 'linux' && Boolean(process.env.DISPLAY),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-client-side-phishing-detection',
        '--disable-popup-blocking',
        '--disable-notifications',
        '--disable-translate',
        '--disable-features=TranslateUI',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--disable-features=Translate',
        '--disable-features=MediaRouter',
        '--disable-features=PrivacySandboxSettings4',
        '--disable-features=OptimizationHints',
        '--disable-features=InterestFeedV2',
        '--disable-features=ChromeWhatsNewUI',
        '--disable-features=SidePanelSearchCompanion',
        '--disable-features=SearchWebInSidePanel',
        '--disable-features=SidePanelReadingMode',
        '--disable-features=SidePanelJourneys',
        '--disable-features=SidePanelCustomizeChrome',
        '--disable-features=SidePanelCompose',
        '--disable-features=SidePanelShoppingInsights',
        '--disable-features=SidePanelBookmarks',
        '--disable-features=SidePanelReadingList',
        '--disable-features=SidePanelHistoryClusters',
        '--disable-features=SidePanelTabSearch',
        '--disable-features=SidePanelJourneysV2',
        '--disable-features=SidePanelFeedback',
        '--disable-features=SidePanelPromos',
        '--disable-features=SidePanelCustomizeChromeV2',
        '--disable-features=SidePanelCustomizeChromeV3',
        '--disable-features=SidePanelCustomizeChromeV4',
        '--disable-features=SidePanelCustomizeChromeV5',
        '--disable-features=SidePanelCustomizeChromeV6',
        '--disable-features=SidePanelCustomizeChromeV7',
        '--disable-features=SidePanelCustomizeChromeV8',
        '--disable-features=SidePanelCustomizeChromeV9',
        '--disable-features=SidePanelCustomizeChromeV10',
        ...(!isHeadless ? ['--start-maximized'] : ['--window-size=1920,1080'])
      ],
      customConfig: {
        userDataDir: userDataDir,
        ...(chromePath && { chromePath })
      },
      turnstile: true,
      connectOption: {
        defaultViewport: null,
        protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000)
      }
    });

    browser = realBrowser;
    page = realPage;
    
    await preparePage(page);
    
    console.log('Browser launched successfully!');
    return browser;
  } finally {
    browserConnecting = false;
  }
}

async function getPage() {
  if (!browser) await getBrowser();
  return page;
}

async function getCursor(targetPage = page) {
  if (targetPage !== page) {
    return createCursor(targetPage);
  }
  return cursor;
}

async function closeBrowser() {
  if (!browser) return;
  console.log('Closing browser...');
  await browser.close();
  browser = null;
  page = null;
}

function resetRuntimeSessionState() {
  isLoggedInGlobal = false;
  stopRequested = false;
  isProcessingQueue = false;
  retweetQueue = [];
}

async function clearSessionProfile() {
  const userDataDir = getUserDataDir();
  await closeBrowser();
  await mkdir(userDataDir, { recursive: true });
  resetRuntimeSessionState();
  console.warn(`Preserving browser profile at ${userDataDir}. Full profile clearing is disabled because it increases X blocking risk.`);
}

async function resetBrowserSession() {
  await closeBrowser();
  resetRuntimeSessionState();
  console.log('Reset in-memory browser session state while preserving the browser profile.');
}

function extractXPostId(url) {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function getXCookieSeed() {
  const cookiesJson = process.env.X_COOKIES_JSON;
  if (cookiesJson) {
    try {
      const parsed = JSON.parse(cookiesJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (error) {
      console.warn(`Invalid X_COOKIES_JSON: ${error.message}`);
    }
  }

  const authToken = process.env.X_AUTH_TOKEN;
  if (!authToken) return null;

  const cookies = [
    {
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true
    }
  ];

  const ct0 = process.env.X_CT0;
  if (ct0) {
    cookies.push({
      name: 'ct0',
      value: ct0,
      domain: '.x.com',
      path: '/',
      httpOnly: false,
      secure: true
    });
  }

  return cookies;
}

async function tryCookieLogin(targetPage) {
  const cookies = getXCookieSeed();
  if (!cookies || cookies.length === 0) return { attempted: false, success: false };

  try {
    console.log(`🍪 Trying cookie-based login (cookies=${cookies.length})...`);
    await targetPage.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await targetPage.setCookie(...cookies);
    await targetPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForPageToSettle(targetPage, 3000);

    const loggedInPage = await waitForLoggedInPage(15000);
    if (loggedInPage) {
      return { attempted: true, success: true, page: loggedInPage };
    }
    return { attempted: true, success: false };
  } catch (error) {
    console.warn(`Cookie-based login attempt failed: ${error.message}`);
    return { attempted: true, success: false };
  }
}

function isDetachedContextError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('detached frame')
    || msg.includes('target closed')
    || msg.includes('execution context was destroyed')
    || msg.includes('session closed')
    || msg.includes('protocol error')
  );
}

async function ensureUsablePage(currentPage) {
  await getBrowser();
  let p = currentPage;
  if (!p || p.isClosed()) {
    p = await browser.newPage();
    await preparePage(p);
  }
  try {
    await p.evaluate(() => 1);
    return p;
  } catch (e) {
    if (!isDetachedContextError(e)) throw e;
  }

  try {
    await p.close().catch(() => {});
  } catch (e) {}
  p = await browser.newPage();
  await preparePage(p);
  return p;
}

async function loginToX(userId) {
  await dbg('loginToX.start', { userId: userId != null ? String(userId) : null });
  if (isLoggedInGlobal) {
    processQueue();
    return true;
  }

  const vpsRaw = process.env.VPS ?? process.env.IS_VPS ?? process.env.DEPLOY_TARGET;
  const isVps = vpsRaw != null && String(vpsRaw).trim() !== '' && (() => {
    const value = String(vpsRaw).trim().toLowerCase();
    return value === 'true' || value === '1' || value === 'yes' || value === 'vps' || value === 'server';
  })();

  const userIdStr = userId != null ? userId.toString() : null;
  let botUser = userIdStr ? await BotUser.findOne({ userId: userIdStr }) : null;
  if (!botUser) {
    botUser = await BotUser.findOne({
      xEmail: { $exists: true, $ne: null },
      xPassword: { $exists: true, $ne: null }
    });
  }
  if (!botUser) {
    botUser = await BotUser.findOne({});
  }

  let p = await ensureUsablePage(await getPage());
  
  try {
    console.log('🔍 Checking for existing logged-in session...');
    await dbg('loginToX.step', { name: 'checkExistingSession' });
    let existingLoggedInPage = await findLoggedInPage();
    if (existingLoggedInPage) {
      page = existingLoggedInPage;
      isLoggedInGlobal = true;
      if (botUser) {
        botUser.isLoggedIn = true;
        botUser.lastLoginAt = new Date();
        await botUser.save().catch(() => {});
      }
      console.log('✅ Successfully detected and loaded persisted logged-in session!');
      processQueue();
      return true;
    }

    await dbg('loginToX.step', { name: 'tryCookieLogin' });
    const cookieLogin = await tryCookieLogin(p);
    if (cookieLogin.success) {
      page = cookieLogin.page;
      isLoggedInGlobal = true;
      if (botUser) {
        botUser.isLoggedIn = true;
        botUser.lastLoginAt = new Date();
        await botUser.save().catch(() => {});
      }
      console.log('✅ Logged in via cookies!');
      processQueue();
      return true;
    }

    if (isVps) {
      const requiresHeadful = process.platform !== 'win32';
      const hasDisplay = Boolean(process.env.DISPLAY);
      const isHeadless = shouldRunHeadless();
      if (requiresHeadful && (!hasDisplay || isHeadless)) {
        console.error('❌ VPS manual login requires a virtual display. Start Xvfb/VNC, set DISPLAY=:99, and set HEADLESS=false, then press Login again.');
        await dbg('loginToX.vpsManualBlocked', { hasDisplay, isHeadless });
        return false;
      }
      await dbg('loginToX.step', { name: 'vpsManualLoginOnly' });
      console.log('🖥️ VPS mode: skipping automated credential login; waiting for manual login in the browser window...');
    } else {
    const hasCreds = Boolean(botUser?.xPassword && (botUser?.xEmail || botUser?.xUsername));
    await dbg('loginToX.hasCreds', { hasCreds });
    if (hasCreds) {
      console.log('🔐 No session/cookies found. Trying automated credential login...');

      let attempt = null;
      try {
        p = await ensureUsablePage(p);
        attempt = await submitLoginFlow(p, botUser);
      } catch (e) {
        await dbg('loginToX.submitLoginFlowError', { message: String(e?.message || e) });
        attempt = null;
      }

      if (!attempt || !attempt.loggedIn) {
        attempt = attempt || null;
      }

      if (attempt?.loggedIn) {
        page = attempt.page || (await findLoggedInPage());
        isLoggedInGlobal = true;
        if (botUser) {
          botUser.isLoggedIn = true;
          botUser.lastLoginAt = new Date();
          await botUser.save().catch(() => {});
        }
        console.log('✅ Logged in via automated credentials!');
        processQueue();
        return true;
      }

      if (attempt?.blocked) {
        console.error('❌ X blocked automated login flow.');
        return false;
      }
    }
    }

    // Check if we're in local development mode
    const isDevMode = process.env.NODE_ENV !== 'production' || !process.env.RENDER;

    if (isDevMode) {
      console.log('⚠️ No existing session found. Going to x.com to let you log in manually...');
      p = await ensureUsablePage(p);
      await p.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(2000);

      // Now just wait patiently for you to log in!
      console.log('⏳ Please log in manually in the browser window now...');
      console.log('   I will keep checking until I detect a successful login!');
      
      let checkCount = 0;
      const maxChecks = 600; // ~10 minutes
      
      while (checkCount < maxChecks && !isLoggedInGlobal) {
        await sleep(1000);
        checkCount++;
        const newLoggedInPage = await findLoggedInPage();
        if (newLoggedInPage) {
          page = newLoggedInPage;
          isLoggedInGlobal = true;
          if (botUser) {
            botUser.isLoggedIn = true;
            botUser.lastLoginAt = new Date();
            await botUser.save().catch(() => {});
          }
          console.log('✅ Manual login detected! Session saved locally!');
          processQueue();
          return true;
        }
      }
      
      if (!isLoggedInGlobal) {
        console.error('❌ Timed out waiting for manual login!');
        return false;
      }
    } else {
      // Production mode: Just check for pre-seeded profile
      console.error('❌ No logged-in session found in production!');
      if (!cookieLogin.attempted) {
        console.error('   Tip: Seeding a Windows Chrome profile will not work on Linux (Render) because cookies are OS-encrypted.');
        console.error('   Use one of these options instead:');
        console.error('   - Provide X_AUTH_TOKEN (and optionally X_CT0) env vars for cookie-based login');
        console.error('   - Generate profile-seed on Linux (e.g., via a Linux Docker container) then re-deploy');
      }
      return false;
    }
  } catch (err) {
    console.error('❌ Error checking login state:', err);
    if (isDetachedContextError(err)) {
      await resetBrowserSession().catch(() => {});
    }
    return false;
  }
}

async function notifySeededAdmins(telegram, text) {
  if (!telegram) return;

  const admins = await Admin.find();
  const adminsWithUserId = admins.filter(admin => admin?.userId);
  const adminsMissingUserId = admins.filter(admin => !admin?.userId);

  const results = await Promise.allSettled(
    adminsWithUserId.map((admin) =>
      telegram.sendMessage(admin.userId, text, { disable_web_page_preview: true })
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - succeeded;

  if (failed > 0) {
    const errorSummaries = results
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.status === 'rejected')
      .slice(0, 5)
      .map(({ r, idx }) => {
        const admin = adminsWithUserId[idx];
        const reason = r.reason;
        const code = reason?.code ?? reason?.response?.error_code ?? reason?.statusCode ?? null;
        const description = reason?.description ?? reason?.message ?? String(reason);
        return `${admin?.userId ?? 'unknown'}:${code ?? 'unknown'}:${description}`;
      })
      .filter((summary) => !summary.toLowerCase().includes('chat not found'))
      .join(' | ');

    if (errorSummaries) {
      console.warn(`Admin DM broadcast failures: failed=${failed}, sample=${errorSummaries}`);
    }
  }
}

async function reactThumbsUp(telegram, chatId, messageId) {
  if (!telegram || !chatId || !messageId) return;

  try {
    await telegram.callApi('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }]
    });
  } catch (error) {
    console.warn(`Failed to react to message ${messageId} in chat ${chatId}: ${error.message}`);
  }
}

async function safeClosePage(targetBrowser, targetPage) {
  if (!targetPage) return;
  const b = targetBrowser || browser;
  if (!b) return;
  try {
    const pages = await b.pages();
    if (pages.length <= 1) {
      try {
        await targetPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (error) {}
      return;
    }
  } catch (error) {}
  await targetPage.close().catch(() => {});
}

async function findClickableHandle(targetPage, selector) {
  const candidates = await targetPage.$$(selector);
  for (const el of candidates) {
    const box = await el.boundingBox();
    if (!box || box.width < 2 || box.height < 2) continue;
    return el;
  }
  return null;
}

async function safeClickSelector(targetPage, selector, timeoutMs = 60000) {
  await targetPage.bringToFront().catch(() => {});
  await targetPage.waitForSelector(selector, { timeout: timeoutMs });
  const el = await findClickableHandle(targetPage, selector);
  if (!el) {
    throw new Error(`Clickable element not found: ${selector}`);
  }
  await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
  const box = await el.boundingBox();
  if (!box) {
    throw new Error(`Element not visible: ${selector}`);
  }
  await targetPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function processSingleRetweet(task) {
  const { url, telegram, chatId, messageId } = task;
  const suppressNotify = Boolean(task?.suppressNotify);
  const suppressReact = Boolean(task?.suppressReact);
  const b = await getBrowser();
  const p = await b.newPage();
  await preparePage(p);
  const postId = extractXPostId(url);
  
  if (!postId) {
    await safeClosePage(b, p);
    return { status: 'invalid_url' };
  }

  try {
    await p.goto(`https://x.com/i/web/status/${postId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));
    await p.waitForSelector('button[data-testid="unretweet"], button[data-testid="retweet"]', { timeout: 15000 }).catch(() => {});

    const result = await p.evaluate((maxWaitMs) => {
      return new Promise(resolve => {
        const startedAt = Date.now();
        const check = () => {
          if (Date.now() - startedAt > maxWaitMs) {
            resolve({ timedOut: true });
            return;
          }

          const container = document.querySelector('.r-1igl3o0.r-rull8r.r-qklmqi') || document;
          
          const unretweetBtn = container.querySelector('[data-testid="unretweet"]');
          if (unretweetBtn) {
            resolve({ alreadyRetweeted: true });
            return;
          }
          
          const retweetBtn = container.querySelector('[data-testid="retweet"]');
          if (retweetBtn) {
            retweetBtn.click();
            resolve({ needsConfirm: true });
            return;
          }
          
          setTimeout(check, 500);
        };
        check();
      });
    }, 20000);

    if (result?.timedOut) {
      console.warn(`Retweet UI detection timed out for ${url}`);
      return { status: 'timeout' };
    }

    if (result.alreadyRetweeted) {
      if (!suppressNotify) {
        await notifySeededAdmins(telegram, 'Already reposted ❌\n\n');
      }
      if (!suppressReact) {
        await reactThumbsUp(telegram, chatId, messageId);
      }
      return { status: 'already_reposted' };
    }

    if (result.needsConfirm) {
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 800));
      await p.evaluate(() => {
        return new Promise(resolve => {
          const clickConfirm = () => {
            const confirmBtn = document.querySelector('[data-testid="retweetConfirm"]');
            if (confirmBtn) {
              confirmBtn.click();
              resolve();
            } else {
              setTimeout(clickConfirm, 500);
            }
          };
          clickConfirm();
        });
      });
    }

    if (!suppressNotify) {
      await notifySeededAdmins(telegram, `Reposted ✅\n\n${url}`);
    }
    if (!suppressReact) {
      await reactThumbsUp(telegram, chatId, messageId);
    }
    return { status: 'reposted' };

  } catch (err) {
    console.error('Retweet error:', err);
    return { status: 'error', error: err?.message || String(err) };
  } finally {
    await safeClosePage(b, p);
  }
}

async function undoRepost(task) {
  const { url, telegram, chatId, messageId } = task;
  const suppressNotify = Boolean(task?.suppressNotify);
  const suppressReact = Boolean(task?.suppressReact);
  const b = await getBrowser();
  const p = await b.newPage();
  await preparePage(p);
  const postId = extractXPostId(url);

  if (!postId) {
    await safeClosePage(b, p);
    return { status: 'invalid_url' };
  }

  try {
    await p.goto(`https://x.com/i/web/status/${postId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForSelector('button[data-testid="unretweet"], button[data-testid="retweet"]', { timeout: 60000 });

    const hasRetweet = await findClickableHandle(p, 'button[data-testid="retweet"]');
    const hasUnretweet = await findClickableHandle(p, 'button[data-testid="unretweet"]');

    if (hasRetweet && !hasUnretweet) {
      if (!suppressReact) {
        await reactThumbsUp(telegram, chatId, messageId);
      }
      return { status: 'already_undone' };
    }
    if (!hasUnretweet) {
      if (!suppressReact) {
        await reactThumbsUp(telegram, chatId, messageId);
      }
      return { status: 'not_reposted' };
    }

    await new Promise((r) => setTimeout(r, 2000));
    await safeClickSelector(p, 'button[data-testid="unretweet"]', 60000);
    await safeClickSelector(p, '[data-testid="unretweetConfirm"], [data-testid="confirmationSheetConfirm"]', 60000);

    await p.waitForFunction(
      () => {
        const hasUnretweetBtn = Boolean(document.querySelector('button[data-testid="unretweet"]'));
        const hasRetweetBtn = Boolean(document.querySelector('button[data-testid="retweet"]'));
        if (hasRetweetBtn && !hasUnretweetBtn) return true;
        const btn = document.querySelector('button[data-testid="retweet"]');
        const label = btn?.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('repost') && !label.toLowerCase().includes('reposted')) return true;
        return false;
      },
      { timeout: 60000 }
    );

    await new Promise((r) => setTimeout(r, 800));

    const stable = await p.evaluate(() => {
      const hasUnretweetBtn = Boolean(document.querySelector('button[data-testid="unretweet"]'));
      const hasRetweetBtn = Boolean(document.querySelector('button[data-testid="retweet"]'));
      if (hasUnretweetBtn) return false;
      if (hasRetweetBtn) return true;
      return false;
    });

    if (!stable) {
      await new Promise((r) => setTimeout(r, 1200));
      const stableRetry = await p.evaluate(() => {
        const hasUnretweetBtn = Boolean(document.querySelector('button[data-testid="unretweet"]'));
        const hasRetweetBtn = Boolean(document.querySelector('button[data-testid="retweet"]'));
        if (hasUnretweetBtn) return false;
        if (hasRetweetBtn) return true;
        return false;
      });
      if (!stableRetry) {
        return { status: 'error', error: 'Undo repost did not stick' };
      }
    }

    if (!suppressNotify) {
      await notifySeededAdmins(telegram, `Undo repost ✅\n\n${url}`);
    }
    if (!suppressReact) {
      await reactThumbsUp(telegram, chatId, messageId);
    }
    return { status: 'undone' };
  } catch (err) {
    console.error('Undo repost error:', err);
    return { status: 'error', error: err?.message || String(err) };
  } finally {
    await safeClosePage(b, p);
  }
}

async function postWithGif(task) {
  const { userId, mediaPath, caption } = task || {};
  if (!userId) {
    return { status: 'error', error: 'Missing userId' };
  }
  if (!mediaPath) {
    return { status: 'error', error: 'Missing mediaPath' };
  }

  const loggedIn = await loginToX(userId);
  if (!loggedIn) {
    return { status: 'error', error: 'Not logged in' };
  }

  const b = await getBrowser();
  const p = await b.newPage();
  await preparePage(p);

  const fileInputSelector = 'input[data-testid="fileInput"][type="file"]';
  const postButtonSelector = 'button[data-testid="tweetButton"]';
  const textAreaSelector = '[data-testid="tweetTextarea_0"]';

  try {
    await p.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForSelector('[data-testid="primaryColumn"]', { timeout: 60000 });
    await sleep(4500);
    await p.evaluate(() => window.scrollTo(0, Math.max(2400, window.innerHeight * 4)));
    await sleep(800);
    await p.evaluate(() => window.scrollTo(0, Math.max(3200, window.innerHeight * 6)));
    await sleep(500);

    await safeClickSelector(p, 'a[data-testid="SideNav_NewTweet_Button"][href="/compose/post"]', 60000);
    await p.waitForSelector('[data-testid="toolBar"]', { timeout: 60000 });
    await p.waitForSelector(textAreaSelector, { timeout: 60000 });

    await p.waitForSelector(fileInputSelector, { timeout: 60000 });

    let uploaded = false;
    try {
      const [chooser] = await Promise.all([
        p.waitForFileChooser({ timeout: 5000 }),
        p.click('button[aria-label="Add photos or video"]')
      ]);
      await chooser.accept([mediaPath]);
      uploaded = true;
    } catch (error) {}

    if (!uploaded) {
      const input = await p.$(fileInputSelector);
      if (!input) throw new Error('fileInput not found');
      await input.uploadFile(mediaPath);
    }

    await p.waitForSelector('button[aria-label="Remove media"]', { timeout: 60000 });
    const imageFailed = await p.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      return text.includes('your image file could not be processed');
    });
    if (imageFailed) {
      return { status: 'error', error: 'X rejected the uploaded media' };
    }

    await safeClickSelector(p, textAreaSelector, 60000);
    const handle = await p.$(textAreaSelector);
    if (!handle) throw new Error('Composer text field not found');
    await handle.focus();
    await p.keyboard.down('Control');
    await p.keyboard.press('KeyA');
    await p.keyboard.up('Control');
    await p.keyboard.press('Backspace');
    await p.keyboard.type(String(caption || ''), { delay: 25 });
    await sleep(600);

    await p.waitForSelector(postButtonSelector, { timeout: 60000 });
    await p.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return !(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
      },
      { timeout: 60000 },
      postButtonSelector
    );

    await safeClickSelector(p, postButtonSelector, 60000);

    try {
      await p.waitForFunction(
        () => {
          if (!location.href.includes('/compose/post')) return true;
          if (!document.querySelector('[data-testid="app-bar-close"]')) return true;
          if (!document.querySelector('[data-testid="tweetTextarea_0"]')) return true;
          return false;
        },
        { timeout: 15000 }
      );
    } catch (error) {}

    await sleep(1200);
    return { status: 'posted' };
  } catch (err) {
    console.error('Post error:', err);
    return { status: 'error', error: err?.message || String(err) };
  } finally {
    await safeClosePage(b, p);
  }
}

async function processQueue() {
  if (isProcessingQueue || retweetQueue.length === 0 || !isLoggedInGlobal) return;
  isProcessingQueue = true;
  stopRequested = false;

  while (retweetQueue.length > 0 && !stopRequested && isLoggedInGlobal) {
    const task = retweetQueue.shift();
    try {
      await processSingleRetweet(task);
      await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
    } catch (err) {
      console.error('Queue processing error:', err);
    }
  }

  isProcessingQueue = false;
}

function addToQueue(task) {
  stopRequested = false;
  retweetQueue.push(task);
  processQueue();
}

function stopQueue() {
  stopRequested = true;
  isProcessingQueue = false;
  retweetQueue = [];
}

function getQueueStatus() {
  return {
    isProcessing: isProcessingQueue,
    queueLength: retweetQueue.length
  };
}

async function logout() {
  try {
    const p = await getPage().catch(() => null);
    if (p && !p.isClosed()) {
      try {
        await p.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {}

      try {
        const cookies = await p.cookies().catch(() => []);
        if (Array.isArray(cookies) && cookies.length > 0) {
          await p.deleteCookie(...cookies).catch(() => {});
        }
      } catch (e) {}

      try {
        const client = await p.target().createCDPSession();
        const origins = ['https://x.com', 'https://twitter.com'];
        for (const origin of origins) {
          await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }).catch(() => {});
        }
      } catch (e) {}
    }
  } finally {
    await closeBrowser();
    resetRuntimeSessionState();
  }
  console.log('Logged out (browser closed, X auth cleared from profile).');
}

function isLoggedIn() {
  return isLoggedInGlobal;
}

export {
  loginToX,
  addToQueue,
  stopQueue,
  getQueueStatus,
  extractXPostId,
  processSingleRetweet,
  undoRepost,
  postWithGif,
  logout,
  isLoggedIn,
  clearSessionProfile,
  resetBrowserSession
};
