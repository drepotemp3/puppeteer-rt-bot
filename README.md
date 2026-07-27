# X Retweet Bot

A Telegram bot that logs into X/Twitter and retweets links sent to the bot or in a group.

## Features

- Local Chrome integration for bot evasion
- Persistent Chrome profile (saves login)
- Queue for retweets when bot is offline
- Anti-bot measures (puppeteer-real-browser)
- Turnstile/CAPTCHA solving

## Project Structure (where things live)

- Bot UI + Telegram handlers: [bot/handlers.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/bot/handlers.js)
- Browser automation + login + queue logic: [helpers/puppeteer.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/helpers/puppeteer.js)
- MongoDB models: [models/db.js](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/models/db.js)
- VPS login options (auth transfer + VNC fallback): [VPS_VNC_LOGIN.md](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/VPS_VNC_LOGIN.md)

## Environment Variables

Create `.env` in the repo root.

Required:

```env
BOT_TOKEN=...
MONGODB_URI=...
```

Common:

```env
VPS=true
HEADLESS=true
TZ=Africa/Lagos
CHROME_USER_DATA_DIR=/var/lib/rtbot/chrome-profile
AUTH_STATE_DIR=/root/puppeteer-rt-bot/.auth_state
```

Notes:
- `VPS=true` makes the login flow prefer manual interaction (no automated credential typing).
- `HEADLESS` controls whether Chrome is headless (typical VPS mode) or headful (VNC mode).
- `CHROME_USER_DATA_DIR` persists Chrome state (profile, cookies, etc).
- `AUTH_STATE_DIR` is where Export/Import Auth reads/writes the portable auth snapshot.

## VPS Mode: Trying To Login vs Post-Login

### Trying to login (needs a visible browser)

Use this only when you must manually interact with the login UI on the VPS (captcha/device checks).

Requirements:
- X server available (Xvfb + VNC)
- `DISPLAY=:99` available to the bot process
- `.env` must include:

```env
HEADLESS=false
VPS=true
```

### Post-login (normal VPS operation)

This is the default steady-state mode after auth has been imported or a session already exists.

Requirements:
- No X server needed
- `.env` should include:

```env
HEADLESS=true
VPS=true
```

Important:
- Actions like **📥 Import Auth**, **🔐 Login**, and any X automation will launch Chrome.
- If `HEADLESS=false` without `DISPLAY`, Puppeteer will fail with “Missing X server”.
- In post-login mode (`HEADLESS=true`), the bot does not require Xvfb/VNC. If you see logs about missing Xvfb, confirm `HEADLESS=true` and restart the systemd service after updating `.env` or pulling new code.

## Admin Panel (Telegram) — Main Actions

In the bot DM (admins only), `/start` shows buttons:

- **🔐 Login / 🚪 Logout**: login state handling
- **💾 Export Auth**: saves `cookies.json`, `localStorage.json`, `sessionStorage.json`
- **📥 Import Auth**: loads the exported auth state and verifies login
- **⚙️ Bot Settings**: set credentials/settings stored in DB
- **👥 Manage Admins**: allow additional Telegram users to access admin panel
- **👥 Manage Groups**: approve/disapprove groups where the bot will operate

## Local Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file with your credentials (see `.env.example`)
3. Run the bot:
   ```bash
   npm start
   ```

## VPS Setup (SSH-Disconnect Survivable) — systemd

This is the recommended way to run the bot on a VPS. The process continues running after SSH disconnect and restarts on crashes/reboots.

Assumptions:
- Repo path: `/root/puppeteer-rt-bot`
- User: `root`
- `.env` exists at `/root/puppeteer-rt-bot/.env`

### Step 1: create the service file

VPS:

```bash
cat >/etc/systemd/system/retweetbot.service <<'EOF'
[Unit]
Description=Retweet Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/puppeteer-rt-bot
EnvironmentFile=/root/puppeteer-rt-bot/.env
ExecStart=/usr/bin/node /root/puppeteer-rt-bot/index.js
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
```

If node is not at `/usr/bin/node`:

```bash
which node
```

Then replace `ExecStart` with that absolute path.

### Step 2: enable and start

```bash
systemctl daemon-reload
systemctl enable --now retweetbot
systemctl status retweetbot --no-pager
```

### Step 3: follow logs

```bash
journalctl -u retweetbot -f
```

### Step 3.1 (Optional): see all logs

```bash 
journalctl -u retweetbot -n 500 --no-pager -o cat
```
### Step 4: common operations

```bash
systemctl restart retweetbot
systemctl stop retweetbot
systemctl start retweetbot
systemctl status retweetbot --no-pager
```

## VPS Workflow: Update Code Without Killing The Bot

Standard update cycle (VPS):

```bash
systemctl stop retweetbot
cd /root/puppeteer-rt-bot
git pull
npm install
systemctl start retweetbot
systemctl status retweetbot --no-pager
```

Follow logs after update:

```bash
journalctl -u retweetbot -f
```

## Login On VPS (Recommended Method)

Primary approach:

1) Run the bot locally and login successfully.
2) Press **💾 Export Auth**.
3) Move `.auth_state/` into the VPS repo (via git push/pull or direct copy).
4) On VPS, press **📥 Import Auth**.

Full detailed steps (including GitHub method and VNC fallback) are in:
- [VPS_VNC_LOGIN.md](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/VPS_VNC_LOGIN.md)

## Commands

- `/start` - Main menu
