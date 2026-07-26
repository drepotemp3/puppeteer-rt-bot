import { Markup } from 'telegraf';
import { Admin, BotUser, ApprovedGroup } from '../models/db.js';
import fs from 'fs';
import path from 'path';
import { loginToX, extractXPostId, logout, isLoggedIn, resetBrowserSession, processSingleRetweet, undoRepost, postWithGif, saveAuthState, loadAuthState } from '../helpers/puppeteer.js';

const userStates = {};
const groupSessions = {};
const loginLocks = {};
const authStateLocks = {};

const QUOTES = [
  'Your limits are often just old stories waiting to be rewritten.',
  'Small steps taken daily create extraordinary destinations.',
  'The future belongs to those who refuse to stop learning.',
  'Strength is built in the moments no one applauds.',
  'A single act of kindness can echo for a lifetime.',
  'Dream boldly, but work even bolder.',
  'Every setback carries the blueprint for a stronger comeback.',
  'The courage to begin is more powerful than the fear of failing.',
  'Consistency turns impossible goals into inevitable results.',
  'Your mindset is the architect of your tomorrow.',
  'Progress is proof that patience has purpose.',
  'Focus on what you can control, and let the rest pass by.',
  'The greatest victories begin with quiet determination.',
  'Confidence is earned through action, not imagination.',
  'A positive attitude opens doors that talent alone cannot.',
  'The hardest paths often lead to the most rewarding views.',
  'Believe in your potential before the world believes in you.',
  'Success is built one disciplined decision at a time.',
  'Every sunrise offers another chance to grow.',
  'Your character speaks louder than your achievements.',
  'The best investment is the one you make in yourself.',
  'Mistakes are teachers dressed as challenges.',
  "Don't fear change; fear standing still.",
  'Resilience is choosing hope after every disappointment.',
  'The life you imagine begins with the habits you practice.',
  'True leadership starts with leading yourself.',
  'Peace begins when comparison ends.',
  'Your actions write the story your words only promise.',
  'Even the tallest trees began as unseen seeds.',
  'Leave behind more encouragement than criticism wherever you go.'
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getGroupSession(chatId) {
  const key = chatId.toString();
  if (!groupSessions[key]) {
    groupSessions[key] = {
      active: false,
      slow: false,
      processing: false,
      posting: false,
      queue: [],
      userLinkCount: {},
      lastEnded: null,
      stats: { received: 0, success: 0, failed: 0 },
      history: []
    };
  }
  return groupSessions[key];
}

function resetGroupSession(session) {
  session.active = false;
  session.slow = false;
  session.processing = false;
  session.posting = false;
  session.queue = [];
  session.userLinkCount = {};
  session.stats = { received: 0, success: 0, failed: 0 };
  session.history = [];
}

function extractFirstXUrl(text) {
  const matches = String(text || '').match(/https?:\/\/\S+|(?:x|twitter)\.com\/\S+/gi) || [];
  for (let candidate of matches) {
    candidate = candidate.trim();
    while (candidate && /[)\]}>,.`"'“”‘’]/.test(candidate[candidate.length - 1])) {
      candidate = candidate.slice(0, -1);
    }
    while (candidate && /^[({\[<`"'“”‘’]/.test(candidate[0])) {
      candidate = candidate.slice(1);
    }
    if (!candidate) continue;
    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
    if (extractXPostId(candidate)) return candidate;
  }
  return null;
}

function normalizeXUrlCandidate(candidate) {
  let value = String(candidate || '').trim();
  while (value && /[)\]}>,.`"'“”‘’]/.test(value[value.length - 1])) {
    value = value.slice(0, -1);
  }
  while (value && /^[({\[<`"'“”‘’]/.test(value[0])) {
    value = value.slice(1);
  }
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  if (!extractXPostId(value)) return null;
  return value;
}

function extractAllXUrls(text) {
  const matches = String(text || '').match(/https?:\/\/\S+|(?:x|twitter)\.com\/\S+/gi) || [];
  const urls = [];
  for (const candidate of matches) {
    const normalized = normalizeXUrlCandidate(candidate);
    if (!normalized) continue;
    urls.push(normalized);
  }
  return urls;
}

function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+|(?:x|twitter)\.com\/\S+/gi, ' ');
}

