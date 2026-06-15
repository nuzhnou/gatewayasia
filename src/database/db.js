const Database = require('libsql');
const path = require('path');

// When Turso credentials are present we connect DIRECTLY to the remote primary
// (synchronous libsql client — same better-sqlite3-style API, no local file, no
// replica, no sync). This makes the bot (Render) and the scraper (local) read
// and write the SAME database with instant consistency — a single source of
// truth. Without the vars we run on a plain local database.db (dev/tests).
const remoteUrl = process.env.TURSO_DATABASE_URL || '';
const authToken = process.env.TURSO_AUTH_TOKEN || '';
const remoteMode = Boolean(remoteUrl);

let db;
if (remoteMode) {
  db = new Database(remoteUrl, { authToken });
  console.log('[DB] Connected to Turso (remote mode).');
} else {
  const dbPath = process.env.LOCAL_DB_PATH || path.join(__dirname, '../../database.db');
  db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch (error) {
    // WAL is a no-op/unsupported in some modes; safe to ignore.
  }
}

// Kept for API compatibility (callers: bot.js, scrapers). In remote mode every
// write hits the primary directly, so there is nothing to flush.
function syncNow() { /* no-op: remote mode is always consistent */ }

function columnExists(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some(column => column.name === columnName);
}

function ensureColumn(tableName, columnName, definition) {
  if (!columnExists(tableName, columnName)) {
    db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

// Инициализация таблиц базы данных
function initDatabase() {
  // Таблица кандидатов (соискателей)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_platform TEXT,
      source_url TEXT UNIQUE,
      candidate_name TEXT,
      contact_info TEXT,
      raw_post_text TEXT,
      extracted_intent TEXT,
      status TEXT DEFAULT 'new',
      assigned_recruiter_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const leadColumns = [
    ['telegram_chat_id', 'INTEGER'],
    ['telegram_username', 'TEXT'],
    ['source_code', 'TEXT'],
    ['source_category', 'TEXT'],
    ['source_group_url', 'TEXT'],
    ['current_location', 'TEXT'],
    ['citizenship', 'TEXT'],
    ['documents', 'TEXT'],
    ['target_vacancy_id', 'TEXT'],
    ['preferred_city', 'TEXT'],
    ['preferred_work_type', 'TEXT'],
    ['start_date', 'TEXT'],
    ['phone', 'TEXT'],
    ['age_group', 'TEXT'],
    ['housing_needed', 'TEXT'],
    ['readiness_level', 'TEXT'],
    ['expected_payout_pln', 'REAL DEFAULT 0.0'],
    ['actual_payout_pln', 'REAL DEFAULT 0.0'],
    ['payout_status', "TEXT DEFAULT 'unpaid'"],
    ['last_admin_message_id', 'INTEGER'],
    ['cold_notified_at', 'DATETIME'],
    ['notes', 'TEXT']
  ];

  for (const [columnName, definition] of leadColumns) {
    ensureColumn('leads', columnName, definition);
  }

  // Таблица суб-рекрутеров (партнеров)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recruiters (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      status TEXT DEFAULT 'active',
      balance_pln REAL DEFAULT 0.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Таблица системных логов
  db.prepare(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT,
      message TEXT,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS lead_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      event_type TEXT,
      old_status TEXT,
      new_status TEXT,
      actor TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    )
  `).run();

  // Таблица истории чата для ИИ-собеседника
  db.prepare(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      role TEXT,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Таблица вакансий, спарсенных из Telegram/сайта
  db.prepare(`
    CREATE TABLE IF NOT EXISTS vacancies (
      id TEXT PRIMARY KEY,
      source_platform TEXT DEFAULT 'telegram',
      source_id TEXT UNIQUE,
      raw_text TEXT,
      title TEXT,
      location TEXT,
      salary TEXT,
      obfuscated_text TEXT,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Журнал публикаций в группы — для каденса (не спамить одну группу),
  // дневных лимитов на аккаунт и расчёта CAC по источникам.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS post_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_url TEXT,
      account TEXT,
      vacancy_id TEXT,
      source_code TEXT,
      status TEXT DEFAULT 'posted',
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Структурированные поля для фильтрации/подбора (заполняются парсером).
  const vacancyColumns = [
    ['city', 'TEXT'],
    ['region', 'TEXT'],
    ['role_category', 'TEXT'],
    ['pay_net_min', 'REAL'],
    ['pay_net_max', 'REAL'],
    ['student_rate', 'REAL'],
    ['gender', "TEXT DEFAULT 'any'"],      // m / f / any
    ['age_min', 'INTEGER'],
    ['age_max', 'INTEGER'],
    ['needs_docs', 'TEXT'],                // напр. "виза/PESEL/карта побыта"
    ['needs_experience', 'INTEGER DEFAULT 0'],
    ['housing_provided', 'INTEGER DEFAULT 0'],
    ['commission_pln_min', 'REAL'],
    ['commission_pln_max', 'REAL'],
    ['source_url', 'TEXT'],
    ['is_active', 'INTEGER DEFAULT 1'],
    ['last_seen_at', 'DATETIME']
  ];
  for (const [columnName, definition] of vacancyColumns) {
    ensureColumn('vacancies', columnName, definition);
  }

  // Push the freshly created schema to the remote primary on first boot.
  syncNow();
  console.log("Database initialized successfully!");
}

module.exports = {
  db,
  initDatabase,
  syncNow,
  remoteMode
};
