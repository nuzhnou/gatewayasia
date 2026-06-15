# Tier 0 — Protect & Measure the Money Funnel (design)

Date: 2026-06-13. Goal: make the already-working candidate funnel safe and measurable
*before* pouring traffic in. Four near-free fixes.

## 1. Payout tracking (the dead KPI)
- **Problem:** `expected_payout_pln` / `actual_payout_pln` are never written → reports show 0.
- **Fix:**
  - On full qualification: set `expected_payout_pln` from the candidate's target vacancy
    commission (`commission_pln_max`, else min, else the top matched vacancy, else a
    configurable default `DEFAULT_COMMISSION_PLN=900`). New `setExpectedPayout(leadId, amount)`.
  - On status → `paid`: copy expected → `actual_payout_pln` (if unset) and set
    `payout_status='paid'`. On `lost`: `payout_status='lost'`.
  - Commission is internal — never shown to the candidate.

## 2. Bot liveness (protect the only inbound channel)
- **Problem:** no `polling_error` handler; `/health` says ok even if polling died.
- **Fix:**
  - `bot.on('polling_error')` → log + record `lastPollingError`.
  - Track `lastUpdateAt` on every received update.
  - Export `getBotStatus()`; `/health` in index.js reports `lastUpdateAgeSec` + last error.
  - Watchdog (every 5 min): if a polling error occurred recently, send ONE debounced
    admin alert to `ADMIN_ALERT_CHAT_ID`.

## 3. Harden AI JSON parsing (stop losing leads)
- **Problem:** model output that isn't clean JSON → `JSON.parse` throws → lead silently lost.
- **Fix:** `parseModelJson(text)` strips ```` ```json ```` fences and extracts the outermost
  `{...}`. On failure, ONE re-prompt via `generateJSON` ("return ONLY valid JSON"). Only then
  the soft "resend" fallback.

## 4. Server-side qualification gate (no junk hot leads)
- **Problem:** `isFullyQualified` is 100% AI-judged; a hallucinated `true` fires a junk admin
  alert + premature candidate promise.
- **Fix:** `validateQualification(q)` requires a real-looking phone (≥9 digits) + non-empty
  name + (city or relocation) + documents. The admin alert / final confirmation fire only when
  AI says qualified **and** validation passes; otherwise the dialogue continues.

## Out of scope (later tiers)
FB group auto-discovery + posting queue (Tier 1), Telegram hub + OLX (Tier 2),
scheduling the site scraper, env-name consolidation, chat_history pruning.
