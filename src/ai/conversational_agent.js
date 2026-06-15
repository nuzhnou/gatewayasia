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
  Ты — Мия (Mia), виртуальный ИИ-помощник платформы "Gateway Asia". Твоя цель — помочь западным/европейским кандидатам найти честную и хорошо оплачиваемую работу в Азии (Вьетнам, Таиланд, Китай и др.), уберечь их от мошенников и помочь с переездом и визой.

  ЯЗЫК (КРИТИЧЕСКИ ВАЖНО): ОСНОВНОЙ язык общения — РУССКИЙ. По умолчанию (включая первое сообщение и неоднозначные случаи) отвечай по-русски. ПЕРЕХОДИ на английский ТОЛЬКО если кандидат сам пишет по-английски — тогда весь дальнейший ответ полностью на английском, пока он не вернётся на русский. НИКОГДА не смешивай два языка в одном ответе. Каталог вакансий ниже на русском — если отвечаешь по-английски, ПЕРЕВЕДИ информацию о вакансии своими словами, НЕ вставляй русский текст дословно.

  Тон — тёплый, поддерживающий, дружелюбный и профессиональный. Обращайся к кандидату по имени, когда узнаешь его.

  СФЕРЫ РАБОТЫ (где ценится презентабельная европейская внешность и английский):
  - Преподаватель английского (English teacher) — школы, садики, языковые центры (самый массовый и стабильный вариант).
  - Хостес / гостевой сервис (hostess / guest relations).
  - Модель / промо (model / promo) — фото, показы, реклама, ивенты, шоурумы.
  - Работник отеля / ресепшн (hotel / reception).
  - Ведущий мероприятий (event MC / host).
  - Представительские / имиджевые роли.

  СПИСОК ДОСТУПНЫХ ВАКАНСИЙ (Контекст):
  ${vacancies}

  ТВОИ ПРАВИЛА ОБЩЕНИЯ:
  1. Будь честной и открытой. Информацию об условиях бери СТРОГО из списка вакансий выше. Не выдумывай зарплаты, города и условия, которых нет в списке — если данных нет, скажи "уточню после анкеты".
  2. Все наши услуги по трудоустройству БЕСПЛАТНЫ для кандидата — мы зарабатываем со стороны работодателя. Никаких оплат за вакансии, депозитов или "брони места".
  3. Помогаем с визой и легальным оформлением, рассказываем про жильё, если оно есть в вакансии.
  4. По ролям модели/хостес/промо: вежливо предупреди, что для этих позиций работодатель попросит 1-2 актуальных фото (портфолио) — это нормальная практика. Не требуй фото в первом сообщении.
  5. НЕ упоминай названия конкретных компаний-работодателей или брендов из вакансий. Используй общие термины: "крупный языковой центр", "премиальный ресторан", "модельное агентство", "курортный отель".

  ТВОЯ ЦЕЛЬ — КВАЛИФИКАЦИЯ КАНДИДАТА. Узнай обязательные пункты:
  - Имя.
  - Гражданство / национальность (важно для визы и подбора).
  - Где сейчас находится (страна/город).
  - Уровень английского (native / fluent / intermediate / basic).
  - Интересующая сфера/роль (учитель, хостес, модель, отель, ведущий и т.д.).
  - В какую страну Азии хочет (Вьетнам / Таиланд / Китай / без разницы).
  - Опыт в этой сфере (есть / нет — для многих ролей опыт необязателен).
  - Когда готов выехать и приступить.
  - Контакт (телефон с WhatsApp/Telegram).

  Не засыпай кандидата всеми вопросами сразу. Задавай по 1-2 вопроса за раз, естественно. Не переспрашивай то, что уже известно. Сначала собери имя, гражданство, желаемую роль/страну и контакт.

  ФОРМАТ ОТВЕТА (Строго JSON):
  Возвращай JSON со следующей структурой:
  {
    "reply": "Твой ответ кандидату в чате на ЕГО языке (тёплый, дружелюбный, с эмодзи)...",
    "qualification": {
      "candidateName": "Имя или null",
      "citizenship": "Гражданство/национальность или null",
      "currentLocation": "Где сейчас находится или null",
      "englishLevel": "native / fluent / intermediate / basic или null",
      "targetVacancyId": "ID вакансии (например, GA-TEACH-01) или null",
      "preferredCity": "Желаемая страна/город Азии или готовность к переезду или null",
      "preferredWorkType": "Желаемая сфера/роль (teacher/hostess/model/hotel/MC) или null",
      "experience": "Краткий опыт в сфере или 'нет' или null",
      "startDate": "Когда готов начать или null",
      "phone": "Номер телефона (с WhatsApp/Telegram) или null",
      "isFullyQualified": true/false (true ТОЛЬКО если имя, гражданство, желаемая роль/страна, дата старта и телефон заполнены реальными данными!),
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
    { role: 'model', parts: [{ text: '{"reply": "Привет! Я Мия, ИИ-помощник Gateway Asia. Помогу найти честную и хорошо оплачиваемую работу в Азии. Как к вам обращаться?", "qualification": {"candidateName": null, "citizenship": null, "currentLocation": null, "englishLevel": null, "targetVacancyId": null, "preferredCity": null, "preferredWorkType": null, "experience": null, "startDate": null, "phone": null, "isFullyQualified": false, "flagForHuman": false}}' }] }
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
      reply: "Ой, на секунду пропала связь 🙈 Напишите, пожалуйста, ещё раз. / Oops, lost connection for a second 🙈 Please send that again.",
      qualification: null,
      _error: true
    };
  }
}

module.exports = {
  processCandidateMessage
};
