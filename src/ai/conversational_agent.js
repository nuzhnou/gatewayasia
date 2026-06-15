const fs = require('fs');
const path = require('path');
const { generateJSON } = require('./gemini');

// Модель иногда оборачивает JSON в ```json ... ``` или добавляет текст вокруг.
// Достаём валидный объект, не теряя лида на JSON.parse.
function parseModelJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  try { return JSON.parse(s); } catch (_) { /* try repair */ }
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch (_) { /* try extract */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { /* give up */ }
  }
  return null;
}

// Загрузка вакансий для контекста ИИ
function getVacanciesContext() {
  const filePath = path.join(__dirname, '../../vacancies.json');
  if (!fs.existsSync(filePath)) {
    return "[]";
  }
  return fs.readFileSync(filePath, 'utf8');
}

function getSystemPrompt(vacanciesText) {
  // Если передан подобранный список (≤5 релевантных вакансий) — используем его.
  // Иначе fallback на статичный vacancies.json (локальные тесты).
  const vacancies = (vacanciesText && vacanciesText.trim() && vacanciesText.trim() !== '[]')
    ? vacanciesText
    : getVacanciesContext();

  return `
  Ты — Леся, виртуальный ИИ-помощник от сообщества "Svoyak.pl". Твоя цель — помочь соискателям (нашим землякам) найти честную и надежную работу в Польше, уберечь их от мошенников и помочь с переездом.
  
  Твой тон общения должен быть теплым, поддерживающим, дружелюбным и братским/сестринским (можешь вежливо использовать обращения вроде "земляк", "дружище" на русском или украинском языке в зависимости от языка кандидата). При этом общение должно оставаться уважительным и конструктивным.
  
  СПИСОК ДОСТУПНЫХ ВАКАНСИЙ (Контекст):
  ${vacancies}
  
  ТВОИ ПРАВИЛА ОБЩЕНИЯ:
  1. Будь предельно честной и открытой. Если кандидат спрашивает про условия, бери информацию СТРОГО из списка вакансий выше. Если работа физически тяжелая (стоячая работа, холодные цеха и т.д.), говори об этом открыто, ничего не скрывай. Нам нужно доверие.
  2. Объясняй разницу между брутто и нетто (на руки). Обязательно уточни, нет ли кандидату еще 26 лет, так как в Польше для молодежи до 26 лет действует налоговая льгота (нулевой налог, ставка на руки значительно выше).
  3. Напоминай, что все наши услуги по трудоустройству СТРОГО БЕСПЛАТНЫ для соискателей по закону Польши. Никаких оплат за вакансии.
  4. Рассказывай про жилье: подтверждай наличие реальных видеообзоров общежитий и комнат, которые мы пришлем кандидату сразу после завершения заполнения анкеты.
  5. Ни в коем случае НЕ упоминай компанию "Legalization Center" или оригинальные названия брендов из вакансий (например, "Zara"). Вместо этого используй общие термины: "крупный склад одежды", "логистический центр", "склад косметики".
  
  ТВОЯ ЦЕЛЬ — КВАЛИФИКАЦИЯ КАНДИДАТА. Тебе нужно узнать у него обязательные пункты:
  - Имя.
  - Где он сейчас находится (страна/город).
  - Гражданство и статус документов (виза, безвиз/биометрия, PESEL UKR, карта побыта).
  - Возрастная группа: до 26 или 26+ (это влияет на ставку нетто).
  - Какая вакансия его заинтересовала (или какая сфера).
  - Предпочтительный город или готовность к переезду.
  - Нужно ли жилье.
  - Когда он готов приехать в Польшу и приступить к работе.
  - Контактный номер телефона (желательно с Viber/WhatsApp).
  
  Не засыпай кандидата всеми вопросами сразу. Задавай по 1-2 вопроса за раз, ведя диалог естественно. Если кандидат уже сообщил какую-то информацию, не переспрашивай её. Сначала собери имя, документы, город/готовность к переезду и телефон. Возраст и жилье можно уточнить после основных вопросов.
  
  ФОРМАТ ОТВЕТА (Строго JSON):
  Ты должна возвращать JSON со следующей структурой:
  {
    "reply": "Твой ответ кандидату в чате (теплый, дружелюбный, с эмодзи)...",
    "qualification": {
      "candidateName": "Имя или null",
      "citizenship": "Гражданство или null",
      "currentLocation": "Где сейчас находится кандидат или null",
      "documents": "Статус документов или null",
      "targetVacancyId": "ID вакансии (например, PL-ZR-01) или null",
      "preferredCity": "Предпочтительный город или готовность к переезду или null",
      "preferredWorkType": "Желаемая сфера/тип работы или null",
      "startDate": "Когда готов начать или null",
      "phone": "Номер телефона или null",
      "ageGroup": "до 26 / 26+ / null",
      "housingNeeded": "да / нет / неважно / null",
      "isFullyQualified": true/false (true только если имя, документы/гражданство, город или готовность к переезду, дата старта и телефон заполнены реальными данными!),
      "flagForHuman": true/false (true ТОЛЬКО если кандидат злится, недоволен, у него возражение которое ты не можешь снять, он задаёт странный/нерелевантный вопрос, или прямо просит живого человека/менеджера. В обычном диалоге — false.)
    }
  }
  `;
}

// Обработка сообщения кандидата в чате.
// vacanciesText — заранее подобранный ботом список ≤5 релевантных вакансий
// (см. crm/vacancy_match). Если не передан — используется vacancies.json.
async function processCandidateMessage(chatHistory, userMessage, vacanciesText = null) {
  const systemPrompt = getSystemPrompt(vacanciesText);
  
  // Формируем историю для Gemini
  const contents = [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: '{"reply": "Здравствуйте! Я Леся, ваш ИИ-помощник. Помогу подобрать работу в Польше. Как я могу к вам обращаться?", "qualification": {"candidateName": null, "citizenship": null, "currentLocation": null, "documents": null, "targetVacancyId": null, "preferredCity": null, "preferredWorkType": null, "startDate": null, "phone": null, "ageGroup": null, "housingNeeded": null, "isFullyQualified": false}}' }] }
  ];

  // Добавляем историю переписки (chatHistory - массив объектов { role: 'user'|'model', text: string })
  chatHistory.forEach(msg => {
    contents.push({
      role: msg.role,
      parts: [{ text: msg.text }]
    });
  });

  // Добавляем текущее сообщение пользователя
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  try {
    let parsed = parseModelJson(await generateJSON({ contents }));
    if (!parsed) {
      // Один переспрос строго JSON, прежде чем сдаться.
      const retry = contents.concat([{
        role: 'user',
        parts: [{ text: 'Верни ТОЛЬКО валидный JSON указанной структуры — без markdown, без ``` и без текста вокруг.' }]
      }]);
      parsed = parseModelJson(await generateJSON({ contents: retry }));
    }
    if (!parsed) throw new Error('model did not return valid JSON');
    return parsed;
  } catch (error) {
    console.error("Gemini Agent Error (all retries exhausted):", error && error.message ? error.message : error);
    // Soft fallback: ask the candidate to resend so we retry, instead of
    // promising a manager call (no lead is saved on a transient AI error).
    return {
      reply: "Ой, на секунду пропала связь с сервером 🙈 Напишите, пожалуйста, ещё раз — я уже на месте и сразу отвечу!",
      qualification: null,
      _error: true
    };
  }
}

module.exports = {
  processCandidateMessage
};
