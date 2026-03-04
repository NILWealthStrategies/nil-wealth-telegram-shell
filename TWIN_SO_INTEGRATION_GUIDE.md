# Twin.so Integration Guide for Nil-Wealth Telegram Bot

**Purpose**: This guide documents the complete integration contract between the Nil-Wealth Telegram Bot (backend) and Twin.so (workflow orchestration). All features shown in the Telegram dashboard are handled directly by the bot—twin.so's role is to manage lead workflows and trigger webhook notifications at specific stages.

**Last Updated**: March 3, 2026  
**Version**: 1.0  
**Status**: Ready for Implementation

---

## 1. SYSTEM ARCHITECTURE

```
[Twin.so Workflow] 
    ↓ (webhook POST)
[Telegram Bot API Server] ← claims leads/submissions
    ↓ (reads/writes)
[Supabase PostgreSQL - nil schema] ← 22 tables, 7 views
    ↓ (queries)
[Telegram Dashboard] ← displays all data
```

**Key Principle**: The Telegram bot owns the **UI layer and database writes**. Twin.so is the **stateless orchestration layer** that:
- Receives submissions from the bot via `/api/submissions`
- Processes leads through workflows
- Reports back status via webhook calls to `/ops/ingest` and `/webhook/metric`
- Never directly reads/writes database (all state flows through bot API)

---

## 2. DATABASE SCHEMA REFERENCE

Twin.so needs to understand which tables the bot reads/writes. All tables are in PostgreSQL schema `nil`:

### Core Tables Twin.so Will Interact With:

| Table | Purpose | Key Columns | Webhook Trigger |
|-------|---------|-------------|-----------------|
| `nil.submissions` | Lead intake from website | id, first_name, last_name, email, phone, state, role, created_at, n8n_status | POST /api/submissions → INSERT |
| `nil.n8n_outbox` | Workflow queue (renamed from n8n but twin.so compatible) | submission_id, status (queued/processing/completed/failed), next_retry_at, result_json, attempt_count | bot writes; twin.so reads via /api/nil-outbox/claim |
| `nil.conversations` | SMS/email threads | id, submission_id, direction, message_type (sms/email), body, sender_type (lead/bot/rep), created_at | webhook event conversation.updated → /ops/ingest |
| `nil.messages` | Individual SMS/email messages | id, conversation_id, submission_id, body, direction, message_type, created_at | webhook event conversation.message → /ops/ingest |
| `nil.calls` | Phone call tracking | id, submission_id, lead_phone, bot_phone, duration_seconds, outcome (answered/rescheduled/no_answer/did_not_connect), called_at, created_at | webhook event call.completed → /ops/ingest |
| `nil.lead_metrics` | KPI rollup (click counts, call counts, etc.) | submission_id, enroll_clicks, calls_made, calls_answered, open_rate, created_at, updated_at | webhook event metric.updated → /webhook/metric |
| `nil.submissions_view` | **READ THIS INSTEAD** (denormalized view with all fields + pipeline state) | All submission fields + pipeline (urgent/needs_reply/forwarded/completed/active/followups) | View refreshed when bot updates pipeline column |

### Tables Twin.so Does NOT Touch (Bot-Only):
- `nil.message_drafts` (bot composes unsent messages)
- `nil.email_sequences` (bot manages nurture flows)
- `nil.support_tickets` (support inbox separate from campaigns)
- `nil.people` (master contact record, read-only)

### Views (Bot creates/updates):
- `nil.submissions_view` - Denormalized; start here for dashboard reads
- `nil.active_submissions_view` - Only non-completed leads
- `nil.urgent_submissions_view` - Only pipeline='urgent'

---

## 3. API ENDPOINT CONTRACT SPECIFICATION

All endpoints are on the Telegram Bot server. Twin.so must call these URLs with the specified auth headers and request/response formats.

### 3.1 SUBMISSION INTAKE: POST /api/submissions

**Purpose**: Create a lead in the system and queue it for twin.so processing.

**Request**:
```bash
curl -X POST https://{YOUR_BOT_WEBHOOK_URL}/api/submissions \
  -H "Content-Type: application/json" \
  -H "x-nil-secret: {BASE_WEBHOOK_SECRET}" \
  -d '{
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",  # REQUIRED: prevent duplicate submissions
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "phone": "+14045551234",
    "state": "GA",
    "role": "parent",
    "coverage_accident": true,
    "coverage_hospital_indemnity": false,
    "coverage_supplemental_medical": false,
    "source": "facebook_ad",  # OPTIONAL: campaign source
    "note": "Interested in accident coverage"  # OPTIONAL: bot note
  }'
```

