# Firm-Ready Launch Checklist

Use this checklist before every production launch.

## 1) Runtime Health Gates
- [ ] `GET /ready` returns `ok: true`.
- [ ] `GET /ready/firm` returns `ok: true` and `grade: firm-ready`.
- [ ] `GET /health` has no missing critical integrations for your active workflows.

## 2) Security Controls
- [ ] `BASE_WEBHOOK_SECRET` is set.
- [ ] `OPS_WEBHOOK_HMAC_SECRET` is set.
- [ ] n8n signs `/ops/ingest` payloads using `x-ops-signature` HMAC SHA-256 over raw JSON.
- [ ] `/webhook/metric` requests include `x-nil-secret`.
- [ ] `ADMIN_TELEGRAM_IDS` contains at least one active operator.

## 3) Forwarded Attribution Controls
- [ ] `FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY=true` in production.
- [ ] Guide links include explicit identity (`person_id` or `person_email` or query `person_key`).
- [ ] Coach self-click protection and bot/prefetch filtering are active in Cloudflare Worker.

## 4) Data Contract / Schema
- [ ] `nil_click_setup.sql` applied in production.
- [ ] Table exists: `nil.click_link_registry`.
- [ ] Columns exist on `nil.click_events`: `dedupe_key`, `is_unique_forwarded`, `person_key`, `actor_type`, `actor_id`.
- [ ] Columns exist on `nil.conversations`: `needs_support_handoff`, `needs_support_handoff_at`, `handoff_detected_reason`, `cc_support_suggested`.

## 5) n8n Event Contract
- [ ] n8n sends canonical envelope to `/ops/ingest` with:
  - `schema_version`, `event_type`, `source`, `direction`, `trace_id`, `idempotency_key`, `entity_type`, `entity_id`, `payload`.
- [ ] `outreach.handoff_detected` events include `entity_id` and reason payload.
- [ ] idempotency keys are deterministic across retries.

## 6) Triage and Operator UX
- [ ] Triage top summary order is: `‼`, `📌`, `📝`, `📱`, `📚`.
- [ ] Waiting (`⏳`) appears in dashboard/queues, not triage summary.
- [ ] Needs Loop row in triage includes `📌 Needs Loop` action when AI-ready.
- [ ] Queue pagination uses simple controls (`Prev`, `Next`, `Last`, `Back`).

## 7) Metrics Naming and Dashboard Fidelity
- [ ] Dashboard and year summary show:
  - `Total Clicks`
  - `Supplemental Health Guide Clicks`
  - `Risk Awareness Guide Clicks`
  - `Tax Education Guide Clicks`
- [ ] No user-facing `Coverage Exploration` label remains.

## 8) Outbox Reliability
- [ ] `/api/nil-outbox/claim` and `/api/nil-outbox/result` are reachable from n8n.
- [ ] Failed outbox entries retry then dead-letter after max attempts.
- [ ] Dead-letter backlog is monitored in watchdog/ops health.

## 9) Canary Scenario (Must Pass)
- [ ] Send Instantly outreach event (`instantly_email_sent`) -> pipeline moves to waiting/actions_waiting.
- [ ] Send Instantly reply event (`instantly_reply_sent`) -> conversation updates and appears active/needs-reply path.
- [ ] Send handoff detected event (`outreach.handoff_detected`) -> triage shows `📌` needs loop item.
- [ ] Execute `📌 Needs Loop` -> support loop action succeeds and item clears from needs-loop queue.

## 10) Post-Launch Observability (First 24 Hours)
- [ ] No sustained watchdog `warn` state.
- [ ] No repeated dead-letter growth trend.
- [ ] Triage counts and dashboard counts move as expected.
- [ ] Operator confirms no missing buttons/cards/paging regressions.
