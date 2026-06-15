# 30-Day Operating Plan: $2000 From Legalization Center Leads

## Goal

Earn about **$2000 in 30 days** by generating and qualifying candidates for Legalization Center work offers, then passing ready candidates for placement and payout tracking.

This is not a passive fully automated system on day one. The fastest path is:

1. Automate lead capture, qualification, tagging, reminders, and reporting.
2. Keep human control over hot-lead follow-up and payout confirmation.
3. Scale only the groups, posts, and traffic sources that show real conversion.

## Money Math

Target: **$2000/month**, roughly **8000 PLN/month**.

If payout is **1000 PLN per placed candidate**, the system needs:

- 8 placed candidates.
- At 20% placement from complete applications: 40 complete applications.
- At 35% complete application rate from bot starts: 115 bot starts.
- At 10% bot-start rate from post/comment traffic: about 1150 interested clicks/messages.

If payout is **500 PLN per placed candidate**, the system needs:

- 16 placed candidates.
- About 80 complete applications.
- About 230 bot starts.

Operational target for the first 30 days:

- **150-250 bot starts**
- **50-90 complete applications**
- **20-35 hot candidates**
- **8-16 placed candidates**

## Positioning

Use the public Legalization Center offer as proof, but route candidates through our tracked bot first.

Core claims from the current site:

- Free vacancy matching for men and women in Poland and Europe.
- More than 100 vacancies.
- Free help with legalization and residence-card support for company workers.
- Full support during employment.
- Fast job confirmation, up to 24 hours after details are agreed.
- No candidate fee.

The candidate-facing brand should be neutral and trust-based:

- Main brand: **Svoyak.pl**
- Bot persona: **Lesya**
- Promise: "Free job matching in Poland with clear conditions, housing details, documents support, and no upfront payments."

Do not overpromise salary, documents, housing quality, or guaranteed hiring. The system should sell speed, clarity, and free support.

## Telegram Control Structure

Use one main bot and a small number of private channels/groups. Too many channels will create noise.

### 1. Candidate Bot

Purpose: public entry point for all leads.

Required behavior:

- Accept `/start` parameters for source tracking, for example `fb_warsaw_001`, `fb_wroclaw_003`, `tg_jobs_002`, `rec_123`.
- Ask one or two questions at a time.
- Collect required data:
  - name;
  - phone with WhatsApp/Viber/Telegram;
  - current city/country;
  - citizenship;
  - document status;
  - age or under/over 26;
  - preferred city or willingness to relocate;
  - preferred work type;
  - when ready to start;
  - whether housing is needed.
- Save every lead in SQLite.
- Send complete applications to the admin group.

### 2. Admin Alerts Group

Name: `LCI - Hot Leads`

Purpose: only actionable leads.

Messages:

- new complete application;
- hot candidate detected;
- candidate asks for human;
- candidate sent phone but did not complete the form;
- candidate ready to leave within 7 days.

This group must stay clean. No logs, no low-quality system messages.

### 3. Daily Report Channel

Name: `LCI - Daily Numbers`

Purpose: one report per day.

Report fields:

- posts published;
- groups touched;
- bot starts;
- complete applications;
- hot candidates;
- candidates sent to Legalization Center;
- confirmed placements;
- expected payout;
- top 5 sources;
- sources to stop using.

### 4. Lead Operations Group

Name: `LCI - Lead Work`

Purpose: manual work queue.

Messages:

- lead needs call;
- no answer follow-up;
- document clarification needed;
- candidate accepted vacancy;
- candidate sent to LC;
- candidate arrived;
- candidate placed;
- payout confirmed.

### 5. Source Testing Channel

Name: `LCI - Source Tests`

Purpose: keep experiments separate from real work.

Messages:

- which FB groups were posted to;
- post text used;
- source code;
- number of starts from each group;
- notes: banned, pending approval, strong group, weak group.

## Lead Status Pipeline

Every lead should have one current status:

1. `new` - started bot or found in a source.
2. `engaged` - replied with meaningful intent.
3. `qualified` - all required data collected.
4. `hot` - ready to start within 7 days or already in Poland.
5. `sent_to_lc` - sent to Legalization Center.
6. `lc_contacted` - LC or manager contacted candidate.
7. `accepted` - candidate accepted a concrete vacancy.
8. `arrived` - candidate arrived or attended onboarding.
9. `placed` - candidate started work.
10. `paid` - payout received.
11. `lost` - rejected, no answer, not eligible, or duplicate.

No lead should live only in Telegram chat history. If a lead is not in the database with status and source, it is lost.

## Facebook Strategy

The first month should use controlled semi-automation, not aggressive spam automation.

Account structure:

- 1 real main account.
- 1 branded Facebook page.
- 2-3 real helper/recruiter accounts if available.
- No mass fake-account creation as the primary strategy.

Group strategy:

