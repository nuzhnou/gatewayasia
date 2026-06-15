require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { db, initDatabase, syncNow } = require('../database/db');
const { processCandidateMessage } = require('../ai/conversational_agent');
const {
  createOrUpdateTelegramLead,
  getLeadById,
  getLeadByTelegramChatId,
  updateLeadFromQualification,
  updateLeadStatus,
  setExpectedPayout,
  validateQualification,
  buildLeadAdminCard,
  buildLeadStatusKeyboard,
  STATUS_LABELS
} = require('../crm/leads');
const { formatDailyLeadReport } = require('../crm/reports');
const { exportHandoffLeads } = require('../crm/export');
const { buildAdminHelpText } = require('./admin_help');
const { buildCriteriaFromLead, matchVacancies, formatVacanciesForPrompt } = require('../crm/vacancy_match');
const { notifyDialogStart, notifyQualified, notifyBotStuck, runColdSweep, formatTranscript } = require('./monitor');

// Чтобы не спамить «бот не справился» по одному кандидату многократно за сессию.
const stuckNotified = new Set();

// Проверка токена
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_TELEGRAM_ID;
const adminAlertChatId = process.env.ADMIN_ALERT_CHAT_ID || adminChatId;
const dailyReportChatId = process.env.DAILY_REPORT_CHAT_ID || adminAlertChatId;
const leadOperationsChatId = process.env.LEAD_OPERATIONS_CHAT_ID || adminAlertChatId;
const dailyReportHour = Number(process.env.DAILY_REPORT_HOUR || 21);

if (!token) {
  console.error("CRITICAL ERROR: TELEGRAM_BOT_TOKEN must be set in .env file.");
  process.exit(1);
}

// Инициализация БД
initDatabase();

// Инициализация бота
const bot = new TelegramBot(token, { polling: true });
console.log("Telegram Bot started in polling mode...");

const DEFAULT_COMMISSION_PLN = Number(process.env.DEFAULT_COMMISSION_PLN || 900);

// --- Liveness: приём лидов — единственный вход воронки, его падение = 0 выручки.
// Важно: ТИШИНА (никто не пишет) — это НЕ поломка. Поломка — это УСТОЙЧИВЫЕ
// ошибки polling. Разовый 409 при деплое (старый+новый инстанс на миг) не в счёт.
const liveness = {
  startedAt: Date.now(),
  lastUpdateAt: Date.now(),
  recentErrors: [],          // timestamps последних ошибок polling
  lastPollingError: null,
  lastAdminAlertAt: 0
};
function errorsInWindow(ms) {
  const cut = Date.now() - ms;
  return liveness.recentErrors.filter(t => t > cut).length;
}
function getBotStatus() {
  return {
    uptimeSec: Math.round((Date.now() - liveness.startedAt) / 1000),
    lastUpdateAgeSec: Math.round((Date.now() - liveness.lastUpdateAt) / 1000),
    errorsLast10m: errorsInWindow(10 * 60 * 1000),
    totalErrors: liveness.recentErrors.length,
    lastPollingError: liveness.lastPollingError
  };
}
bot.on('polling_error', (err) => {
  liveness.recentErrors.push(Date.now());
  if (liveness.recentErrors.length > 50) liveness.recentErrors.shift();
  liveness.lastPollingError = { message: (err && err.message) || String(err), at: Date.now() };
  console.error('[POLLING ERROR]', (err && err.code) || '', (err && err.message) || err);
});
// Watchdog: алертим только при УСТОЙЧИВЫХ сбоях (≥3 ошибки за 10 мин), с дебаунсом.
setInterval(() => {
  const sustained = errorsInWindow(10 * 60 * 1000) >= 3;
  const debounced = Date.now() - liveness.lastAdminAlertAt > 30 * 60 * 1000;
  if (sustained && debounced && adminAlertChatId) {
    liveness.lastAdminAlertAt = Date.now();
    const e = liveness.lastPollingError || {};
    bot.sendMessage(adminAlertChatId, `⚠️ Бот: устойчивые ошибки polling (${errorsInWindow(600000)} за 10 мин). Последняя: ${e.message}. Похоже на реальный сбой — проверь Render.`).catch(() => {});
  }
}, 5 * 60 * 1000);

module.exports = { getBotStatus };

