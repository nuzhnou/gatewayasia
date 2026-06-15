#!/usr/bin/env node
require('dotenv').config();

const {
  readFacebookSources,
  formatSourcesReport,
  buildBotLink
} = require('../crm/sources');

function parseArgs(argv) {
  const args = {
    command: argv[2] || 'report',
    sourceCode: null
  };

  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--source') {
      args.sourceCode = argv[i + 1] || null;
      i += 1;
    }
  }

  return args;
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run sources:report',
    '  npm run sources:link -- --source fb_warsaw_001'
  ].join('\n'));
}

function main() {
  const args = parseArgs(process.argv);
  const rows = readFacebookSources();

  if (args.command === 'report') {
    console.log(formatSourcesReport(rows));
    return;
  }

  if (args.command === 'link') {
    if (!args.sourceCode) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    const row = rows.find(item => item.source_code === args.sourceCode);
    if (!row) {
      console.error(`Unknown source code: ${args.sourceCode}`);
      process.exitCode = 1;
      return;
    }
    const link = buildBotLink(args.sourceCode);
    if (!link) {
      console.error('TELEGRAM_BOT_USERNAME is missing. Fill it in .env first.');
      process.exitCode = 1;
      return;
    }
    console.log(link);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main();