- Build a list of 100-200 groups.
- Start with 30-50 groups.
- Track every group with a source code.
- Post manually or semi-automatically at first.
- Keep only groups that produce bot starts.

Group categories:

- Ukrainians in Poland by city.
- Belarusians in Poland by city.
- Russian-speaking Poland city groups.
- Work in Poland groups.
- Women in Poland groups.
- Students/young workers groups.
- Housing/work help groups where job posts are allowed.

Daily posting limit for the first week:

- Main account: 10-15 posts/comments per day.
- Page: 5-10 posts/comments per day.
- Helpers: 5-10 posts/comments each.

Better than raw posting:

- Comment under posts where people ask for work.
- DM only people who clearly asked for work and do it manually at first.
- Use city-specific posts.
- Rotate offers and text.
- Do not post the same link and text everywhere.

## Content System

Use five offer angles:

1. Work without Polish.
2. Work with housing.
3. Work for women.
4. Work for men/couples.
5. Fast start / already in Poland.

Each post should contain:

- city or relocation note;
- work type;
- free support;
- housing/documents note;
- no upfront fees;
- simple CTA to the bot.

Example CTA:

`Напишите в Telegram слово РАБОТА, бот задаст 5 вопросов и подберет вариант: https://t.me/<bot>?start=fb_warsaw_001`

## Daily Operating Rhythm

Morning:

- Check yesterday report.
- Pick top groups and top offer angles.
- Prepare 10-20 posts/comments for the day.
- Process hot leads first.

Daytime:

- Publish and comment in groups.
- Reply to candidate comments manually.
- Push people into the bot.
- Call/write hot candidates quickly.

Evening:

- Send complete applications to Legalization Center.
- Update statuses.
- Review source performance.
- Stop bad groups and repeat good groups with new text.

## What User Must Prepare

Required before full launch:

1. Confirm exact payout rules from Legalization Center:
   - payout per candidate;
   - when payout is counted;
   - payout delay;
   - whether there is hourly passive income;
   - what candidate data they require;
   - who receives applications.

2. Create Telegram assets:
   - candidate bot via BotFather;
   - admin alert group;
   - daily report channel;
   - lead operations group;
   - source testing channel.

3. Get IDs and tokens:
   - `TELEGRAM_BOT_TOKEN`;
   - `ADMIN_TELEGRAM_ID` or admin group ID;
   - group/channel IDs for reports and operations.

4. Prepare Facebook assets:
   - main account warmed up;
   - branded page;
   - list of current FB groups;
   - decision whether helpers/recruiters will join.

5. Prepare payout tracking:
   - spreadsheet or database statuses;
   - payout amount;
   - date sent to LC;
   - date confirmed;
   - date paid.

## What Codex Should Build Next

Priority 1:

- Add source-code tracking for every `/start`.
- Expand the lead schema with source, city, citizenship, documents, phone, readiness, housing, language, age, status, and payout fields.
- Add admin notifications to a group, not only one admin DM.
- Add status buttons for admin: `Hot`, `Sent to LC`, `Accepted`, `Placed`, `Paid`, `Lost`.

Priority 2:

- Add daily report command and scheduled daily report.
- Add source performance report.
- Add CSV export of leads.
- Add duplicate detection by phone and Telegram ID.

Priority 3:

- Add recruiter/referral tracking.
- Add separate recruiter links and payout balances.
- Add controlled posting queue with source codes per group.

## 7-Day Launch Plan

Day 1:

- Confirm payout rules.
- Create Telegram bot and management groups.
- Configure `.env`.
- Implement lead status pipeline and source tracking.

Day 2:

- Add reporting and admin buttons.
- Prepare first 50 FB groups.
- Create 30 post variants.

Day 3:

- Soft launch in 10-15 groups.
- Manually check every bot conversation.
- Fix bot questions and objections.

Day 4:

- Scale to 30-50 groups.
- Start daily reports.
- Send first qualified candidates to LC.

Day 5:

- Identify top 10 sources.
- Stop weak groups.
- Add helper/recruiter links if available.

Day 6:

- Push hot leads with manual follow-up.
- Build a small retargeting list of people who started but did not finish.

Day 7:

- Review numbers.
- Decide whether to scale posting, add helpers, or change offer angle.

## Decision Rules

Scale a source if:

- it produces at least 3 bot starts per post/comment batch;
- at least 20% of starts become complete applications;
- comments are not hostile;
- the account is not being restricted.

Stop a source if:

- no starts after 3 attempts;
- group admins delete posts;
- users complain about spam;
- candidate quality is consistently bad.

Hot candidate rule:

- already in Poland;
- ready within 7 days;
- has valid documents or clear legal path;
- gives phone;
- open to relocation or has city match.

## First Real Milestone

Do not judge the system by revenue in the first 48 hours. Judge it by whether it can produce:

- 20+ bot starts;
- 8+ complete applications;
- 3+ hot candidates;
- 1+ candidate sent to Legalization Center.

Once this is true, scale the sources that created those candidates.