**Response (HTTP 200)**:
```json
{
  "ok": true,
  "submission_id": "submissionid_abcdef1234567890",
  "queued": true,
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (HTTP 409 - Duplicate Idempotency Key)**:
```json
{
  "ok": false,
  "error": "Duplicate idempotency_key",
  "existing_submission_id": "submissionid_existing123"
}
```

**Response (HTTP 400 - Missing Required Field)**:
```json
{
  "ok": false,
  "error": "Missing required field: email"
}
```

**Side Effects**:
- Inserts 1 row into `nil.submissions` (n8n_status='queued')
- Inserts 1 row into `nil.n8n_outbox` (status='queued')
- Returns immediately (async; don't wait for processing)

**Notes**:
- `idempotency_key` MUST be UUID v4 or globally unique string
- Email/phone MUST pass basic validation (domain exists, country code valid)
- all_coverage_* fields are optional booleans (default false)
- Duplicate submitter (same email within 24h) → auto-skip, use existing submission_id
- Bot will send initial Telegram card immediately; twin.so processes async

---

### 3.2 OUTBOX CLAIM: GET /api/nil-outbox/claim

**Purpose**: Twin.so claims the next submission from the queue for processing.

**Request**:
```bash
curl -X GET "https://{YOUR_BOT_WEBHOOK_URL}/api/nil-outbox/claim?limit=10" \
  -H "x-nil-secret: {BASE_WEBHOOK_SECRET}"
```

**Response (HTTP 200 - Submissions to process)**:
```json
{
  "ok": true,
  "batch_id": "claim_batch_20260303_abc123",
  "items": [
    {
      "claim_id": "outbox_id_12345",
      "submission_id": "submissionid_xyz789",
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "+14045551234",
      "state": "GA",
      "role": "parent",
      "coverage_accident": true,
      "claimed_at": "2026-03-03T14:22:30.123Z"
    }
  ],
  "count": 1
}
```

**Response (HTTP 200 - No items to process)**:
```json
{
  "ok": true,
  "batch_id": null,
  "items": [],
  "count": 0
}
```

**Side Effects**:
- Marks outbox rows as `status='processing'` (claim lock)
- Records claim in bot memory (timeout after 5 minutes; auto-release if not ack'd)
- Older claims (>5min stale) auto-requeue

**Recommended Polling**:
- Call every 30 seconds
- Process items in this batch before claiming next batch
- If batch_id exists, you own those items; results must go to `/api/nil-outbox/result/{batch_id}`

---

### 3.3 OUTBOX RESULT: POST /api/nil-outbox/result/{batch_id}

**Purpose**: Report results of workflow processing back to the bot.

**Request**:
```bash
curl -X POST "https://{YOUR_BOT_WEBHOOK_URL}/api/nil-outbox/result/{batch_id}" \
  -H "Content-Type: application/json" \
  -H "x-nil-secret: {BASE_WEBHOOK_SECRET}" \
  -d '{
    "results": [
      {
        "claim_id": "outbox_id_12345",
        "submission_id": "submissionid_xyz789",
        "status": "completed",
        "result": {
          "workflow_executed": "Nil-Wealth Accident Coverage Flow",
          "leads_sent_to_sales": true,
          "email_sent": true,
          "sms_sent": true,
          "note": "Triggered outreach sequence; awaiting callback"
        }
      }
    ]
  }'
