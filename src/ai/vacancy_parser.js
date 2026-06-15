require('dotenv').config();
const { db } = require('../database/db');
const { generateJSON } = require('./gemini');

const BRAND_REPLACEMENTS = [
  { pattern: /\b(?:zara|inditex|bershka|pull\s*&\s*bear|stradivarius)\b/gi, replacement: 'крупный логистический склад брендовой одежды' },
  { pattern: /\b(?:amazon|dhl|inpost|dpd|gls)\b/gi, replacement: 'крупный логистический центр' },
  { pattern: /\b(?:biedronka|lidl|kaufland|auchan|carrefour)\b/gi, replacement: 'сеть продуктовых супермаркетов' },
  { pattern: /\b(?:lg|samsung|bosch|philips)\b/gi, replacement: 'завод бытовой техники' },
  { pattern: /\b(?:h&m|hm)\b/gi, replacement: 'склад брендовой одежды' },
  { pattern: /\b(?:legalization center|центр легализации|lci рекрутеры|lci)\b/gi, replacement: '' }
];

const POLISH_CITIES = [
  'Warszawa', 'Варшава', 'Krakow', 'Kraków', 'Краков', 'Poznan', 'Poznań', 'Познань',
  'Wroclaw', 'Wrocław', 'Вроцлав', 'Gdansk', 'Gdańsk', 'Гданьск', 'Lodz', 'Łódź', 'Лодзь',
  'Katowice', 'Катовице', 'Szczecin', 'Щецин', 'Bydgoszcz', 'Быдгощ', 'Lublin', 'Люблин'
];

function sanitizeObfuscatedText(text = '') {
  let sanitized = String(text);

  for (const item of BRAND_REPLACEMENTS) {
    sanitized = sanitized.replace(item.pattern, item.replacement);
  }

  sanitized = sanitized
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/@\w+/g, match => {
      const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'PolandJobMatchBot';
      return match.toLowerCase() === `@${botUsername}`.toLowerCase() ? match : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return sanitized;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return (match[1] || match[0]).trim();
    }
  }
  return null;
}

function extractSalary(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const salaryLine = lines.find(line => /(ставка|оплата|зарплата|stawk[ai]|netto|brutto)/i.test(line));
  if (salaryLine) {
    return salaryLine
      .replace(/^(ставка|оплата|зарплата|stawk[ai])[:\s-]*/i, '')
      .trim();
  }

  return firstMatch(text, [
    /(\d{2}(?:[.,]\d{1,2})?\s*(?:-|–|до)?\s*\d{0,2}(?:[.,]\d{0,2})?\s*(?:PLN|pln|зл|zl)\s*(?:\/|в)?\s*(?:час|год|h)?\s*(?:netto|brutto|чистыми)?)/i
  ]);
}

