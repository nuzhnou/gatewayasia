const { db } = require('../database/db');

function toSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getDailyLeadReport({ sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000) } = {}) {
  const since = toSqlDateTime(sinceDate);
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('qualified', 'hot', 'sent_to_lc', 'lc_contacted', 'accepted', 'arrived', 'placed', 'paid') THEN 1 ELSE 0 END) AS complete_applications,
      SUM(CASE WHEN status = 'hot' THEN 1 ELSE 0 END) AS hot,
      SUM(CASE WHEN status IN ('sent_to_lc', 'lc_contacted', 'accepted', 'arrived', 'placed', 'paid') THEN 1 ELSE 0 END) AS sent_to_lc,
      SUM(CASE WHEN status IN ('placed', 'paid') THEN 1 ELSE 0 END) AS placed,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
      SUM(COALESCE(expected_payout_pln, 0)) AS expected_payout_pln,
      SUM(COALESCE(actual_payout_pln, 0)) AS actual_payout_pln
    FROM leads
    WHERE created_at >= ?
  `).get(since);

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM leads
    WHERE created_at >= ?
    GROUP BY status
    ORDER BY count DESC
  `).all(since);

  const sourceRows = db.prepare(`
    SELECT COALESCE(source_code, source_platform, 'unknown') AS source, COUNT(*) AS count
    FROM leads
    WHERE created_at >= ?
    GROUP BY COALESCE(source_code, source_platform, 'unknown')
    ORDER BY count DESC
    LIMIT 5
  `).all(since);

  return {
    totals: {
      total: totals.total || 0,
      completeApplications: totals.complete_applications || 0,
      hot: totals.hot || 0,
      sentToLc: totals.sent_to_lc || 0,
      placed: totals.placed || 0,
      paid: totals.paid || 0,
      expectedPayoutPln: totals.expected_payout_pln || 0,
      actualPayoutPln: totals.actual_payout_pln || 0
    },
    statuses: statusRows,
    sources: sourceRows
  };
}

function formatDailyLeadReport(report = getDailyLeadReport()) {
  const { totals, statuses, sources } = report;
  const statusText = statuses.length > 0
    ? statuses.map(row => `- ${row.status}: ${row.count}`).join('\n')
    : '- no leads';
  const sourceText = sources.length > 0
    ? sources.map(row => `- ${row.source}: ${row.count}`).join('\n')
    : '- no sources';

  return [
    'LCI daily numbers',
    '',
    `New leads: ${totals.total}`,
    `Complete applications: ${totals.completeApplications}`,
    `Hot: ${totals.hot}`,
    `Sent to LC: ${totals.sentToLc}`,
    `Placed: ${totals.placed}`,
    `Paid: ${totals.paid}`,
    `Expected payout: ${Math.round(totals.expectedPayoutPln)} PLN`,
    `Actual payout: ${Math.round(totals.actualPayoutPln)} PLN`,
    '',
    'Statuses:',
    statusText,
    '',
    'Top sources:',
    sourceText
  ].join('\n');
}

module.exports = {
  getDailyLeadReport,
  formatDailyLeadReport
};
