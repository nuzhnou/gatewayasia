require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../database/db');
const { readFacebookSources } = require('../crm/sources');

// Канонические города с формами под RU/UA/PL запросы. variants — все написания,
// которые могут встретиться в базе (латиница/диакритика/кириллица), нормализуем.
const CANON = [
  { key: 'warszawa',  pl: 'Warszawa',  ru: 'Варшава',   ua: 'Варшава',   variants: ['warszawa', 'варшава', 'warsaw'] },
  { key: 'krakow',    pl: 'Kraków',    ru: 'Краков',    ua: 'Краків',    variants: ['krakow', 'kraków', 'краков', 'краків'] },
  { key: 'wroclaw',   pl: 'Wrocław',   ru: 'Вроцлав',   ua: 'Вроцлав',   variants: ['wroclaw', 'wrocław', 'вроцлав'] },
  { key: 'poznan',    pl: 'Poznań',    ru: 'Познань',   ua: 'Познань',   variants: ['poznan', 'poznań', 'познань'] },
  { key: 'gdansk',    pl: 'Gdańsk',    ru: 'Гданьск',   ua: 'Гданськ',   variants: ['gdansk', 'gdańsk', 'гданьск', 'гданськ'] },
  { key: 'lodz',      pl: 'Łódź',      ru: 'Лодзь',     ua: 'Лодзь',     variants: ['lodz', 'łódź', 'łodz', 'лодзь'] },
  { key: 'katowice',  pl: 'Katowice',  ru: 'Катовице',  ua: 'Катовіце',  variants: ['katowice', 'катовице', 'катовіце'] },
  { key: 'szczecin',  pl: 'Szczecin',  ru: 'Щецин',     ua: 'Щецин',     variants: ['szczecin', 'щецин'] },
  { key: 'bydgoszcz', pl: 'Bydgoszcz', ru: 'Быдгощ',    ua: 'Бидгощ',    variants: ['bydgoszcz', 'быдгощ', 'бидгощ'] },
  { key: 'bialystok', pl: 'Białystok', ru: 'Белосток',  ua: 'Білосток',  variants: ['bialystok', 'białystok', 'белосток', 'білосток'] },
  { key: 'olsztyn',   pl: 'Olsztyn',   ru: 'Ольштын',   ua: 'Ольштин',   variants: ['olsztyn', 'ольштын', 'ольштин'] },
  { key: 'chorzow',   pl: 'Chorzów',   ru: 'Хожув',     ua: 'Хожув',     variants: ['chorzow', 'chorzów', 'хожув'] },
  { key: 'tarnow',    pl: 'Tarnów',    ru: 'Тарнув',    ua: 'Тарнув',    variants: ['tarnow', 'tarnów', 'тарнув'] },
  { key: 'rzeszow',   pl: 'Rzeszów',   ru: 'Жешув',     ua: 'Жешів',     variants: ['rzeszow', 'rzeszów', 'жешув', 'жешів'] },
  { key: 'gdynia',    pl: 'Gdynia',    ru: 'Гдыня',     ua: 'Гдиня',     variants: ['gdynia', 'гдыня', 'гдиня'] },
  { key: 'mikolajki', pl: 'Mikołajki', ru: 'Миколайки', ua: 'Миколайки', variants: ['mikolajki', 'mikołajki', 'миколайки'] }
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const VARIANT_TO_CANON = {};
for (const c of CANON) for (const v of c.variants) VARIANT_TO_CANON[norm(v)] = c;
function toCanon(cityRaw) { return VARIANT_TO_CANON[norm(cityRaw)] || null; }

function searchUrl(query) {
  return `https://www.facebook.com/search/groups/?q=${encodeURIComponent(query)}`;
}

// Запросы под город: и диаспора (наши), и польские группы.
function queriesForCity(c) {
  return [
    { audience: 'наши', lang: 'ru', q: `${c.ru} наши` },
    { audience: 'украинцы', lang: 'ru', q: `${c.ru} украинцы` },
    { audience: 'белорусы', lang: 'ru', q: `${c.ru} белорусы` },
    { audience: 'работа', lang: 'ru', q: `${c.ru} работа` },
    { audience: 'робота', lang: 'ua', q: `Робота ${c.ua}` },
    { audience: 'praca', lang: 'pl', q: `Praca ${c.pl}` },
    { audience: 'ogloszenia', lang: 'pl', q: `${c.pl} ogłoszenia` },
    { audience: 'ukraincy_pl', lang: 'pl', q: `Ukraińcy ${c.pl}` },
    { audience: 'dam_prace', lang: 'pl', q: `dam pracę ${c.pl}` }
  ];
}

const NATIONAL = [
  { audience: 'national', lang: 'ru', q: 'Работа в Польше' },
  { audience: 'national', lang: 'ua', q: 'Робота в Польщі' },
  { audience: 'national', lang: 'pl', q: 'Praca w Polsce' },
  { audience: 'national', lang: 'mix', q: 'Praca Polska Ukraina' }
];

function buildWorklist() {
  // 1. Вакансии по каноническим городам (где работа → там и кандидаты).
  const vacRows = db.prepare(
    "SELECT city FROM vacancies WHERE is_active=1 AND status='parsed' AND city IS NOT NULL AND city!=''"
  ).all();
  const vacByCity = {};
  for (const r of vacRows) {
    const c = toCanon(r.city);
    if (c) vacByCity[c.key] = (vacByCity[c.key] || 0) + 1;
  }

  // 2. Сколько готовых групп уже есть по городу (best-effort из CSV).
  const groupsByCity = {};
  for (const row of readFacebookSources()) {
    if (row.joined_status !== 'ready') continue;
    const c = toCanon(row.city);
    if (c) groupsByCity[c.key] = (groupsByCity[c.key] || 0) + 1;
  }

  // 3. Приоритет: где много вакансий и мало групп.
  const cities = CANON
    .map(c => ({ c, vac: vacByCity[c.key] || 0, groups: groupsByCity[c.key] || 0 }))
    .filter(x => x.vac > 0)
    .sort((a, b) => (b.vac - b.groups) - (a.vac - a.groups));

  const rows = [];
  const seenUrls = new Set();
  for (const { c, vac, groups } of cities) {
    for (const item of queriesForCity(c)) {
      const url = searchUrl(item.q);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      rows.push({ priority: vac - groups, city: c.pl, vacancies: vac, groups_have: groups, audience: item.audience, lang: item.lang, query: item.q, search_url: url, status: 'to_review' });
    }
  }
  for (const item of NATIONAL) {
    const url = searchUrl(item.q);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    rows.push({ priority: 999, city: 'ВСЯ ПОЛЬША', vacancies: vacRows.length, groups_have: 0, audience: item.audience, lang: item.lang, query: item.q, search_url: url, status: 'to_review' });
  }
  return { rows, cities };
}

function quoteCsv(v) {
  v = String(v == null ? '' : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function run() {
  const { rows, cities } = buildWorklist();
  const headers = ['priority', 'city', 'vacancies', 'groups_have', 'audience', 'lang', 'query', 'search_url', 'status'];
  const out = [headers.join(',')]
    .concat(rows.map(r => headers.map(h => quoteCsv(r[h])).join(',')))
    .join('\n') + '\n';
  const outPath = path.join(__dirname, '../../data/fb_group_search_worklist.csv');
  fs.writeFileSync(outPath, out, 'utf8');

  console.log('=== FB GROUP DISCOVERY WORKLIST ===');
  console.log(`Города с вакансиями (приоритет = вакансии − уже_есть_групп):`);
  for (const { c, vac, groups } of cities) {
    console.log(`  ${c.pl.padEnd(12)} вакансий:${String(vac).padStart(3)}  групп:${String(groups).padStart(2)}  приоритет:${vac - groups}`);
  }
  console.log(`\nСгенерировано ${rows.length} поисковых запросов → ${path.relative(process.cwd(), outPath)}`);
  console.log('Как пользоваться: открывай search_url, вступай в подходящие группы В ЧЕЛОВЕЧЕСКОМ ТЕМПЕ');
  console.log('(1–2 в день на холодном акке), и URL вступленных групп вписывай в data/facebook_sources.csv.');
  return { count: rows.length, outPath };
}

module.exports = { buildWorklist, queriesForCity, toCanon, run };

if (require.main === module) {
  run();
}
