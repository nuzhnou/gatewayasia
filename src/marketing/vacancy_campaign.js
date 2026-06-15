require('dotenv').config();
const { db, initDatabase } = require('../database/db');
const { runTelegramVacancyScraper } = require('../scrapers/tg_vacancy_scraper');
const { runVacancyParser } = require('../ai/vacancy_parser');
const { postToFacebookGroup } = require('./fb_local_poster');
const { getReadyFacebookSources, appendTrackedCta } = require('../crm/sources');
const config = require('../../config.json');

function randomDelayMinutes(minDelayMinutes, maxDelayMinutes) {
  if (minDelayMinutes === maxDelayMinutes) {
    return minDelayMinutes;
  }
  const min = Math.max(0, Number(minDelayMinutes) || 0);
  const max = Math.max(min, Number(maxDelayMinutes) || min);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizePostingTarget(target) {
  if (typeof target === 'string') {
    return { groupUrl: target, sourceCode: null };
  }
  return {
    groupUrl: target.groupUrl || target.group_url || target.url,
    sourceCode: target.sourceCode || target.source_code || null,
    city: target.city || null,
    segment: target.segment || null
  };
}

function buildPostingPlan(vacancies, facebookGroups, options = {}) {
  const maxPosts = Number.isInteger(options.maxPosts) ? options.maxPosts : Infinity;
  const maxGroupsPerVacancy = Number.isInteger(options.maxGroupsPerVacancy)
    ? options.maxGroupsPerVacancy
    : facebookGroups.length;
  const minDelayMinutes = options.minDelayMinutes ?? 10;
  const maxDelayMinutes = options.maxDelayMinutes ?? 25;
  const plan = [];

  for (const vacancy of vacancies || []) {
    const groups = (facebookGroups || []).slice(0, maxGroupsPerVacancy);
    for (const rawTarget of groups) {
      if (plan.length >= maxPosts) {
        return plan;
      }
      const target = normalizePostingTarget(rawTarget);
      if (!target.groupUrl) {
        continue;
      }
      plan.push({
        vacancyId: vacancy.id,
        groupUrl: target.groupUrl,
        sourceCode: target.sourceCode,
        city: target.city,
        segment: target.segment,
        adText: target.sourceCode
          ? appendTrackedCta(vacancy.obfuscated_text, target.sourceCode, options.botUsername)
          : vacancy.obfuscated_text,
        delayMinutes: randomDelayMinutes(minDelayMinutes, maxDelayMinutes)
      });
    }
  }

  return plan;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const { buildSpunAdText } = require('./spinner');
const { normalizeCity } = require('../crm/vacancy_match');

// Группа считается «общей» (примет любую вакансию), если её город — Польша/общий.
function isGeneralGroup(group) {
  const city = String(group.city || '').toLowerCase();
  const seg = String(group.segment || '').toLowerCase();
  return !city || /poland|польша|general|общ/.test(city) || /general|общ/.test(seg);
}

// Привлекательность вакансии для ОБЩИХ групп: большие города, куда люди реально
// готовы ехать — в приоритете; затем качество работы (оплата netto, жильё).
// Мелкие города / неуказанный город уходят вниз.
const CITY_APPEAL = {
  warszawa: 5, krakow: 5, wroclaw: 5, poznan: 4, gdansk: 4,
  lodz: 3, katowice: 3, szczecin: 3, gdynia: 3, bydgoszcz: 2, lublin: 2
};
function vacancyAppeal(v) {
  const cityScore = CITY_APPEAL[normalizeCity(v.city || v.location || '')] || 0;
  const pay = v.pay_net_max || v.pay_net_min || 0;
  const housing = v.housing_provided ? 3 : 0;
  return cityScore * 1000 + pay * 10 + housing;
}

// Когда в группу последний раз постили (для каденса).
function lastPostedAt(groupUrl) {
  const row = db.prepare("SELECT MAX(posted_at) m FROM post_log WHERE group_url = ? AND status='posted'").get(groupUrl);
  return row && row.m ? Date.parse(row.m + 'Z') || Date.parse(row.m) : 0;
}
function postsToday(account) {
  const row = db.prepare(
    "SELECT COUNT(*) c FROM post_log WHERE status='posted' AND posted_at >= datetime('now','-1 day') AND account = ?"
  ).get(account || 'main');
  return row ? row.c : 0;
}
function recordPost({ groupUrl, account, vacancyId, sourceCode, status }) {
  db.prepare("INSERT INTO post_log (group_url, account, vacancy_id, source_code, status) VALUES (?, ?, ?, ?, ?)")
    .run(groupUrl, account || 'main', vacancyId || null, sourceCode || null, status || 'posted');
}

// Безопасный план: матчим вакансию к группе по городу, не долбим одну группу
// чаще лимита, уважаем дневной лимит аккаунта, текст — спиннингом (не идентичный).
function buildSafePostingPlan(options = {}) {
  const account = options.account || 'main';
  const minHoursPerGroup = Number(options.minHoursPerGroup ?? 72); // 48–72ч по ресёрчу
  const dailyCap = Number(options.dailyCap ?? 10);
  const botUsername = options.botUsername || process.env.TELEGRAM_BOT_USERNAME;
  const now = Date.now();

  const groups = getReadyFacebookSources();
  const vacancies = db.prepare(
    "SELECT * FROM vacancies WHERE is_active=1 AND status='parsed' ORDER BY commission_pln_max DESC, updated_at DESC"
  ).all();

  // Для общих групп — вакансии в порядке привлекательности (большие города + оплата).
  const generalVacancies = [...vacancies].sort((a, b) => vacancyAppeal(b) - vacancyAppeal(a));

  let budget = Math.max(0, dailyCap - postsToday(account));
  const plan = [];
  const usedGroups = new Set();
  let generalIdx = 0; // ротация вакансий для общих групп — чтобы не дублить одну

  for (const group of groups) {
    if (budget <= 0) break;
    if (usedGroups.has(group.groupUrl)) continue;
    // Каденс: не постить в группу, если недавно уже постили.
    if (now - lastPostedAt(group.groupUrl) < minHoursPerGroup * 3600 * 1000) continue;

    const gCity = normalizeCity(group.city || '');
    const general = isGeneralGroup(group);
    // Город группы → вакансия того же города; общие группы крутят РАЗНЫЕ вакансии.
    let vacancy;
    if (general) {
      vacancy = generalVacancies[generalIdx % generalVacancies.length];
      generalIdx += 1;
    } else {
      vacancy = vacancies.find(v => gCity && normalizeCity(v.city || v.location || '') === gCity);
    }
    if (!vacancy) continue;

    usedGroups.add(group.groupUrl);
    plan.push({
      vacancyId: vacancy.id,
      groupUrl: group.groupUrl,
      sourceCode: group.sourceCode,
      city: group.city,
      adText: buildSpunAdText(vacancy, { botUsername, sourceCode: group.sourceCode, key: `${vacancy.id}|${group.groupUrl}` }),
      delayMinutes: randomDelayMinutes(options.minDelayMinutes ?? 8, options.maxDelayMinutes ?? 20)
    });
    budget -= 1;
  }
  return plan;
}

function getParsedVacancies(limit = 10) {
  return db.prepare(`
    SELECT id, title, location, salary, obfuscated_text
    FROM vacancies
    WHERE status = 'parsed'
      AND obfuscated_text IS NOT NULL
      AND TRIM(obfuscated_text) != ''
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(limit);
}

async function runVacancyCampaign(options = {}) {
  const dryRun = options.dryRun !== false;
  const shouldScrapeTelegram = options.scrapeTelegram === true;
  const shouldParseVacancies = options.parseVacancies !== false;
  const shouldPostToFacebook = options.postToFacebook === true && !dryRun;
  const readySourceTargets = options.useSourceSheet === false ? [] : getReadyFacebookSources();
  const facebookGroups = options.facebookGroups
    || (readySourceTargets.length > 0 ? readySourceTargets : config.sources.facebookGroups || []);
  const postingConfig = config.facebookPosting || {};

  if (shouldScrapeTelegram) {
    const scrapeResult = await runTelegramVacancyScraper(options.telegramSource || config.telegramVacancySource);
    if (!scrapeResult || scrapeResult.success === false) {
      throw new Error(`Telegram vacancy scraping failed: ${scrapeResult?.error || 'unknown error'}`);
    }
  }

  if (shouldParseVacancies) {
    await runVacancyParser();
  }

  const vacancies = options.vacancies || getParsedVacancies(options.vacancyLimit || 10);
  const plan = options.plan || buildPostingPlan(vacancies, facebookGroups, {
    maxPosts: options.maxPosts ?? postingConfig.max_posts_per_run ?? 3,
    maxGroupsPerVacancy: options.maxGroupsPerVacancy ?? postingConfig.max_groups_per_vacancy ?? 2,
    minDelayMinutes: options.minDelayMinutes ?? postingConfig.min_delay_minutes ?? 10,
    maxDelayMinutes: options.maxDelayMinutes ?? postingConfig.max_delay_minutes ?? 25,
    botUsername: options.botUsername || process.env.TELEGRAM_BOT_USERNAME
  });

  console.log(`[VACANCY CAMPAIGN] Mode: ${dryRun ? 'dry-run' : 'live'}. Planned posts: ${plan.length}.`);

  if (dryRun || !shouldPostToFacebook) {
    for (const item of plan) {
      const sourceText = item.sourceCode ? ` | source ${item.sourceCode}` : '';
      console.log(`[DRY RUN] Vacancy ${item.vacancyId} -> ${item.groupUrl}${sourceText} after ${item.delayMinutes} min`);
      console.log(item.adText);
      console.log('---');
    }
    return { dryRun: true, planned: plan.length, plan };
  }

  const results = [];
  for (const item of plan) {
    const delayMs = item.delayMinutes * 60 * 1000;
    console.log(`[VACANCY CAMPAIGN] Waiting ${item.delayMinutes} minutes before posting to ${item.groupUrl}...`);
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const result = await postToFacebookGroup(item.groupUrl, item.adText, options.headless !== false);
    results.push({ ...item, result });
    // Журналируем для каденса/CAC (и успех, и неудачу).
    recordPost({
      groupUrl: item.groupUrl,
      account: options.account || 'main',
      vacancyId: item.vacancyId,
      sourceCode: item.sourceCode,
      status: result && result.success ? 'posted' : 'failed'
    });
  }

  const successfulVacancyIds = new Set(
    results.filter(item => item.result && item.result.success).map(item => item.vacancyId)
  );
  for (const vacancyId of successfulVacancyIds) {
    db.prepare("UPDATE vacancies SET status = 'posted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(vacancyId);
  }

  return { dryRun: false, planned: plan.length, results };
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  initDatabase(); // ensure post_log + structured columns exist
  const safe = args.has('--safe');
  const run = safe
    ? runVacancyCampaign({
        dryRun: !args.has('--live'),
        postToFacebook: args.has('--live'),
        headless: !args.has('--headed'),
        parseVacancies: false,
        plan: buildSafePostingPlan({ botUsername: process.env.TELEGRAM_BOT_USERNAME })
      })
    : runVacancyCampaign({
        scrapeTelegram: args.has('--scrape-telegram'),
        dryRun: !args.has('--live'),
        postToFacebook: args.has('--live'),
        headless: !args.has('--headed')
      });
  run.catch(error => {
    console.error("[VACANCY CAMPAIGN] Failed:", error);
    process.exit(1);
  });
}

module.exports = {
  buildPostingPlan,
  buildSafePostingPlan,
  recordPost,
  runVacancyCampaign
};
