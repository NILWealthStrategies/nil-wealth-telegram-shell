# Complete System Integration Overview: Twin.so + Telegram Bot

**Date**: March 4, 2026  
**Purpose**: Map Twin.so's current configuration to Nil-Wealth's complete system  
**Status**: Comprehensive guide for full integration

---

## What Twin.so Has vs. What's Still Missing

### ✅ Twin.so HAS Configured

From their "Instantly Reply Monitor" agent:

| Component | Status | Details |
|-----------|--------|---------|
| Instantly.ai API polling | ✅ DONE | Polls campaign 57ebe130-68e3-4ee0-bde8-a60c090ef176 every 15 min |
| Reply detection | ✅ DONE | Finds email replies from coaches |
| Database inserts | ✅ DONE | Creates processed_emails, run_log, nil.conversations rows |
| Lead lookup | ✅ DONE | Matches sender to lead_pool via email |
| Metric event creation | ✅ DONE | Inserts into nil.metric_events |
| /ops/ingest webhook | ✅ DONE | POSTs reply events to bot |
| Conversation card upsert | ✅ DONE | Updates dashboard display |

### ❌ Twin.so MISSING

| Component | Required For | Implementation |
|-----------|--------------|-----------------|
| `/api/submissions` client | Website form intake | HTTP POST to bot with form data |
| `/api/nil-outbox/claim` polling | Outreach queue | GET endpoints every 30 sec |
| Instantly.ai send | Initial outreach | Send email to prospect with campaign template |
| `/api/nil-outbox/result` | Completion reporting | POST results of sends |
| Gmail support monitoring | Support inbox replies | Poll support@mynilwealthstrategies.com every 5 min |
| Call event creation | Call tracking | POST `/ops/ingest` with call.attempted |
| Calendar/callback scheduling | Callback booking | POST `/ops/ingest` with call.scheduled |

---

## What Telegram Bot Needs to Support All Features

### 🔧 Required Environment Variables (Currently Missing)

Update your `.env` in [nil-wealth-telegram-shell](nil-wealth-telegram-shell/.env):

```bash
# ✅ ALREADY HAVE
TELEGRAM_BOT_TOKEN=7950661012:AAH...
ADMIN_TELEGRAM_IDS=7810862886
BASE_WEBHOOK_SECRET=nil_wealth_ops_secure_2026
SUPABASE_URL=https://bjyxaprcdbwougewbauw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
PORT=3000

# ❌ NEED TO ADD
MAKE_SEND_WEBHOOK_URL=https://REPLACE_WITH_TWIN_SO_SEND_WEBHOOK
CC_SUPPORT_WEBHOOK_URL=https://REPLACE_WITH_CC_WEBHOOK
ENABLE_TELEGRAM_BOT=true                    # Launch bot (false = API-only)
ENABLE_TELEGRAM_LIVE_REFRESH=true           # Auto-refresh cards (false = quiet mode)
URGENT_AFTER_MINUTES=180                    # Auto-escalate after 3 hours
URGENT_COOLDOWN_HOURS=24                    # Don't re-escalate same lead within 24h

# OPTIONAL (for future integrations)
CALENDLY_API_KEY=your-calendly-api-key     # If using Calendly direct
TWILIO_ACCOUNT_SID=your-twilio-sid          # If using Twilio for SMS
TWILIO_AUTH_TOKEN=your-twilio-token
TWILIO_PHONE_NUMBER=+1234567890
```

### 📋 Database Schema Requirements

The bot expects these tables (all created by `COMPLETE_SUPABASE_SCHEMA.sql`):

**Must Exist**:
- `nil.submissions` - Lead records
- `nil.n8n_outbox` - Work queue for Twin.so
- `nil.conversations` - Email/SMS threads
- `nil.messages` - Individual message records
- `nil.calls` - Call history
- `nil.lead_metrics` - KPI aggregation
- `nil.submissions_view` - Denormalized view for bot queries

**Optional (for advanced features)**:
- `nil.email_sequences` - Nurture flows
- `nil.message_drafts` - Unsent message queue

---

## Feature-by-Feature: What Needs to Work

### Feature 1: Website Form → Submission Queue

