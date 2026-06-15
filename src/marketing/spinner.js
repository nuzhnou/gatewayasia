const { sanitizeObfuscatedText } = require('../ai/vacancy_parser');

// Детерминированный «рандом» от строки-ключа — один и тот же (группа+вакансия)
// всегда даёт один вариант, но РАЗНЫЕ группы получают разные тексты.
// Идентичные посты в разные группы — главный триггер теневого бана.
function seededIndex(key, modulo) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % modulo;
}

const OPENERS = [
  'Работа в Польше 🇵🇱',
  '🔥 Свежая вакансия в Польше',
  'Ищем людей на работу в Польше 🇵🇱',
  'Польша: набор сотрудников',
  '📢 Актуальная вакансия',
  'Робота в Польщі 🇵🇱',
  'Открыт набор — работа в Польше'
];
const PAY_PHRASE = [
  (p) => `Оплата: ${p} 💶`,
  (p) => `Ставка ${p}`,
  (p) => `Зарплата: ${p} (на руки)`,
  (p) => `Платят ${p} netto`
];
const HOUSING_YES = [
  '🏠 Жильё предоставляется',
  '🏠 Проживание бесплатно от работодателя',
  'Жильё включено',
  '🏠 Жильё есть'
];
const FREE_NOTE = [
  '✅ Для кандидата всё бесплатно, без оплат за вакансию.',
  '✅ Трудоустройство бесплатное (по закону Польши).',
  '✅ Никаких оплат за вакансию — это бесплатно.'
];
const CTA = [
  (u) => `Подробности и анкета у бота 👉 ${u}`,
  (u) => `Все условия и видеообзоры жилья — в боте: ${u}`,
  (u) => `Откликнуться за 2 минуты: ${u}`,
  (u) => `Жми и оставь заявку 👇\n${u}`
];

function payRange(v) {
  if (v.pay_net_min) {
    const max = v.pay_net_max && v.pay_net_max !== v.pay_net_min ? `-${v.pay_net_max}` : '';
    return `${v.pay_net_min}${max} zł/час${v.student_rate ? `, студентам до 26 — ${v.student_rate} zł` : ''}`;
  }
  return v.salary || 'по договорённости';
}

// Собираем варьированный пост из структурированных полей вакансии.
// opts: { botUsername, sourceCode, key }
function buildSpunAdText(v, opts = {}) {
  const username = String(opts.botUsername || process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
  const link = (username && opts.sourceCode)
    ? `https://t.me/${username}?start=${opts.sourceCode}`
    : (username ? `https://t.me/${username}` : '');
  const key = String(opts.key || `${v.id}|${opts.sourceCode || ''}`);

  const pick = (arr, salt) => arr[seededIndex(key + salt, arr.length)];

  const title = sanitizeObfuscatedText(v.title || 'Работник на склад/производство').slice(0, 80);
  const city = v.city || v.location || 'Польша';

  const lines = [
    pick(OPENERS, 'op'),
    '',
    `📍 ${city} — ${title}`,
    pick(PAY_PHRASE, 'pay')(payRange(v))
  ];
  if (v.housing_provided) lines.push(pick(HOUSING_YES, 'hs'));
  if (v.age_min || v.age_max) lines.push(`👥 Возраст: ${v.age_min || 18}–${v.age_max || 55}`);
  lines.push('');
  lines.push(pick(FREE_NOTE, 'free'));
  if (link) {
    lines.push('');
    lines.push(pick(CTA, 'cta')(link));
  }
  // Не санитизируем целиком — иначе вырежется наша же t.me-ссылка. Заголовок
  // уже очищен от брендов выше; остальное — наш контролируемый шаблон.
  return lines.join('\n');
}

module.exports = { buildSpunAdText, seededIndex };
