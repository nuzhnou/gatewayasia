require('dotenv').config();
const { ApifyClient } = require('apify-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db, initDatabase } = require('../database/db');
const config = require('../../config.json');

// Проверка наличия обязательных ключей
if (!process.env.APIFY_TOKEN || !process.env.GEMINI_API_KEY) {
  console.error("CRITICAL ERROR: APIFY_TOKEN and GEMINI_API_KEY must be set in .env file.");
  process.exit(1);
}

// Инициализация клиентов
const apifyClient = new ApifyClient({ token: process.env.APIFY_TOKEN });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" } // Включаем режим JSON
});

// Инициализируем БД
initDatabase();

// Функция анализа поста через Gemini
async function analyzePostWithAI(postText) {
  const prompt = `
  Ты — профессиональный ИИ-рекрутер. Твоя задача — проанализировать сообщение из группы по поиску работы в Польше.
  Определи, действительно ли автор является соискателем (физическим лицом), который ищет работу для себя. Исключи рекламу других агентств, спам, предложения жилья или услуг.

  Если это соискатель, извлеки:
  1. Имя кандидата (если указано).
  2. Контактную информацию (телефон, viber, whatsapp, ник в Telegram, email).
  3. Текущее местоположение и статус документов (виза, биометрия, PESEL UKR, карта побыта).
  4. Пожелания к вакансии (сфера, город).

  Верни результат строго в формате JSON со следующими полями:
  {
    "isCandidate": true/false (является ли автором сообщения соискатель?),
    "candidateName": "Имя или null",
    "contactInfo": "список контактов или null",
    "locationAndDocs": "местоположение и документы или null",
    "preferences": "пожелания по работе или null",
    "reason": "краткое объяснение решения"
  }
  
  Анализируй текст сообщения:
  "${postText}"
  `;

  try {
    const result = await aiModel.generateContent(prompt);
    const responseText = result.response.text();
    return JSON.parse(responseText);
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return { isCandidate: false, reason: "Error parsing via AI" };
  }
}

// Функция запуска скрапера Facebook
async function scrapeFacebook(groupUrls) {
  console.log(`Starting Facebook scraping for ${groupUrls.length} groups...`);
  
  // Пример параметров для memo23/apify-facebook-group-scraper
  const input = {
    startUrls: groupUrls.map(url => ({ url })),
    resultsLimit: config.apify.default_limit,
    // Другие параметры (например, customCookies) можно добавить в config.json при необходимости
  };

  try {
    const run = await apifyClient.actor(config.apify.actors.facebook_group_scraper).call(input);
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    console.log(`Scraped ${items.length} posts from Facebook groups.`);
    return items;
  } catch (error) {
    console.error("Facebook scraping error:", error);
    return [];
  }
}

// Функция запуска скрапера Telegram
async function scrapeTelegram(channels) {
  console.log(`Starting Telegram scraping for channels: ${channels.join(', ')}...`);

  // Параметры для webfinity/telegram-channel-content-media-scraper-v2
  const input = {
    channelUrls: channels.map(ch => `https://t.me/${ch.replace('@', '')}`),
    limit: config.apify.default_limit,
  };

  try {
    const run = await apifyClient.actor(config.apify.actors.telegram_channel_scraper).call(input);
    const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
    console.log(`Scraped ${items.length} posts from Telegram channels.`);
    return items;
  } catch (error) {
    console.error("Telegram scraping error:", error);
    return [];
  }
}

// Главная функция сбора и обработки лидов
async function runLeadHunter(sources) {
  const fbGroups = sources.facebookGroups || [];
  const tgChannels = sources.telegramChannels || [];
  
  let allRawLeads = [];

  // 1. Собираем посты
  if (fbGroups.length > 0) {
    const fbItems = await scrapeFacebook(fbGroups);
    fbItems.forEach(item => {
      if (item.text || item.message) {
        allRawLeads.push({
          platform: 'facebook',
          url: item.url || item.id,
          text: item.text || item.message,
          name: item.authorName || null
        });
      }
    });
  }

  if (tgChannels.length > 0) {
    const tgItems = await scrapeTelegram(tgChannels);
    tgItems.forEach(item => {
      if (item.text || item.message) {
        allRawLeads.push({
          platform: 'telegram',
          url: item.url || item.id,
          text: item.text || item.message,
          name: null
        });
      }
    });
  }

  console.log(`Processing ${allRawLeads.length} raw leads with AI...`);

  // 2. Пропускаем через Gemini и сохраняем квалифицированных
  let savedCount = 0;
  for (const rawLead of allRawLeads) {
    // Проверяем, нет ли уже этой ссылки в базе
    const existing = db.prepare("SELECT id FROM leads WHERE source_url = ?").get(rawLead.url);
    if (existing) {
      continue; // Пропускаем дубликаты
    }

    const aiAnalysis = await analyzePostWithAI(rawLead.text);
    
    if (aiAnalysis.isCandidate) {
      console.log(`[QUALIFIED LEAD FOUND] Platform: ${rawLead.platform} | Candidate: ${aiAnalysis.candidateName}`);
      
      const insert = db.prepare(`
        INSERT INTO leads (source_platform, source_url, candidate_name, contact_info, raw_post_text, extracted_intent, status)
        VALUES (?, ?, ?, ?, ?, ?, 'new')
      `);
      
      insert.run(
        rawLead.platform,
        rawLead.url,
        aiAnalysis.candidateName || rawLead.name,
        aiAnalysis.contactInfo,
        rawLead.text,
        JSON.stringify(aiAnalysis)
      );
      savedCount++;
    }
  }

  console.log(`Lead Hunter execution finished. Saved ${savedCount} new qualified leads.`);
}

module.exports = {
  runLeadHunter
};