function isAdminContext(msg) {
  const chatId = msg.chat.id;
  const fromId = msg.from && msg.from.id;
  return String(fromId) === String(adminChatId)
    || (adminAlertChatId && String(chatId) === String(adminAlertChatId))
    || (dailyReportChatId && String(chatId) === String(dailyReportChatId))
    || (leadOperationsChatId && String(chatId) === String(leadOperationsChatId));
}

function parseCommandOptions(text = '') {
  const parts = String(text).trim().split(/\s+/).slice(1);
  const options = {
    statuses: ['hot', 'qualified'],
    limit: 50
  };

  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '--statuses' && parts[i + 1]) {
      options.statuses = parts[i + 1].split(',').map(value => value.trim()).filter(Boolean);
      i += 1;
    } else if (parts[i] === '--limit' && parts[i + 1]) {
      options.limit = Number(parts[i + 1]) || options.limit;
      i += 1;
    }
  }

  return options;
}

// Обработчик команды /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = msg.chat.username || "unknown";
  const startParam = match[1] ? match[1].trim() : "";
  const tracking = createOrUpdateTelegramLead({
    chatId,
    username,
    firstName: msg.chat.first_name,
    startParam
  });

  console.log(`User ${chatId} (${username}) started bot. Source: ${tracking.sourceCode}. Recruiter ID: ${tracking.recruiterId}`);

  // Очищаем историю чата перед началом нового диалога
  db.prepare("DELETE FROM chat_history WHERE chat_id = ?").run(chatId);

  const welcomeMessage = "👋 Привет! Я Мия, ИИ-помощник Gateway Asia.\nПомогаю с честными вакансиями в Азии (Вьетнам, Таиланд, Китай) — преподавание английского, хостес, модели/промо, отели и индустрия гостеприимства. Без обмана и без оплаты вакансий.\nКак тебя зовут? 👇\n\n👋 Hi! I'm Mia, the Gateway Asia AI assistant.\nI help with legit jobs across Asia (Vietnam, Thailand, China) — English teaching, hostess, model/promo, hotel & hospitality roles. No scams, no fees for jobs.\nWhat's your name? 👇";
  
  // Сохраняем приветствие бота в историю
  db.prepare("INSERT INTO chat_history (chat_id, role, message) VALUES (?, ?, ?)")
    .run(chatId, 'model', welcomeMessage);

bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdminContext(msg)) {
    return bot.sendMessage(chatId, "Эта команда доступна только администратору.");
  }

  await bot.sendMessage(chatId, formatDailyLeadReport());
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdminContext(msg)) {
    return bot.sendMessage(chatId, "Эта команда доступна только администратору.");
  }

  await bot.sendMessage(chatId, buildAdminHelpText());
});

bot.onText(/\/handoff(?:\s+.*)?/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdminContext(msg)) {
    return bot.sendMessage(chatId, "Эта команда доступна только администратору.");
  }

  try {
    const options = parseCommandOptions(msg.text);
    const result = exportHandoffLeads({
      format: 'csv',
      statuses: options.statuses,
      limit: options.limit
    });

    if (result.count === 0) {
      return bot.sendMessage(
        chatId,
        `Нет лидов для LC handoff по статусам: ${options.statuses.join(', ')}.`
      );
    }

    await bot.sendDocument(chatId, result.outputPath, {
      caption: `LC handoff: ${result.count} lead(s). Statuses: ${options.statuses.join(', ')}.`
    });
  } catch (error) {
    console.error("LC handoff command failed:", error);
    await bot.sendMessage(chatId, "Не удалось сформировать LC handoff файл. Проверьте логи.");
  }
});

bot.onText(/\/lead(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdminContext(msg)) {
    return bot.sendMessage(chatId, "Эта команда доступна только администратору.");
  }

  const leadId = Number(match && match[1]);
  if (!leadId) {
    return bot.sendMessage(chatId, "Использование: /lead 123");
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    return bot.sendMessage(chatId, `Лид #${leadId} не найден.`);
  }

  await bot.sendMessage(chatId, buildLeadAdminCard(lead), {
    reply_markup: buildLeadStatusKeyboard(lead.id)
  });
});