**Flow**:
```
Website Form (contact form, signup page)
    ↓
POST /api/submissions (from website backend or Twin.so)
    ↓
Bot creates:
  - nil.submissions row (first_name, last_name, email, phone, state, role, coverage_*)
  - nil.n8n_outbox row (status='queued')
    ↓
Bot sends Telegram card: "NEW LEAD: John Doe (GA, parent) - Waiting for response"
    ↓
Twin.so claims via GET /api/nil-outbox/claim
    ↓
Twin.so sends email via Instantly.ai
    ↓
Twin.so POSTs /ops/ingest: { event_type: "outbox.email.sent" }
    ↓
Bot updates card: "EMAIL SENT: Waiting for reply..."
```

**What Twin.so Must Implement**:
- [ ] Endpoint: `POST /api/submissions` with full form data
- [ ] Polling: `GET /api/nil-outbox/claim` every 30 sec
- [ ] Sending: Send email via Instantly.ai campaign
- [ ] Reporting: `POST /api/nil-outbox/result/{batch_id}` with status

**What Bot Provides** (already coded):
- ✅ `/api/submissions` endpoint (line 5920 in index.js)
- ✅ Submission queuing to nil.n8n_outbox
- ✅ Telegram notification card
- ✅ `/api/nil-outbox/claim` endpoint (line 6050 in index.js)
- ✅ `/api/nil-outbox/result` endpoint (line 6090 in index.js)
- ✅ Dashboard card updates on events

---

### Feature 2: Email Reply Detection → Conversation Thread

**Flow**:
```
Coach receives email from Twin.so (via Instantly.ai)
    ↓
Coach replies to Instantly.ai campaign
    ↓
Twin.so polls Instantly.ai API every 15 min
    ↓
Twin.so detects reply
    ↓
Twin.so POSTs /ops/ingest:
{
  "event_type": "outbox.email.received",
  "submission_id": "submissionid_xyz789",
  "metadata": { "from": "coach@gmail.com", "body": "Yes, I'm interested!" }
}
    ↓
Bot updates nil.conversations (new message with direction=inbound)
Bot updates pipeline: "urgent" → "active" (resets SLA timer)
Bot updates Telegram card: "REPLY RECEIVED: Coach said 'Yes, I'm interested!'"
Bot auto-BCC's support@mynilwealthstrategies.com (CC Support feature)
Bot sends Telegram alert: "New reply from John Doe - Active now"
```

**What Twin.so Must Implement**:
- ✅ ALREADY DONE: "Instantly Reply Monitor" polls and detects replies
- [ ] Still need: POST `/ops/ingest` with correct event_type + metadata
- [ ] Gmail support inbox monitoring (separate workflow) for support@... replies

**What Bot Provides** (already coded):
- ✅ `/ops/ingest` endpoint (line 5800 in index.js)
- ✅ Conversation row creation + message insertion
- ✅ Pipeline state transition (urgent → active, reset timer)
- ✅ Auto-BCC to support (line 2590 in index.js)
- ✅ Telegram alert with reply preview
- ✅ Dashboard card live update

---

### Feature 3: Urgent Escalation (SLA Timeout)

**Flow**:
```
Lead submitted at: 2:00 PM
Bot marks pipeline: "active"
    ↓
Timer: 180 minutes (3 hours) with NO REPLY event
    ↓
Bot auto-escalates at: 5:00 PM
Bot updates pipeline: "urgent"
Bot sends Telegram alert: "🚨 URGENT: John Doe (GA, parent) — No reply for 3 hours"
Bot color-codes card RED in dashboard
Rep clicks "Send Manual Outreach" or "Call"
```

**What Twin.so Must Implement**:
- [ ] Send "reply received" event within 180 minutes OR lead auto-escalates
- [ ] If calling lead, POST `/ops/ingest` with `event_type: "call.attempted"` + outcome

**What Bot Provides** (already coded):
- ✅ SLA timer logic (line 701 in index.js)
- ✅ Auto-escalation to pipeline='urgent' (line 752 in index.js)
- ✅ Telegram alert with urgency badge
- ✅ Config vars: URGENT_AFTER_MINUTES=180, URGENT_COOLDOWN_HOURS=24

---

### Feature 4: Call Tracking → Pipeline State Updates

