const { db } = require('../database/db');

const LEAD_STATUSES = [
  'new',
  'engaged',
  'qualified',
  'hot',
  'sent_to_lc',
  'lc_contacted',
  'accepted',
  'arrived',
  'placed',
  'paid',
  'lost'
];

const STATUS_LABELS = {
  new: 'New',
  engaged: 'Engaged',
  qualified: 'Qualified',
  hot: 'Hot',
  sent_to_lc: 'Sent to LC',
  lc_contacted: 'LC contacted',
  accepted: 'Accepted',
  arrived: 'Arrived',
  placed: 'Placed',
  paid: 'Paid',
  lost: 'Lost'
};

const LOCKED_BY_BOT_STATUSES = new Set([
  'sent_to_lc',
  'lc_contacted',
  'accepted',
  'arrived',
  'placed',
  'paid',
  'lost'
]);

function parseStartParam(rawParam = '') {
  const value = String(rawParam || '').trim().replace(/^\/start\s*/i, '');
  if (!value) {
    return { sourceCode: 'direct', sourceCategory: 'direct', recruiterId: null };
  }

  if (value.startsWith('rec_')) {
    return {
      sourceCode: value,
      sourceCategory: 'recruiter',
      recruiterId: parseInt(value.replace('rec_', ''), 10) || null
    };
  }

  const category = value.split('_')[0] || 'unknown';
  return {
    sourceCode: value,
    sourceCategory: category,
    recruiterId: null
  };
}

function normalizePhone(phone) {
  if (!phone) {
    return null;
  }
  return String(phone).replace(/[^\d+]/g, '').trim() || null;
}

function inferReadinessLevel(startDate = '') {
  const value = String(startDate || '').toLowerCase();
  if (!value) {
    return null;
  }

  if (/(сразу|завтра|уже|now|asap|od zaraz|терміново|срочно)/i.test(value)) {
    return 'hot';
  }

  if (/(недел|тижд|week|7|несколько дней|kilka dni)/i.test(value)) {
    return 'warm';
  }

  if (/(месяц|місяц|month|пока|интересуюсь|цікавлюсь)/i.test(value)) {
    return 'cold';
  }

  return 'unknown';
}

function statusFromQualification(qualification = {}, currentStatus = 'new') {
  if (LOCKED_BY_BOT_STATUSES.has(currentStatus)) {
    return currentStatus;
  }

  const readiness = inferReadinessLevel(qualification.startDate);
  if (qualification.isFullyQualified && readiness === 'hot') {
    return 'hot';
  }
  if (qualification.isFullyQualified) {
    return 'qualified';
  }
  return currentStatus === 'new' ? 'engaged' : currentStatus;
}

function getLeadByTelegramChatId(chatId) {
  return db.prepare('SELECT * FROM leads WHERE telegram_chat_id = ? OR source_url = ?')
    .get(chatId, `tg://${chatId}`);
}

