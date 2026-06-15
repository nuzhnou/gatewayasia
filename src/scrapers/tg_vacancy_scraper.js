require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require('fs');
const path = require('path');
const { db } = require('../database/db');

// Константы подключения
const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : null;
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_USER_SESSION || "";

const defaultChannelId = "-1001620252294"; // PEER ID 1620252294 с приставкой -100 для каналов
const defaultInviteLink = "https://t.me/+ETDNHsW1Xek4ODRk";

async function runTelegramVacancyScraper(sourceConfig = {}) {
  const channelId = sourceConfig.channel_id || defaultChannelId;
  const inviteLink = sourceConfig.invite_link || defaultInviteLink;
  const messageLimit = sourceConfig.message_limit || 50;

  if (!apiId || !apiHash) {
    console.error("\n[TG SCRAPER] ERROR: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env file.");
    console.error("Пожалуйста, зарегистрируйте ваше приложение на https://my.telegram.org/ и добавьте ключи в .env:\n");
    console.error("TELEGRAM_API_ID=123456");
    console.error("TELEGRAM_API_HASH=abcdef123456...\n");
    return { success: false, error: "Missing API credentials in .env" };
  }

  console.log("[TG SCRAPER] Connecting to Telegram client...");
  const stringSession = new StringSession(sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    // Авторизация пользователя (интерактивная при первом запуске)
    await client.start({
      phoneNumber: async () => await input.text("Введите ваш номер телефона (Telegram): "),
      password: async () => await input.text("Введите пароль двухфакторной аутентификации (если есть): "),
      phoneCode: async () => await input.text("Введите код подтверждения из Telegram: "),
      onError: (err) => console.error("[TG SCRAPER] Auth Error:", err),
    });

    console.log("[TG SCRAPER] Successfully connected to Telegram account!");
    
    // Если сессия новая, сохраняем её в .env
    const currentSession = client.session.save();
    if (currentSession !== sessionString) {
      console.log("[TG SCRAPER] Saving new session string to .env file...");
      const envPath = path.join(__dirname, '../../.env');
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : "";
      
      // Удаляем возможные пустые строки в конце и добавляем/заменяем сессию
      if (envContent.includes("TELEGRAM_USER_SESSION=")) {
        envContent = envContent.replace(/TELEGRAM_USER_SESSION=.*/, `TELEGRAM_USER_SESSION=${currentSession}`);
      } else {
        envContent += `\nTELEGRAM_USER_SESSION=${currentSession}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
      process.env.TELEGRAM_USER_SESSION = currentSession;
      console.log("[TG SCRAPER] Session saved successfully!");
    }

    // Получаем доступ к приватному каналу
    let entity;
    try {
      // Пробуем получить объект канала напрямую по peer_id
      entity = await client.getEntity(channelId);
      console.log(`[TG SCRAPER] Found target channel: ${entity.title}`);
    } catch (err) {
      console.log(`[TG SCRAPER] Channel not found in dialogs. Attempting to join via invite link: ${inviteLink}...`);
      try {
        // Извлекаем хэш из инвайт-ссылки
        const hash = inviteLink.split('+')[1];
        await client.invoke(new Api.messages.ImportChatInvite({ hash }));
        entity = await client.getEntity(channelId);
        console.log(`[TG SCRAPER] Successfully joined and retrieved channel: ${entity.title}`);
      } catch (joinErr) {
        console.error("[TG SCRAPER] Failed to join channel via invite link:", joinErr);
        throw joinErr;
      }
    }

    // Считываем последние сообщения
    console.log("[TG SCRAPER] Fetching latest messages from channel...");
    const messages = await client.getMessages(entity, { limit: messageLimit });
    console.log(`[TG SCRAPER] Retrieved ${messages.length} messages.`);

    let newCount = 0;
    for (const msg of messages) {
      if (!msg.message) continue; // Игнорируем пустые/служебные сообщения

      const sourceId = String(msg.id);
      const uuid = `TG-${sourceId}`;

      // Проверяем, есть ли уже этот пост в нашей базе
      const existing = db.prepare("SELECT id FROM vacancies WHERE source_id = ?").get(sourceId);
      if (!existing) {
        // Сохраняем как новую сырую вакансию
        db.prepare(`
          INSERT INTO vacancies (id, source_platform, source_id, raw_text, status)
          VALUES (?, 'telegram', ?, ?, 'new')
        `).run(uuid, sourceId, msg.message);
        newCount++;
      }
    }

    console.log(`[TG SCRAPER] Scraping finished. Added ${newCount} new raw vacancies to SQLite database.`);
    await client.disconnect();
    return { success: true, newCount };
  } catch (error) {
    console.error("[TG SCRAPER] Scraper crashed with error:", error);
    try { await client.disconnect(); } catch (e) {}
    return { success: false, error: error.message };
  }
}

module.exports = {
  runTelegramVacancyScraper
};

// Запуск напрямую при вызове из терминала
if (require.main === module) {
  runTelegramVacancyScraper();
}
