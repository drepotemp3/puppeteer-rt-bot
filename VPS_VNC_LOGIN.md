# VPS Login & Auth Transfer — Retweet Bot

This project can run on a VPS without constantly re-logging into X.

There are two ways to get an authenticated X session onto the VPS:

1) **Recommended (no VNC): login locally → Export Auth → move `.auth_state/` to VPS → Import Auth**
2) **Fallback (VPS visual): VNC/Xvfb manual login on the VPS**

This document covers both and also describes the project features so a fresh chat session / new dev can understand the full context.

---

## Part A — Recommended: Local Login → Export Auth → VPS Import

### What this does

- You login locally where X is least likely to block (real desktop, real GPU, your normal browser environment).
- The bot exports session data to `.auth_state/`:
  - `cookies.json`
  - `localStorage.json`
  - `sessionStorage.json`
- On the VPS you import that auth state via the admin panel button and the bot becomes logged in without doing UI typing.

### Step 1 (Local): login and export

1) Start the bot locally (headful is fine).
2) In Telegram admin panel:
   - Press **🔐 Login**
   - Complete login in the opened Chrome window (if needed)
3) Press **💾 Export Auth**
4) Confirm these files exist on your local machine:

```text
<repo_root>/.auth_state/cookies.json
<repo_root>/.auth_state/localStorage.json
<repo_root>/.auth_state/sessionStorage.json
```

### Step 2: get `.auth_state/` onto the VPS

The VPS must receive the exported `.auth_state/` folder.

#### Method A (GitHub): commit locally, pull on VPS

Local machine (inside repo):

```bash
git add .auth_state
git commit -m "Add auth state for VPS import"
git push
```

If `git add .auth_state` reports the folder is ignored, run:

```bash
git add -f .auth_state
git commit -m "Add auth state for VPS import"
git push
```

VPS (inside repo):

```bash
cd /path/to/your/repo
git pull
```

#### Method B (Direct copy): SCP the folder to the VPS

From local machine, copy the folder to the VPS repo root:

```bash
scp -r .auth_state root@YOUR_VPS_IP:/path/to/your/repo/
```

### Step 3 (VPS): import via Telegram

1) Start the bot on the VPS normally.
2) In Telegram admin panel press **📥 Import Auth**.
3) Expected result: **“Auth imported. Logged in.”**

If the browser visibly shows you’re logged in but the bot says you aren’t, the code now waits and re-checks login for up to ~20 seconds before deciding “not logged in”.

VPS post-login behavior:
- When running with `HEADLESS=true`, the bot will not demand `DISPLAY`/Xvfb for normal operation.
- If login state is unclear, the bot now actively checks the persisted profile session by navigating to `https://x.com/home` before it shows any “start Xvfb/VNC” guidance.

### Step 4: after restart, why the menu shows Logout/Login

The menu is decided by:

- in-memory runtime login state (fast), and
- DB fallback (`BotUser.isLoggedIn`) so `/start` doesn’t randomly revert after process restarts.

So once Import succeeds and DB is updated, `/start` should show **🚪 Logout**.

---

## Part B — Fallback: VPS Manual Login (Xvfb + VNC)

Use this when:

- X blocks headless / automation on the VPS
- You want to manually complete login (or a captcha / device verification step) on the VPS itself
- You are moving to a brand new account/device and you want to “look human” on the VPS

If the VPS is in normal post-login mode (`HEADLESS=true`) and you see Xvfb-related errors in logs, switch back to the recommended flow in Part A (Import Auth) and confirm the VPS `.env` is not forcing `HEADLESS=false`.

### Concepts (what each tool does)

**Xvfb**
- Virtual display server for Linux servers without a real monitor (we use `:99`).

**Openbox**
- Window manager; without it your VNC screen can look blank even when Xvfb is fine.

**x11vnc**
- Exposes Xvfb’s `:99` as a VNC server on `localhost:5900`.

**SSH Tunnel**
- Keeps VNC bound to localhost on the VPS; you forward it to your PC.

**VNC Viewer (Windows)**
- TigerVNC (or any VNC viewer) connects to `127.0.0.1:15900` on your PC.

### Repo/Env conventions (VPS visual mode)

Suggested `.env` entries:

```env
VPS=true
HEADLESS=false
CHROME_USER_DATA_DIR=/var/lib/rtbot/chrome-profile
```

Notes:
- `VPS=true` makes login flow “manual” (no automated credential typing on VPS).
- You must pass `DISPLAY=:99` into the process environment when starting the bot.

### Terminal layout (blocking-aware)

Use 3 terminals:

1) **Terminal A (VPS): display stack**
2) **Terminal B (LOCAL/PC): SSH tunnel** (blocking by design)
3) **Terminal C (VPS): bot** (blocking by design)

### Terminal A (VPS): start Xvfb + Openbox + x11vnc

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

Optional: show a test window (so VNC isn’t “blank”):

```bash
DISPLAY=:99 xterm &
```

### Terminal B (LOCAL): create SSH tunnel (keep open)

```bash
ssh -L 15900:127.0.0.1:5900 root@YOUR_VPS_IP
```

Then open your VNC viewer and connect to:

```text
127.0.0.1:15900
```

### Terminal C (VPS): start the bot so Chrome appears in VNC

```bash
cd /path/to/your/repo
DISPLAY=:99 HEADLESS=false node index.js
```

### Manual login flow

In Telegram admin panel:
- Press **🔐 Login**
- Complete login inside the VNC browser window
- Press **💾 Export Auth** if you want to later reuse the session elsewhere

---

Operational instructions (systemd service, restart/pull workflow, logs, monitoring) are documented in [README.md](file:///c:/Users/Itive%20Peace%20Ufuoma/Desktop/TG%20BOTS/Client%20Ben/Rtbot-Without-XApi/README.md).
