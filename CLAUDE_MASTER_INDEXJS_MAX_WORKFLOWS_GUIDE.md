# CLAUDE MASTER GUIDE — Maximum-Capability Workflow Stack for NIL index.js Telegram Bot

Date: March 5, 2026  
Target runtime: `src/index.js` (Telegraf + Express + Supabase nil schema)  
Purpose: Give Claude a single complete source of truth to generate/maintain all workflows your bot can use.

---

## 1) Mission

Build and operate the **full automation fabric** around `index.js` so the bot reaches maximum operational capability across:
- submissions
- outreach outbox
- reply/support ingestion
- CC-support bridge/mirror
- identity/thread linking
- SLA/escalation
- click + KPI analytics
- reliability + observability

This guide includes **all workflows** by tier, plus payload contracts and implementation order.

---

## 2) Hard Contracts from index.js

### API endpoints exposed by bot
- `POST /ops/ingest` (canonical event ingestion with dedupe)
- `POST /api/submissions` (submission + outbox queue)
- `GET /api/nil-outbox/claim` (claim queued outbox rows)
- `POST /api/nil-outbox/result` (mark send status)
- `POST /webhook/metric` (legacy metric webhook)

### Auth expectations
- `x-nil-secret` must match `BASE_WEBHOOK_SECRET` unless HMAC path is used.

### Event types bot reacts to for UI refresh
- `submission.created`
- `submission.updated`
- `conversation.updated`
- `message.ingested`
- `outbox.email.*`
- `outbox.sms.*`
- `call.*`
- `click.*`
- `metric.*`
- `eapp.visit`

### CC + Mirror hooks already in index.js
- Bot can call `CC_SUPPORT_WEBHOOK_URL` with `event_type: cc_support.requested`
- Bot already uses:
  - `conversations.mirror_conversation_id`
  - `nil.card_mirrors`
  - `OPENMIRROR` UI action
- Bot expects mirror to appear **after downstream ingestion**.

---

## 3) Maximum Workflow Inventory (All Possible)

## Tier A — Core Runtime (Required)

### A1. Website Submission Intake
Trigger: website form/webhook  
Writes: `nil.submissions`, `nil.n8n_outbox`  
Notifies: `submission.created` to `/ops/ingest` (optional if using API path)

### A2. Outbox Dispatcher (Email/SMS)
Trigger: schedule every 30–60 sec  
Flow: claim -> send -> result callback  
Uses:
- `GET /api/nil-outbox/claim`
- provider send (Instantly/Gmail/SendGrid/Twilio)
- `POST /api/nil-outbox/result`

### A3. Reply/Support Ingest Producer
Trigger: Instantly/Gmail polling or webhook  
Writes/upserts: `nil.conversations`, `nil.messages`  
Emits: `message.ingested` and/or `conversation.updated` to `/ops/ingest`

### A4. Analytics Sync
Trigger: schedule 15–60 min  
Fetches: opens/clicks/replies/bounce from provider  
Writes: `nil.lead_metrics` / click table path  
Emits: `metric.*` / `click.*` to `/ops/ingest`

---

## Tier B — Identity, Threading, and CC (Required for advanced ops)

### B1. Conversation Identity Linker
Goal: same email -> unified thread family  
Writes:
- `conversations.mirror_conversation_id`
- `nil.card_mirrors`

### B2. Mirror Reconciler
Goal: fix one-way or broken mirror links  
Repairs forward+reverse links and stale references.

### B3. CC Support Executor
Goal: execute `cc_support.requested` end-to-end  
Actions:
- send bridge message (outreach lane)
- send support-forward (support sender)
- create/find support mirror conversation
- link mirrors + emit refresh events

### B4. Thread Matcher + Upsert Guard
Goal: avoid duplicate conversation rows by robust keying  
Key precedence:
1) `thread_key`
2) `(normalized_email + source + recent window)`
3) fallback explicit map

### B5. Contact Identity Normalizer
Goal: normalize email/phone/name in one consistent pass before writes.

---

## Tier C — Triage and SLA (Strongly Recommended)

### C1. SLA Escalator
Goal: auto move stale/overdue conversations to `urgent`.

### C2. Follow-up Scheduler
Goal: populate `next_action_at` and send reminder events.