function getLeadById(leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

function createOrUpdateTelegramLead({ chatId, username, firstName, startParam }) {
  const parsed = parseStartParam(startParam);
  const sourceUrl = `tg://${chatId}`;
  const existingLead = getLeadByTelegramChatId(chatId);

  if (!existingLead) {
    const result = db.prepare(`
      INSERT INTO leads (
        source_platform,
        source_url,
        candidate_name,
        status,
        assigned_recruiter_id,
        telegram_chat_id,
        telegram_username,
        source_code,
        source_category
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'telegram',
      sourceUrl,
      firstName || username || null,
      'new',
      parsed.recruiterId,
      chatId,
      username || null,
      parsed.sourceCode,
      parsed.sourceCategory
    );

    return { leadId: result.lastInsertRowid, ...parsed };
  }

  db.prepare(`
    UPDATE leads
    SET
      telegram_chat_id = ?,
      telegram_username = COALESCE(?, telegram_username),
      assigned_recruiter_id = COALESCE(?, assigned_recruiter_id),
      source_code = CASE WHEN source_code IS NULL OR source_code = 'direct' THEN ? ELSE source_code END,
      source_category = CASE WHEN source_category IS NULL OR source_category = 'direct' THEN ? ELSE source_category END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    chatId,
    username || null,
    parsed.recruiterId,
    parsed.sourceCode,
    parsed.sourceCategory,
    existingLead.id
  );

  return { leadId: existingLead.id, ...parsed };
}

function updateLeadFromQualification(chatId, qualification = {}) {
  const lead = getLeadByTelegramChatId(chatId);
  if (!lead) {
    return null;
  }

  const newStatus = statusFromQualification(qualification, lead.status);
  const readinessLevel = inferReadinessLevel(qualification.startDate);
  const phone = normalizePhone(qualification.phone);

  db.prepare(`
    UPDATE leads
    SET
      candidate_name = COALESCE(?, candidate_name),
      contact_info = COALESCE(?, contact_info),
      extracted_intent = ?,
      status = ?,
      citizenship = COALESCE(?, citizenship),
      documents = COALESCE(?, documents),
      target_vacancy_id = COALESCE(?, target_vacancy_id),
      current_location = COALESCE(?, current_location),
      preferred_city = COALESCE(?, preferred_city),
      preferred_work_type = COALESCE(?, preferred_work_type),
      start_date = COALESCE(?, start_date),
      phone = COALESCE(?, phone),
      age_group = COALESCE(?, age_group),
      housing_needed = COALESCE(?, housing_needed),
      readiness_level = COALESCE(?, readiness_level),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    qualification.candidateName || null,
    phone || qualification.phone || null,
    JSON.stringify(qualification),
    newStatus,
    qualification.citizenship || null,
    qualification.documents || null,
    qualification.targetVacancyId || null,
    qualification.currentLocation || null,
    qualification.preferredCity || null,
    qualification.preferredWorkType || null,
    qualification.startDate || null,
    phone,
    qualification.ageGroup || null,
    qualification.housingNeeded || null,
    readinessLevel,
    lead.id
  );

  if (lead.status !== newStatus) {
    recordLeadEvent({
      leadId: lead.id,
      eventType: 'status_change',
      oldStatus: lead.status,
      newStatus,
      actor: 'bot',
      notes: 'Updated from candidate qualification'
    });
  }

  return db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
}

function recordLeadEvent({ leadId, eventType, oldStatus, newStatus, actor, notes }) {
  db.prepare(`
    INSERT INTO lead_events (lead_id, event_type, old_status, new_status, actor, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leadId, eventType, oldStatus || null, newStatus || null, actor || 'system', notes || null);
}

function updateLeadStatus(leadId, newStatus, actor = 'admin', notes = null) {
  if (!LEAD_STATUSES.includes(newStatus)) {
    throw new Error(`Unsupported lead status: ${newStatus}`);
  }

  const lead = db.prepare('SELECT id, status FROM leads WHERE id = ?').get(leadId);
  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`);
  }

  if (lead.status !== newStatus) {
    db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newStatus, leadId);
    recordLeadEvent({
      leadId,
      eventType: 'status_change',
      oldStatus: lead.status,
      newStatus,
      actor,
      notes
    });

    // Учёт денег по статусу: при оплате фиксируем фактическую выплату
    // (из ожидаемой, если фактическая ещё не задана), при потере — помечаем.
    if (newStatus === 'paid') {
      const row = db.prepare('SELECT expected_payout_pln, actual_payout_pln FROM leads WHERE id = ?').get(leadId);
      const actual = (row && row.actual_payout_pln > 0) ? row.actual_payout_pln : ((row && row.expected_payout_pln) || 0);
      db.prepare("UPDATE leads SET actual_payout_pln = ?, payout_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(actual, leadId);
    } else if (newStatus === 'lost') {
      db.prepare("UPDATE leads SET payout_status = 'lost', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(leadId);
    }
  }

  return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
}

// Записываем ожидаемую комиссию (наш заработок) на лида — основа KPI/ROI.
function setExpectedPayout(leadId, amountPln) {
  const amt = Number(amountPln);
  if (!leadId || !Number.isFinite(amt) || amt <= 0) return;
  db.prepare('UPDATE leads SET expected_payout_pln = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(amt, leadId);
}

// Серверная валидация: не верим «isFullyQualified» от ИИ на слово.
function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}
function validateQualification(q = {}) {
  if (!q) return false;
  if (!q.candidateName || String(q.candidateName).trim().length < 2) return false;
  if (!isValidPhone(q.phone)) return false;
  if (!q.documents && !q.citizenship) return false;        // хоть что-то по документам
  if (!q.preferredCity && !q.currentLocation) return false; // город или где находится
  return true;
}

function buildLeadAdminCard(lead, qualification = null) {
  const q = qualification || {};
  const name = q.candidateName || lead.candidate_name || 'Не указано';
  const phone = q.phone || lead.phone || lead.contact_info || 'Не указан';
  const documents = q.documents || lead.documents || 'Не указано';
  const citizenship = q.citizenship || lead.citizenship || 'Не указано';
  const currentLocation = q.currentLocation || lead.current_location || 'Не указано';
  const preferredCity = q.preferredCity || lead.preferred_city || 'Не указано';
  const workType = q.preferredWorkType || lead.preferred_work_type || 'Не указано';
  const ageGroup = q.ageGroup || lead.age_group || 'Не указано';
  const housing = q.housingNeeded || lead.housing_needed || 'Не указано';
  const startDate = q.startDate || lead.start_date || 'Не указано';
  const vacancy = q.targetVacancyId || lead.target_vacancy_id || 'Любая/уточнить';
  const source = lead.source_code || lead.source_platform || 'unknown';
  const status = STATUS_LABELS[lead.status] || lead.status;

  return [
    `New candidate #${lead.id}`,
    '',
    `Status: ${status}`,
    `Name: ${name}`,
    `Phone: ${phone}`,
    `Current location: ${currentLocation}`,
    `Citizenship: ${citizenship}`,
    `Documents: ${documents}`,
    `Age: ${ageGroup}`,
    `Preferred city: ${preferredCity}`,
    `Work type: ${workType}`,
    `Housing: ${housing}`,
    `Ready: ${startDate}`,
    `Vacancy: ${vacancy}`,
    `Source: ${source}`,
    lead.telegram_chat_id ? `Telegram: tg://user?id=${lead.telegram_chat_id}` : null
  ].filter(Boolean).join('\n');
}

function buildLeadStatusKeyboard(leadId) {
  return {
    inline_keyboard: [
      [
        { text: 'Hot', callback_data: `lead:${leadId}:hot` },
        { text: 'Sent LC', callback_data: `lead:${leadId}:sent_to_lc` }
      ],
      [
        { text: 'Accepted', callback_data: `lead:${leadId}:accepted` },
        { text: 'Placed', callback_data: `lead:${leadId}:placed` }
      ],
      [
        { text: 'Paid', callback_data: `lead:${leadId}:paid` },
        { text: 'Lost', callback_data: `lead:${leadId}:lost` }
      ]
    ]
  };
}

module.exports = {
  LEAD_STATUSES,
  STATUS_LABELS,
  parseStartParam,
  normalizePhone,
  inferReadinessLevel,
  statusFromQualification,
  getLeadById,
  createOrUpdateTelegramLead,
  getLeadByTelegramChatId,
  updateLeadFromQualification,
  updateLeadStatus,
  setExpectedPayout,
  validateQualification,
  isValidPhone,
  buildLeadAdminCard,
  buildLeadStatusKeyboard
};