```

**Response (HTTP 200)**:
```json
{
  "ok": true,
  "updated": 1,
  "batch_id": "claim_batch_20260303_abc123"
}
```

**Response (HTTP 400 - Invalid batch_id)**:
```json
{
  "ok": false,
  "error": "Batch not found or expired"
}
```

**Status Values**:
- `completed` - Workflow ran successfully; bot marks submission as complete
- `failed` - Workflow error; bot retries after 5 minutes (up to 3 times)
- `skipped` - Twin.so skipped this submission (e.g., invalid lead); bot requeues as 'completed'

**Side Effects**:
- Updates corresponding `nil.n8n_outbox` row with result_json
- Webhooks `{ event_type: "outbox.result.completed", submission_id }` to /ops/ingest
- If status='failed': sets `next_retry_at = now + 5 minutes`

---

### 3.4 EVENT WEBHOOK: POST /ops/ingest

**Purpose**: Report real-time lead events (calls, messages, state changes) as they happen in twin.so.

**Request**:
```bash
curl -X POST https://{YOUR_BOT_WEBHOOK_URL}/ops/ingest \
  -H "Content-Type: application/json" \
  -H "x-nil-secret: {BASE_WEBHOOK_SECRET}" \
  -d '{
    "event_type": "submission.call_attempted",
    "submission_id": "submissionid_xyz789",
    "timestamp": "2026-03-03T14:25:15.123Z",
    "metadata": {
      "phone": "+14045551234",
      "duration_seconds": 0,
      "outcome": "no_answer"
    }
  }'
```

**Event Types Twin.so Should Send**:

| Event Type | Metadata | Trigger | Bot Action |
|-----------|----------|---------|-----------|
| `outbox.email.sent` | `{ email, subject, body }` | After email via Instantly.ai | INSERT into conversations; auto-reply detection |
| `outbox.email.opened` | `{ email, timestamp }` | Opens email (tracked by Instantly.ai pixel) | Increment nil.lead_metrics.open_rate |
| `outbox.sms.sent` | `{ phone, body }` | After SMS sent | INSERT into conversations |
| `outbox.sms.delivered` | `{ phone }` | Carrier delivery receipt | mark message as delivered |
| `call.attempted` | `{ phone, outcome: "answered/no_answer/did_not_connect/rescheduled", duration_seconds }` | Dial or receive lead callback | INSERT into calls; update pipeline state |
| `call.scheduled` | `{ phone, scheduled_time (ISO), type: "callback/calendly" }` | Lead booked time slot | Add to followups queue; update pipeline |
| `submission.note_added` | `{ note: "text" }` | Twin.so or sales rep adds note | Append to nil.submissions.notes |
| `submission.forwarded` | `{ forwarded_to: "sales@...", reason: "qualified/callback_failed/..." }` | Sales team claims lead | Update pipeline='forwarded'; trigger CC webhook |
| `submission.replied` | `{ reply_from: "rep@...", body: "..." }` | Rep responds to lead email/SMS | INSERT into conversations; update pipeline to 'active' |
| `metric.enroll_click` | `{ lead_id, timestamp }` | Lead clicks enroll link in email | Increment nil.lead_metrics.enroll_clicks; trigger /webhook/metric |

**Response (HTTP 200)**:
```json
{
  "ok": true,
  "event_id": "evt_20260303_abc123xyz",
  "processed_at": "2026-03-03T14:25:16.000Z"
}
```

**Response (HTTP 400 - Invalid event_type)**:
```json
{
  "ok": false,
  "error": "Unknown event_type: submission.bad_event"
}
```

**Side Effects** (bot processes webhook and updates DB):
- Event inserted into audit log
- Corresponding table row updated (conversations, calls, metrics, etc.)
- If pipeline state changes: bot triggers `refreshLiveCards()` → Telegram dashboard updates
- If urgent SLA triggered: bot sends alert to rep

---

### 3.5 METRIC WEBHOOK: POST /webhook/metric

**Purpose**: Report click-through, enrollment, and other conversion metrics.

**Request**:
```bash
curl -X POST https://{YOUR_BOT_WEBHOOK_URL}/webhook/metric \
  -H "Content-Type: application/json" \
  -H "x-nil-secret: {BASE_WEBHOOK_SECRET}" \
  -d '{
    "event_type": "metric.enroll_click",
    "submission_id": "submissionid_xyz789",
    "timestamp": "2026-03-03T14:30:00.123Z",
    "metric_type": "enroll_click",
    "value": 1
  }'
