require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { db } = require('../database/db');
const { postToFacebookGroup } = require('./fb_local_poster');
const config = require('../../config.json');

// Проверка ключей
if (!process.env.GEMINI_API_KEY) {
  console.error("CRITICAL ERROR: GEMINI_API_KEY must be set in .env file.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Чтение статичных вакансий (фолбек)
function loadVacancies() {
  const filePath = path.join(__dirname, '../../vacancies.json');
  if (!fs.existsSync(filePath)) {
    console.error("Vacancies file not found!");
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error("Error reading vacancies.json:", e);
    return [];
  }
}

// Генерация уникального рекламного текста через Gemini (Text Spinner)
async function generateUniqueAdText(vacancy) {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "PolandJobMatchBot";
  
  const prompt = `
  Ты — копирайтер сообщества взаимопомощи экспатов в Польше "Svoyak.pl".
  Твоя задача — составить теплое, простое и честное объявление о работе для социальных сетей (Facebook, Telegram) на русском или украинском языке. Пиши так, словно ты советуешь проверенную работу своему земляку или хорошему другу.
  
  ДАННЫЕ О ВАКАНСИИ:
  Название: ${vacancy.title}
  Город: ${vacancy.location}
  Оплата: ${vacancy.salary}
  График: ${vacancy.schedule || '10-12 часов, 5-6 дней в неделю'}
  Жилье: ${vacancy.housing || 'Предоставляется'}
  Детали жилья: ${vacancy.housing_details || 'Wi-Fi, все удобства'}
  Обязанности: ${Array.isArray(vacancy.duties) ? vacancy.duties.join(', ') : (vacancy.duties || 'физический труд')}
  Требования: ${Array.isArray(vacancy.requirements) ? vacancy.requirements.join(', ') : (vacancy.requirements || 'виза или биометрия')}
  Бонусы: ${vacancy.benefits || 'официальное оформление'}
  
  ПРАВИЛА СОСТАВЛЕНИЯ:
  1. Пиши понятным, живым языком без лишнего официоза. Используй теплые эмодзи (🏡, 👋, 💸).
  2. Ни в коем случае НЕ упоминай компанию "Legalization Center" и оригинальные бренды (например, "Zara"). Вместо этого используй общие фразы: "крупный логистический склад одежды", "логистический центр", "косметическое предприятие".
  3. Сделай упор на честность: открыто упомяни жилье и то, что кандидат может посмотреть реальный видеообзор комнат прямо в нашем Telegram-боте.
  4. Подчеркни, что трудоустройство полностью бесплатное (никаких скрытых сборов).
  5. В конце добавь четкий призыв к действию (CTA): зайти в наш бот @${botUsername}, посмотреть жилье и оставить заявку за 1 минуту.
  6. Каждый раз генерируй совершенно разные заголовки и структуру предложений, чтобы избежать спам-фильтров.
  
  Верни только готовый текст объявления, без комментариев.
  `;

  try {
    const result = await aiModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error("AI Post Generation Error:", error);
    return `🔥 Срочная вакансия в Польше: ${vacancy.title}!\n📍 Город: ${vacancy.location}\n💰 Оплата: ${vacancy.salary}\n🏠 Жилье предоставляется.\n🤖 Для подачи заявки пишите нашему ИИ-помощнику в Telegram: @${botUsername}`;
  }
}

// Запуск процесса автопостинга
async function runAutoPoster(targetFbGroups = []) {
  let vacancy = null;
  let isFromDb = false;

  // 1. Пытаемся взять готовую отмаскированную вакансию из базы данных
  try {
    const rows = db.prepare("SELECT * FROM vacancies WHERE status = 'parsed' ORDER BY created_at ASC LIMIT 1").all();
    if (rows.length > 0) {
      vacancy = rows[0];
      isFromDb = true;
    }
  } catch (err) {
    console.error("[AUTO POSTER] DB query error:", err);
  }

  // 2. Если в базе нет новых распарсенных вакансий, берем случайную из vacancies.json (fallback)
  if (!vacancy) {
    console.log("[AUTO POSTER] No active 'parsed' vacancies found in DB. Falling back to vacancies.json...");
    const vacancies = loadVacancies();
    if (vacancies.length === 0) {
      console.log("[AUTO POSTER] No vacancies available to post.");
      return null;
    }
    vacancy = vacancies[Math.floor(Math.random() * vacancies.length)];
  }

  console.log(`[AUTO POSTER] Selected vacancy for posting: ${vacancy.id} (${vacancy.title})`);

  // 3. Формируем текст объявления
  let adText = "";
  if (isFromDb && vacancy.obfuscated_text) {
    // В базе уже лежит сгенерированный ИИ обфусцированный текст, берем его напрямую
    adText = vacancy.obfuscated_text;
  } else {
    // Для вакансий из json генерируем текст через Gemini
    adText = await generateUniqueAdText(vacancy);
  }

  console.log("=========================================");
  console.log("GENERATED AD TEXT FOR FB:");
  console.log(adText);
  console.log("=========================================");

  // 4. Публикуем в Facebook-группы
  if (targetFbGroups.length > 0) {
    console.log(`[AUTO POSTER] Directing posting to ${targetFbGroups.length} groups...`);
    let publishSuccess = false;

    for (const groupUrl of targetFbGroups) {
      try {
        const res = await postToFacebookGroup(groupUrl, adText, true); // headless: true по умолчанию
        if (res.success) {
          console.log(`[AUTO POSTER] Successfully posted to group: ${groupUrl}`);
          publishSuccess = true;
        } else {
          console.error(`[AUTO POSTER] Failed to post to group: ${groupUrl}. Error: ${res.error}`);
        }
      } catch (postErr) {
        console.error(`[AUTO POSTER] Exception posting to group: ${groupUrl}`, postErr);
      }
    }

    // Если опубликовано хотя бы в одну группу и вакансия была из БД, помечаем её как posted
    if (publishSuccess && isFromDb) {
      try {
        db.prepare("UPDATE vacancies SET status = 'posted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(vacancy.id);
        console.log(`[AUTO POSTER] Vacancy ID ${vacancy.id} status updated to 'posted' in SQLite.`);
      } catch (dbErr) {
        console.error("[AUTO POSTER] Failed to update vacancy status in database:", dbErr);
      }
    }
  } else {
    console.log("[AUTO POSTER] No target Facebook groups provided in config.json. Skipping posting.");
  }
  
  return adText;
}

// Запуск тестового прогона напрямую
if (require.main === module) {
  process.env.TELEGRAM_BOT_USERNAME = "PolandJobMatchBot";
  runAutoPoster(config.sources.facebookGroups || []);
}

module.exports = {
  runAutoPoster
};

