console.log("=== Testing Phase 4 Vacancy Posting Pipeline ===");

process.env.TELEGRAM_BOT_USERNAME = "SvoyakWorkBot";

const {
  parseVacancyTextOffline,
  sanitizeObfuscatedText,
  buildFallbackAdText
} = require('./src/ai/vacancy_parser');
const { buildPostingPlan } = require('./src/marketing/vacancy_campaign');
const { appendTrackedCta } = require('./src/crm/sources');

const rawVacancy = `
LCI РЕКРУТЕРЫ
Zara склад одежды, Познань
Ставка 22.50 netto, студенты до 26 лет 27.70 netto.
График 10-12 часов, 5-6 дней в неделю.
Жилье бесплатно, коммунальные 150 зл, комнаты 3-4 человека.
Обязанности: сортировка, упаковка, сканер.
Писать менеджеру Legalization Center: +48 500 111 222
`;

const parsed = parseVacancyTextOffline(rawVacancy);

if (!parsed.isVacancy) {
  throw new Error(`Expected raw text to be recognized as vacancy. Reason: ${parsed.invalid_reason}`);
}

if (!parsed.location || !parsed.location.toLowerCase().includes('познан')) {
  throw new Error(`Expected location Poznan/Poznanь, got: ${parsed.location}`);
}

if (!parsed.salary || !parsed.salary.includes('22.50')) {
  throw new Error(`Expected extracted salary to include 22.50, got: ${parsed.salary}`);
}

const adText = buildFallbackAdText(parsed, rawVacancy);
const sanitized = sanitizeObfuscatedText(adText);

const forbiddenFragments = [
  'Zara',
  'Legalization Center',
  '+48 500 111 222',
  'LCI'
];

for (const fragment of forbiddenFragments) {
  if (sanitized.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`Sanitized ad text leaked forbidden fragment: ${fragment}`);
  }
}

if (!sanitized.includes('@SvoyakWorkBot')) {
  throw new Error('Expected ad text to include Telegram bot username.');
}

if (!sanitized.toLowerCase().includes('бесплат')) {
  throw new Error('Expected ad text to clearly say the vacancy is free for candidates.');
}

const postingPlan = buildPostingPlan(
  [{ id: 'TG-1', obfuscated_text: sanitized }],
  ['https://www.facebook.com/groups/group-one', 'https://www.facebook.com/groups/group-two'],
  { minDelayMinutes: 7, maxDelayMinutes: 7, maxPosts: 2 }
);

if (postingPlan.length !== 2) {
  throw new Error(`Expected two planned Facebook posts, got: ${postingPlan.length}`);
}

if (postingPlan.some(item => item.delayMinutes !== 7)) {
  throw new Error('Expected deterministic 7 minute delay in posting plan.');
}

if (postingPlan.some(item => !item.adText.includes('@SvoyakWorkBot'))) {
  throw new Error('Expected every planned post to keep bot CTA.');
}

const trackedText = appendTrackedCta(sanitized, 'fb_warsaw_001', 'SvoyakWorkBot');
if (!trackedText.includes('https://t.me/SvoyakWorkBot?start=fb_warsaw_001')) {
  throw new Error('Expected tracked CTA link with source code.');
}

const trackedPostingPlan = buildPostingPlan(
  [{ id: 'TG-2', obfuscated_text: sanitized }],
  [{ groupUrl: 'https://www.facebook.com/groups/group-three', sourceCode: 'fb_warsaw_001', city: 'Warsaw' }],
  { minDelayMinutes: 5, maxDelayMinutes: 5, maxPosts: 1, botUsername: 'SvoyakWorkBot' }
);

if (trackedPostingPlan.length !== 1) {
  throw new Error(`Expected one tracked planned post, got: ${trackedPostingPlan.length}`);
}

if (trackedPostingPlan[0].sourceCode !== 'fb_warsaw_001') {
  throw new Error(`Expected source code on tracked post, got: ${trackedPostingPlan[0].sourceCode}`);
}

if (!trackedPostingPlan[0].adText.includes('start=fb_warsaw_001')) {
  throw new Error('Expected tracked posting plan ad text to include source-coded bot link.');
}

console.log("Generated safe ad text:");
console.log(sanitized);
console.log("Posting plan:");
console.log(JSON.stringify(postingPlan, null, 2));
console.log("=== ALL PHASE 4 TESTS PASSED! ===");