// /dialog <chatId|leadId> — полный транскрипт переписки (только админ).
bot.onText(/\/dialog(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdminContext(msg)) {
    return bot.sendMessage(chatId, "Эта команда доступна только администратору.");
  }
  const id = match && match[1] ? Number(match[1]) : null;
  if (!id) {
    return bot.sendMessage(chatId, "Использование: /dialog <chat_id> (id есть в карточке монитора).");
  }
  // Принимаем и chat_id, и lead id — если по chat_id пусто, пробуем как lead.
  let targetChatId = id;
  let transcript = formatTranscript(targetChatId);
  if (transcript.startsWith('Нет истории')) {
    const lead = getLeadById(id);
    if (lead && lead.telegram_chat_id) {
      targetChatId = lead.telegram_chat_id;
      transcript = formatTranscript(targetChatId);
    }
  }
  // Telegram лимит 4096 символов — режем при необходимости.
  await bot.sendMessage(chatId, transcript.slice(0, 4000));
});

// Обработчик всех входящих текстовых сообщений
bot.on('message', async (msg) => {
  liveness.lastUpdateAt = Date.now(); // сигнал живости приёма лидов
  const chatId = msg.chat.id;
  const text = msg.text;

  // Игнорируем команды
  if (!text || text.startsWith('/')) {
    return;
  }

  console.log(`Received message from ${chatId}: "${text}"`);

  try {
    // 1. Получаем историю чата из SQLite (последние 15 сообщений)
    const historyRows = db.prepare(`
      SELECT role, message FROM chat_history 
      WHERE chat_id = ? 
      ORDER BY id ASC LIMIT 15
    `).all(chatId);

    const chatHistory = historyRows.map(row => ({
      role: row.role,
      text: row.message
    }));

    // 🆕 Старт диалога: первое сообщение нового чата → в монитор.
    if (historyRows.length === 0) {
      const startLead = getLeadByTelegramChatId(chatId) || { telegram_chat_id: chatId };
      notifyDialogStart(bot, startLead, text).catch(() => {});
    }

    // Отправляем индикатор "typing" кандидату для имитации человека
    bot.sendChatAction(chatId, 'typing');

    // 1.5 Фильтр-первый подбор вакансий: по уже собранным данным кандидата
    // достаём ≤5 релевантных вакансий и отдаём только их в контекст ИИ
    // (не всю базу — это масштабируется на тысячи вакансий).
    let vacanciesText = null;
    let matchedVacancies = [];
    try {
      const lead = getLeadByTelegramChatId(chatId);
      const criteria = buildCriteriaFromLead(lead || {});
      matchedVacancies = matchVacancies(criteria, 5);
      if (matchedVacancies.length) vacanciesText = formatVacanciesForPrompt(matchedVacancies);
    } catch (matchErr) {
      console.error('[VACANCY MATCH] failed, falling back to default context:', matchErr.message);
    }

    // 2. Обрабатываем сообщение через ИИ-агента (Gemini)
    const result = await processCandidateMessage(chatHistory, text, vacanciesText);

    // 3. Отправляем ответ кандидату
    await bot.sendMessage(chatId, result.reply);

    // 4. Записываем диалог в историю SQLite
    db.prepare("INSERT INTO chat_history (chat_id, role, message) VALUES (?, ?, ?)")
      .run(chatId, 'user', text);
    db.prepare("INSERT INTO chat_history (chat_id, role, message) VALUES (?, ?, ?)")
      .run(chatId, 'model', result.reply);

    // 🚩 Бот не справился: либо ИИ упал (result._error), либо ИИ сам пометил
    // диалог как требующий человека (q.flagForHuman). Шлём один раз на кандидата.
    if ((result._error || (result.qualification && result.qualification.flagForHuman)) && !stuckNotified.has(chatId)) {
      stuckNotified.add(chatId);
      const stuckLead = getLeadByTelegramChatId(chatId) || { telegram_chat_id: chatId };
      notifyBotStuck(bot, stuckLead, result._error ? 'ИИ недоступен' : 'нужен человек', text).catch(() => {});
    }

    // 5. Обработка квалификации кандидата
    const q = result.qualification;
    if (q) {
      const previousLead = getLeadByTelegramChatId(chatId);
      const updatedLead = updateLeadFromQualification(chatId, q);
      const alreadySubmitted = previousLead && [
        'qualified',
        'hot',
        'sent_to_lc',
        'lc_contacted',
        'accepted',
        'arrived',
        'placed',
        'paid',
        'lost'
      ].includes(previousLead.status);

      if (q.isFullyQualified && updatedLead && !alreadySubmitted && validateQualification(q)) {
        console.log(`[LEAD FULLY QUALIFIED] ChatID: ${chatId}`);

        // Фиксируем ожидаемую комиссию (наш заработок) из выбранной/лучшей вакансии.
        let expected = DEFAULT_COMMISSION_PLN;
        const target = matchedVacancies.find(v => v.id === q.targetVacancyId) || matchedVacancies[0];
        if (target && (target.commission_pln_max || target.commission_pln_min)) {
          expected = target.commission_pln_max || target.commission_pln_min;
        }
        setExpectedPayout(updatedLead.id, expected);

        // ✅ Дублируем карточку в монитор диалогов (полная картина по каналу).
        notifyQualified(bot, buildLeadAdminCard(updatedLead, q)).catch(() => {});

        // Отправляем уведомление администратору (вам)
        if (adminAlertChatId) {
          const sent = await bot.sendMessage(
            adminAlertChatId,
            buildLeadAdminCard(updatedLead, q),
            { reply_markup: buildLeadStatusKeyboard(updatedLead.id) }
          );
          db.prepare("UPDATE leads SET last_admin_message_id = ? WHERE id = ?")
            .run(sent.message_id, updatedLead.id);
          console.log(`Notification sent to admin chat: ${adminAlertChatId}`);
        } else {
          console.warn("WARNING: ADMIN_ALERT_CHAT_ID/ADMIN_TELEGRAM_ID is not set in .env. Admin notification skipped.");
        }

        // Отправляем кандидату финальное сообщение
        const finalConfirmation = "Спасибо за ответы! 🙌 Ваши данные сохранены и переданы нашему менеджеру — он свяжется с вами в ближайшее время для подтверждения вакансии и деталей по визе/переезду. ⏳\n\nThank you! 🙌 Your details are saved and passed to our manager — they'll contact you soon to confirm the role and visa/relocation details. ⏳";
        await bot.sendMessage(chatId, finalConfirmation);
        
        db.prepare("INSERT INTO chat_history (chat_id, role, message) VALUES (?, ?, ?)")
          .run(chatId, 'model', finalConfirmation);

        // Flush this completed lead to the remote DB immediately — it is the
        // money event, we do not want to wait for the periodic sync timer.
        syncNow();
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
    bot.sendMessage(chatId, "Прошу прощения, возникла небольшая техническая ошибка при обработке сообщения. Попробуйте написать мне через минуту.");
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const match = data.match(/^lead:(\d+):([a-z_]+)$/);
  if (!match) {
    return bot.answerCallbackQuery(query.id);
  }

  const leadId = Number(match[1]);
  const nextStatus = match[2];

  try {
    const lead = updateLeadStatus(leadId, nextStatus, `telegram:${query.from.id}`);
    await bot.answerCallbackQuery(query.id, {
      text: `Lead #${leadId}: ${STATUS_LABELS[nextStatus] || nextStatus}`
    });

    if (query.message) {
      await bot.editMessageReplyMarkup(buildLeadStatusKeyboard(leadId), {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }

    if (['sent_to_lc', 'placed', 'paid', 'lost'].includes(nextStatus)) {
      const statusMessage = `Lead #${lead.id} status changed to ${STATUS_LABELS[nextStatus] || nextStatus}.`;
      if (adminAlertChatId) {
        await bot.sendMessage(adminAlertChatId, statusMessage);
      }
      if (leadOperationsChatId && String(leadOperationsChatId) !== String(adminAlertChatId)) {
        await bot.sendMessage(leadOperationsChatId, statusMessage);
      }
    }
  } catch (error) {
    console.error("Lead status update failed:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "Could not update lead status.",
      show_alert: true
    });
  }
});

if (dailyReportChatId) {
  let lastDailyReportKey = null;
  setInterval(async () => {
    const now = new Date();
    const reportKey = now.toISOString().slice(0, 10);
    if (now.getHours() !== dailyReportHour || lastDailyReportKey === reportKey) {
      return;
    }

    try {
      await bot.sendMessage(dailyReportChatId, formatDailyLeadReport());
      lastDailyReportKey = reportKey;
    } catch (error) {
      console.error("Daily report send failed:", error);
    }
  }, 15 * 60 * 1000);
}

// ❄️ Cold-sweep: периодически ищем заглохшие диалоги и шлём в монитор.
setInterval(() => {
  runColdSweep(bot).catch(err => console.error('[MONITOR] cold sweep failed:', err.message));
}, 20 * 60 * 1000);