```

**Supported Metric Types**:
- `enroll_click` - Lead clicked "Enroll Now" link
- `open_rate` - Email opened
- `call_attempted` - Outbound/inbound call attempt
- `call_completed` - Call answered
- `scheduled_callback` - Lead booked callback time
- `converted` - Lead became customer (submit to CRM)

**Response (HTTP 200)**:
```json
{
  "ok": true,
  "metric_id": "metric_20260303_def456",
  "submission_id": "submissionid_xyz789"
}
```

**Side Effects**:
- Aggregates into `nil.lead_metrics.{metric_type}` column
- Recalculates lead scoring (future: AI model integration)
- Triggers dashboard refresh if metric crosses threshold

---

## 4. WEBHOOK AUTHENTICATION

All requests TO the bot must include this header:

```http
x-nil-secret: {VALUE_OF_BASE_WEBHOOK_SECRET}
```

**Where to Find `BASE_WEBHOOK_SECRET`**:
- Telegram Bot `.env` file: `BASE_WEBHOOK_SECRET=xyz123...`
- This is a shared secret; keep it in `.env` on both sides
- Change it only if you suspect compromise; all existing claims/webhooks will fail

**Validation Logic (bot-side)**:
```javascript
const headerSecret = req.headers['x-nil-secret'];
const expected = process.env.BASE_WEBHOOK_SECRET;
if (!headerSecret || headerSecret !== expected) {
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}
```

---

## 5. PIPELINE STATE MACHINE

As submissions flow through twin.so, they transition through these states. The bot manages these automatically based on webhook events.

```
queued (initial)
  ↓
active (twin.so processing started)
  ↓ (depends on twin.so actions)
  ├→ urgent (no reply after 180 minutes; escalate to rep)
  │  └→ needs_reply (rep can manually set; trigger manual outreach)
  │     ├→ forwarded (sent to sales; rep now owns)
  │     └→ completed (rep closed)
  ├→ followups (scheduled callback or nurture sequence)
  │  └→ completed (callback done or sequence finished)
  └→ completed (workflow marked done; don't process further)
```

**Valid Transitions**:
- `queued` → `active` (when /api/nil-outbox/claim returns)
- `active` → `urgent` (after 180 min no activity; set by bot automated SLA)
- `urgent` → `needs_reply` (manual escalation or callback scheduled)
- `needs_reply` → `forwarded` (sent to sales rep)
- `forwarded` → `completed` (rep closed or auto-completed after 7 days)
- Any state → `completed` (early termination)
- Any state → `followups` (callback scheduled or nurture in progress)

**How Twin.so Triggers Transitions**:
1. Send event via `/ops/ingest` with `event_type: "call.scheduled"` → bot sets state to `followups`
2. Send event via `/ops/ingest` with `event_type: "submission.forwarded"` → bot sets state to `forwarded`
3. Send event via `/ops/ingest` with `event_type: "submission.replied"` → bot sets state to `active` (reset timer)
4. Don't send anything for 180 min → bot auto-sets state to `urgent`

---

## 6. FEATURE-BY-FEATURE INTEGRATION POINTS

This section maps each **Telegram dashboard feature** to its corresponding API endpoint and database table.

### Feature: CC Support Mirroring

**What It Does**: All lead emails auto-BCC to support@mynilwealthstrategies.com so support team stays informed.

**Twin.so Integration Points**:
1. When sending email via Instantly.ai, add `support@mynilwealthstrategies.com` to BCC
2. When lead replies, forward to support inbox
3. POST to `/ops/ingest` with event:
   ```json
   {
     "event_type": "outbox.email.sent",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "email": "john@example.com",
       "subject": "Your coverage options",
       "body": "...",
       "cc_support": true
     }
   }
   ```

**Bot Behavior**:
- Stores BCC in nil.conversations.metadata → support team sees it in separate inbox view
- Triggers webhook to CC_SUPPORT_WEBHOOK_URL (optional external CRM notification)

---

### Feature: Reply Tracking

**What It Does**: Dashboard shows "replied" / "needs reply" conversations; alerts rep when lead goes silent.

**Twin.so Integration Points**:
1. Receive lead reply (via email or SMS)
2. POST to `/ops/ingest`:
   ```json
   {
     "event_type": "submission.replied",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "reply_from": "john@example.com",
       "reply_type": "email",
       "body": "Yes, I'm interested. What's the next step?"
     }
   }
   ```

**Bot Behavior**:
- Updates pipeline state from `urgent` → `active` (reset SLA timer)
- Inserts conversation row with sender_type='lead'
- Triggers Telegram alert to rep: "New reply from John Doe"

---

### Feature: Click Tracking (Enroll Links)

**What It Does**: Dashboard shows "# Enrolled" metric = number of leads who clicked "Enroll Now" button.

**Twin.so Integration Points**:
1. Include clickable link in outreach email: `https://{your_domain}/enroll?submission_id=submissionid_xyz789&click_id=unique123`
2. When lead clicks, log it
3. POST to `/webhook/metric`:
   ```json
   {
     "event_type": "metric.enroll_click",
     "submission_id": "submissionid_xyz789",
     "timestamp": "2026-03-03T14:30:00Z",
     "metric_type": "enroll_click"
   }
   ```

