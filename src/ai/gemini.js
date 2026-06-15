const { GoogleGenerativeAI } = require('@google/generative-ai');

// Несколько API-ключей = несколько проектов = суммарно кратно больше дневной
// бесплатной квоты. Ротация по кругу + фолбэк на запасную модель делают вызовы
// устойчивыми к 429 (квота) и 503/500 (перегрузка Google).
const KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';
const MODELS = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];

if (!KEYS.length) {
  console.error('[GEMINI] No API keys configured (set GEMINI_API_KEYS or GEMINI_API_KEY).');
}

const modelCache = new Map();
function getModel(key, model) {
  const id = `${key}|${model}`;
  if (!modelCache.has(id)) {
    const genAI = new GoogleGenerativeAI(key);
    modelCache.set(id, genAI.getGenerativeModel({
      model,
      generationConfig: { responseMimeType: 'application/json' }
    }));
  }
  return modelCache.get(id);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = (e) => (e && (e.status || e.statusCode)) || 0;
function isQuota(e) {
  const m = String((e && e.message) || '');
  return statusOf(e) === 429 || /\b429\b|quota|rate limit/i.test(m);
}
function isRetryable(e) {
  const s = statusOf(e);
  const m = String((e && e.message) || '');
  return isQuota(e) || s === 503 || s === 500
    || /\b(503|500)\b|overload|unavailable|high demand|temporar/i.test(m);
}

let rrCursor = 0; // round-robin старт по ключам, чтобы равномерно жечь квоты

// input: строка-промпт ИЛИ { contents: [...] } (как в @google/generative-ai).
// Возвращает текст ответа (обычно JSON-строку). Бросает, если все попытки сожжены.
async function generateJSON(input) {
  const n = Math.max(1, KEYS.length);
  const start = rrCursor++ % n;
  // Порядок попыток: основная модель по всем ключам (с ротацией), затем
  // запасная модель по всем ключам.
  const attempts = [];
  for (const model of MODELS) {
    for (let i = 0; i < n; i += 1) {
      attempts.push({ key: KEYS[(start + i) % n], model, keyIdx: (start + i) % n });
    }
  }

  let lastError;
  for (let i = 0; i < attempts.length; i += 1) {
    const { key, model, keyIdx } = attempts[i];
    try {
      const result = await getModel(key, model).generateContent(input);
      return result.response.text().trim();
    } catch (error) {
      lastError = error;
      const hasMore = i < attempts.length - 1;
      const retry = isRetryable(error);
      console.error(`[GEMINI] try ${i + 1}/${attempts.length} (key#${keyIdx}, ${model}) failed: ${statusOf(error) || error.message}. ${hasMore && retry ? 'rotating...' : 'giving up.'}`);
      if (!hasMore || !retry) break;
      await sleep(isQuota(error) ? 120 : 400); // quota → быстро на след. ключ; 5xx → подождать
    }
  }
  throw lastError;
}

module.exports = {
  generateJSON,
  KEYS_COUNT: KEYS.length,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  isRetryable
};
