const { initDatabase, db } = require('./src/database/db');
const {
  parseStartParam,
  inferReadinessLevel,
  updateLeadStatus,
  getLeadById,
  buildLeadAdminCard
} = require('./src/crm/leads');
const { formatDailyLeadReport } = require('./src/crm/reports');
const { exportLeads, exportHandoffLeads } = require('./src/crm/export');
const {
  readFacebookSources,
  analyzeFacebookSources,
  buildBotLink
} = require('./src/crm/sources');
const { buildAdminHelpText } = require('./src/bot/admin_help');
const fs = require('fs');
const path = require('path');

console.log("=== Testing Phase 1 Setup ===");

try {
  // 1. Проверяем инициализацию базы данных
  console.log("Initializing database...");
  initDatabase();

  // 2. Тестируем запись тестового кандидата
  console.log("Inserting a mock candidate...");
  const insert = db.prepare(`
    INSERT OR IGNORE INTO leads (source_platform, source_url, candidate_name, contact_info, raw_post_text, extracted_intent, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const mockUrl = "https://t.me/test_channel/123";
  insert.run(
    "telegram",
    mockUrl,
    "Алексей Тестовый",
    "Telegram: @alex_test, Phone: +48555111222",
    "Ищу работу на складе в Варшаве, виза 6 месяцев, готов приступить завтра.",
    JSON.stringify({ isCandidate: true, name: "Алексей", documents: "виза 6 месяцев" }),
    "new"
  );

  // 3. Тестируем чтение кандидата
  console.log("Querying database for candidate...");
  const row = db.prepare("SELECT * FROM leads WHERE source_url = ?").get(mockUrl);
  if (row) {
    console.log("SUCCESS! Mock lead retrieved:");
    console.log(`- ID: ${row.id}`);
    console.log(`- Name: ${row.candidate_name}`);
    console.log(`- Contact: ${row.contact_info}`);
    console.log(`- Status: ${row.status}`);
  } else {
    throw new Error("Failed to retrieve the inserted mock lead.");
  }

  // 3.1 Проверяем миграции CRM-полей
  console.log("Checking CRM lead columns...");
  const leadColumns = db.prepare("PRAGMA table_info(leads)").all().map(column => column.name);
  const requiredLeadColumns = [
    'telegram_chat_id',
    'source_code',
    'current_location',
    'citizenship',
    'documents',
    'phone',
    'readiness_level',
    'payout_status'
  ];
  for (const columnName of requiredLeadColumns) {
    if (!leadColumns.includes(columnName)) {
      throw new Error(`Missing CRM lead column: ${columnName}`);
    }
  }

  const sourceTracking = parseStartParam('fb_warsaw_001');
  if (sourceTracking.sourceCode !== 'fb_warsaw_001' || sourceTracking.sourceCategory !== 'fb') {
    throw new Error(`Unexpected source tracking parse result: ${JSON.stringify(sourceTracking)}`);
  }

  const recruiterTracking = parseStartParam('rec_123');
  if (recruiterTracking.recruiterId !== 123 || recruiterTracking.sourceCategory !== 'recruiter') {
    throw new Error(`Unexpected recruiter tracking parse result: ${JSON.stringify(recruiterTracking)}`);
  }

  if (inferReadinessLevel('готов выйти завтра') !== 'hot') {
    throw new Error('Expected immediate readiness to be hot.');
  }

  const updatedLead = updateLeadStatus(row.id, 'hot', 'test', 'Phase 1 CRM status test');
  if (updatedLead.status !== 'hot') {
    throw new Error(`Expected lead status hot, got ${updatedLead.status}`);
  }

  db.prepare(`
    UPDATE leads
    SET
      phone = ?,
      current_location = ?,
      citizenship = ?,
      documents = ?,
      age_group = ?,
      preferred_city = ?,
      preferred_work_type = ?,
      housing_needed = ?,
      start_date = ?,
      readiness_level = ?,
      source_code = ?
    WHERE id = ?
  `).run(
    '+48555111222',
    'Warsaw',
    'Belarus',
    'visa 6 months',
    '26+',
    'Warsaw or nearby',
    'warehouse',
    'yes',
    'tomorrow',
    'hot',
    'fb_warsaw_001',
    row.id
  );

  const leadById = getLeadById(row.id);
  if (!leadById || leadById.id !== row.id) {
    throw new Error(`Expected to fetch lead by id ${row.id}`);
  }
  const adminCard = buildLeadAdminCard(leadById);
  if (!adminCard.includes(`New candidate #${row.id}`) || !adminCard.includes('Status: Hot')) {
    throw new Error(`Unexpected admin card: ${adminCard}`);
  }

  const reportText = formatDailyLeadReport();
  if (!reportText.includes('LCI daily numbers') || !reportText.includes('Hot:')) {
    throw new Error(`Unexpected daily report text: ${reportText}`);
  }

  const testExportDir = path.join(__dirname, 'exports', 'test');
  const csvExport = exportLeads({ format: 'csv', limit: 10, exportDir: testExportDir });
  if (!fs.existsSync(csvExport.outputPath)) {
    throw new Error(`CSV export was not created: ${csvExport.outputPath}`);
  }
  const csvContent = fs.readFileSync(csvExport.outputPath, 'utf8');
  if (!csvContent.includes('candidate_name') || !csvContent.includes('Алексей Тестовый')) {
    throw new Error(`CSV export content is invalid: ${csvContent}`);
  }

  const jsonExport = exportLeads({ format: 'json', limit: 10, exportDir: testExportDir });
  if (!fs.existsSync(jsonExport.outputPath)) {
    throw new Error(`JSON export was not created: ${jsonExport.outputPath}`);
  }

  const handoffExport = exportHandoffLeads({ format: 'csv', statuses: ['hot'], limit: 10, exportDir: testExportDir });
  if (!fs.existsSync(handoffExport.outputPath)) {
    throw new Error(`LC handoff export was not created: ${handoffExport.outputPath}`);
  }
  const handoffContent = fs.readFileSync(handoffExport.outputPath, 'utf8');
  if (!handoffContent.includes('lead_id,candidate_name,phone') || !handoffContent.includes('Алексей Тестовый')) {
    throw new Error(`LC handoff export content is invalid: ${handoffContent}`);
  }

  const sourceRows = readFacebookSources();
  const sourceAnalysis = analyzeFacebookSources(sourceRows);
  if (sourceAnalysis.totalRows < 30) {
    throw new Error(`Expected at least 30 starter source rows, got ${sourceAnalysis.totalRows}`);
  }
  if (sourceAnalysis.duplicates.length > 0) {
    throw new Error(`Expected unique source codes, duplicates: ${sourceAnalysis.duplicates.join(', ')}`);
  }
  const botLink = buildBotLink('fb_warsaw_001', 'SvoyakWorkBot');
  if (botLink !== 'https://t.me/SvoyakWorkBot?start=fb_warsaw_001') {
    throw new Error(`Unexpected bot link: ${botLink}`);
  }

  const adminHelpText = buildAdminHelpText();
  for (const expectedFragment of ['/report', '/handoff', '/lead 123', 'sent_to_lc']) {
    if (!adminHelpText.includes(expectedFragment)) {
      throw new Error(`Admin help text is missing: ${expectedFragment}`);
    }
  }

  // 4. Проверяем импорт остальных пакетов
  console.log("Checking library imports...");
  const { ApifyClient } = require('apify-client');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  require('dotenv').config();

  console.log("ApifyClient import: OK");
  console.log("GoogleGenerativeAI import: OK");
  console.log("dotenv import: OK");

  console.log("=== ALL PHASE 1 INTERNAL TESTS PASSED! ===");
} catch (error) {
  console.error("Test failed with error:", error);
  process.exit(1);
}
