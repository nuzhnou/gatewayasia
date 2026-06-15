#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const config = require('../../config.json');
const { initDatabase } = require('../database/db');
const { readFacebookSources, analyzeFacebookSources } = require('../crm/sources');

const ROOT_DIR = path.join(__dirname, '../..');

const REQUIRED_ENV = [
  'GEMINI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'ADMIN_TELEGRAM_ID',
  'ADMIN_ALERT_CHAT_ID',
  'DAILY_REPORT_CHAT_ID'
];

const OPTIONAL_FOR_AUTOMATION_ENV = [
  'APIFY_TOKEN',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_USER_SESSION',
  'LEAD_OPERATIONS_CHAT_ID',
  'SOURCE_TESTS_CHAT_ID'
];

function isPlaceholder(value) {
  if (!value) {
    return true;
  }
  return /your_|_here|telegram_group|telegram_channel|numerical|token_here|api_id|api_hash/i.test(value);
}

function checkEnv(name, required = true) {
  const value = process.env[name];
  const ok = !isPlaceholder(value);
  return {
    name,
    ok: required ? ok : true,
    warning: !required && !ok,
    message: ok ? 'set' : required ? 'missing or placeholder' : 'not set'
  };
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT_DIR, relativePath));
}

function printSection(title, checks) {
  console.log(`\n${title}`);
  for (const check of checks) {
    const mark = check.warning ? '[WARN]' : check.ok ? '[OK]' : '[FAIL]';
    console.log(`${mark} ${check.name}: ${check.message}`);
  }
}

function main() {
  initDatabase();

  const requiredEnvChecks = REQUIRED_ENV.map(name => checkEnv(name, true));
  const optionalEnvChecks = OPTIONAL_FOR_AUTOMATION_ENV.map(name => checkEnv(name, false));
  const facebookSourceRows = readFacebookSources();
  const facebookSourceAnalysis = analyzeFacebookSources(facebookSourceRows);

  const fileChecks = [
    { name: 'docs/2000_USD_30_DAY_OPERATING_PLAN.md', ok: fileExists('docs/2000_USD_30_DAY_OPERATING_PLAN.md'), message: fileExists('docs/2000_USD_30_DAY_OPERATING_PLAN.md') ? 'present' : 'missing' },
    { name: 'docs/PRELAUNCH_CHECKLIST.md', ok: fileExists('docs/PRELAUNCH_CHECKLIST.md'), message: fileExists('docs/PRELAUNCH_CHECKLIST.md') ? 'present' : 'missing' },
    { name: 'docs/STARTER_FB_TG_CONTENT_PACK.md', ok: fileExists('docs/STARTER_FB_TG_CONTENT_PACK.md'), message: fileExists('docs/STARTER_FB_TG_CONTENT_PACK.md') ? 'present' : 'missing' },
    { name: 'data/facebook_sources.csv', ok: fileExists('data/facebook_sources.csv'), message: fileExists('data/facebook_sources.csv') ? 'present' : 'missing' },
    { name: 'exports/', ok: fileExists('exports'), message: fileExists('exports') ? 'present' : 'missing' },
    { name: 'database.db', ok: fileExists('database.db'), message: fileExists('database.db') ? 'present' : 'will be created on first run' }
  ];

  const sourceChecks = [
    {
      name: 'Facebook groups in config.json',
      ok: Array.isArray(config.sources?.facebookGroups) && config.sources.facebookGroups.length >= 2,
      warning: !(Array.isArray(config.sources?.facebookGroups) && config.sources.facebookGroups.length >= 10),
      message: `${config.sources?.facebookGroups?.length || 0} configured; first launch target is 50+`
    },
    {
      name: 'Telegram channels in config.json',
      ok: Array.isArray(config.sources?.telegramChannels) && config.sources.telegramChannels.length > 0,
      message: `${config.sources?.telegramChannels?.length || 0} configured`
    },
    {
      name: 'Facebook posting limits',
      ok: Number(config.facebookPosting?.max_posts_per_run || 0) > 0,
      message: `max_posts_per_run=${config.facebookPosting?.max_posts_per_run || 0}`
    },
    {
      name: 'Facebook source sheet rows',
      ok: facebookSourceAnalysis.totalRows >= 30,
      warning: facebookSourceAnalysis.totalRows < 50,
      message: `${facebookSourceAnalysis.totalRows} source rows; first launch target is 50+`
    },
    {
      name: 'Facebook source sheet URLs',
      ok: facebookSourceAnalysis.withUrl > 0,
      warning: facebookSourceAnalysis.withUrl < 50,
      message: `${facebookSourceAnalysis.withUrl} group URLs filled; first launch target is 50+`
    },
    {
      name: 'Facebook ready groups',
      ok: true,
      warning: facebookSourceAnalysis.ready < 10,
      message: `${facebookSourceAnalysis.ready} ready; first test target is 10+`
    },
    {
      name: 'Facebook source code uniqueness',
      ok: facebookSourceAnalysis.duplicates.length === 0,
      message: facebookSourceAnalysis.duplicates.length === 0 ? 'no duplicates' : facebookSourceAnalysis.duplicates.join(', ')
    },
    {
      name: 'Facebook source row validity',
      ok: facebookSourceAnalysis.invalidRows.length === 0,
      message: facebookSourceAnalysis.invalidRows.length === 0 ? 'valid' : `${facebookSourceAnalysis.invalidRows.length} invalid row(s)`
    }
  ];

  printSection('Required environment', requiredEnvChecks);
  printSection('Optional automation environment', optionalEnvChecks);
  printSection('Local files', fileChecks);
  printSection('Traffic sources', sourceChecks);

  const failures = [...requiredEnvChecks, ...fileChecks, ...sourceChecks].filter(check => !check.ok && !check.warning);
  const warnings = [...optionalEnvChecks, ...sourceChecks].filter(check => check.warning);

  console.log('\nSummary');
  if (failures.length === 0) {
    console.log('[OK] Core setup can run.');
  } else {
    console.log(`[FAIL] ${failures.length} required item(s) need attention before launch.`);
  }

  if (warnings.length > 0) {
    console.log(`[WARN] ${warnings.length} item(s) are not blocking, but limit automation or scale.`);
  }

  process.exitCode = failures.length > 0 ? 1 : 0;
}

main();
