# X Retweet Bot

A Telegram bot that logs into X/Twitter and retweets links sent to the bot or in a group.

## Features

- Local Chrome integration for bot evasion
- Persistent Chrome profile (saves login)
- Queue for retweets when bot is offline
- Anti-bot measures (puppeteer-real-browser)
- Turnstile/CAPTCHA solving

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

## Commands

- `/start` - Main menu
