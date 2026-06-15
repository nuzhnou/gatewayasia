function buildAdminHelpText() {
  return [
    'LCI admin commands',
    '',
    '/report',
    'Daily funnel numbers for the last 24 hours.',
    '',
    '/handoff',
    'Create and send LC handoff CSV for hot and qualified leads.',
    '',
    '/handoff --statuses hot,qualified --limit 50',
    'Create LC handoff CSV with explicit statuses and limit.',
    '',
    '/lead 123',
    'Open lead card with status buttons.',
    '',
    'Status flow:',
    'new -> engaged -> qualified/hot -> sent_to_lc -> accepted -> placed -> paid',
    '',
    'Daily routine:',
    '1. Check /report.',
    '2. Process new cards in Hot Leads.',
    '3. Use /handoff for LC-ready candidates.',
    '4. Mark sent_to_lc, placed, and paid with buttons.',
    '5. Export or review sources from terminal when needed.'
  ].join('\n');
}

module.exports = {
  buildAdminHelpText
};
