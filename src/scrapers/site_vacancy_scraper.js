require('dotenv').config();
const puppeteer = require('puppeteer');
const { db, syncNow, initDatabase } = require('../database/db');
const {
  extractVacancyFieldsOffline,
  parseVacancyTextOffline,
  buildFallbackAdText,
  sanitizeObfuscatedText
} = require('../ai/vacancy_parser');

const WORK_SPACE_URL = process.env.LC_WORKSPACE_URL || 'https://legalizationcenter.com/work_space/';

// 1. Получаем список ссылок на вакансии (список рендерится JS — нужен браузер).
async function fetchVacancyLinks() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(WORK_SPACE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const countProducts = () => page.evaluate(() => new Set(
      [...document.querySelectorAll('a[href*="/tproduct/"]')]
        .map(a => (a.href.match(/tproduct\/\d+-(\d+)-/) || [])[1]).filter(Boolean)
    ).size);

    // Каталог скрыт за кнопкой «Загрузить ещё» — кликаем её, пока появляются
    // новые вакансии (иначе соберём только первую страницу).
    let prev = -1;
    for (let i = 0; i < 60; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 700));
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('a,button,div,span')].find(e =>
          /загрузить ещё|загрузить еще|показать ещё|показать еще|load more/i.test(e.textContent || '')
          && (e.textContent || '').trim().length < 30 && e.offsetParent !== null);
        if (btn) { btn.click(); return true; }
        return false;
      });
      await new Promise(r => setTimeout(r, clicked ? 1100 : 400));
      const count = await countProducts();
      if (!clicked && count === prev) break; // кнопки нет и роста нет → конец
      prev = count;
    }
    console.log(`[SITE SCRAPER] Catalog fully loaded: ${prev} products visible.`);

    const links = await page.evaluate(() => {
      const set = {};
      document.querySelectorAll('a[href*="/tproduct/"]').forEach(a => {
        const href = a.href.split('?')[0];
        const m = href.match(/tproduct\/(\d+)-(\d+)-([a-z0-9-]+)/i);
        if (m) set[m[2]] = { productId: m[2], url: href, slug: m[3] };
      });
      return Object.values(set);
    });
    return links;
  } finally {
    await browser.close();
  }
}

// 2. Детальная страница читается обычным HTTP — чистим в текст.
// Возвращаем чистый заголовок (og:title) отдельно + сшитый текст деталей,
// гарантированно включающий строку с комиссией (она бывает в конце страницы).
async function fetchVacancyText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const decode = (s) => String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').trim();
  const ogTitle = decode((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || '');
  const ogDesc = decode((html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1] || '');
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const startIdx = Math.max(0, body.indexOf('Место работы'));
  const detail = body.slice(startIdx, startIdx + 3200);
  // Некоторые строки бывают за пределами окна деталей — добираем явно по всему телу.
  const grab = (re) => (body.match(re) || [])[0] || '';
  const commissionLine = grab(/Комисси[яю][^.]{0,40}/i);
  const housingLine = grab(/(?:жил[ьё]|житло|проживани[ея]|общежити[ея]|zakwaterowan)[^.]{0,80}/i);
  const studentLine = grab(/студент[^.]{0,60}/i);
  const ageLine = grab(/(?:кто требуется|возраст)[^.]{0,80}/i);
  const text = [ogTitle, ogDesc, detail, commissionLine, housingLine, studentLine, ageLine]
    .filter(Boolean).join('\n');
  return { ogTitle, text };
}

