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

function createClient() {
  if (remoteMode) {
    return new Database(remoteUrl, { authToken });
  }
  const dbPath = process.env.LOCAL_DB_PATH || path.join(__dirname, '../../database.db');
  const local = new Database(dbPath);
  try {
    local.pragma('journal_mode = WAL');
  } catch (error) {
    // WAL is a no-op/unsupported in some modes; safe to ignore.
  }
  return local;
}

let client = createClient();
console.log(remoteMode ? '[DB] Connected to Turso (remote mode).' : '[DB] Local database file.');

// Удалённый стрим Turso (Hrana) протухает при простое — запрос падает с
// "stream not found". Эти ошибки восстановимы: пересоздаём соединение и повторяем
// запрос один раз. Так бот переживает простои Render и сетевые блипы.
const RECOVERABLE = /stream not found|stream is closed|stream expired|baton|hrana|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|connection (reset|closed)|50[234]/i;

function reconnect(reason) {
  try { if (client && client.close) client.close(); } catch (_) { /* ignore */ }
  client = createClient();
  console.warn('[DB] reconnected to Turso (' + String(reason || '').slice(0, 80) + ')');
}

// db.prepare(sql) → стейтмент с run/get/all, которые при восстановимой ошибке
// один раз переподключаются и повторяют запрос. Все вызовы db.prepare в коде
// работают как прежде — менять их не нужно.
const db = {
  prepare(sql) {
    let stmt = client.prepare(sql);
    let conn = client;
    const exec = (method) => (...args) => {
      if (conn !== client) { stmt = client.prepare(sql); conn = client; }
      try {
        return stmt[method](...args);
      } catch (e) {
        if (remoteMode && RECOVERABLE.test((e && e.message) || '')) {
          reconnect(e && e.message);
          stmt = client.prepare(sql);
          conn = client;
          return stmt[method](...args); // повтор один раз на свежем соединении
        }
        throw e;
      }
    };
    return { run: exec('run'), get: exec('get'), all: exec('all') };
  },
  pragma: (...args) => client.pragma(...args)
};

// Держим Hrana-стрим тёплым: лёгкий пинг раз в 90с не даёт ему протухнуть при
// простое (это и была причина падений cold sweep раз в 20 мин).
if (remoteMode) {
  const ka = setInterval(() => { try { db.prepare('SELECT 1').get(); } catch (_) { /* recover внутри */ } }, 90 * 1000);
  if (ka.unref) ka.unref();
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
