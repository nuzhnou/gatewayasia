const { db } = require('../database/db');

// Кандидаты пишут города кириллицей ("Краков"), а на сайте латиница с
// диакритикой ("Kraków"). Приводим к общему канону.
const CITY_ALIASES = {
  'варшава': 'warszawa', 'warszawa': 'warszawa', 'warsaw': 'warszawa',
  'краков': 'krakow', 'kraków': 'krakow', 'krakow': 'krakow',
  'познань': 'poznan', 'poznań': 'poznan', 'poznan': 'poznan',
  'вроцлав': 'wroclaw', 'wrocław': 'wroclaw', 'wroclaw': 'wroclaw',
  'гданьск': 'gdansk', 'гданськ': 'gdansk', 'gdańsk': 'gdansk', 'gdansk': 'gdansk',
  'лодзь': 'lodz', 'łódź': 'lodz', 'lodz': 'lodz',
  'катовице': 'katowice', 'katowice': 'katowice',
  'щецин': 'szczecin', 'szczecin': 'szczecin',
  'люблин': 'lublin', 'lublin': 'lublin',
  'быдгощ': 'bydgoszcz', 'bydgoszcz': 'bydgoszcz',
  'тарнув': 'tarnow', 'tarnów': 'tarnow', 'tarnow': 'tarnow',
  'миколайки': 'mikolajki', 'mikołajki': 'mikolajki', 'mikolajki': 'mikolajki',
  'белосток': 'bialystok', 'białystok': 'bialystok', 'bialystok': 'bialystok',
  'гдыня': 'gdynia', 'gdynia': 'gdynia', 'сопот': 'sopot', 'sopot': 'sopot',
  'ольштын': 'olsztyn', 'olsztyn': 'olsztyn', 'жешув': 'rzeszow', 'rzeszów': 'rzeszow',
  'хожув': 'chorzow', 'chorzów': 'chorzow', 'рацибуж': 'raciborz', 'racibórz': 'raciborz'
};

function normalizeCity(name = '') {
  const k = String(name).toLowerCase().trim();
  if (!k) return '';
  if (CITY_ALIASES[k]) return CITY_ALIASES[k];
  for (const alias in CITY_ALIASES) {
    if (alias.length >= 4 && k.includes(alias)) return CITY_ALIASES[alias];
  }
  return k.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Преобразуем собранные ботом данные кандидата в критерии фильтра.
function buildCriteriaFromLead(lead = {}) {
  const cityRaw = (lead.preferred_city || lead.current_location || '').trim();
  const relocate = /переезд|relocat|куда\s*угодно|люб(ой|ое)\s*город|готов(а)?\s*(ехать|переехать)|будь\s*як/i
    .test(lead.preferred_city || '');
  return {
    city: cityRaw || null,
    relocate,
    ageGroup: lead.age_group || null,
    documents: lead.documents || null,
    workType: lead.preferred_work_type || null
  };
}

function ageFromGroup(group) {
  if (!group) return null;
  if (/26\s*\+|старше|26\s*и|26\+/i.test(group)) return 30;
  if (/до\s*26|young|молод/i.test(group)) return 22;
  return null;
}

// Фильтр-первый подбор: возвращает топ ≤limit активных вакансий под критерии.
// Работает и на 10 000 строк — обычный SQL + ранжирование в памяти по limit.
function matchVacancies(criteria = {}, limit = 5) {
  // Берём активные вакансии с разумным потолком (LIMIT защищает сеть в
  // remote-режиме) и ранжируем в памяти. Город матчим через нормализацию
  // (кириллица↔латиница), поэтому SQL-LIKE по городу здесь ненадёжен.
  const rows = db.prepare(
    "SELECT * FROM vacancies WHERE is_active = 1 AND status = 'parsed' LIMIT 500"
  ).all();
  if (!rows.length) return [];

  const critCity = normalizeCity(criteria.city || '');
  const age = ageFromGroup(criteria.ageGroup);
  const workType = (criteria.workType || '').toLowerCase();

  const scored = rows.map(v => {
    let score = 0;
    const vCity = normalizeCity(v.city || v.location || '');
    if (critCity && vCity && vCity === critCity) score += 50;
    else if (criteria.relocate) score += 10;

    if (workType && v.role_category && v.role_category.toLowerCase().includes(workType)) score += 25;
    if (workType && v.title && v.title.toLowerCase().includes(workType)) score += 15;

    if (age && v.age_min && v.age_max) {
      if (age >= v.age_min && age <= v.age_max) score += 10; else score -= 15;
    }
    // Комиссия в нашу пользу — только тай-брейк (кандидат её не видит).
    score += (v.commission_pln_max || v.commission_pln_min || 0) / 1000;
    return { v, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.v);
}

// Компактный текст для промпта бота. ВАЖНО: без комиссии и без source_url —
// кандидат этого видеть не должен.
function formatVacanciesForPrompt(list = []) {
  if (!list.length) return '[]';
  return list.map(v => {
    const pay = v.pay_net_min
      ? `${v.pay_net_min}${v.pay_net_max && v.pay_net_max !== v.pay_net_min ? '-' + v.pay_net_max : ''} zł/час netto${v.student_rate ? ', студентам до 26: ' + v.student_rate + ' zł' : ''}`
      : (v.salary || 'уточняется после анкеты');
    return [
      `ID: ${v.id}`,
      `Должность: ${v.title || '-'}`,
      `Город: ${v.city || v.location || '-'}`,
      `Ставка: ${pay}`,
      `Жильё: ${v.housing_provided ? 'предоставляется' : 'уточняется'}`,
      (v.age_min || v.age_max) ? `Возраст: ${v.age_min || '18'}-${v.age_max || '55'}` : null,
      v.needs_docs ? `Документы: ${v.needs_docs}` : null,
      v.needs_experience ? 'Опыт: желателен' : 'Опыт: можно без опыта'
    ].filter(Boolean).join('; ');
  }).join('\n');
}

module.exports = { buildCriteriaFromLead, matchVacancies, formatVacanciesForPrompt, ageFromGroup, normalizeCity };
