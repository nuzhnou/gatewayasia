const fs = require('fs');
const path = require('path');
const { db } = require('../database/db');

const EXPORT_COLUMNS = [
  'id',
  'status',
  'candidate_name',
  'phone',
  'contact_info',
  'telegram_chat_id',
  'telegram_username',
  'source_platform',
  'source_code',
  'source_category',
  'current_location',
  'citizenship',
  'documents',
  'age_group',
  'preferred_city',
  'preferred_work_type',
  'housing_needed',
  'start_date',
  'readiness_level',
  'target_vacancy_id',
  'expected_payout_pln',
  'actual_payout_pln',
  'payout_status',
  'assigned_recruiter_id',
  'created_at',
  'updated_at',
  'notes'
];

const HANDOFF_COLUMNS = [
  'lead_id',
  'candidate_name',
  'phone',
  'telegram',
  'current_location',
  'citizenship',
  'documents',
  'age_group',
  'preferred_city',
  'preferred_work_type',
  'housing_needed',
  'start_date',
  'readiness_level',
  'target_vacancy_id',
  'source_code',
  'status',
  'notes'
];

const DEFAULT_HANDOFF_STATUSES = [
  'qualified',
  'hot',
  'sent_to_lc',
  'lc_contacted',
  'accepted'
];

function ensureExportDir(exportDir) {
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function getLeadsForExport({ status = null, limit = 1000 } = {}) {
  const sql = `
    SELECT ${EXPORT_COLUMNS.join(', ')}
    FROM leads
    ${status ? 'WHERE status = ?' : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `;

  return status
    ? db.prepare(sql).all(status, limit)
    : db.prepare(sql).all(limit);
}

function toCsv(rows, columns = EXPORT_COLUMNS) {
  const header = columns.join(',');
  const body = rows.map(row => columns.map(column => csvEscape(row[column])).join(','));
  return [header, ...body].join('\n') + '\n';
}

function buildExportPath({ format, exportDir, prefix = 'leads', timestamp = new Date() }) {
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
  return path.join(exportDir, `${prefix}-${stamp}.${format}`);
}

function exportLeads({ format = 'csv', status = null, limit = 1000, exportDir = path.join(__dirname, '../../exports') } = {}) {
  if (!['csv', 'json'].includes(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  ensureExportDir(exportDir);
  const rows = getLeadsForExport({ status, limit });
  const outputPath = buildExportPath({ format, exportDir });
  const content = format === 'json'
    ? JSON.stringify(rows, null, 2) + '\n'
    : toCsv(rows);

  fs.writeFileSync(outputPath, content, 'utf8');
  return { outputPath, count: rows.length, format };
}

function getHandoffLeads({ statuses = DEFAULT_HANDOFF_STATUSES, limit = 1000 } = {}) {
  const normalizedStatuses = Array.isArray(statuses) && statuses.length > 0
    ? statuses
    : DEFAULT_HANDOFF_STATUSES;
  const placeholders = normalizedStatuses.map(() => '?').join(', ');

  return db.prepare(`
    SELECT
      id AS lead_id,
      candidate_name,
      COALESCE(phone, contact_info) AS phone,
      CASE
        WHEN telegram_chat_id IS NOT NULL THEN 'tg://user?id=' || telegram_chat_id
        WHEN telegram_username IS NOT NULL THEN '@' || telegram_username
        ELSE ''
      END AS telegram,
      current_location,
      citizenship,
      documents,
      age_group,
      preferred_city,
      preferred_work_type,
      housing_needed,
      start_date,
      readiness_level,
      target_vacancy_id,
      source_code,
      status,
      notes
    FROM leads
    WHERE status IN (${placeholders})
    ORDER BY
      CASE status
        WHEN 'hot' THEN 1
        WHEN 'qualified' THEN 2
        WHEN 'sent_to_lc' THEN 3
        WHEN 'lc_contacted' THEN 4
        WHEN 'accepted' THEN 5
        ELSE 9
      END,
      updated_at DESC,
      id DESC
    LIMIT ?
  `).all(...normalizedStatuses, limit);
}

function exportHandoffLeads({ format = 'csv', statuses = DEFAULT_HANDOFF_STATUSES, limit = 1000, exportDir = path.join(__dirname, '../../exports') } = {}) {
  if (!['csv', 'json'].includes(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }

  ensureExportDir(exportDir);
  const rows = getHandoffLeads({ statuses, limit });
  const outputPath = buildExportPath({ format, exportDir, prefix: 'lc-handoff' });
  const content = format === 'json'
    ? JSON.stringify(rows, null, 2) + '\n'
    : toCsv(rows, HANDOFF_COLUMNS);

  fs.writeFileSync(outputPath, content, 'utf8');
  return { outputPath, count: rows.length, format };
}

module.exports = {
  EXPORT_COLUMNS,
  HANDOFF_COLUMNS,
  DEFAULT_HANDOFF_STATUSES,
  getLeadsForExport,
  getHandoffLeads,
  toCsv,
  exportLeads,
  exportHandoffLeads
};