function upsertVacancy(record) {
  const existing = db.prepare('SELECT id FROM vacancies WHERE id = ?').get(record.id);
  if (existing) {
    db.prepare(`
      UPDATE vacancies SET
        raw_text=?, title=?, location=?, salary=?, obfuscated_text=?, status='parsed',
        city=?, region=?, role_category=?, pay_net_min=?, pay_net_max=?, student_rate=?,
        gender=?, age_min=?, age_max=?, needs_docs=?, needs_experience=?, housing_provided=?,
        commission_pln_min=?, commission_pln_max=?, source_url=?, is_active=1, last_seen_at=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      record.raw_text, record.title, record.location, record.salary, record.obfuscated_text,
      record.city, record.region, record.role_category, record.pay_net_min, record.pay_net_max, record.student_rate,
      record.gender, record.age_min, record.age_max, record.needs_docs, record.needs_experience, record.housing_provided,
      record.commission_pln_min, record.commission_pln_max, record.source_url, record.last_seen_at, record.id
    );
    return 'updated';
  }
  db.prepare(`
    INSERT INTO vacancies (
      id, source_platform, source_id, raw_text, title, location, salary, obfuscated_text, status,
      city, region, role_category, pay_net_min, pay_net_max, student_rate,
      gender, age_min, age_max, needs_docs, needs_experience, housing_provided,
      commission_pln_min, commission_pln_max, source_url, is_active, last_seen_at
    ) VALUES (?, 'site', ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    record.id, record.source_id, record.raw_text, record.title, record.location, record.salary, record.obfuscated_text,
    record.city, record.region, record.role_category, record.pay_net_min, record.pay_net_max, record.student_rate,
    record.gender, record.age_min, record.age_max, record.needs_docs, record.needs_experience, record.housing_provided,
    record.commission_pln_min, record.commission_pln_max, record.source_url, record.last_seen_at
  );
  return 'inserted';
}

async function runSiteVacancyScraper() {
  initDatabase(); // ensure structured columns exist on the (Turso) schema
  const runStartIso = new Date().toISOString();
  console.log('[SITE SCRAPER] Fetching vacancy list from', WORK_SPACE_URL);
  const links = await fetchVacancyLinks();
  console.log(`[SITE SCRAPER] Found ${links.length} vacancy links.`);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fetchDelayMs = Number(process.env.SCRAPE_DETAIL_DELAY_MS || 350);

  let inserted = 0, updated = 0, failed = 0;
  for (const link of links) {
    try {
      // Небольшая пауза + 1 ретрай: при 159 запросах подряд сайт начинает
      // отдавать пустые/короткие ответы (троттлинг).
      let { ogTitle, text } = await fetchVacancyText(link.url);
      if (!text || text.length < 40) {
        await sleep(1500);
        ({ ogTitle, text } = await fetchVacancyText(link.url));
      }
      if (!text || text.length < 40) { failed += 1; await sleep(fetchDelayMs); continue; }
      // Офлайн-извлечение (без Gemini): для структурированных вакансий сайта
      // regex-парсер точен, бесплатен и не упирается в квоту API.
      const fields = extractVacancyFieldsOffline(text);
      const parsed = parseVacancyTextOffline(text);
      const obfuscated = parsed.isVacancy
        ? buildFallbackAdText(parsed, text)
        : sanitizeObfuscatedText(text.slice(0, 500));
      // Чистый заголовок берём из og:title (реальное название вакансии),
      // вычищая бренды/«Центр легализации».
      const cleanTitle = sanitizeObfuscatedText(ogTitle || '').replace(/\s+/g, ' ').trim();
      const record = {
        id: `SITE-${link.productId}`,
        source_id: link.productId,
        raw_text: text,
        title: cleanTitle || (parsed && parsed.title) || link.slug.replace(/-/g, ' '),
        location: (parsed && parsed.location) || fields.city || 'Польша',
        salary: (parsed && parsed.salary) || null,
        obfuscated_text: obfuscated || null,
        source_url: link.url,
        last_seen_at: runStartIso,
        ...fields
      };
      const op = upsertVacancy(record);
      if (op === 'inserted') inserted += 1; else updated += 1;
      if ((inserted + updated) % 20 === 0) {
        console.log(`[SITE SCRAPER] progress: ${inserted + updated}/${links.length} (last: ${record.city} | ${record.commission_pln_max || '?'} zł)`);
      }
    } catch (error) {
      failed += 1;
      console.error(`[SITE SCRAPER] Failed ${link.url}:`, error.message);
    }
    await sleep(fetchDelayMs);
  }

  // Деактивируем только те вакансии с сайта, которых РЕАЛЬНО нет в текущем
  // списке (а не те, что просто не распарсились в этот раз — иначе транзиентный
  // сбой загрузки ошибочно спрятал бы живую вакансию).
  const seenIds = links.map(l => l.productId);
  const placeholders = seenIds.map(() => '?').join(',') || "''";
  const deactivated = db.prepare(`
    UPDATE vacancies SET is_active=0, updated_at=CURRENT_TIMESTAMP
    WHERE source_platform='site' AND source_id NOT IN (${placeholders})
  `).run(...seenIds);

  syncNow();
  console.log(`[SITE SCRAPER] Done. inserted=${inserted}, updated=${updated}, failed=${failed}, deactivated=${deactivated.changes}.`);
  return { inserted, updated, failed, deactivated: deactivated.changes };
}

module.exports = { runSiteVacancyScraper, fetchVacancyLinks, fetchVacancyText };

if (require.main === module) {
  runSiteVacancyScraper().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
