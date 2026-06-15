require('dotenv').config();
const http = require('http');
const { initDatabase } = require('./src/database/db');
const { runLeadHunter } = require('./src/scrapers/lead_hunter');
const { runAutoPoster } = require('./src/marketing/auto_poster');
const config = require('./config.json');

console.log("====================================================");
console.log("   POLAND RECRUITMENT ARBITRAGE AUTOMATION SYSTEM   ");
console.log("====================================================");

// 1. Инициализация базы данных
console.log("[SYSTEM] Initializing SQLite database...");
initDatabase();

// 2. Запуск Telegram-бота (автоматически начинает поллинг при импорте)
console.log("[SYSTEM] Launching Conversational AI Bot...");
let botModule = null;
try {
  botModule = require('./src/bot/bot.js');
} catch (error) {
  console.error("[CRITICAL ERROR] Failed to start Telegram Bot:", error);
}

// 3. Настройка периодического запуска модуля сбора лидов (Lead Hunter)
const hunterIntervalMs = config.automation.lead_hunting_interval_hours * 60 * 60 * 1000;
console.log(`[SYSTEM] Scheduled Lead Hunter to run every ${config.automation.lead_hunting_interval_hours} hours.`);

setInterval(async () => {
  console.log(`[SCHEDULED JOB] Running Lead Hunter at ${new Date().toISOString()}...`);
  try {
    await runLeadHunter(config.sources);
  } catch (error) {
    console.error("[ERROR] Lead Hunter execution failed:", error);
  }
}, hunterIntervalMs);

// 4. Настройка периодического запуска модуля автопостинга вакансий (Auto Poster)
const posterIntervalMs = config.automation.auto_posting_interval_hours * 60 * 60 * 1000;
console.log(`[SYSTEM] Scheduled Auto Poster to run every ${config.automation.auto_posting_interval_hours} hours.`);

setInterval(async () => {
  console.log(`[SCHEDULED JOB] Running Auto Poster at ${new Date().toISOString()}...`);
  try {
    // В реальной работе передаем список Facebook-групп для публикации
    await runAutoPoster(config.sources.facebookGroups);
  } catch (error) {
    console.error("[ERROR] Auto Poster execution failed:", error);
  }
}, posterIntervalMs);

// Запуск первичного быстрого прогона (dry-run/warm-up) через 5 секунд после старта
setTimeout(async () => {
  console.log("[SYSTEM] Starting initial system checks...");
  console.log("[INFO] To run full scraper and poster, make sure API tokens in .env are valid.");
}, 5000);

// 5. HTTP health server.
// Render (and most PaaS) require the process to bind to $PORT, otherwise the
// deploy is marked unhealthy and killed. This endpoint is also what an external
// keep-alive pinger (cron-job.org / UptimeRobot) hits to stop a free instance
// from sleeping after 15 minutes of inactivity.
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const bot = botModule && botModule.getBotStatus ? botModule.getBotStatus() : null;
    // Degraded только при УСТОЙЧИВЫХ ошибках polling. Тишина (никто не пишет) —
    // это норма, не поломка.
    const degraded = bot && bot.errorsLast10m >= 3;
    res.writeHead(degraded ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: degraded ? 'degraded' : 'ok',
      service: 'svoyak-bot',
      time: new Date().toISOString(),
      bot
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(port, () => {
  console.log(`[SYSTEM] Health server listening on :${port} (GET /health)`);
});

// 6. Keep-alive self-ping.
// Render free instances spin down after ~15 min without inbound traffic, which
// would stop Telegram polling. The instance pings its own public URL every 10
// minutes — that round-trips through Render's edge as inbound traffic and resets
// the idle timer, keeping the bot awake 24/7. Render injects RENDER_EXTERNAL_URL
// automatically; KEEPALIVE_URL can override it.
const keepAliveUrl = process.env.KEEPALIVE_URL
  || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health` : null);
if (keepAliveUrl) {
  const KEEPALIVE_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 10 * 60 * 1000);
  setInterval(async () => {
    try {
      await fetch(keepAliveUrl, { method: 'GET' });
    } catch (error) {
      console.warn('[KEEPALIVE] self-ping failed:', error.message);
    }
  }, KEEPALIVE_MS);
  console.log(`[SYSTEM] Keep-alive self-ping every ${Math.round(KEEPALIVE_MS / 60000)}min -> ${keepAliveUrl}`);
} else {
  console.log('[SYSTEM] Keep-alive disabled (no RENDER_EXTERNAL_URL/KEEPALIVE_URL). Set KEEPALIVE_URL to enable.');
}

console.log("[SYSTEM] Infrastructure is active and waiting for events.");
console.log("====================================================");
