const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCES_PATH = path.join(__dirname, '../../data/facebook_sources.csv');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values.map(value => value.trim());
}

function readFacebookSources(filePath = DEFAULT_SOURCES_PATH) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#'));

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = { rowNumber: index + 2 };
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] || '';
    });
    return row;
  });
}

function isFacebookUrl(value = '') {
  return /^https:\/\/(?:www\.)?facebook\.com\/groups\/[^/\s]+\/?$/i.test(String(value).trim());
}

function analyzeFacebookSources(rows = readFacebookSources()) {
  const sourceCodes = new Map();
  const duplicates = [];
  const invalidRows = [];

  for (const row of rows) {
    if (!row.source_code) {
      invalidRows.push({ rowNumber: row.rowNumber, reason: 'missing source_code' });
      continue;
    }

    if (sourceCodes.has(row.source_code)) {
      duplicates.push(row.source_code);
    }
    sourceCodes.set(row.source_code, row);

    if (row.group_url && !isFacebookUrl(row.group_url)) {
      invalidRows.push({ rowNumber: row.rowNumber, sourceCode: row.source_code, reason: 'invalid group_url' });
    }
  }

  const withUrl = rows.filter(row => row.group_url);
  const ready = rows.filter(row => row.group_url && row.joined_status === 'ready');
  const joinedOrPending = rows.filter(row => ['ready', 'requested', 'joined'].includes(row.joined_status));

  return {
    totalRows: rows.length,
    withUrl: withUrl.length,
    ready: ready.length,
    joinedOrPending: joinedOrPending.length,
    duplicates,
    invalidRows,
    byCity: rows.reduce((acc, row) => {
      const city = row.city || 'Unknown';
      acc[city] = (acc[city] || 0) + 1;
      return acc;
    }, {})
  };
}

function buildBotLink(sourceCode, botUsername = process.env.TELEGRAM_BOT_USERNAME) {
  const cleanUsername = String(botUsername || '').replace(/^@/, '').trim();
  if (!cleanUsername || !sourceCode) {
    return '';
  }
  return `https://t.me/${cleanUsername}?start=${sourceCode}`;
}

function getReadyFacebookSources(rows = readFacebookSources()) {
  return rows
    .filter(row => row.group_url && row.joined_status === 'ready' && isFacebookUrl(row.group_url))
    .map(row => ({
      sourceCode: row.source_code,
      groupUrl: row.group_url,
      city: row.city,
      segment: row.segment,
      priority: Number(row.priority || 999)
    }))
    .sort((a, b) => a.priority - b.priority || a.sourceCode.localeCompare(b.sourceCode));
}

function buildTrackedCta(sourceCode, botUsername = process.env.TELEGRAM_BOT_USERNAME) {
  const link = buildBotLink(sourceCode, botUsername);
  if (!link) {
    return '';
  }
  return [
    '',
    'Анкета и быстрый подбор:',
    link
  ].join('\n');
}

function appendTrackedCta(adText, sourceCode, botUsername = process.env.TELEGRAM_BOT_USERNAME) {
  const cta = buildTrackedCta(sourceCode, botUsername);
  if (!cta) {
    return adText;
  }
  const text = String(adText || '').trim();
  if (text.includes(`start=${sourceCode}`)) {
    return text;
  }
  return `${text}\n${cta}`.trim();
}

function formatSourcesReport(rows = readFacebookSources(), botUsername = process.env.TELEGRAM_BOT_USERNAME) {
  const analysis = analyzeFacebookSources(rows);
  const topRows = rows.slice(0, 15).map(row => {
    const link = buildBotLink(row.source_code, botUsername);
    const urlStatus = row.group_url ? 'url' : 'no-url';
    return `- ${row.source_code} | ${row.city || '-'} | ${row.joined_status || '-'} | ${urlStatus}${link ? ` | ${link}` : ''}`;
  }).join('\n');

  const duplicateText = analysis.duplicates.length > 0
    ? analysis.duplicates.join(', ')
    : 'none';
  const invalidText = analysis.invalidRows.length > 0
    ? analysis.invalidRows.map(row => `row ${row.rowNumber}: ${row.reason}`).join('; ')
    : 'none';

  return [
    'Facebook source readiness',
    '',
    `Rows: ${analysis.totalRows}`,
    `Rows with group URL: ${analysis.withUrl}`,
    `Ready groups: ${analysis.ready}`,
    `Joined/requested/ready: ${analysis.joinedOrPending}`,
    `Duplicate source codes: ${duplicateText}`,
    `Invalid rows: ${invalidText}`,
    '',
    'First source links:',
    topRows || '- no source rows'
  ].join('\n');
}

module.exports = {
  DEFAULT_SOURCES_PATH,
  parseCsvLine,
  readFacebookSources,
  analyzeFacebookSources,
  buildBotLink,
  getReadyFacebookSources,
  buildTrackedCta,
  appendTrackedCta,
  formatSourcesReport
};
