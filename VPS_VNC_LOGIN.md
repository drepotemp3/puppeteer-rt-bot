# VPS Manual Login (Xvfb + VNC) — Retweet Bot

This project supports running on a VPS while still allowing a one-time (or occasional) manual X login in a visible browser, with auth persisted to disk (Chrome profile directory).

This document explains:
- Why a VPS needs Xvfb/VNC for a “visible” browser
- The exact commands and order to bring the VNC screen up reliably
- How to run the bot so Chrome actually appears in VNC
- The codebase changes that make this stable (no stuck “Launching browser…”, no profile lock corruption)

---

## Concepts (what each tool does)

**Xvfb**
- A virtual X11 display server (a fake monitor) for Linux servers without a real screen.
- We use `:99` as the display number.

**Openbox**
- A lightweight window manager. Without a window manager, your VNC screen can look “blank” even if Xvfb is working.

**x11vnc**
- Exposes the Xvfb display as a VNC server (`localhost:5900`).

**SSH Tunnel**
- For safety, VNC is bound to localhost on the VPS.
- You access it from your PC using SSH port forwarding.

**TigerVNC Viewer (PC app)**
- The VNC client you use on Windows to view and control the VPS “screen”.

---

## Repo/Env conventions

The bot loads environment variables from `.env` (in the repo root on the VPS) via `dotenv/config`.

Recommended entries for VPS manual login:

```env
VPS=true
HEADLESS=false
CHROME_USER_DATA_DIR=/var/lib/rtbot/chrome-profile
```

Notes:
- `VPS=true` makes the **Login button** follow the VPS manual-login path (no automated typing on VPS).
- `HEADLESS=false` is required for a visible browser window.
- `DISPLAY=:99` is not stored in `.env` by default; it must exist in the terminal environment that starts the bot (or be set inline on the start command).

---

## Terminal layout (blocking-aware)

You should operate with 3 terminals because some commands are intentionally blocking:

1) **Terminal A (VPS: Display stack)**
   - Runs Xvfb/Openbox/x11vnc as background services.
   - These commands are non-blocking because they use `nohup ... &`.

2) **Terminal B (LOCAL/PC: SSH tunnel)**
   - Holds an SSH port-forward open.
   - This terminal is blocking by design. Keep it open.

3) **Terminal C (VPS: Bot)**
   - Runs `node index.js`.
   - This terminal is blocking by design. Keep it open.

---

## One-time prerequisites (VPS)

### Install packages

```bash
apt update
apt install -y xvfb x11vnc openbox xterm x11-apps
```

### Install Chrome (Puppeteer-managed)

Inside the repo folder:

```bash
cd ~/puppeteer-rt-bot
npx puppeteer browsers install chrome
```

---

## Bring up the VNC screen (reliable method)

### Terminal A (VPS): start Xvfb + Openbox + x11vnc

Run:

```bash
pkill Xvfb || true
pkill x11vnc || true
pkill openbox || true

rm -f /tmp/.X99-lock
rm -f /tmp/.X11-unix/X99
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

export DISPLAY=:99
nohup Xvfb :99 -screen 0 1920x1080x24 -ac >/tmp/xvfb.log 2>&1 &
nohup openbox >/tmp/openbox.log 2>&1 &
nohup x11vnc -display :99 -forever -shared -rfbport 5900 -localhost -nopw -ncache 10 >/tmp/x11vnc.log 2>&1 &
```

### Show a test window so the screen isn’t “blank”

Still in Terminal A:

```bash
DISPLAY=:99 xterm &
```

If you connect via VNC and can see the xterm, the display stack is healthy.

---

## Connect from your PC (Windows)

### Terminal B (LOCAL): create the SSH tunnel

Run and keep it open:

```bash
ssh -L 15900:127.0.0.1:5900 root@YOUR_VPS_IP
```

### TigerVNC Viewer

Open TigerVNC Viewer on your PC and connect to:

```text
127.0.0.1:15900
```

You should see the VPS screen (black background + xterm window is normal).

---

## Start the bot so Chrome appears inside VNC

### Terminal C (VPS): start the bot with DISPLAY + headful

In another VPS terminal session:

```bash
cd ~/puppeteer-rt-bot
DISPLAY=:99 HEADLESS=false node index.js
```

That guarantees the bot process inherits `DISPLAY=:99`, and ensures Chrome opens inside the VNC session.

---

## Manual login flow (in Telegram)

In the bot’s admin panel:
- Press **Login**

On VPS (when `VPS=true`), the bot will:
- Reuse existing logged-in session from the Chrome profile if present
- Try cookie login if provided (`X_AUTH_TOKEN` / `X_CT0` / `X_COOKIES_JSON`)
- Otherwise require manual login in the visible Chrome window inside VNC

After you log in, the session persists in:

```text
/var/lib/rtbot/chrome-profile
```

---

## Latest stability fixes (what changed in code and why it matters)

### 1) Stop puppeteer-real-browser from fighting your Xvfb

When running headful (`HEADLESS=false`) on Linux with an existing `DISPLAY`, `puppeteer-real-browser` can try to spawn its own Xvfb and conflict with your already-running `:99`.

The browser launch now passes:
- `disableXvfb: true` when `DISPLAY` exists and headless is false

This prevents “server already running” failures.

### 2) Skip `connect()` on headful Linux; prefer `puppeteer.launch()`

`connect()` (puppeteer-real-browser) sometimes hangs or returns `ECONNREFUSED` on the VPS, leaving a Chrome process behind and causing profile locking issues.

The launch strategy is now:
- **Headless:** may use `connect()`
- **Headful Linux (VNC/Xvfb):** skips `connect()` and uses `puppeteer.launch()` directly

### 3) Prevent profile lock corruption (SingletonLock)

If Chrome is left running, the profile directory gets locked:

```text
/var/lib/rtbot/chrome-profile/SingletonLock
```

The bot now:
- Detects the singleton-lock error during launch
- Removes stale singleton files (`SingletonLock`, `SingletonSocket`, `SingletonCookie`)
- Retries launching once

If you get stuck anyway, the manual recovery is:

```bash
pkill -f chrome-linux64/chrome || true
rm -f /var/lib/rtbot/chrome-profile/SingletonLock /var/lib/rtbot/chrome-profile/SingletonSocket /var/lib/rtbot/chrome-profile/SingletonCookie
```

---

## Troubleshooting checklist

### VNC shows a black screen
Black background is normal. Confirm you started a visible window:

```bash
DISPLAY=:99 xterm &
```

If xterm appears in VNC, your display stack is working.

### Chrome doesn’t appear in VNC
Ensure the bot process is started with the display:

```bash
DISPLAY=:99 HEADLESS=false node index.js
```

### Xvfb “server already running”
You started Xvfb twice. Reset and restart:

```bash
pkill Xvfb || true
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
```

### Profile “already running” (SingletonLock)
Kill chrome + remove singleton files (see above).

---

## Clean stop (optional)

```bash
pkill x11vnc || true
pkill openbox || true
pkill Xvfb || true
```