**Bot Behavior**:
- Increments `nil.lead_metrics.enroll_clicks` for this submission
- Updates dashboard graph in real-time

---

### Feature: Forwarded Message Queue

**What It Does**: When lead is qualified, rep can "forward" to sales. Dashboard shows forwarded leads separately.

**Twin.so Integration Points**:
1. Sales rep marks lead as qualified
2. Twin.so forwards to sales team CRM/email
3. POST to `/ops/ingest`:
   ```json
   {
     "event_type": "submission.forwarded",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "forwarded_to": "sales@mynilwealthstrategies.com",
       "reason": "high_intent_accident_coverage",
       "note": "Customer called in; wants quote"
     }
   }
   ```

**Bot Behavior**:
- Updates pipeline state to `forwarded`
- Removes from "active" queue in dashboard
- Sends webhook to external CRM via CC_SUPPORT_WEBHOOK_URL (if configured)
- Bot no longer manages this lead (sales team owns it)

---

### Feature: Urgent/Needs-Reply Pipeline

**What It Does**: If lead doesn't reply within 180 minutes, dashboard flags as urgent. Rep can manually escalate to "needs-reply" for manual outreach.

**Twin.so Integration Points**:
1. Submit lead via `/api/submissions` → bot marks as `active`
2. Set timer: if no reply in 180 minutes, bot auto-escalates to `urgent`
3. To manually escalate, POST to `/ops/ingest`:
   ```json
   {
     "event_type": "submission.urgent_escalation",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "reason": "no_response_after_initial_email"
     }
   }
   ```

**Bot Behavior**:
- Dashboard shows urgent leads in red
- Sends instant Telegram alert: "🚨 John Doe (GA, parent) — No reply in 3 hours"
- Suggests follow-up actions (call, SMS, retry email)
- If rep clicks "Send Manual Outreach", bot queues SMS/email to lead

**Configuration (in bot .env)**:
```bash
URGENT_AFTER_MINUTES=180          # minutes before auto-escalation
URGENT_COOLDOWN_HOURS=24          # don't re-escalate same lead within 24h
```

---

### Feature: Call Tracking

**What It Does**: Dashboard shows call history (inbound/outbound), outcome, duration, and auto-routes to callback scheduling.

**Twin.so Integration Points**:
1. When lead is called (outbound via dialer) or calls in (inbound)
2. POST to `/ops/ingest` **after call completes**:
   ```json
   {
     "event_type": "call.attempted",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "phone": "+14045551234",
       "outcome": "answered",
       "duration_seconds": 420,
       "rep_notes": "Customer interested; has 3 kids. Wants quotes for 2.",
       "callback_time": null
     }
   }
   ```

**Valid Outcomes**:
- `answered` - Contact connected; update pipeline to `active`
- `no_answer` - No pickup; auto-trigger urgent escalation after 2nd attempt
- `did_not_connect` - Technical error; retry
- `rescheduled` - Lead booked callback; update pipeline to `followups`

**Alternative Event (if Calendly scheduled callback)**:
```json
{
  "event_type": "call.scheduled",
  "submission_id": "submissionid_xyz789",
  "metadata": {
    "scheduled_time": "2026-03-05T14:00:00Z",
    "type": "callback",
    "calendly_link": "https://calendly.com/..."
  }
}
```

**Bot Behavior**:
- Inserts row into `nil.calls` table
- Updates pipeline: `answered` → `active` | `no_answer` → `urgent` (after 2 attempts) | `rescheduled` → `followups`
- Increments `nil.lead_metrics.calls_made` and `calls_answered` for dashboard KPIs
- Sends Telegram alert: "📞 Call with John Doe — 7 min | Interested | Book callback?"

---

### Feature: Calendly Integration

**What It Does**: Lead can self-book callback time via Calendly link in email. Dashboard shows scheduled callbacks.