**Flow**:
```
Rep initiates call to lead (via phone system, dialpad, etc.)
Call completes
    ↓
Rep logs outcome (via external system or bot button)
    ↓
Twin.so (or rep's call system) POSTs /ops/ingest:
{
  "event_type": "call.attempted",
  "submission_id": "submissionid_xyz789",
  "metadata": {
    "phone": "+14045551234",
    "outcome": "answered",  // or no_answer, did_not_connect, rescheduled
    "duration_seconds": 420,
    "rep_notes": "Qualified, wants quote"
  }
}
    ↓
Bot inserts into nil.calls table
Bot updates pipeline based on outcome:
  - answered → "active"
  - no_answer (2nd attempt) → "urgent"
  - rescheduled → "followups"
Bot increments nil.lead_metrics.calls_made + calls_answered
Bot sends Telegram alert: "📞 Call logged: 7 min | ANSWERED | Active"
```

**What Twin.so Must Implement**:
- [ ] Create `/ops/ingest` event posting for call.attempted with outcome

**What Bot Provides** (already coded):
- ✅ `/ops/ingest` event routing for call.attempted (line 5881 in index.js)
- ✅ nil.calls table insertion (line 4696 in index.js)
- ✅ Pipeline state transitions (answered→active, no_answer→urgent)
- ✅ Metrics increment (line 3171 in index.js)
- ✅ Telegram alert with call details

---

### Feature 5: Callback Scheduling (Calendly / Self-Book)

**Flow**:
```
Lead receives email with Calendly link
    ↓
Lead clicks link and books callback
    ↓
Calendly webhook fires (via Zapier/Make.com relay to Twin.so)
    ↓
Twin.so POSTs /ops/ingest:
{
  "event_type": "call.scheduled",
  "submission_id": "submissionid_xyz789",
  "metadata": {
    "scheduled_time": "2026-03-05T14:00:00Z",
    "type": "calendly",
    "calendly_event_uuid": "abc123xyz"
  }
}
    ↓
Bot updates pipeline: "followups"
Bot adds to callback reminder queue
Bot sends Telegram reminder 30 min before (SMS or app alert)
Bot updates card: "CALLBACK SCHEDULED: Wed 2:00 PM ET"
```

**What Twin.so Must Implement**:
- [ ] Relay Calendly webhook to `/ops/ingest` with event_type="call.scheduled"

**What Bot Provides** (already coded):
- ✅ `/ops/ingest` routing for call.scheduled (line 5881 in index.js)
- ✅ Pipeline update to "followups" (line 2082 in index.js)
- ✅ Reminder queue logic (line 1469 in index.js)
- ✅ Telegram reminder notifications

---

### Feature 6: Click Tracking → Metrics

**Flow**:
```
Lead receives outreach email with link:
"https://mynilwealthstrategies.com/enroll?submission_id=xyz&click_id=unique"
    ↓
Lead clicks "Enroll Now" button
    ↓
Website backend POSTs metric webhook or Twin.so logs it:
POST /webhook/metric
{
  "event_type": "metric.enroll_click",
  "submission_id": "submissionid_xyz789",
  "metric_type": "enroll_click",
  "timestamp": "2026-03-04T..."
}
    ↓
Bot increments nil.lead_metrics.enroll_clicks
Bot updates dashboard KPI graph: "Enrolled: 5"
```

