// Non-interactive Telegram user login helper.
// Usage:
//   TG_PHONE="+48..." [TG_2FA="..."] node src/scrapers/tg_login.js
// Flow:
//   1. Reads TELEGRAM_API_ID / TELEGRAM_API_HASH from .env
//   2. Requests a login code (Telegram sends it to your account)
//   3. Polls /tmp/tg_code.txt for the code (write the code there)
//   4. On success, saves TELEGRAM_USER_SESSION into .env
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : null;
const apiHash = process.env.TELEGRAM_API_HASH;
const phone = process.env.TG_PHONE;
const twoFa = process.env.TG_2FA || '';
const CODE_FILE = process.env.TG_CODE_FILE || '/tmp/tg_code.txt';

function fail(msg) { console.error('[TG LOGIN] ' + msg); process.exit(1); }
if (!apiId || !apiHash) fail('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env (from https://my.telegram.org).');
if (!phone) fail('Set TG_PHONE env var, e.g. TG_PHONE="+48123456789".');

async function waitForCode(timeoutMs = 300000) {
  try { fs.unlinkSync(CODE_FILE); } catch (e) {}
  console.log(`[TG LOGIN] Code requested. Waiting for you to write it to ${CODE_FILE} ...`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(CODE_FILE)) {
      const code = fs.readFileSync(CODE_FILE, 'utf8').trim();
      if (code) { console.log('[TG LOGIN] Code received.'); return code; }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Timed out waiting for login code.');
}

(async () => {
  const session = new StringSession(process.env.TELEGRAM_USER_SESSION || '');
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => phone,
    password: async () => twoFa,
    phoneCode: async () => await waitForCode(),
    onError: (err) => console.error('[TG LOGIN] Auth error:', err && err.message ? err.message : err),
  });
  const str = client.session.save();
  const envPath = path.join(__dirname, '../../.env');
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/TELEGRAM_USER_SESSION=.*/.test(env)) env = env.replace(/TELEGRAM_USER_SESSION=.*/, `TELEGRAM_USER_SESSION=${str}`);
  else env = env.replace(/\n*$/, '\n') + `TELEGRAM_USER_SESSION=${str}\n`;
  fs.writeFileSync(envPath, env, 'utf8');
  console.log('[TG LOGIN] Success. Session saved to .env. You can now run: npm run campaign:scrape');
  await client.disconnect();
  process.exit(0);
})().catch(e => fail(e.message || String(e)));