**Twin.so Integration Points**:
1. Include Calendly link in outreach email
2. When lead books, Calendly webhook fires (via Zapier/Make.com relay to twin.so)
3. Twin.so sends event to `/ops/ingest`:
   ```json
   {
     "event_type": "call.scheduled",
     "submission_id": "submissionid_xyz789",
     "metadata": {
       "scheduled_time": "2026-03-05T14:00:00-05:00",
       "type": "calendly",
       "calendly_event_uuid": "abc123xyz",
       "lead_confirmed": true
     }
   }
   ```

**Bot Behavior**:
- Updates pipeline to `followups`
- Adds to callback reminder queue
- Sends rep SMS reminder 30 minutes before scheduled time

---

### Feature: Dashboard Live Refresh

**What It Does**: Telegram bot updates dashboard cards every 6 seconds with latest data (new submissions, state changes, calls, etc.).

**Twin.so Integration Points**:
1. After each webhook event is processed, bot auto-refreshes dashboard
2. If you want to trigger immediate refresh (don't wait 6 sec), POST to `/ops/ingest` with:
   ```json
   {
     "event_type": "dashboard.refresh",
     "submission_id": "submissionid_xyz789"
   }
   ```

**Bot Behavior**:
- Queries `nil.submissions_view` for updated pipeline/state
- Recalculates urgency badges, call counts, metrics
- Pushes Telegram message edit to update cards in real-time
- If ENABLE_TELEGRAM_LIVE_REFRESH=false (in .env), skips auto-refresh (but webhooks still work)

---

## 7. COMPLETE INTEGRATION CHECKLIST

Use this checklist to verify twin.so implementation is complete before going live:

### 7.1 Database Connectivity
- [ ] Twin.so can read `nil.submissions_view` (SELECT test query)
- [ ] Twin.so can read `nil.n8n_outbox` table
- [ ] Postgres connection uses same `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as bot
- [ ] Can execute SELECT query returning 5+ results

### 7.2 Submission Intake
- [ ] POST /api/submissions works with valid payload
- [ ] Bot responds with submission_id + queued=true
- [ ] Row appears in `nil.submissions` with n8n_status='queued' within 1 second
- [ ] Row appears in `nil.n8n_outbox` with status='queued' within 1 second
- [ ] Duplicate idempotency_key returns HTTP 409 (not duplicate insert)
- [ ] Invalid email returns HTTP 400 with error message
- [ ] Bot sends Telegram notification to dashboard with new lead

### 7.3 Outbox Claim Loop
- [ ] GET /api/nil-outbox/claim returns submitted items
- [ ] Claimed items marked as status='processing' in DB
- [ ] Same items not returned on next claim (claim lock works)
- [ ] After 5 minutes with no result, items auto-requeue (test by claiming then waiting)
- [ ] Claim batch_id unique per call

### 7.4 Outbox Result Processing
- [ ] POST /api/nil-outbox/result/{batch_id} accepts valid results
- [ ] Result JSON stored in `nil.n8n_outbox.result_json`
- [ ] Status='completed' prevents re-queuing
- [ ] Status='failed' adds next_retry_at timestamp (5 min from now)
- [ ] Webhook event sent to /ops/ingest with event_type='outbox.result.completed'

### 7.5 Authentication
- [ ] All requests include x-nil-secret header (remove to test rejection)
- [ ] Requests without secret get HTTP 401
- [ ] Requests with wrong secret get HTTP 401
- [ ] Correct secret gets HTTP 200

### 7.6 Event Webhook (Email/SMS/Calls)
- [ ] POST /ops/ingest accepts all event_type values from Section 3.4
- [ ] Event processed and row inserted into correct table
  - outbox.email.sent → nil.conversations + nil.messages
  - call.attempted → nil.calls
  - submission.replied → nil.conversations (direction=inbound)
  - metric.enroll_click → nil.lead_metrics (increment enroll_clicks)
- [ ] Event with invalid event_type returns HTTP 400
- [ ] Pipeline state transitions correctly (reply → active, call.no_answer → urgent, etc.)
- [ ] Telegram dashboard updates within 1 second

### 7.7 Metric Webhook
- [ ] POST /webhook/metric accepts metric.enroll_click
- [ ] Click count increments in `nil.lead_metrics.enroll_clicks`
- [ ] Dashboard KPI graph updates

### 7.8 Pipeline State Machine
- [ ] New submissions start in pipeline='queued'
- [ ] After claim+result, change to pipeline='active'
- [ ] 180 minutes with no reply sets pipeline='urgent' (auto by bot)
- [ ] call.attempted with outcome='answered' sets pipeline='active'
- [ ] call.scheduled or calendly event sets pipeline='followups'
- [ ] submission.forwarded sets pipeline='forwarded'
- [ ] rep manual action sets pipeline='completed'

### 7.9 CC Support Integration
- [ ] When sending email, add support@mynilwealthstrategies.com to BCC
- [ ] Email sent event includes cc_support=true
- [ ] Support inbox sees BCC'd messages in separate view (verify manually in Gmail)

### 7.10 Urgent Escalation
- [ ] Lead remains in pipeline='active' for first 180 minutes (check URGENT_AFTER_MINUTES env var)
- [ ] After 180 minutes with no reply event, auto-escalates to pipeline='urgent'
- [ ] Telegram alert sent to rep: "🚨 [Name] — No reply for 3 hours"
- [ ] Rep can manually set to pipeline='needs_reply' to trigger resend

### 7.11 Call Tracking
- [ ] Call event inserts row into `nil.calls` table
- [ ] call.answered increments calls_answered in metrics
- [ ] call.no_answer (2nd time) triggers urgent escalation
- [ ] call.scheduled updates pipeline to followups
- [ ] Dashboard shows call duration, outcome, rep notes

### 7.12 End-to-End Flow (Critical Smoke Test)
1. Submit lead via POST /api/submissions
2. Verify in Telegram dashboard: new card appears
3. Poll GET /api/nil-outbox/claim → get submission back
4. POST /api/nil-outbox/result with status=completed
5. Verify in DB: `nil.submissions.n8n_status = 'completed'`
6. Send event POST /ops/ingest with event_type=outbox.email.sent
7. Verify in Telegram: card updates with email status
8. Send call event POST /ops/ingest with call.attempted (outcome='answered')
9. Verify: `nil.calls` row exists, metrics updated, pipeline='active'
10. Wait 181 minutes OR manually POST event submission.urgent_escalation
11. Verify: pipeline='urgent', Telegram alert sent

---

## 8. SAMPLE IMPLEMENTATION PSEUDOCODE

This is **not** production code, but shows the flow twin.so should follow:

```javascript
// Twin.so Worker (pseudocode for reference)

const BOT_URL = "https://your-telegram-bot-domain.com";
const BOT_SECRET = process.env.BASE_WEBHOOK_SECRET;

// 1. POLL FOR SUBMISSIONS
async function pollAndProcess() {
  try {
    const claimRes = await fetch(`${BOT_URL}/api/nil-outbox/claim?limit=10`, {
      method: "GET",
      headers: { "x-nil-secret": BOT_SECRET }
    });
    const { items, batch_id } = await claimRes.json();
    
    if (items.length === 0) {
      console.log("No items to process");
      return;
    }

    // 2. PROCESS EACH SUBMISSION (YOUR WORKFLOW LOGIC HERE)
    const results = [];
    for (const item of items) {
      try {
        // Sample: send email via Instantly.ai
        await instantly.sendEmail({
          to: item.email,
          template: "accident-cover-flow",
          variables: { name: item.first_name }
        });

        // 3. REPORT EMAIL SENT BACK TO BOT
        await fetch(`${BOT_URL}/ops/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-nil-secret": BOT_SECRET
          },
          body: JSON.stringify({
            event_type: "outbox.email.sent",
            submission_id: item.submission_id,
            timestamp: new Date().toISOString(),
            metadata: { email: item.email, subject: "Your coverage options" }
          })
        });

        results.push({
          claim_id: item.claim_id,
          submission_id: item.submission_id,
          status: "completed",
          result: { workflow_executed: "Accident Cover Flow", email_sent: true }
        });
      } catch (err) {
        console.error(`Error processing ${item.submission_id}:`, err);
        results.push({
          claim_id: item.claim_id,
          submission_id: item.submission_id,
          status: "failed",
          result: { error: err.message }
        });
      }
    }

    // 4. REPORT ALL RESULTS BACK
    await fetch(`${BOT_URL}/api/nil-outbox/result/${batch_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nil-secret": BOT_SECRET
      },
      body: JSON.stringify({ results })
    });

    console.log(`Processed ${results.length} submissions`);
  } catch (err) {
    console.error("Poll error:", err);
  }
}

// Run every 30 seconds
setInterval(pollAndProcess, 30000);
```

---

## 9. DEBUGGING CHECKLIST

If integrations aren't working:

### Issue: "Submission not appearing in dashboard"
- [ ] Check HTTP 200 response from POST /api/submissions (not 400/500)
- [ ] Query DB: `SELECT * FROM nil.submissions WHERE email='...'` → row exists?
- [ ] Check bot logs for errors during POST
- [ ] Verify bot is connected to Supabase (test query: `SELECT 1 FROM nil.submissions LIMIT 1`)

### Issue: "Outbox claim returns empty"
- [ ] Check DB: `SELECT * FROM nil.n8n_outbox WHERE status='queued'` → rows exist?
- [ ] Verify x-nil-secret header in claim request
- [ ] Check bot logs for claim endpoint errors

### Issue: "Event webhook not updating DB"
- [ ] Verify x-nil-secret header in event POST
- [ ] Check HTTP response code (200 = accepted, 400 = bad event_type, 401 = auth)
- [ ] Query DB for event effect: did `nil.conversations` row get inserted?
- [ ] Check bot logs: `console.log` for event processing

### Issue: "Pipeline state not changing"
- [ ] Verify event_type is valid (see Section 3.4 Event Types table)
- [ ] Confirm submission_id exists in nil.submissions
- [ ] Check bot logs for state transition logic
- [ ] Manually query DB: `SELECT submission_id, pipeline FROM nil.submissions WHERE submission_id='...'`

### Issue: "Telegram dashboard not refreshing"
- [ ] Check bot .env: `ENABLE_TELEGRAM_LIVE_REFRESH=true` (or remove for default true)
- [ ] If false, refresh only happens on webhook events (not auto-refresh loop)
- [ ] Check Telegram connection: bot should be running and connected to @BotFather token

### Issue: "Auth failures (401 errors)"
- [ ] Verify x-nil-secret header is **exactly** the string from bot .env
- [ ] No extra spaces or quotes around secret
- [ ] Use `echo $BASE_WEBHOOK_SECRET` to print actual value if debugging

---

## 10. DEPLOYMENT STEPS

1. **Review this document** with your development team
2. **Update .env** in twin.so with:
   ```bash
   BOT_WEBHOOK_URL=https://{your-bot-domain}/
   BOT_SECRET={BASE_WEBHOOK_SECRET from telegram bot .env}
   ```
3. **Implement the 4 API clients**:
   - POST /api/submissions (submit lead)
   - GET /api/nil-outbox/claim (poll for work)
   - POST /api/nil-outbox/result (report results)
   - POST /ops/ingest (send events)
4. **Test in Staging**:
   - Run 7.12 End-to-End test above (local or staging bot URL)
   - Verify all 12 checklist items pass before deploying to production
5. **Enable Telegram Bot** (in bot .env):
   ```bash
   ENABLE_TELEGRAM_BOT=true
   ENABLE_TELEGRAM_LIVE_REFRESH=true  # or false if you want quiet mode
   ```
6. **Launch Bot**:
   ```bash
   cd /path/to/nil-wealth-telegram-shell
   set -a; source .env; set +a
   node src/index.js
   ```
   Expected output: `Bot running: Index.js V5.5`

7. **Launch Twin.so** workflows
8. **Monitor Dashboard** for 1-2 hours:
   - New submissions appearing
   - Pipeline state transitions working
   - Telegram alerts firing correctly
9. **Go Live**: Direct website form traffic to submission endpoint

---

## 11. SUPPORT & CONTACT

**Questions about this integration?**
- Review the codebase at `/Users/dr3wmcconnell/Desktop/nil-wealth-telegram-shell/src/index.js` (lines 5800-6150 for endpoint logic)
- Search for function names: `app.post("/api/submissions")`, `app.get("/api/nil-outbox/claim")`, `app.post("/ops/ingest")`
- Check database schema: [COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql)

**Common Configuration**:
- Bot port: 3000 (configurable via PORT env var)
- Database schema: `nil` (hardcoded in bot)
- Webhook timeout: 30 seconds (return within this time or webhook auto-fails)
- Outbox claim timeout: 5 minutes (claimed items auto-requeue if no result sent)

**Version History**:
- v1.0 (2026-03-03): Initial release for twin.so integration

---

**Ready to integrate? Start with Section 7 (Checklist) and work through each item systematically.**