function parseVacancyTextOffline(rawText = '') {
  const text = String(rawText).trim();
  const lowerText = text.toLowerCase();
  const vacancySignals = [
    'ставка', 'netto', 'brutto', 'зл', 'pln', 'график', 'жилье', 'житло',
    'обязанности', 'требования', 'работа', 'вакансия', 'склад', 'завод'
  ];
  const hasVacancySignal = vacancySignals.some(signal => lowerText.includes(signal));
  const looksLikeCandidate = /ищу\s+работ|шукаю\s+робот|poszukuj[eę]\s+prac/i.test(text);

  if (!hasVacancySignal || looksLikeCandidate) {
    return {
      isVacancy: false,
      invalid_reason: looksLikeCandidate ? 'candidate search post' : 'not enough vacancy signals'
    };
  }

  const city = POLISH_CITIES.find(cityName => lowerText.includes(cityName.toLowerCase())) || null;
  const salary = extractSalary(text);
  const schedule = firstMatch(text, [
    /(?:график|графік|schedule)[:\s-]*([^\n.]+)/i,
    /(\d{1,2}\s*-\s*\d{1,2}\s*час[^\n.]*)/i,
    /(\d{1,2}\s*час[^\n.]*)/i
  ]);
  const housing = firstMatch(text, [
    /(?:жилье|житло|проживание|housing)[:\s-]*([^\n.]+)/i,
    /(жилье[^\n.]+)/i,
    /(житло[^\n.]+)/i
  ]);
  const dutiesText = firstMatch(text, [
    /(?:обязанности|обов'язки|обовязки)[:\s-]*([^\n]+)/i
  ]);
  const requirementsText = firstMatch(text, [
    /(?:требования|вимоги)[:\s-]*([^\n]+)/i
  ]);

  const firstLine = text.split('\n').map(line => line.trim()).find(Boolean) || 'Работа в Польше';
  const title = sanitizeObfuscatedText(firstLine)
    .replace(/^\W+|\W+$/g, '')
    .slice(0, 90) || 'Работник на производство или склад';

  return {
    isVacancy: true,
    title,
    location: city || 'Польша',
    salary: salary || 'ставка уточняется после анкеты',
    schedule: schedule || 'график уточняется',
    housing: housing || 'жилье уточняется',
    housing_details: housing || null,
    duties: dutiesText ? dutiesText.split(/[,;•]/).map(x => x.trim()).filter(Boolean).slice(0, 5) : [],
    requirements: requirementsText ? requirementsText.split(/[,;•]/).map(x => x.trim()).filter(Boolean).slice(0, 5) : [],
    benefits: lowerText.includes('доезд') || lowerText.includes('трансфер') ? 'есть организованный доезд' : 'официальное оформление',
    invalid_reason: null
  };
}

function buildFallbackAdText(parsedVacancy, rawText = '') {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'PolandJobMatchBot';
  const title = sanitizeObfuscatedText(parsedVacancy.title || 'Работа в Польше');
  const duties = Array.isArray(parsedVacancy.duties) && parsedVacancy.duties.length > 0
    ? `\n\nЧто делать:\n${parsedVacancy.duties.map(item => `- ${sanitizeObfuscatedText(item)}`).join('\n')}`
    : '';
  const requirements = Array.isArray(parsedVacancy.requirements) && parsedVacancy.requirements.length > 0
    ? `\n\nКто подходит:\n${parsedVacancy.requirements.map(item => `- ${sanitizeObfuscatedText(item)}`).join('\n')}`
    : '';

  return sanitizeObfuscatedText(`
Работа в Польше: ${title}

Город: ${parsedVacancy.location || 'Польша'}
Ставка: ${parsedVacancy.salary || 'уточняется'}
График: ${parsedVacancy.schedule || 'уточняется'}
Жилье: ${parsedVacancy.housing || 'уточняется'}${duties}${requirements}

Трудоустройство для кандидатов бесплатное, без оплат за вакансию.

Чтобы быстро проверить условия и оставить анкету, напишите нашему боту @${botUsername}. Он задаст пару вопросов и передаст заявку менеджеру.
`);
}

// --- Структурированные поля для фильтрации/подбора ---------------------------

const ALL_CITIES = POLISH_CITIES.concat([
  'Mikołajki', 'Миколайки', 'Skawina', 'Скавина', 'Raciborz', 'Racibórz', 'Рацибуж',
  'Rybnik', 'Рыбник', 'Olsztyn', 'Ольштын', 'Tarnow', 'Tarnów', 'Тарнув',
  'Chorzow', 'Chorzów', 'Хожув', 'Rzeszow', 'Rzeszów', 'Жешув', 'Bialystok', 'Białystok', 'Белосток',
  'Gdynia', 'Гдыня', 'Sopot', 'Сопот'
]);

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const n = parseFloat(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Офлайн-извлечение структурированных полей (без ИИ) — fallback и для проверки.
function extractVacancyFieldsOffline(rawText = '') {
  const text = String(rawText);
  const lower = text.toLowerCase();

  const city = ALL_CITIES.find(c => lower.includes(c.toLowerCase())) || null;

  // Ставка netto: берём все числа перед "zł netto/час" или "netto"
  const payNumbers = (text.match(/(\d{1,2}[.,]?\d{0,2})\s*(?:zł|зл|pln)\s*netto/gi) || [])
    .map(s => parseNumber(s)).filter(Boolean);
  const pay_net_min = payNumbers.length ? Math.min(...payNumbers) : null;
  const pay_net_max = payNumbers.length ? Math.max(...payNumbers) : null;

  // Комиссия рекрутёру: "Комиссия: 900-1000 zł" / "800zł"
  let commission_pln_min = null, commission_pln_max = null;
  const commLine = (text.match(/комисси[яю][^\n]*/i) || [])[0] || '';
  const commNums = (commLine.match(/\d{3,4}/g) || []).map(Number);
  if (commNums.length) { commission_pln_min = Math.min(...commNums); commission_pln_max = Math.max(...commNums); }

  // Возраст: "25–60 лет" / "от 25 до 60" / "до 45 лет" / "от 18 лет"
  let age_min = null, age_max = null;
  const ageFromTo = text.match(/от\s*(\d{2})\s*(?:лет|год)?\s*до\s*(\d{2})\s*(?:лет|год)/i);
  const ageRange = text.match(/(\d{2})\s*[–\-—]\s*(\d{2})\s*(?:лет|год)/i);
  if (ageFromTo) { age_min = Number(ageFromTo[1]); age_max = Number(ageFromTo[2]); }
  else if (ageRange) { age_min = Number(ageRange[1]); age_max = Number(ageRange[2]); }
  else {
    const ageTo = text.match(/до\s*(\d{2})\s*(?:лет|год)/i); if (ageTo) age_max = Number(ageTo[1]);
    const ageFrom = text.match(/от\s*(\d{2})\s*(?:лет|год)/i); if (ageFrom) age_min = Number(ageFrom[1]);
  }

  // Ставка для студентов до 26: "студентам ... 27.70 zł" / "до 26 лет — 27 zł"
  let student_rate = null;
  const studMatch = text.match(/студент[^\d]{0,40}(\d{2}[.,]?\d{0,2})\s*(?:zł|зл|pln)/i)
    || text.match(/до\s*26[^\d]{0,30}(\d{2}[.,]?\d{0,2})\s*(?:zł|зл|pln)/i);
  if (studMatch) student_rate = parseNumber(studMatch[1]);

  // Пол: упоминания "женщины/мужчины/пары"
  const hasMen = /мужчин|чолович|men\b/i.test(text);
  const hasWomen = /женщин|жінк|women\b/i.test(text);
  const gender = (hasMen && !hasWomen) ? 'm' : (hasWomen && !hasMen) ? 'f' : 'any';

  const housing_provided = /(жил[ьё]|житло|проживание|общежит|hostel|zakwaterowan)/i.test(text)
    && !/жиль[её]\s*(?:не\s*предоставля|нет)/i.test(text) ? 1 : 0;

  const needs_experience = /(с\s*опытом|опыт\s*(?:работы\s*)?(?:от|обязател)|з\s*досвідом|doświadczenie)/i.test(text)
    && !/(без\s*опыта|опыт\s*не\s*требуется|bez\s*doświadczenia)/i.test(text) ? 1 : 0;

  // Документы
  const docs = [];
  if (/виз[аы]|visa|віз/i.test(text)) docs.push('виза');
  if (/pesel|песел/i.test(text)) docs.push('PESEL');
  if (/карт[аы]\s*побыт|karta\s*pobytu|карт[аы]\s*поб/i.test(text)) docs.push('карта побыта');
  if (/безвиз|биометр|biometr/i.test(text)) docs.push('биометрия');
  const needs_docs = docs.length ? docs.join('/') : null;

  // Грубая категория роли по ключевым словам
  const roleMap = [
    [/повар|кухн|кухар|kucharz/i, 'кухня/общепит'],
    [/склад|упаков|сортиров|magazyn|комплектов/i, 'склад/логистика'],
    [/водител|kierowca|driver|c\+e/i, 'водитель'],
    [/строит|каменщик|плиточник|гипсокартон|монтаж|сварщик|кровельщик|budowlan/i, 'стройка'],
    [/мебел|сборк/i, 'производство/сборка'],
    [/убор|sprzątan|клинин/i, 'уборка'],
    [/сантехник|водопровод|hydraulik/i, 'сантехника']
  ];
  let role_category = null;
  for (const [re, cat] of roleMap) { if (re.test(text)) { role_category = cat; break; } }

  return {
    city, region: null, role_category,
    pay_net_min, pay_net_max, student_rate,
    gender, age_min, age_max,
    needs_docs, needs_experience, housing_provided,
    commission_pln_min, commission_pln_max
  };
}

// Извлечение структурированных полей через Gemini (с офлайн-фолбэком и слиянием).
async function extractVacancyFields(rawText = '') {
  const offline = extractVacancyFieldsOffline(rawText);
  const prompt = `
Извлеки из текста вакансии в Польше структурированные поля. Верни СТРОГО JSON:
{
  "city": "город работы латиницей или null",
  "region": "регион/воеводство или null",
  "role_category": "короткая категория (кухня, склад, стройка, водитель, уборка, производство) или null",
  "pay_net_min": число (zł/час netto) или null,
  "pay_net_max": число или null,
  "student_rate": число (ставка для студентов до 26) или null,
  "gender": "m | f | any (any если женщины и мужчины или пары)",
  "age_min": число или null,
  "age_max": число или null,
  "needs_docs": "кратко какие документы нужны (виза/PESEL/карта побыта) или null",
  "needs_experience": 0 или 1,
  "housing_provided": 0 или 1,
  "commission_pln_min": число (комиссия рекрутёру zł) или null,
  "commission_pln_max": число или null
}
Текст вакансии:
"${String(rawText).slice(0, 4000)}"
`;
  try {
    const ai = JSON.parse(await generateJSON(prompt));
    // Сливаем: ИИ в приоритете, офлайн добивает пустоты.
    const merged = { ...offline };
    for (const k of Object.keys(offline)) {
      if (ai[k] !== undefined && ai[k] !== null && ai[k] !== '') merged[k] = ai[k];
    }
    if (!['m', 'f', 'any'].includes(merged.gender)) merged.gender = 'any';
    return merged;
  } catch (error) {
    console.error('[VACANCY FIELDS] AI extraction failed, using offline:', error.message);
    return offline;
  }
}

// Функция парсинга одного сообщения через Gemini
async function parseAndObfuscateVacancy(rawText) {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "PolandJobMatchBot";

  const prompt = `
  Ты — профессиональный ИИ-рекрутер и копирайтер. Твоя задача — проанализировать сырой текст сообщения о работе в Польше, извлечь данные и переписать вакансию в маскированном (обфусцированном) виде.
  
  ПРАВИЛА ОБРАБОТКИ:
  1. Определи, содержит ли текст предложение о работе (вакансию). Если это реклама услуг, спам, новость или простое сообщение о поиске работы соискателем — укажи isVacancy = false.
  2. Если это вакансия, извлеки структурированные данные (title, location, salary, schedule, housing, duties, requirements, benefits).
  3. Сгенерируй МАСКИРОВАННЫЙ (обфусцированный) текст объявления для публикации в соцсетях (obfuscated_text):
     - ПОЛНОСТЬЮ исключи и замаскируй любые оригинальные названия брендов (например: Zara, Amazon, LG, Biedronka, H&M, DHL). Вместо них используй общие фразы: "крупный логистический центр брендовой одежды", "склад интернет-магазина косметики", "завод по сборке бытовой техники", "сеть продуктовых супермаркетов".
     - ПОЛНОСТЬЮ исключи названия агентств-конкурентов и оригинального работодателя "Legalization Center" (или "Центр Легализации").
     - Сделай текст дружелюбным, легким для чтения, структурированным по пунктам, с использованием тематических эмодзи.
     - Обязательно добавь упоминание, что вакансия абсолютно бесплатная (без скрытых оплат).
     - В конце текста добавь призыв к действию (CTA): зайти в наш ИИ-бот @${botUsername} для просмотра видеообзоров жилья и мгновенного бронирования вакансии.

  Верни результат строго в формате JSON:
  {
    "isVacancy": true/false,
    "title": "Название вакансии (например, Упаковщик одежды)",
    "location": "Город работы (например, Познань)",
    "salary": "Оплата (например, 22.00 - 27.50 PLN/час нетто)",
    "schedule": "График (например, 12 часов, 5-6 дней в неделю)",
    "housing": "Условия проживания (например, Предоставляется бесплатно)",
    "housing_details": "Детали жилья (по сколько человек в комнате, Wi-Fi и т.д.)",
    "duties": ["обязанность 1", "обязанность 2"],
    "requirements": ["требование 1", "требование 2"],
    "benefits": "Бонусы (например, бесплатный доезд до работы, рабочая одежда)",
    "obfuscated_text": "Готовый рекламный текст объявления...",
    "invalid_reason": "Причина отсева (если isVacancy = false)"
  }

  Сырой текст сообщения для анализа:
  "${rawText}"
  `;

  try {
    const responseText = await generateJSON(prompt);
    const parsed = JSON.parse(responseText);
    if (parsed.isVacancy && parsed.obfuscated_text) {
      parsed.obfuscated_text = sanitizeObfuscatedText(parsed.obfuscated_text);
    }
    return parsed;
  } catch (error) {
    console.error("[VACANCY PARSER] AI generation or parsing failed:", error);
    const fallback = parseVacancyTextOffline(rawText);
    if (!fallback.isVacancy) {
      return { ...fallback, invalid_reason: "AI parser error; offline parser rejected text: " + fallback.invalid_reason };
    }
    return {
      ...fallback,
      obfuscated_text: buildFallbackAdText(fallback, rawText),
      parser_mode: 'offline_fallback'
    };
  }
}

// Запуск парсинга всех необработанных записей из БД
async function runVacancyParser() {
  console.log("[VACANCY PARSER] Querying new raw vacancies from database...");
  const newRawVacancies = db.prepare("SELECT id, raw_text FROM vacancies WHERE status = 'new'").all();
  console.log(`[VACANCY PARSER] Found ${newRawVacancies.length} raw vacancies to process.`);

  let parsedCount = 0;
  let skippedCount = 0;

  for (const rawVacancy of newRawVacancies) {
    console.log(`[VACANCY PARSER] Parsing vacancy ID: ${rawVacancy.id}...`);
    const parsedData = await parseAndObfuscateVacancy(rawVacancy.raw_text);

    if (parsedData.isVacancy) {
      console.log(`[VACANCY PARSER] SUCCESSFULLY PARSED: ${parsedData.title} in ${parsedData.location}`);
      
      const update = db.prepare(`
        UPDATE vacancies
        SET title = ?, location = ?, salary = ?, obfuscated_text = ?, status = 'parsed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      update.run(
        parsedData.title,
        parsedData.location,
        parsedData.salary,
        parsedData.obfuscated_text,
        rawVacancy.id
      );
      parsedCount++;
    } else {
      console.log(`[VACANCY PARSER] SKIPPED (Not a job vacancy): ${parsedData.invalid_reason || 'No details'}`);
      
      const update = db.prepare(`
        UPDATE vacancies
        SET status = 'archived', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      update.run(rawVacancy.id);
      skippedCount++;
    }
  }

  console.log(`[VACANCY PARSER] Parsing complete. Parsed: ${parsedCount}, Skipped: ${skippedCount}.`);
  return { parsedCount, skippedCount };
}

module.exports = {
  parseVacancyTextOffline,
  sanitizeObfuscatedText,
  buildFallbackAdText,
  parseAndObfuscateVacancy,
  runVacancyParser,
  extractVacancyFields,
  extractVacancyFieldsOffline
};

// Запуск напрямую
if (require.main === module) {
  runVacancyParser().then(() => console.log("Done."));
}