function detectPanelActionHeader(line) {
  const meta = stripUrls(line)
    .replace(/[`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!meta) return null;
  if (meta.includes('undo') && meta.includes('and') && meta.includes('rt') && meta.includes('again')) return 'undo_and_rt_again';
  if (meta.includes('undo') && meta.includes('rt') && meta.includes('again')) return 'undo_rt_again';
  if (meta.includes('undo') && meta.includes('rt')) return 'undo_rt';
  if (meta.includes('undo')) return 'undo_rt';
  if (meta.includes('redo')) return 'redo';
  return null;
}

function stepsForPanelMode(mode) {
  if (mode === 'undo_and_rt_again') return ['undo', 'repost'];
  if (mode === 'undo_rt' || mode === 'undo_rt_again') return ['undo'];
  return ['repost'];
}

function parseLinksPanel(text) {
  const lines = String(text || '').split(/\r?\n/);
  let mode = 'redo';
  const order = [];
  const byUrl = new Map();
  const lastFinal = new Map();

  for (const line of lines) {
    const urls = extractAllXUrls(line);
    if (urls.length === 0) {
      const header = detectPanelActionHeader(line);
      if (header) mode = header;
      continue;
    }

    for (const url of urls) {
      if (!byUrl.has(url)) {
        order.push(url);
      }

      let steps;
      if (lastFinal.has(url)) {
        const prev = lastFinal.get(url);
        steps = prev === 'repost' ? ['undo'] : ['repost'];
      } else {
        steps = stepsForPanelMode(mode);
      }
      lastFinal.set(url, steps[steps.length - 1]);
      byUrl.set(url, { url, steps });
    }
  }

  return order.map((url) => byUrl.get(url)).filter(Boolean);
}

function getLastKnownRepostStateForUrl(session, url) {
  if (!session || !Array.isArray(session.history)) return null;
  for (let i = session.history.length - 1; i >= 0; i--) {
    const h = session.history[i];
    if (!h || h.url !== url) continue;
    const status = h.status;
    if (status === 'reposted' || status === 'already_reposted') return true;
    if (status === 'undone' || status === 'already_undone' || status === 'not_reposted') return false;
  }
  return null;
}

function parseSimpleMultiLinks(text, session) {
  const urls = extractAllXUrls(text);
  if (urls.length === 0) return [];

  const meta = stripUrls(text);
  const wantsUndoAndRtAgain = /\bundo\b/i.test(meta) && /\brt\b/i.test(meta) && /\bagain\b/i.test(meta) && /\band\b/i.test(meta);
  const wantsUndo = /\bundo\b/i.test(meta);
  const wantsRedo = /\bredo\b/i.test(meta);

  let baseSteps = ['repost'];
  if (wantsUndoAndRtAgain) {
    baseSteps = ['undo', 'repost'];
  } else if (wantsUndo) {
    baseSteps = ['undo'];
  } else if (wantsRedo) {
    baseSteps = ['repost'];
  }

  const order = [];
  const byUrl = new Map();
  const lastFinal = new Map();

  for (const url of urls) {
    if (!byUrl.has(url)) order.push(url);

    let steps;
    if (lastFinal.has(url)) {
      const prev = lastFinal.get(url);
      steps = prev === 'repost' ? ['undo'] : ['repost'];
    } else if (!wantsUndo && !wantsRedo && !wantsUndoAndRtAgain) {
      const lastKnownReposted = getLastKnownRepostStateForUrl(session, url);
      if (lastKnownReposted === true) {
        steps = ['undo'];
      } else if (lastKnownReposted === false) {
        steps = ['repost'];
      } else {
        steps = baseSteps;
      }
    } else {
      steps = baseSteps;
    }

    lastFinal.set(url, steps[steps.length - 1]);
    byUrl.set(url, { url, steps });
  }

  return order.map((url) => byUrl.get(url)).filter(Boolean);
}

function looksLikeLinksPanel(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('links panel')) return true;
  if (lower.includes('total unique')) return true;
  if (!lower.includes('\n')) return false;
  const urls = extractAllXUrls(text);
  if (urls.length < 2) return false;
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (extractAllXUrls(line).length > 0) continue;
    if (detectPanelActionHeader(line)) return true;
  }
  return false;
}

function pickRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function getGifDir() {
  return path.resolve(process.cwd(), 'assets', 'gifs');
}

function listNumericGifs() {
  const dir = getGifDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const gifs = files
    .map((name) => {
      const match = name.match(/^(\d+)\.gif$/i);
      if (!match) return null;
      return { name, n: Number(match[1]) };
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.name);
  return gifs;
}

async function pickNextGif(chatId) {
  const gifs = listNumericGifs();
  if (gifs.length === 0) return null;
  const chatIdStr = chatId.toString();
  let group = await ApprovedGroup.findOne({ chatId: chatIdStr });
  if (!group) {
    group = new ApprovedGroup({ chatId: chatIdStr, isApproved: false });
  }

  const last = group.lastGifUsed;
  let nextIndex = 0;
  if (last) {
    const lastIndex = gifs.indexOf(last);
    nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % gifs.length;
  }

  group.lastGifUsed = gifs[nextIndex];
  await group.save().catch(() => {});
  return path.join(getGifDir(), gifs[nextIndex]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getAdminRecord(from) {
  const userId = from?.id != null ? from.id.toString() : null;
  const username = from?.username ? from.username.trim() : null;

  const or = [];
  if (userId) or.push({ userId });
  if (username) or.push({ username: new RegExp(`^${escapeRegExp(username)}$`, 'i') });

  if (or.length === 0) return null;
  return await Admin.findOne({ $or: or });
}

async function syncAdminRecord(from, admin) {
  if (!admin || !from) return;
  const userId = from.id != null ? from.id.toString() : null;
  const username = from.username ? from.username.trim() : null;

  let changed = false;
  if (userId && admin.userId !== userId) {
    admin.userId = userId;
    changed = true;
  }
  if (username && (!admin.username || admin.username.toLowerCase() !== username.toLowerCase())) {
    admin.username = username;
    changed = true;
  }

  if (changed) {
    await admin.save();
  }
}

async function isAdmin(from) {
  return Boolean(await getAdminRecord(from));
}

async function isApprovedGroup(chatId) {
  const group = await ApprovedGroup.findOne({ chatId: chatId.toString(), isApproved: true });
  return !!group;
}

function mainMenuKeyboard() {
  const buttons = [
    [Markup.button.callback('⚙️ Bot Settings', 'menu_settings')],
  ];
  if (isLoggedIn()) {
    buttons.push([Markup.button.callback('🚪 Logout', 'menu_logout')]);
  } else {
    buttons.push([Markup.button.callback('🔐 Login', 'menu_login')]);
  }
  buttons.push([Markup.button.callback('💾 Export Auth', 'menu_export_auth')]);
  buttons.push([Markup.button.callback('📥 Import Auth', 'menu_import_auth')]);
  buttons.push([Markup.button.callback('👥 Manage Admins', 'menu_admins')]);
  buttons.push([Markup.button.callback('👥 Manage Groups', 'menu_groups')]);
  return Markup.inlineKeyboard(buttons);
}

function backMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('« Back', 'back_menu')]
  ]);
}

async function editOrReply(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      return await ctx.editMessageText(text, { disable_web_page_preview: true, ...extra });
    }
  } catch (e) { }
  return await safeReply(ctx, text, { disable_web_page_preview: true, ...extra });
}

function isTransientTelegramError(err) {
  const code = err?.code || err?.errno;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true;
  const statusCode = err?.response?.error_code || err?.statusCode;
  if (statusCode === 429) return true;
  const message = (err?.message || '').toLowerCase();
  if (message.includes('econnreset') || message.includes('socket hang up')) return true;
  return false;
}

async function safeReply(ctx, text, extra = {}) {
  if (!ctx || typeof ctx.reply !== 'function') {
    try {
      console.warn(`Reply skipped: ctx.reply is not available`);
    } catch (e) {}
    return null;
  }
  const maxAttempts = 4;
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await ctx.reply(text, extra);
    } catch (err) {
      lastErr = err;
      const statusCode = err?.response?.error_code || err?.statusCode;
      const retryAfter = err?.response?.parameters?.retry_after;
      const shouldRetry = isTransientTelegramError(err);
      if (!shouldRetry || attempt >= maxAttempts) break;

      let waitMs = 750 * Math.pow(2, attempt - 1);
      if (statusCode === 429 && retryAfter) {
        waitMs = Math.max(waitMs, Number(retryAfter) * 1000);
      }
      await sleep(waitMs);
    }
  }

  try {
    console.warn(`Reply failed after retries: ${lastErr?.code || lastErr?.message || String(lastErr)}`);
  } catch (e) {}
  return null;
}

export function setupBot(bot) {
  bot.catch((err, ctx) => {
    const isIgnoredGroupNonTextMessage = Boolean(
      ctx?.chat
      && ['group', 'supergroup'].includes(ctx.chat.type)
      && ctx.updateType === 'message'
      && (!ctx.message || !('text' in ctx.message))
    );

    if (isIgnoredGroupNonTextMessage) {
      return;
    }

    console.error('Unhandled error while processing', ctx?.update, err);
  });

  bot.use(async (ctx, next) => {
    if (ctx.updateType === 'my_chat_member') {
      return next();
    }
    
    if (ctx.chat && ctx.chat.type === 'private') {
      if (ctx.from) {
        const admin = await getAdminRecord(ctx.from);
        if (!admin) {
          const isStart = Boolean(
            ctx.updateType === 'message'
            && ctx.message
            && 'text' in ctx.message
            && typeof ctx.message.text === 'string'
            && ctx.message.text.trim().toLowerCase().startsWith('/start')
          );
          if (isStart) {
            return next();
          }
          return;
        }
        await syncAdminRecord(ctx.from, admin);
      } else {
        return;
      }
    } else if (ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type)) {
      if (!(await isApprovedGroup(ctx.chat.id))) {
        return;
      }

      if (ctx.updateType === 'message' && (!ctx.message || !('text' in ctx.message))) {
        return;
      }
    }
    return next();
  });

  bot.on('my_chat_member', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const title = ctx.chat.title;
    const username = ctx.chat.username;
    await ApprovedGroup.updateOne(
      { chatId },
      {
        $set: { title: title ?? null, username: username ?? null },
        $setOnInsert: { isApproved: false }
      },
      { upsert: true }
    ).catch(() => {});

    const newStatus = ctx.update?.my_chat_member?.new_chat_member?.status;
    if (newStatus === 'left' || newStatus === 'kicked') {
      return;
    }
    try {
      await bot.telegram.setChatPermissions(ctx.chat.id, {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      });
    } catch (e) {}
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type === 'private') {
      const admin = await getAdminRecord(ctx.from);
      if (!admin) {
        await safeReply(ctx, `You don't have permissions to use this bot.\nWait for admins to open a session in the group`);
        return;
      }
      await syncAdminRecord(ctx.from, admin);
      await safeReply(ctx, 'Welcome to Retweet Bot!', mainMenuKeyboard());
    }
  });

  bot.action('back_menu', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    delete userStates[ctx.from.id];
    await editOrReply(ctx, 'Welcome to Retweet Bot!', mainMenuKeyboard());
  });

  bot.action('menu_settings', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    let user = await BotUser.findOne({ userId: ctx.from.id.toString() });
    if (!user) {
      user = new BotUser({ userId: ctx.from.id.toString(), username: ctx.from.username || null });
      await user.save();
    }
    const emailText = user.xEmail ? `Email/Username: ${user.xEmail}` : 'Email/Username: Not set';
    const passText = user.xPassword ? `Password: ********` : 'Password: Not set';
    await editOrReply(ctx,
      `Current X credentials:\n${emailText}\n${passText}\n${user.xUsername ? `Username: ${user.xUsername}` : ''}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Credentials', 'edit_credentials')],
        [Markup.button.callback('🗑️ Delete Credentials', 'delete_credentials')],
        [Markup.button.callback('« Back', 'back_menu')]
      ])
    );
  });

  bot.action('edit_credentials', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    userStates[ctx.from.id] = { step: 'settings_email' };
    await editOrReply(ctx, 'Send your X (Twitter) email/username:', backMenuKeyboard());
  });

  bot.action('delete_credentials', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    let user = await BotUser.findOne({ userId: ctx.from.id.toString() });
    if (user) {
      user.xEmail = null;
      user.xPassword = null;
      user.xUsername = null;
      user.isLoggedIn = false;
      user.lastLoginAt = null;
      await user.save();
    }
    await resetBrowserSession();
    await editOrReply(ctx, 'Credentials deleted. Browser profile preserved to avoid triggering X anti-bot checks.', mainMenuKeyboard());
  });

  bot.action('menu_login', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lockKey = ctx.from?.id != null ? ctx.from.id.toString() : null;
    if (lockKey && loginLocks[lockKey]) return;
    if (lockKey) loginLocks[lockKey] = true;
    let background = false;
    try {
      if (isLoggedIn()) {
        await safeReply(ctx, 'Already logged in.');
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
          await ctx.editMessageText('Welcome to Retweet Bot!', mainMenuKeyboard()).catch(() => {});
        }
        return;
      }

      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText('Logging in...', mainMenuKeyboard()).catch(() => {});
      } else {
        await safeReply(ctx, 'Logging in...');
      }

      background = true;
      setImmediate(async () => {
        let loggedIn = false;
        try {
          loggedIn = await loginToX(ctx.from.id);
        } catch (e) {
          loggedIn = false;
        }

        await BotUser.updateOne(
          { userId: ctx.from.id.toString() },
          {
            $set: { isLoggedIn: Boolean(loggedIn), lastLoginAt: loggedIn ? new Date() : null },
            $setOnInsert: { username: ctx.from.username || null }
          },
          { upsert: true }
        ).catch(() => {});

        try {
          if (chatId && messageId) {
            await bot.telegram.editMessageText(chatId, messageId, undefined, 'Welcome to Retweet Bot!', mainMenuKeyboard()).catch(() => {});
          }
        } finally {
          if (lockKey) loginLocks[lockKey] = false;
        }
      });

      return;
    } catch (err) {
      await safeReply(ctx, `Error: ${err.message}`);
    } finally {
      if (!background && lockKey) loginLocks[lockKey] = false;
    }
  });

  bot.action('menu_logout', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      await logout();
      await BotUser.updateOne(
        { userId: ctx.from.id.toString() },
        { isLoggedIn: false, lastLoginAt: null }
      );
      await safeReply(ctx, 'Logged out successfully!');
      // Now edit the previous message that had the menu (the one that triggered this callback)
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText('Welcome to Retweet Bot!', mainMenuKeyboard()).catch(() => {});
      }
    } catch (err) {
      await safeReply(ctx, `Error logging out: ${err.message}`);
    }
  });

  bot.action('menu_export_auth', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lockKey = ctx.from?.id != null ? ctx.from.id.toString() : null;
    if (lockKey && authStateLocks[lockKey]) return;
    if (lockKey) authStateLocks[lockKey] = true;
    let background = false;
    try {
      if (!isLoggedIn()) {
        await safeReply(ctx, 'Not logged in.');
        if (ctx.callbackQuery && ctx.callbackQuery.message) {
          await ctx.editMessageText('Welcome to Retweet Bot!', mainMenuKeyboard()).catch(() => {});
        }
        return;
      }

      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText('Exporting auth...', mainMenuKeyboard()).catch(() => {});
      } else {
        await safeReply(ctx, 'Exporting auth...');
      }

      background = true;
      setImmediate(async () => {
        try {
          await saveAuthState();
          if (chatId && messageId) {
            await bot.telegram.editMessageText(chatId, messageId, undefined, 'Auth exported to .auth_state/', mainMenuKeyboard()).catch(() => {});
          } else {
            await safeReply(ctx, 'Auth exported to .auth_state/');
          }
        } catch (e) {
          const msg = e?.message || String(e);
          if (chatId && messageId) {
            await bot.telegram.editMessageText(chatId, messageId, undefined, `Export failed: ${msg}`, mainMenuKeyboard()).catch(() => {});
          } else {
            await safeReply(ctx, `Export failed: ${msg}`);
          }
        } finally {
          if (lockKey) authStateLocks[lockKey] = false;
        }
      });
    } catch (err) {
      await safeReply(ctx, `Error: ${err.message}`);
    } finally {
      if (!background && lockKey) authStateLocks[lockKey] = false;
    }
  });

  bot.action('menu_import_auth', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lockKey = ctx.from?.id != null ? ctx.from.id.toString() : null;
    if (lockKey && authStateLocks[lockKey]) return;
    if (lockKey) authStateLocks[lockKey] = true;
    let background = false;
    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (ctx.callbackQuery && ctx.callbackQuery.message) {
        await ctx.editMessageText('Importing auth...', mainMenuKeyboard()).catch(() => {});
      } else {
        await safeReply(ctx, 'Importing auth...');
      }

      background = true;
      setImmediate(async () => {
        let loggedIn = false;
        try {
          loggedIn = await loadAuthState();
        } catch (e) {
          loggedIn = false;
          const msg = e?.message || String(e);
          if (chatId && messageId) {
            await bot.telegram.editMessageText(chatId, messageId, undefined, `Import failed: ${msg}`, mainMenuKeyboard()).catch(() => {});
          } else {
            await safeReply(ctx, `Import failed: ${msg}`);
          }
          if (lockKey) authStateLocks[lockKey] = false;
          return;
        }

        await BotUser.updateOne(
          { userId: ctx.from.id.toString() },
          {
            $set: { isLoggedIn: Boolean(loggedIn), lastLoginAt: loggedIn ? new Date() : null },
            $setOnInsert: { username: ctx.from.username || null }
          },
          { upsert: true }
        ).catch(() => {});

        try {
          const text = loggedIn ? 'Auth imported. Logged in.' : 'Auth imported. Still not logged in.';
          if (chatId && messageId) {
            await bot.telegram.editMessageText(chatId, messageId, undefined, text, mainMenuKeyboard()).catch(() => {});
          } else {
            await safeReply(ctx, text);
          }
        } finally {
          if (lockKey) authStateLocks[lockKey] = false;
        }
      });
    } catch (err) {
      await safeReply(ctx, `Error: ${err.message}`);
    } finally {
      if (!background && lockKey) authStateLocks[lockKey] = false;
    }
  });

  bot.action('menu_admins', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await editOrReply(ctx, 'Manage admins:', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Admin', 'add_admin')],
      [Markup.button.callback('➖ Remove Admin', 'remove_admin')],
      [Markup.button.callback('📋 List Admins', 'list_admins')],
      [Markup.button.callback('« Back', 'back_menu')]
    ]));
  });

  bot.action('add_admin', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    userStates[ctx.from.id] = { step: 'add_admin' };
    await editOrReply(ctx, 'Send the user ID or @username of the admin to add:', backMenuKeyboard());
  });

  bot.action('remove_admin', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    userStates[ctx.from.id] = { step: 'remove_admin' };
    await editOrReply(ctx, 'Send the user ID or @username of the admin to remove:', backMenuKeyboard());
  });

  bot.action('list_admins', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const admins = await Admin.find();
    const text = admins.length
      ? admins
          .map((a) => {
            const dmStatus = a.userId ? 'DM:✅' : 'DM:❌';
            const idPart = a.userId ? `ID: ${a.userId}` : 'ID: (missing)';
            const usernamePart = a.username ? ` | @${a.username}` : '';
            return `${dmStatus} ${idPart}${usernamePart}`;
          })
          .join('\n')
      : 'No admins found';
    await editOrReply(ctx, text, backMenuKeyboard());
  });

  bot.action('menu_groups', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const groups = await ApprovedGroup.find();
    if (groups.length === 0) {
      userStates[ctx.from.id] = { step: 'approve_group' };
      await editOrReply(ctx, 'No groups found yet. Send the group ID or @username to add/approve a group:', backMenuKeyboard());
      return;
    }
    const keyboard = groups.map(g => [
      Markup.button.callback(`${g.isApproved ? '✅' : '❌'} ${g.title || 'No Title'}${g.username ? ` (@${g.username})` : ''}`, `select_group:${g._id}`)
    ]);
    keyboard.push([Markup.button.callback('➕ Add Group by ID/Username', 'add_group_manual')]);
    keyboard.push([Markup.button.callback('« Back', 'back_menu')]);
    await editOrReply(ctx, 'Select a group to manage:', Markup.inlineKeyboard(keyboard));
  });

  bot.action('add_group_manual', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    userStates[ctx.from.id] = { step: 'approve_group' };
    await editOrReply(ctx, 'Send the group ID or @username to add/approve:', backMenuKeyboard());
  });

  bot.action(/select_group:(.+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const groupId = ctx.match[1];
    const group = await ApprovedGroup.findById(groupId);
    if (!group) {
      await editOrReply(ctx, 'Group not found.', backMenuKeyboard());
      return;
    }
    userStates[ctx.from.id] = { step: 'manage_group', groupId: group._id.toString() };
    const statusText = group.isApproved ? 'Approved' : 'Not Approved';
    await editOrReply(ctx,
      `Managing group:\n${group.title || 'No Title'}\nID: ${group.chatId}${group.username ? `\n@${group.username}` : ''}\nStatus: ${statusText}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Approve', 'toggle_approve'), Markup.button.callback('Decline', 'toggle_disapprove')],
        [Markup.button.callback('« Back', 'menu_groups')]
      ])
    );
  });

  bot.action('toggle_approve', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const state = userStates[ctx.from.id];
    if (!state || state.step !== 'manage_group') return;
    const group = await ApprovedGroup.findById(state.groupId);
    if (!group) return;
    group.isApproved = true;
    await group.save();
    const statusText = group.isApproved ? 'Approved' : 'Not Approved';
    await editOrReply(ctx,
      `Managing group:\n${group.title || 'No Title'}\nID: ${group.chatId}${group.username ? `\n@${group.username}` : ''}\nStatus: ${statusText}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Approve', 'toggle_approve'), Markup.button.callback('Decline', 'toggle_disapprove')],
        [Markup.button.callback('« Back', 'menu_groups')]
      ])
    );
  });

  bot.action('toggle_disapprove', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const state = userStates[ctx.from.id];
    if (!state || state.step !== 'manage_group') return;
    const group = await ApprovedGroup.findById(state.groupId);
    if (!group) return;
    group.isApproved = false;
    await group.save();
    const statusText = group.isApproved ? 'Approved' : 'Not Approved';
    await editOrReply(ctx,
      `Managing group:\n${group.title || 'No Title'}\nID: ${group.chatId}${group.username ? `\n@${group.username}` : ''}\nStatus: ${statusText}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Approve', 'toggle_approve'), Markup.button.callback('Decline', 'toggle_disapprove')],
        [Markup.button.callback('« Back', 'menu_groups')]
      ])
    );
  });

  async function requireAdminForGroup(ctx) {
    const isCmd = Boolean(
      ctx?.updateType === 'message'
      && ctx.message
      && 'text' in ctx.message
      && typeof ctx.message.text === 'string'
      && ctx.message.text.trim().startsWith('/')
    );

    if (!ctx?.from) {
      if (isCmd && ctx?.message?.sender_chat) {
        await ctx.reply('Disable anonymous admin mode and resend the command.').catch(() => {});
      }
      return false;
    }

    const admin = await getAdminRecord(ctx.from);
    if (!admin) {
      if (isCmd) {
        try {
          const member = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
          const status = member?.status;
          const isGroupAdmin = status === 'creator' || status === 'administrator';
          if (isGroupAdmin) {
            await ctx
              .reply("You're a group admin, but not registered as a bot admin. Ask the owner to add you via the bot admin list, then DM the bot /start once.")
              .catch(() => {});
          }
        } catch (e) {}
      }
      return false;
    }

    await syncAdminRecord(ctx.from, admin);
    return true;
  }

  const groupTypingState = {};
  async function setGroupTyping(chatId, open, force = false) {
    const key = chatId.toString();
    const desired = open ? 'open' : 'closed';
    if (!force && groupTypingState[key] === desired) return;
    groupTypingState[key] = desired;
    try {
      await bot.telegram.setChatPermissions(chatId, open ? {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: true,
        can_pin_messages: false,
        can_manage_topics: false
      } : {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      });
    } catch (e) {}
  }

  const groupLockLastAttempt = {};
  const groupLockInterval = setInterval(async () => {
    let groups;
    try {
      groups = await ApprovedGroup.find({ isApproved: true });
    } catch (e) {
      return;
    }

    for (const g of groups) {
      const chatId = g?.chatId ? Number(g.chatId) : null;
      if (!chatId) continue;
      const session = getGroupSession(chatId);
      if (session.active) continue;

      const key = chatId.toString();
      const last = groupLockLastAttempt[key] || 0;
      const now = Date.now();
      if (now - last < 30000) continue;
      groupLockLastAttempt[key] = now;

      await setGroupTyping(chatId, false, true);
    }
  }, 60000);
  if (typeof groupLockInterval.unref === 'function') {
    groupLockInterval.unref();
  }

  async function processGroupQueue(chatId) {
    const session = getGroupSession(chatId);
    if (!session.active || session.processing) return;
    session.processing = true;

    try {
      while (session.active && session.queue.length > 0) {
        const item = session.queue.shift();
        if (!item) continue;
        let result;

        if (item.kind === 'undo') {
          result = await undoRepost({
            url: item.url,
            telegram: bot.telegram,
            chatId: item.chatId,
            messageId: item.messageId,
            suppressNotify: true
          });
        } else {
          result = await processSingleRetweet({
            url: item.url,
            telegram: bot.telegram,
            chatId: item.chatId,
            messageId: item.messageId
          });
        }

        const status = result?.status || 'error';
        const ok = status === 'reposted' || status === 'undone';
        if (ok) {
          session.stats.success += 1;
        } else {
          session.stats.failed += 1;
        }

        session.history.push({
          url: item.url,
          action: item.kind === 'undo' ? 'undo' : 'repost',
          status,
          ok,
          chatId: item.chatId,
          messageId: item.messageId
        });

        if (session.slow && item.kind !== 'undo') {
          await sleep(40000);
        }
      }
    } finally {
      session.processing = false;
    }
  }

  bot.command(['s', 'open'], async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;

    const session = getGroupSession(ctx.chat.id);
    resetGroupSession(session);

    let loggedIn = false;
    try {
      loggedIn = await loginToX(ctx.from?.id);
    } catch (e) {
      loggedIn = false;
    }
    if (!loggedIn) {
      await safeReply(ctx, 'Login failed.');
      return;
    }

    session.active = true;
    await setGroupTyping(ctx.chat.id, true);
    await safeReply(ctx, 'Start dropping your X links');
  });

  bot.command('slow', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;
    const session = getGroupSession(ctx.chat.id);
    if (!session.active) {
      await safeReply(ctx, 'No session yet. Please start one first using /s or /open');
      return;
    }
    session.slow = true;
    await setGroupTyping(ctx.chat.id, true, true);
    await safeReply(ctx, 'Slow mode enabled.');
  });

  bot.command('endslow', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;
    const session = getGroupSession(ctx.chat.id);
    if (!session.active) {
      await safeReply(ctx, 'No session yet. Please start one first using /s or /open');
      return;
    }
    session.slow = false;
    await setGroupTyping(ctx.chat.id, true, true);
    await safeReply(ctx, 'Slow mode disabled.');
  });

  bot.command('retry', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;

    const session = getGroupSession(ctx.chat.id);
    const sourceHistory = session.active ? session.history : session.lastEnded?.history;
    if (!Array.isArray(sourceHistory) || sourceHistory.length === 0) {
      await safeReply(ctx, 'No failed links to retry');
      return;
    }

    const failed = sourceHistory
      .map((h, idx) => ({ h, idx }))
      .filter(x => x?.h && x.h.ok === false);

    if (failed.length === 0) {
      await safeReply(ctx, 'No failed links to retry');
      return;
    }

    if (session.processing) return;
    session.processing = true;
    await safeReply(ctx, 'Retrying for failed links...');

    let retriedSuccess = 0;
    let retriedFailed = 0;

    try {
      for (const item of failed) {
        const h = item.h;
        const url = h.url;
        const chatId = h.chatId ?? ctx.chat.id;
        const messageId = h.messageId ?? null;

        let res;
        try {
          if (h.action === 'undo') {
            res = await undoRepost({
              url,
              telegram: bot.telegram,
              chatId,
              messageId,
              suppressNotify: true
            });
          } else {
            res = await processSingleRetweet({
              url,
              telegram: bot.telegram,
              chatId,
              messageId,
              suppressNotify: true
            });
          }
        } catch (e) {
          res = null;
        }

        const status = res?.status || 'error';
        const ok =
          status === 'reposted'
          || status === 'undone'
          || status === 'already_reposted'
          || status === 'already_undone'
          || status === 'not_reposted';

        if (ok) {
          retriedSuccess += 1;
          sourceHistory[item.idx].ok = true;
          if (session.active) {
            if (session.stats.failed > 0) session.stats.failed -= 1;
            session.stats.success += 1;
          } else if (session.lastEnded?.stats) {
            if (session.lastEnded.stats.failed > 0) session.lastEnded.stats.failed -= 1;
            session.lastEnded.stats.success += 1;
          }
        } else {
          retriedFailed += 1;
        }

        if (session.slow && h.action !== 'undo') {
          await sleep(40000);
        }
      }
    } finally {
      session.processing = false;
    }

    const total = failed.length;
    await safeReply(
      ctx,
      `Total Links Retried: ${total}\nSuccessful Retry: ${retriedSuccess}\nFailed Retry: ${retriedFailed}`
    );
  });

  bot.command(['close', 'c'], async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;

    const session = getGroupSession(ctx.chat.id);
    if (!session.active) {
      await setGroupTyping(ctx.chat.id, false, true);
      await safeReply(ctx, 'No session yet. Please start one first using /s or /open');
      return;
    }
    const remaining = session.queue.length;
    session.active = false;
    session.queue = [];

    await safeReply(ctx, 'Session ended.\nAll queued message cleared');
    const notReposted = remaining + session.stats.failed;
    const linkWord = notReposted === 1 ? 'link' : 'links';
    const verb = notReposted === 1 ? 'was' : 'were';
    await safeReply(ctx, `${notReposted} ${linkWord} ${verb} not reposted.`);
    await setGroupTyping(ctx.chat.id, false);

    session.lastEnded = {
      endedAt: Date.now(),
      stats: { ...session.stats },
      history: session.history.slice()
    };
  });

  bot.command('summary', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;
    const session = getGroupSession(ctx.chat.id);
    if (!session.active && !session.lastEnded) {
      await safeReply(ctx, 'No session has occured yet.\nPlease start a session and end it to see summary');
      return;
    }
    const stats = session.active ? session.stats : session.lastEnded.stats;
    await safeReply(ctx,
      `Total Links Received: ${stats.received}\nSuccessful Repost: ${stats.success}\nFailed Repost: ${stats.failed}`
    );
  });

  bot.command(['reverse', 'r'], async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;
    const session = getGroupSession(ctx.chat.id);
    if (session.active) {
      await safeReply(ctx, 'Please end the current session first using /close or /c');
      return;
    }
    if (!session.lastEnded || !Array.isArray(session.lastEnded.history) || session.lastEnded.history.length === 0) {
      await safeReply(ctx, 'No session has occured yet.\nPlease start a session and end it before using reverse');
      return;
    }
    if (session.processing) return;

    let acted = 0;
    const history = session.lastEnded.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (!h?.ok) continue;

      if (h.action === 'repost') {
        const res = await undoRepost({
          url: h.url,
          telegram: bot.telegram,
          suppressNotify: true,
          suppressReact: true
        });
        if (res?.status === 'undone' || res?.status === 'already_undone') {
          acted += 1;
        }
      } else if (h.action === 'undo') {
        const res = await processSingleRetweet({
          url: h.url,
          telegram: bot.telegram,
          suppressNotify: true,
          suppressReact: true
        });
        if (res?.status === 'reposted' || res?.status === 'already_reposted') {
          acted += 1;
        }
      }
    }

    await safeReply(ctx, `Reverse action taken successfully on ${acted} links`);
  });

  bot.command('set', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) return;
    const isAdminUser = await requireAdminForGroup(ctx);
    if (!isAdminUser) return;

    const session = getGroupSession(ctx.chat.id);
    if (session.posting) return;
    session.posting = true;

    try {
      await safeReply(ctx, 'posting...');

      const gifPath = await pickNextGif(ctx.chat.id);
      if (!gifPath) {
        await safeReply(ctx, 'No gifs found.');
        return;
      }

      const quote = pickRandomQuote();
      let result;
      try {
        result = await postWithGif({
          userId: ctx.from?.id,
          mediaPath: gifPath,
          caption: quote
        });
      } catch (e) {
        result = null;
      }

      if (result?.status === 'posted') {
        await safeReply(ctx, 'completed ✅');
      } else {
        await safeReply(ctx, 'failed');
      }
    } finally {
      session.posting = false;
    }
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id.toString();
    const state = userStates[userId];

    if (ctx.chat.type === 'private') {
      const admin = await getAdminRecord(ctx.from);
      if (!admin) return;
      await syncAdminRecord(ctx.from, admin);
    }

    if (ctx.chat.type !== 'private') {
      if (text.startsWith('/')) {
        if (!ctx.from && ctx.message?.sender_chat) {
          await ctx.reply('Disable anonymous admin mode and resend the command.').catch(() => {});
        }
        return;
      }

      const session = getGroupSession(ctx.chat.id);
      if (!session.active) {
        const isAdminUser = await requireAdminForGroup(ctx);
        if (isAdminUser) return;
        await setGroupTyping(ctx.chat.id, false, true);
        await ctx.deleteMessage().catch(() => {});
        return;
      }

      const isAdminUser = await requireAdminForGroup(ctx);
      const urlsInMessage = extractAllXUrls(text);
      if (urlsInMessage.length === 0) return;

      if (!isAdminUser) {
        const key = ctx.from.id.toString();
        const current = session.userLinkCount[key] || 0;
        if (current >= 1) {
          await ctx.deleteMessage().catch(() => {});
          return;
        }
        if (urlsInMessage.length > 1) {
          await ctx.deleteMessage().catch(() => {});
          return;
        }
        session.userLinkCount[key] = current + 1;
      }

      const parsed = isAdminUser
        ? (looksLikeLinksPanel(text) ? parseLinksPanel(text) : parseSimpleMultiLinks(text, session))
        : [{ url: urlsInMessage[0], steps: ['repost'] }];

      if (parsed.length === 0) return;

      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;
      for (const entry of parsed) {
        const url = entry?.url;
        const steps = entry?.steps;
        if (!url || !Array.isArray(steps) || steps.length === 0) continue;

        for (const step of steps) {
          session.queue.push({
            kind: step === 'undo' ? 'undo' : 'repost',
            url,
            chatId,
            messageId
          });
          session.stats.received += 1;
        }
      }

      processGroupQueue(chatId);
      return;
    }

    if (ctx.chat.type === 'private' && state) {
      if (state.step === 'settings_email') {
        userStates[userId] = { step: 'settings_password', pendingEmail: text };
        await ctx.reply('Now send your X password:', backMenuKeyboard());
        return;
      }

      if (state.step === 'settings_password') {
        let user = await BotUser.findOne({ userId });
        user.xEmail = state.pendingEmail;
        user.xPassword = text;
        user.isLoggedIn = false;
        user.lastLoginAt = null;
        await user.save();
        await resetBrowserSession();
        delete userStates[userId];
        await ctx.reply('Settings saved. Browser profile was preserved to avoid X blocking, but the runtime session was reset.', mainMenuKeyboard());
        return;
      }

      if (state.step === 'add_admin') {
        let admin;
        if (text.startsWith('@')) {
          admin = await Admin.findOne({ username: text.slice(1) });
          if (!admin) {
            admin = new Admin({ username: text.slice(1) });
          }
        } else {
          admin = await Admin.findOne({ userId: text });
          if (!admin) {
            admin = new Admin({ userId: text });
          }
        }
        await admin.save();
        delete userStates[userId];
        await ctx.reply('Admin added!', mainMenuKeyboard());
        return;
      }

      if (state.step === 'remove_admin') {
        if (text.startsWith('@')) {
          await Admin.deleteOne({ username: text.slice(1) });
        } else {
          await Admin.deleteOne({ userId: text });
        }
        delete userStates[userId];
        await ctx.reply('Admin removed!', mainMenuKeyboard());
        return;
      }

      if (state.step === 'approve_group') {
        let group;
        if (text.startsWith('@')) {
          group = await ApprovedGroup.findOne({ username: text.slice(1) });
        } else {
          group = await ApprovedGroup.findOne({ chatId: text });
        }
        if (group) {
          group.isApproved = true;
          await group.save();
        } else {
          group = new ApprovedGroup({
            chatId: text.startsWith('@') ? null : text,
            username: text.startsWith('@') ? text.slice(1) : null,
            isApproved: true
          });
          await group.save();
        }
        delete userStates[userId];
        await ctx.reply('Group approved!', mainMenuKeyboard());
        return;
      }

      if (state.step === 'disapprove_group') {
        if (text.startsWith('@')) {
          await ApprovedGroup.updateOne({ username: text.slice(1) }, { isApproved: false });
        } else {
          await ApprovedGroup.updateOne({ chatId: text }, { isApproved: false });
        }
        delete userStates[userId];
        await ctx.reply('Group disapproved!', mainMenuKeyboard());
        return;
      }
    }
  });
}