### C3. Unreplied Aging Scanner
Goal: detect threads with no outbound after inbound within SLA window.

### C4. Priority Scorer
Goal: compute priority tier from role/source/age/conversion likelihood.

### C5. Assignment Router
Goal: auto-assign support tickets or followups by queue rules.

---

## Tier D — Role Intelligence and Data Quality

### D1. Role Conflict Resolver
Goal: resolve `role_pending` safely (auto/high-confidence + manual queue).

### D2. Submission-to-Conversation Role Sync Verifier
Goal: ensure submission role sync succeeded; heal drift.

### D3. Email/Phone Dedupe Sweeper
Goal: merge duplicate records and preserve canonical references.

### D4. Backfill Normalized Fields
Goal: fill missing `normalized_email`, etc. for old rows.

---

## Tier E — Reliability/Operations (Required in production)

### E1. Dead Letter Replayer
Goal: replay `nil.dead_letters` back into `/ops/ingest` safely.

### E2. Retry Supervisor
Goal: exponential backoff for outbox/provider failures.

### E3. Webhook Signature/Secret Auditor
Goal: detect auth failures and alert.

### E4. Workflow Heartbeat Monitor
Goal: periodic health pings and stale-run detection.

### E5. Error Budget & Alerting
Goal: threshold alerts to Telegram on failure spikes.

---

## Tier F — Analytics and Growth (Maximum insight)

### F1. Click Link Generator
Goal: generate tracked links + registry + short code mapping.

### F2. Cloudflare Link Event Ingest
Goal: ingest enriched click metadata and write canonical click rows.

### F3. Funnel Builder
Goal: compute email->guide->enroll conversion cohorts.

### F4. KPI Materializer
Goal: precompute daily/weekly/monthly/yearly summary tables.

### F5. Cohort Analytics
Goal: conversion by source/state/role/device/template version.

### F6. A/B Draft Performance Tracker
Goal: compare V1/V2/V3 draft outcomes by click/reply.

---

## Tier G — Communication and Reporting

### G1. Daily Ops Digest
Goal: morning Telegram digest for pipeline + risks + wins.

### G2. Weekly Executive Summary
Goal: conversion + SLA + throughput + exceptions.

### G3. Incident Blast
Goal: urgent one-click alert fanout when critical failures occur.

### G4. Noisy-Event Suppressor
Goal: collapse repetitive alerts into grouped reports.

---

## Tier H — Integrations (optional but useful)

### H1. Calendly/Call Webhook Ingest
Goal: write call events and emit `call.*`.

### H2. CRM Sync (HubSpot/Salesforce)
Goal: sync lead/conversation status bi-directionally.

### H3. Warehouse Export (BigQuery/S3)
Goal: long-term analytical storage + BI dashboards.

### H4. Compliance Archiver
Goal: archive/de-identify aged PII records.

---

## 4) Workflows already created in this repo

- `n8n-conversation-identity-linker-workflow.json`
- `n8n-mirror-reconciler-workflow.json`
- `n8n-cc-support-executor-workflow.json`
- `n8n-dead-letter-replayer-workflow.json`
- `n8n-sla-escalator-workflow.json`
- `n8n-role-conflict-resolver-workflow.json`

Reference architecture doc:
- `CLAUDE_INDEXJS_MAX_CAPABILITY_WORKFLOWS.md`

---

## 5) Master Build Order (recommended)

Phase 1 (stability first)
1. A1, A2, A3, A4
2. E1, E2, E4

Phase 2 (thread correctness)
3. B1, B2, B4, B5
4. B3

Phase 3 (operational maturity)
5. C1, C2, C3
6. D1, D2, D3

Phase 4 (analytics depth)
7. F1, F2, F3, F4, F6
8. G1, G2

Phase 5 (enterprise add-ons)
9. H1, H2, H3, H4

---

## 6) Canonical OPS event envelope

All workflows that notify the bot should emit this shape to `POST /ops/ingest`:

```json
{
  "schema_version": "5.3",
  "event_type": "conversation.updated",
  "source": "n8n",
  "direction": "inbound",
  "trace_id": "uuid",
  "idempotency_key": "string",
  "entity_type": "conversation",
  "entity_id": "uuid-or-stable-id",
  "submission_id": null,
  "client_email": "optional@example.com",
  "client_phone_e164": null,
  "payload": {
    "any": "domain-specific fields"
  }
}
```