**What Twin.so Must Implement**:
- [ ] Website link tracking backend (your website, not Twin.so's job)
- [ ] OR: Twin.so tracks via Instantly.ai email open tracking

**What Bot Provides** (already coded):
- ✅ `/webhook/metric` endpoint (line 5904 in index.js)
- ✅ Metrics table updates (line 3241 in index.js)
- ✅ Dashboard KPI display

---

### Feature 7: Forward to Sales → Remove from Active Queue

**Flow**:
```
Rep qualifies lead as sales-ready
    ↓
Rep clicks "Forward to Sales" button
    ↓
Twin.so (or bot) POSTs /ops/ingest:
{
  "event_type": "submission.forwarded",
  "submission_id": "submissionid_xyz789",
  "metadata": {
    "forwarded_to": "sales@mynilwealthstrategies.com",
    "reason": "high_intent_accident_coverage",
    "note": "Called, wants quote"
  }
}
    ↓
Bot updates pipeline: "forwarded"
Bot removes from "Active" dashboard section
Bot sends Telegram notification: "Lead forwarded to sales team"
Bot webhooks to external CRM (via CC_SUPPORT_WEBHOOK_URL if configured)
```

**What Twin.so Must Implement**:
- [ ] Create `/ops/ingest` event for forwarding (likely bot button, not Twin.so)

**What Bot Provides** (already coded):
- ✅ `/ops/ingest` routing for submission.forwarded (line 5870 in index.js)
- ✅ Pipeline update to "forwarded" (line 2082 in index.js)
- ✅ Dashboard filtering/removal
- ✅ CC_SUPPORT_WEBHOOK_URL integration (line 2594 in index.js)

---

### Feature 8: CC Support Mirroring → Automatic

**How It Works**:
1. Whenever a reply is detected (from Instantly or Gmail), bot auto-BCC's support
2. Bot stores conversation info with cc_support=true flag
3. Support team sees BCC'd copy in their inbox
4. If support replies, bot detects it as well (via Gmail monitor)

**Prerequisites**:
- Support Gmail account configured: support@mynilwealthstrategies.com
- Bot has permission to send/receive on that email
- Twin.so implements Gmail support monitoring (Feature 2 above)

**What Twin.so Must Implement**:
- [ ] Gmail support inbox monitoring workflow (separate from Instantly monitoring)
- [ ] Match support replies back to submission via sender email

**What Bot Provides** (already coded):
- ✅ Auto-BCC logic on reply detection (line 2535 in index.js)
- ✅ Conversation metadata storage (cc_support flag)
- ✅ Support inbox view in dashboard

---

### Feature 9: Dashboard Live Refresh (6-second Updates)

**How It Works**:
```
Any event POST to /ops/ingest
    ↓
Bot updates database
    ↓
Bot updates all Telegram cards in real-time
    ↓ (also: every 6 seconds anyway)
Dashboard shows latest pipeline state, metrics, calls, replies
```

**Control**:
- `ENABLE_TELEGRAM_LIVE_REFRESH=true` → Auto-refresh dashboard every 6 sec
- `ENABLE_TELEGRAM_LIVE_REFRESH=false` → Only refresh on webhook events (quiet mode)

**What Twin.so Must Implement**:
- [ ] Just POST events to `/ops/ingest` — bot handles refresh

**What Bot Provides** (already coded):
- ✅ Auto-refresh loop (line 5527 in index.js)
- ✅ Telegram card updates (line 5600+ in index.js)
- ✅ Environment toggle (ENABLE_TELEGRAM_LIVE_REFRESH)

---

## Complete Data Model: What Twin.so Must Know

### nil.submissions (Lead Master Record)

```json
{
  "submission_id": "submissionid_xyz789",
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "phone": "+14045551234",
  "state": "GA",
  "role": "parent",
  "coverage_accident": true,
  "coverage_hospital_indemnity": false,
  "coverage_supplemental_medical": false,
  "n8n_status": "queued|completed|failed",
  "pipeline": "queued|active|urgent|needs_reply|forwarded|followups|completed",
  "created_at": "2026-03-04T12:00:00Z",
  "updated_at": "2026-03-04T15:30:00Z",
  "notes": "Called, wants quote"
}
```

### nil.n8n_outbox (Work Queue)

```json
{
  "submission_id": "submissionid_xyz789",
  "claim_id": "outbox_id_12345",
  "status": "queued|processing|completed|failed",
  "attempt_count": 1,
  "next_retry_at": "2026-03-04T16:00:00Z",
  "result_json": {
    "workflow_executed": "Accident Coverage Flow",
    "email_sent": true,
    "note": "..."
  }
}
```

### nil.conversations (Email/SMS Threads)

```json
{
  "conversation_id": "conv_abc123",
  "submission_id": "submissionid_xyz789",
  "direction": "outbound|inbound",
  "message_type": "email|sms",
  "subject": "Your coverage options",
  "body": "Here's what we recommend...",
  "sender_type": "bot|rep|lead",
  "normalized_email": "john@example.com",
  "cc_support": true,
  "created_at": "2026-03-04T12:30:00Z"
}
```

### nil.calls (Call History)

```json
{
  "call_id": "call_xyz123",
  "submission_id": "submissionid_xyz789",
  "lead_phone": "+14045551234",
  "outcome": "answered|no_answer|did_not_connect|rescheduled",
  "duration_seconds": 420,
  "rep_notes": "Qualified, wants quote",
  "called_at": "2026-03-04T14:00:00Z"
}
```

### nil.lead_metrics (KPI Aggregation)

```json
{
  "metric_id": "metric_xyz123",
  "submission_id": "submissionid_xyz789",
  "enroll_clicks": 1,
  "calls_made": 2,
  "calls_answered": 1,
  "open_rate": 0.5,
  "updated_at": "2026-03-04T15:30:00Z"
}
```

---

## Implementation Roadmap for Twin.so

### Phase 1 (Week 1): Website Form → Outreach

```
[ ] 1a. Create /api/submissions client (POST to bot)
[ ] 1b. Create /api/nil-outbox/claim poller (GET every 30 sec)
[ ] 1c. Send email via Instantly.ai
[ ] 1d. Create /api/nil-outbox/result reporter (POST batch completion)
[ ] TEST: End-to-end form → email → dashboard
```

### Phase 2 (Week 2): Instantly Reply Monitoring

```
✅ 2a. Poll Instantly.ai for replies (DONE)
✅ 2b. Create nil.conversations rows (DONE)
✅ 2c. Update nil.lead_metrics (DONE)
[ ] 2d. POST /ops/ingest events (VERIFY WORKING)
[ ] TEST: Reply detection → dashboard update
```

### Phase 3 (Week 3): Support Inbox Monitoring

```
[ ] 3a. Set up Gmail API access for support@mynilwealthstrategies.com
[ ] 3b. Create polling workflow (every 5 min)
[ ] 3c. Match sender email to submission_id (DB lookup)
[ ] 3d. POST /ops/ingest for support replies
[ ] 3e. Mark emails as read (no re-processing)
[ ] TEST: Support reply → dashboard update → CC thread
```

### Phase 4 (Week 4): Call Tracking + Calendly

```
[ ] 4a. Create call logging workflow
[ ] 4b. POST /ops/ingest for call.attempted + outcomes
[ ] 4c. Relay Calendly webhooks to /ops/ingest (call.scheduled)
[ ] 4d. Test reminder notifications
[ ] TEST: Call → pipeline transition → followups
```

### Phase 5 (Week 5+): Verification & Optimization

```
[ ] Run TWIN_SO_INTEGRATION_VERIFY.sh (all 12 tests must pass)
[ ] Load test: 100+ concurrent leads
[ ] Verify SLA timers (urgent escalation)
[ ] Verify metrics aggregation accuracy
[ ] Performance tuning (polling frequency, batch sizes)
```

---

## Telegram Bot Configuration Checklist

Before launching bot, ensure:

### Environment Variables
- [ ] TELEGRAM_BOT_TOKEN=your_token
- [ ] ADMIN_TELEGRAM_IDS=your_id
- [ ] BASE_WEBHOOK_SECRET=your_secret
- [ ] SUPABASE_URL=correct
- [ ] SUPABASE_SERVICE_ROLE_KEY=correct
- [ ] MAKE_SEND_WEBHOOK_URL=set to real Twin.so URL
- [ ] CC_SUPPORT_WEBHOOK_URL=set (or leave empty for stub)
- [ ] ENABLE_TELEGRAM_BOT=true
- [ ] ENABLE_TELEGRAM_LIVE_REFRESH=true
- [ ] URGENT_AFTER_MINUTES=180
- [ ] URGENT_COOLDOWN_HOURS=24

### Database
- [ ] Run COMPLETE_SUPABASE_SCHEMA.sql in Supabase
- [ ] Verify all 22 tables exist in `nil` schema
- [ ] Verify 7 views created

### Bot Launch
```bash
cd /Users/dr3wmcconnell/Desktop/nil-wealth-telegram-shell
set -a; source .env; set +a
node src/index.js
```

Expected output:
```
Bot running: Index.js V5.5
Webhook server listening on 0.0.0.0:3000
```

### Test
```bash
curl -X POST http://localhost:3000/api/submissions \
  -H "Content-Type: application/json" \
  -H "x-nil-secret: nil_wealth_ops_secure_2026" \
  -d '{"idempotency_key":"test-uuid","first_name":"John","last_name":"Doe","email":"john@test.com","phone":"+14045551234","state":"GA","role":"parent","coverage_accident":true}'
```

Should return: `{ ok: true, submission_id: "...", queued: true }`

---

## Summary: ALL Required Pieces

| System | Component | Status | Owner | Deadline |
|--------|-----------|--------|-------|----------|
| **Website** | Contact form | ❌ NOT configured | You / web team | Week 1 |
| **Bot** | /api/submissions endpoint | ✅ CODED | Bot (index.js) | Ready now |
| **Bot** | Telegram dashboard | ✅ CODED | Bot (index.js) | Ready now |
| **Bot** | /ops/ingest event routing | ✅ CODED | Bot (index.js) | Ready now |
| **Bot** | Auto-refresh cards | ✅ CODED | Bot (index.js) | Ready now |
| **Bot** | SLA urgent escalation | ✅ CODED | Bot (index.js) | Ready now |
| **Twin.so** | /api/submissions client | ❌ MISSING | Twin.so | Week 1 |
| **Twin.so** | Outbox claim loop | ❌ MISSING | Twin.so | Week 1 |
| **Twin.so** | Outreach email sending | ❌ MISSING | Twin.so | Week 1 |
| **Twin.so** | Outbox result reporting | ❌ MISSING | Twin.so | Week 1 |
| **Twin.so** | Instantly reply monitor | ✅ DONE | Twin.so | Complete |
| **Twin.so** | Gmail support inbox monitor | ❌ MISSING | Twin.so | Week 3 |
| **Twin.so** | Call event creation | ❌ MISSING | Twin.so | Week 4 |
| **Twin.so** | Calendly relay | ❌ MISSING | Twin.so | Week 4 |
| **DB** | Schema (22 tables) | ✅ DEPLOYED | Supabase | Ready now |
| **Config** | .env variables | ⚠️ PARTIAL | You | NOW - add webhooks |

---

## Files to Share with Twin.so

Send them these files:
1. [TWIN_SO_INTEGRATION_GUIDE.md](./TWIN_SO_INTEGRATION_GUIDE.md) — Full API contract
2. [TWIN_SO_CLARIFICATION_ANSWERS.md](./TWIN_SO_CLARIFICATION_ANSWERS.md) — Answers to their questions
3. [TWIN_SO_QUICK_REFERENCE.txt](./TWIN_SO_QUICK_REFERENCE.txt) — Quick lookup
4. [TWIN_SO_INTEGRATION_VERIFY.sh](./TWIN_SO_INTEGRATION_VERIFY.sh) — Test script
5. [COMPLETE_SUPABASE_SCHEMA.sql](./COMPLETE_SUPABASE_SCHEMA.sql) — Database schema
6. **THIS DOCUMENT** ([COMPLETE_SYSTEM_INTEGRATION_OVERVIEW.md](./COMPLETE_SYSTEM_INTEGRATION_OVERVIEW.md)) — Everything tied together

---

## Next Steps for You

1. **Update .env NOW**:
   ```bash
   # Edit .env add/update these:
   MAKE_SEND_WEBHOOK_URL=https://your-twin-so-send-webhook
   CC_SUPPORT_WEBHOOK_URL=https://your-cc-webhook-or-leave-empty
   ENABLE_TELEGRAM_BOT=true
   ENABLE_TELEGRAM_LIVE_REFRESH=true
   ```

2. **Launch Bot**:
   ```bash
   cd /Users/dr3wmcconnell/Desktop/nil-wealth-telegram-shell
   set -a; source .env; set +a
   node src/index.js &
   ```

3. **Send to Twin.so**:
   - All 6 files above
   - This roadmap
   - Ask them to start with Phase 1 + Phase 2

4. **Website Integration**:
   - Point your contact form to: `POST https://bot-domain/api/submissions`
   - Include all required fields (first_name, last_name, email, phone, state, role, coverage_*)
   - Include unique idempotency_key to prevent duplicates

---

**Once all pieces are in place, you'll have:**
- ✅ Website form → database
- ✅ Automatic email outreach (Instantly.ai)
- ✅ Reply detection + conversation threads
- ✅ Support email mirroring (CC)
- ✅ Call tracking + metrics
- ✅ Urgent escalation (SLA)
- ✅ Callback scheduling (Calendly)
- ✅ Real-time Telegram dashboard
- ✅ Full pipeline state management (queued → active → urgent → forwarded → completed)
