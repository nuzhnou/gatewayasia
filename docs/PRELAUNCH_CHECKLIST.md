# Prelaunch Checklist

This checklist prepares the system for the first real 7-day launch toward the $2000/month target.

## Target

The first launch is not judged by revenue immediately. It is judged by whether the system can produce:

- 20+ bot starts;
- 8+ complete applications;
- 3+ hot candidates;
- 1+ candidate sent to Legalization Center.

After that, scale only the sources that produced real candidates.

## Day 0: Confirm Legalization Center Terms

Get written answers before scaling traffic.

Message to send:

```text
Здравствуйте. Хочу приводить кандидатов на ваши вакансии.

Подскажите, пожалуйста:
1. Сколько PLN выплата за одного трудоустроенного кандидата?
2. Когда кандидат считается засчитанным: выход на работу, 3 дня, 7 дней, другое?
3. Через сколько дней выплата?
4. Какие данные кандидата нужны в анкете?
5. Куда лучше отправлять анкеты: Telegram, email, форма, CRM?
6. Можно ли вести кандидата через мой Telegram-бот, а потом передавать вам готовую анкету?
7. Есть ли дополнительная выплата за отработанные часы кандидата?
```

Record the answers:

```text
Payout per placed candidate:
Placement counted after:
Payout delay:
Application destination:
Required candidate fields:
Passive/hourly payout:
Manager contact:
```

Do not scale paid or heavy traffic until these answers are clear.

## Day 1: Telegram Setup

Create the candidate bot:

1. Open `@BotFather`.
2. Run `/newbot`.
3. Name: `Svoyak Work Assistant` or similar.
4. Username: short and trustable, for example `SvoyakWorkBot`.
5. Save the bot token.

Create 4 Telegram workspaces:

1. `LCI - Hot Leads`
   - Ready applications and hot candidates only.
   - Add the bot as admin.

2. `LCI - Daily Numbers`
   - Daily report channel.
   - Add the bot as admin.

3. `LCI - Lead Work`
   - Manual work queue.
   - Calls, follow-ups, sent to LC, placed, paid.

4. `LCI - Source Tests`
   - FB groups, post text, source codes, results.

Get IDs:

```text
ADMIN_TELEGRAM_ID=
ADMIN_ALERT_CHAT_ID=
DAILY_REPORT_CHAT_ID=
LEAD_OPERATIONS_CHAT_ID=
SOURCE_TESTS_CHAT_ID=
```

Update `.env`:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
ADMIN_TELEGRAM_ID=
ADMIN_ALERT_CHAT_ID=
DAILY_REPORT_CHAT_ID=
DAILY_REPORT_HOUR=21
LEAD_OPERATIONS_CHAT_ID=
SOURCE_TESTS_CHAT_ID=
GEMINI_API_KEY=
```

Check readiness:

```bash
npm run preflight
```

## Day 1: Facebook Source Setup

Create a source sheet with these columns:

```text
date_added
city
group_name
group_url
members
language
post_allowed
joined_status
source_code
last_post_date
bot_starts
applications
hot_leads
notes
```

In this project the editable source sheet is:

```text
data/facebook_sources.csv
```

Check it with:

```bash
npm run sources:report
```

Generate a tracked bot link:

```bash
npm run sources:link -- --source fb_warsaw_001
```

Collect first 50 groups:

- Warsaw: 10 groups.
- Wroclaw: 8 groups.
- Poznan: 8 groups.
- Gdansk/Tricity: 8 groups.
- Lodz: 6 groups.
- General Poland work groups: 10 groups.

Use source codes from `docs/STARTER_FB_TG_CONTENT_PACK.md`.

## Day 2: Dry Run

Run checks:

```bash
npm test
npm run preflight
npm run leads:report
npm run leads:export -- --csv --limit 20
```

Expected result:

- tests pass;
- preflight has no required failures;
- report prints cleanly;
- CSV export appears in `exports/`.

Start the bot:

```bash
node src/bot/bot.js
```

Manual test:

1. Open your bot in Telegram.
2. Start it with a test source:
   `https://t.me/<BOT_USERNAME>?start=fb_test_001`
3. Complete a fake candidate conversation.
4. Confirm the lead appears in `LCI - Hot Leads`.
5. Press one admin status button.
6. Run:
   ```bash
   npm run leads:report
   npm run leads:export -- --csv --limit 20
   ```

## Days 3-7: First Source Test

Daily limits for first test:

- 10-15 group posts/comments from the main account.
- 5-10 comments under posts where people ask for work.
- No repeated identical text.
- No mass fake accounts.

Daily routine:

Morning:

- Read `LCI - Daily Numbers`.
- Pick 10 groups and 2 offer angles.
- Prepare source-coded links.

Daytime:

- Post/comment.
- Reply manually to comments.
- Push people into the bot.
- Contact hot candidates quickly.

Evening:

- Update lead statuses.
- Send qualified candidates to Legalization Center.
- Export CSV.
- Stop weak sources and repeat winning sources.

Use the LC handoff export before sending candidates:

```bash
npm run leads:handoff -- --statuses hot,qualified --limit 50
```

Or from an admin Telegram chat:

```text
/admin
/report
/handoff
/handoff --statuses hot,qualified --limit 50
```

After sending a candidate to LC, mark the lead as `sent_to_lc` in the admin Telegram buttons. When the candidate starts work, mark `placed`. When the payout arrives, mark `paid`.

To reopen a lead card in Telegram:

```text
/lead 123
```

## Daily Commands

```bash
npm run leads:report
npm run leads:export -- --csv
npm run leads:handoff
npm run campaign:dry
```

Use live Facebook posting only after manual review:

```bash
npm run campaign:live:headed
```

## Launch Gate

Do not call the first week a success unless these are true:

- source codes are used in every link;
- every complete application appears in Telegram and SQLite;
- hot leads are contacted manually;
- Legalization Center confirms they received candidates;
- payouts are tracked through `placed` and `paid` statuses.

## What Codex Can Do After This

Once the above is ready, Codex can:

- run preflight and tests;
- start the bot;
- generate and rotate post text;
- maintain source-code structure;
- export leads;
- inspect source performance;
- improve bot prompts and reports;
- add automation around the channels.

Codex cannot independently create your Telegram bot, receive SMS/2FA, warm Facebook accounts, or force Legalization Center to pay. Those external steps must be prepared by the user.