Rules:
- Always include `trace_id`.
- Always include deterministic `idempotency_key`.
- Use event types from index.js refresh paths whenever possible.

---

## 7) Environment variable matrix

Global
- `BASE_WEBHOOK_SECRET`
- `OPS_INGEST_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

CC/Email
- `CC_SUPPORT_WEBHOOK_URL`
- `SUPPORT_FROM_EMAIL`
- `OUTREACH_FROM_EMAIL`
- provider API keys (Instantly/Gmail/SendGrid/Twilio)

SLA
- `URGENT_AFTER_MINUTES`
- `URGENT_COOLDOWN_HOURS`

Analytics
- `TRACKING_BASE_URL`
- `CLOUDFLARE_WORKER_URL`

---

## 8) SQL/schema requirements checklist

Must exist:
- `nil.conversations`
- `nil.messages`
- `nil.submissions`
- `nil.n8n_outbox`
- `nil.ops_events`
- `nil.dead_letters`
- `nil.card_mirrors`

For click analytics (recommended):
- `nil.click_events` (+ summary views/materializers)

For role workflows:
- `conversations.role`
- `conversations.role_pending`
- `conversations.role_confidence`
- `conversations.role_source`

For CC lock:
- `conversations.cc_support_enabled`
- `conversations.cc_support_locked_at`

---

## 9) Test matrix (must pass before prod)

Identity/mirror
- Same email across 3 conversation rows -> one canonical + mirrors linked.
- Broken back-link repaired by reconciler in one cycle.

CC workflow
- CC button in bot -> webhook fired -> 2 sends recorded -> mirror visible.
- Duplicate CC click does not duplicate sends.

SLA
- stale conversation crosses threshold -> pipeline urgent.
- urgent cooldown respected.

Dead letters
- malformed dead letter skipped and logged.
- replayable dead letter deleted after success.

Role conflicts
- role_pending auto-accepted only under policy.
- manual-review events logged for unresolved conflicts.

Analytics
- click and metric events appear in dashboard refresh within one cycle.

---

## 10) Claude super-prompt (use this to generate/update everything)

```markdown
You are generating and maintaining n8n workflows for NIL Wealth index.js Telegram bot.

Use this repo contracts:
- API endpoints: /ops/ingest, /api/submissions, /api/nil-outbox/claim, /api/nil-outbox/result
- Schema: nil
- Mirror model: conversations.mirror_conversation_id + nil.card_mirrors
- CC trigger payload: event_type=cc_support.requested
- Ops envelope with idempotency_key and trace_id

Build/maintain these workflows:
A1 A2 A3 A4
B1 B2 B3 B4 B5
C1 C2 C3 C4 C5
D1 D2 D3 D4
E1 E2 E3 E4 E5
F1 F2 F3 F4 F5 F6
G1 G2 G3 G4
H1 H2 H3 H4

For each workflow provide:
1) Trigger and schedule/webhook path
2) Full node-by-node design
3) Importable n8n JSON
4) Env vars and credentials
5) Idempotency strategy
6) Failure/retry/dead-letter behavior
7) Test payload + expected DB deltas

Do not omit any tier. Keep event naming compatible with index.js refresh logic.
```

---

## 11) What is required vs optional (practical)

Required for robust production:
- A1 A2 A3 A4
- B1 B2 B3
- C1
- D1
- E1 E2 E4
- G1

Optional but high-value:
- B4 B5
- C2 C3 C4 C5
- D2 D3 D4
- F1..F6
- G2 G3 G4
- H1..H4

---

## 12) Immediate next action

Import and wire these six starter workflows first:
1. `n8n-conversation-identity-linker-workflow.json`
2. `n8n-mirror-reconciler-workflow.json`
3. `n8n-cc-support-executor-workflow.json`
4. `n8n-dead-letter-replayer-workflow.json`
5. `n8n-sla-escalator-workflow.json`
6. `n8n-role-conflict-resolver-workflow.json`

Then run test matrix section 9 in staging before production activation.
