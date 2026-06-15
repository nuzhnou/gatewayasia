const { db } = require('../database/db');

// Куда слать мониторинг диалогов. Если отдельный канал не задан — падает в
// admin-alert (чтобы работало сразу), но лучше выделенный канал.
const MONITOR_CHAT_ID = process.env.DIALOG_MONITOR_CHAT_ID
  || process.env.ADMIN_ALERT_CHAT_ID
  || process.env.ADMIN_TELEGRAM_ID
  || null;
const COLD_HOURS = Number(process.env.DIALOG_COLD_HOURS || 3);

const TERMINAL_OR_QUALIFIED = ['qualified', 'hot', 'sent_to_lc', 'lc_contacted', 'accepted', 'arrived', 'placed', 'paid', 'lost'];

function leadLabel(lead = {}) {
  const name = lead.candidate_name || lead.telegram_username || `chat ${lead.telegram_chat_id}`;
  const src = lead.source_code || lead.source_platform || '—';
  return `${name} · source: ${src} · chat ${lead.telegram_chat_id}`;
}

async function send(bot, text) {
  if (!MONITOR_CHAT_ID) return;
  try {
    await bot.sendMessage(MONITOR_CHAT_ID, text);
  } catch (error) {
    console.error('[MONITOR] send failed:', error.message);
  }
}

async function notifyDialogStart(bot, lead, firstMessage) {
  await send(bot, `🆕 Новый диалог\n${leadLabel(lead)}\n\nПервое сообщение:\n«${String(firstMessage || '').slice(0, 500)}»`);
}

async function notifyQualified(bot, cardText) {
  await send(bot, `✅ КВАЛИФИЦИРОВАН\n\n${cardText}`);
}

async function notifyBotStuck(bot, lead, reason, lastMessage) {
  await send(bot, `🚩 Бот не справился (${reason})\n${leadLabel(lead)}\n\nПоследнее сообщение кандидата:\n«${String(lastMessage || '').slice(0, 500)}»\n\nПолный диалог: /dialog ${lead.telegram_chat_id}`);
}

function formatTranscript(chatId) {
  const rows = db.prepare(
    'SELECT role, message FROM chat_history WHERE chat_id = ? ORDER BY id ASC'
  ).all(chatId);
  if (!rows.length) return `Нет истории для chat ${chatId}.`;
  const body = rows.map(r => `${r.role === 'user' ? '👤' : '🤖'} ${r.message}`).join('\n\n');
  return `Транскрипт chat ${chatId} (${rows.length} сообщений):\n\n${body}`;
}

// Фоновый проход: кто писал, не дошёл до квалификации и молчит > COLD_HOURS.
async function runColdSweep(bot) {
  const rows = db.prepare(`
    SELECT l.* FROM leads l
    WHERE l.telegram_chat_id IS NOT NULL
      AND l.cold_notified_at IS NULL
      AND l.status NOT IN (${TERMINAL_OR_QUALIFIED.map(() => '?').join(',')})
      AND (SELECT COUNT(*) FROM chat_history c WHERE c.chat_id = l.telegram_chat_id AND c.role = 'user') >= 1
      AND (SELECT MAX(created_at) FROM chat_history c WHERE c.chat_id = l.telegram_chat_id) < datetime('now', ?)
  `).all(...TERMINAL_OR_QUALIFIED, `-${COLD_HOURS} hours`);

  for (const lead of rows) {
    const collected = [
      lead.candidate_name ? `Имя: ${lead.candidate_name}` : null,
      lead.phone ? `Телефон: ${lead.phone}` : null,
      (lead.preferred_city || lead.current_location) ? `Город: ${lead.preferred_city || lead.current_location}` : null,
      lead.documents ? `Документы: ${lead.documents}` : null,
      lead.preferred_work_type ? `Работа: ${lead.preferred_work_type}` : null
    ].filter(Boolean).join('\n') || 'почти ничего не успел сказать';
    await send(bot, `❄️ Заглох (молчит >${COLD_HOURS}ч)\n${leadLabel(lead)}\n\nУспели собрать:\n${collected}\n\nМожно дожать вручную. Диалог: /dialog ${lead.telegram_chat_id}`);
    db.prepare('UPDATE leads SET cold_notified_at = CURRENT_TIMESTAMP WHERE id = ?').run(lead.id);
  }
  return rows.length;
}

module.exports = {
  MONITOR_CHAT_ID,
  COLD_HOURS,
  notifyDialogStart,
  notifyQualified,
  notifyBotStuck,
  runColdSweep,
  formatTranscript
};
