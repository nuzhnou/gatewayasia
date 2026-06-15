#!/usr/bin/env node
require('dotenv').config();

const { initDatabase } = require('../database/db');
const { exportLeads, exportHandoffLeads, DEFAULT_HANDOFF_STATUSES } = require('../crm/export');
const { formatDailyLeadReport } = require('../crm/reports');

function parseArgs(argv) {
  const args = {
    command: argv[2] || 'report',
    format: 'csv',
    status: null,
    statuses: null,
    limit: 1000
  };

  for (let i = 3; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--json') {
      args.format = 'json';
    } else if (item === '--csv') {
      args.format = 'csv';
    } else if (item === '--status') {
      args.status = argv[i + 1] || null;
      i += 1;
    } else if (item === '--statuses') {
      args.statuses = (argv[i + 1] || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      i += 1;
    } else if (item === '--limit') {
      args.limit = Number(argv[i + 1] || args.limit);
      i += 1;
    }
  }

  return args;
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run leads:report',
    '  npm run leads:export -- --csv',
    '  npm run leads:export -- --json',
    '  npm run leads:export -- --status hot --limit 100',
    '  npm run leads:handoff',
    '  npm run leads:handoff -- --statuses hot,qualified --limit 50',
    '',
    'Exports are written to ./exports.'
  ].join('\n'));
}

async function main() {
  initDatabase();
  const args = parseArgs(process.argv);

  if (args.command === 'report') {
    console.log(formatDailyLeadReport());
    return;
  }

  if (args.command === 'export') {
    const result = exportLeads({
      format: args.format,
      status: args.status,
      limit: Number.isFinite(args.limit) ? args.limit : 1000
    });
    console.log(`Exported ${result.count} leads to ${result.outputPath}`);
    return;
  }

  if (args.command === 'handoff') {
    const result = exportHandoffLeads({
      format: args.format,
      statuses: args.statuses || DEFAULT_HANDOFF_STATUSES,
      limit: Number.isFinite(args.limit) ? args.limit : 1000
    });
    console.log(`Exported ${result.count} LC handoff leads to ${result.outputPath}`);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
