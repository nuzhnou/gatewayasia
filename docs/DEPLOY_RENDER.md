# Деплой бота 24/7 на Render Free + Turso

Цель: бот @svoyakplBot работает круглосуточно, лиды не теряются при рестартах.
Хост бесплатный (Render free), база — бесплатный Turso (libSQL).

Почему так: у Render free нет постоянного диска — файл `database.db` обнуляется
при каждом рестарте. Поэтому база вынесена в Turso. Код уже умеет это
автоматически: если в окружении есть `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`,
он работает как embedded-реплика (пишет в облако, читает локально). Если их нет —
обычный локальный файл (для разработки).

---

## Шаг 1. Создать базу в Turso (один раз, ~5 минут)

Установить CLI и войти:

```bash
# macOS
brew install tursodatabase/tap/turso
# или: curl -sSfL https://get.tur.so/install.sh | bash

turso auth signup        # откроется браузер, войти через GitHub
```

Создать базу и получить креды:

```bash
turso db create svoyak
turso db show svoyak --url            # -> это TURSO_DATABASE_URL (libsql://...)
turso db tokens create svoyak         # -> это TURSO_AUTH_TOKEN (длинная строка)
```

Сохрани оба значения — они понадобятся в Шаге 3.

(Опционально, проверить локально перед деплоем:)

```bash
TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="..." node -e "require('./src/database/db').initDatabase()"
# в логах должно быть: [DB] Embedded replica connected to Turso and synced.
turso db shell svoyak "SELECT name FROM sqlite_master WHERE type='table';"
```

## Шаг 2. Залить код на GitHub

Render деплоит из репозитория. `.gitignore` уже настроен — `.env`,
`database.db`, `facebook_cookies.json` НЕ попадут в репозиторий.

```bash
git init
git add .
git commit -m "Deploy: svoyak bot on Render + Turso"
git branch -M main
git remote add origin https://github.com/<твой_логин>/svoyak-bot.git
git push -u origin main
```

⚠️ Перед push убедись, что `.env` не в индексе: `git status` не должен его
показывать. Если показывает — `git rm --cached .env`.

## Шаг 3. Создать сервис на Render

Вариант А (через Blueprint, проще) — в репозитории уже есть `render.yaml`:

1. https://dashboard.render.com → **New** → **Blueprint**.
2. Подключить репозиторий → Render прочитает `render.yaml`.
3. На шаге переменных вписать секреты (они помечены `sync:false`):
   - `TELEGRAM_BOT_TOKEN` = `8940414316:AAG...`
   - `TELEGRAM_BOT_USERNAME` = `svoyakplBot`
   - `GEMINI_API_KEY` = ...
   - `ADMIN_TELEGRAM_ID` = `243806649`
   - `ADMIN_ALERT_CHAT_ID` = `-1004465298499`
   - `DAILY_REPORT_CHAT_ID` = `-1004409800121`
   - `TURSO_DATABASE_URL` = из Шага 1
   - `TURSO_AUTH_TOKEN` = из Шага 1
   - `APIFY_TOKEN` = ...
4. **Apply** → дождаться деплоя. В логах: `Health server listening` и
   `[DB] Embedded replica connected to Turso and synced.`

Вариант Б (вручную): New → Web Service → репозиторий → Build `npm install`,
Start `node index.js`, Health Check Path `/health`, Plan Free, и те же env-vars.

## Шаг 4. Keep-alive (обязательно для free!)

Render free засыпает после ~15 минут без входящего трафика — и тогда бот
перестаёт принимать сообщения. Нужен внешний пингер.

1. https://cron-job.org (бесплатно) → создать job.
2. URL: `https://svoyak-bot.onrender.com/health` (свой адрес из Render).
3. Интервал: каждые **10 минут**.
4. Сохранить и включить.

(Альтернатива: UptimeRobot, монитор типа HTTP(s), интервал 5 мин.)

## Проверка, что всё живо

1. Открой `https://svoyak-bot.onrender.com/health` → должно вернуть
   `{"status":"ok",...}`.
2. Напиши боту в Telegram: `/start fb_gdansk_001`, пройди воронку.
3. Анкета должна прийти в группу **Svoyakpl - admin alert**.
4. Проверь, что лид сохранился в Turso:
   ```bash
   turso db shell svoyak "SELECT id, candidate_name, status, source_code FROM leads ORDER BY id DESC LIMIT 5;"
   ```
5. Сделай Manual Deploy в Render (рестарт) и повтори пункт 4 — лид должен
   остаться на месте. Это доказывает, что данные переживают рестарты.

## Важные нюансы

- **Лимит Render free — 750 часов/месяц на весь аккаунт.** Один always-on
  сервис ≈ 730ч, влезает. Если на аккаунте уже крутятся другие free-сервисы
  24/7 — суммарно превысите 750ч, и сервис вырубится до конца месяца. Тогда
  переноси что-то на платный план или на отдельный аккаунт.
- **Холодный старт.** После засыпания первый запрос будит сервис ~30–60 сек.
  Пингер раз в 10 минут не даёт заснуть, так что в норме этого не будет.
- **Facebook-постинг на сервере не работает** (Chromium не качается,
  `PUPPETEER_SKIP_DOWNLOAD=true`). Постинг в FB по-прежнему запускается у тебя
  локально (`npm run campaign:live:headed`) — это намеренно, чтобы не словить
  бан и не раздувать билд.
- **TG-парсинг канала LCI** работает и на сервере, если добавишь
  `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION` в env Render.
