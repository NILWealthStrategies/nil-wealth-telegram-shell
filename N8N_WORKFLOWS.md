# n8n Workflow Reference

Complete n8n workflow configurations for nil-wealth Telegram bot integrations.

---

## Table of Contents

### Legacy Workflows (Manual Setup)
1. [Vercel Form Submissions](#1-vercel-form-submissions)
2. [Email to Conversation](#2-email-to-conversation)
3. [Email Outbox Processor](#3-email-outbox-processor)
4. [SMS Outbox Processor](#4-sms-outbox-processor)
5. [Metric Event Tracking](#5-metric-event-tracking)
6. [Call Scheduler](#6-call-scheduler)

### Complete Automation System (Import-Ready JSONs)
7. [Lead Generation (Apify + Hunter.io)](#7-lead-generation-apify--hunterio)
8. [Email Outreach (Instantly.ai + ChatGPT)](#8-email-outreach-instantlyai--chatgpt)
9. [Support Handler (Instantly.ai Replies)](#9-support-handler-instantlyai-replies)

---

## 1. Vercel Form Submissions

**Trigger:** Webhook receives Vercel form data  
**Action:** Insert into `nil.submissions`  
**Frequency:** On-demand (form submission)

### Workflow Nodes

#### Node 1: Webhook Trigger
- **Type**: Webhook
- **Method**: POST
- **Path**: `/vercel-submission`
- **Response**: `{ "success": true }`

#### Node 2: Supabase Insert
- **Type**: Supabase
- **Operation**: Insert
- **Schema**: `nil`
- **Table**: `submissions`
- **Fields**:
  ```json
  {
    "submission_id": "={{ $json.body.submissionId || $json.body.id }}",
    "client_id": "={{ $json.body.clientId }}",
    "athlete_name": "={{ $json.body.athleteName }}",
    "state": "={{ $json.body.state }}",
    "coverage_accident": "={{ $json.body.coverageAccident }}",
    "coverage_hospital_indemnity": "={{ $json.body.coverageHospitalIndemnity }}",
    "coverage_type": "={{ $json.body.coverageType }}",
    "coach_id": "={{ $json.body.coachId }}",
    "coach_name": "={{ $json.body.coachName }}",
    "pool_label": "={{ $json.body.poolLabel }}",
    "submission_payload": "={{ $json.body }}"
  }
  ```

### Test Payload
```bash
curl -X POST https://your-n8n.app.n8n.cloud/webhook/vercel-submission \
  -H "Content-Type: application/json" \
  -d '{
    "submissionId": "sub-12345",
    "clientId": "client-abc",
    "athleteName": "John Athlete",
    "state": "California",
    "coverageAccident": "100000",
    "coverageHospitalIndemnity": "50000",
    "coverageType": "comprehensive",
    "coachId": "coach-xyz",
    "coachName": "Coach Smith",
    "poolLabel": "Pool A"
  }'
```

---

## 2. Email to Conversation

**Trigger:** Email received (Gmail, IMAP, etc.)  
**Action:** Upsert conversation, insert message  
**Frequency:** Real-time (via Gmail webhook) or polling (every 1 min)

### Workflow Nodes

#### Node 1: Gmail Trigger
- **Type**: Gmail Trigger
- **Event**: Message Received
- **Filters**: From specific domains or labels

#### Node 2: Supabase Upsert Conversation
- **Type**: Supabase
- **Operation**: Upsert
- **Schema**: `nil`
- **Table**: `conversations`
- **Conflict Target**: `thread_key`
- **Fields**:
  ```json
  {
    "thread_key": "={{ $json.threadId }}",
    "contact_email": "={{ $json.from.split('<')[1]?.replace('>', '') || $json.from }}",
    "subject": "={{ $json.subject }}",
    "preview": "={{ $json.snippet || $json.textPlain?.substring(0, 200) }}",
    "pipeline": "needs_reply",
    "source": "support",
    "gmail_url": "=https://mail.google.com/mail/u/0/#inbox/{{ $json.id }}",
    "updated_at": "={{ $now }}"
  }
  ```

#### Node 3: Get Inserted Conversation ID
- **Type**: Code
- **Code**:
  ```javascript
  const conversationId = $input.first().json.id;
  return [{ json: { conversationId, ...items[0].json } }];
  ```

#### Node 4: Supabase Insert Message
- **Type**: Supabase
- **Operation**: Insert
- **Schema**: `nil`
- **Table**: `messages`
- **Fields**:
  ```json
  {
    "conversation_id": "={{ $json.conversationId }}",
    "direction": "inbound",
    "from_email": "={{ $('Gmail Trigger').item.json.from }}",
    "to_email": "={{ $('Gmail Trigger').item.json.to }}",
    "subject": "={{ $('Gmail Trigger').item.json.subject }}",
    "body": "={{ $('Gmail Trigger').item.json.textPlain || $('Gmail Trigger').item.json.textHtml }}",
    "preview": "={{ $('Gmail Trigger').item.json.snippet }}"
  }
  ```

---

## 3. Email Outbox Processor

**Trigger:** Schedule (every 1 minute)  
**Action:** Query queued emails, send via Gmail/SMTP, mark as sent  
**Frequency:** Every 1 minute

### Workflow Nodes

#### Node 1: Schedule Trigger
- **Type**: Schedule Trigger
- **Interval**: Every 1 minute

#### Node 2: Supabase Query Queued
- **Type**: Supabase
- **Operation**: Get Many
- **Schema**: `nil`
- **Table**: `email_outbox`
- **Filters**:
  - `status` = `queued`
- **Limit**: 10
- **Order**: `created_at ASC`

#### Node 3: Check If Empty
- **Type**: IF
- **Condition**: `={{ $json.length > 0 }}`
- **True**: Continue to Node 4
- **False**: Stop

#### Node 4: Loop Over Emails
- **Type**: Loop Over Items
- **Expression**: `={{ $json }}`

#### Node 5: Send Email (Gmail)
- **Type**: Gmail
- **Operation**: Send Email
- **Fields**:
  ```json
  {
    "to": "={{ $json.to }}",
    "subject": "={{ $json.subject }}",
    "message": "={{ $json.html }}",
    "cc": "={{ $json.cc }}",
    "bcc": "={{ $json.bcc }}"
  }
  ```

#### Node 6: Supabase Update Status
- **Type**: Supabase
- **Operation**: Update
- **Schema**: `nil`
- **Table**: `email_outbox`
- **Filter**: `id` = `={{ $('Loop Over Emails').item.json.id }}`
- **Fields**:
  ```json
  {
    "status": "sent",
    "sent_at": "={{ $now }}"
  }
  ```

#### Node 7: Error Handler (Optional)
- **Type**: Supabase Update
- **Trigger**: On Gmail error
- **Fields**:
  ```json
  {
    "status": "error",
    "error_message": "={{ $json.error.message }}"
  }
  ```

---

## 4. SMS Outbox Processor

**Trigger:** Schedule (every 1 minute)  
**Action:** Query queued SMS, send via Twilio, mark as sent  
**Frequency:** Every 1 minute

### Workflow Nodes

#### Node 1: Schedule Trigger
- **Type**: Schedule Trigger
- **Interval**: Every 1 minute

#### Node 2: Supabase Query Queued
- **Type**: Supabase
- **Operation**: Get Many
- **Schema**: `nil`
- **Table**: `sms_outbox`
- **Filters**:
  - `status` = `queued`
- **Limit**: 10

#### Node 3: Check If Empty
- **Type**: IF
- **Condition**: `={{ $json.length > 0 }}`

#### Node 4: Loop Over SMS
- **Type**: Loop Over Items

#### Node 5: Send SMS (Twilio)
- **Type**: Twilio
- **Operation**: Send SMS
- **Fields**:
  ```json
  {
    "to": "={{ $json.to }}",
    "message": "={{ $json.text }}",
    "from": "+1234567890"
  }
  ```

#### Node 6: Supabase Update Status
- **Type**: Supabase
- **Operation**: Update
- **Schema**: `nil`
- **Table**: `sms_outbox`
- **Filter**: `id` = `={{ $('Loop Over SMS').item.json.id }}`
- **Fields**:
  ```json
  {
    "status": "sent",
    "sent_at": "={{ $now }}"
  }
  ```

---

## 5. Metric Event Tracking

**Trigger:** Webhook receives metric event  
**Action:** Insert into `nil.metric_events`  
**Frequency:** On-demand (user action)

### Workflow Nodes

#### Node 1: Webhook Trigger
- **Type**: Webhook
- **Method**: POST
- **Path**: `/metric-event`

#### Node 2: Supabase Insert
- **Type**: Supabase
- **Operation**: Insert
- **Schema**: `nil`
- **Table**: `metric_events`
- **Fields**:
  ```json
  {
    "event_type": "={{ $json.body.event_type }}",
    "source": "={{ $json.body.source || 'default' }}",
    "data": "={{ $json.body.data || {} }}"
  }
  ```

### Test Payloads

#### Program Link Open
```bash
curl -X POST https://your-n8n.app.n8n.cloud/webhook/metric-event \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "program_link_open",
    "source": "programs",
    "data": {
      "coach_id": "coach-123",
      "link_url": "https://example.com/program"
    }
  }'
```

#### Coverage Exploration
```bash
curl -X POST https://your-n8n.app.n8n.cloud/webhook/metric-event \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "coverage_exploration",
    "source": "support",
    "data": {
      "client_id": "client-456",
      "coverage_type": "accident"
    }
  }'
```

#### Enrollment Click
```bash
curl -X POST https://your-n8n.app.n8n.cloud/webhook/metric-event \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "enroll_click",
    "source": "programs",
    "data": {
      "coach_id": "coach-789"
    }
  }'
```

---

## 6. Call Scheduler

**Trigger:** Webhook receives call scheduling request  
**Action:** Insert into `nil.calls`  
**Frequency:** On-demand (call scheduled)

### Workflow Nodes

#### Node 1: Webhook Trigger
- **Type**: Webhook
- **Method**: POST
- **Path**: `/schedule-call`

#### Node 2: Supabase Insert
- **Type**: Supabase
- **Operation**: Insert
- **Schema**: `nil`
- **Table**: `calls`
- **Fields**:
  ```json
  {
    "call_id": "={{ $json.body.callId || 'call-' + $now.toUnixInteger() }}",
    "client_name": "={{ $json.body.clientName }}",
    "client_id": "={{ $json.body.clientId }}",
    "scheduled_at": "={{ $json.body.scheduledAt }}",
    "source": "={{ $json.body.source || 'default' }}",
    "outcome": "scheduled"
  }
  ```

### Test Payload
```bash
curl -X POST https://your-n8n.app.n8n.cloud/webhook/schedule-call \
  -H "Content-Type: application/json" \
  -d '{
    "callId": "call-12345",
    "clientName": "John Athlete",
    "clientId": "client-abc",
    "scheduledAt": "2026-02-27T14:00:00Z",
    "source": "programs"
  }'
```

---

## Environment Variables

Add to n8n credentials:

### Supabase Credentials
- **Name**: `nil-wealth-supabase`
- **URL**: `https://xxxxx.supabase.co`
- **Key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (service_role key)

### Gmail Credentials (if using Gmail)
- **Name**: `gmail-account`
- **Auth**: OAuth2
- **Scopes**: `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/gmail.readonly`

### Twilio Credentials (if using SMS)
- **Name**: `twilio-account`
- **Account SID**: From Twilio dashboard
- **Auth Token**: From Twilio dashboard

---

## Testing Workflows

### 1. Test Vercel Form Workflow
```bash
# Test with curl
curl -X POST https://your-n8n.app.n8n.cloud/webhook/vercel-submission \
  -H "Content-Type: application/json" \
  -d '{"submissionId": "test-1", "athleteName": "Test Athlete"}'

# Check in Supabase
SELECT * FROM nil.submissions WHERE submission_id = 'test-1';

# Check in Telegram Bot
/dashboard → All Queues → Submissions → Should see "Test Athlete"
```

### 2. Test Email Outbox Workflow
```javascript
// In Telegram bot, simulate queuing an email
// This requires the bot code to have a test command, or manually insert:
INSERT INTO nil.email_outbox ("to", subject, html, status)
VALUES ('test@example.com', 'Test Email', '<p>Hello World</p>', 'queued');

// Wait 1 minute for n8n to pick it up
// Check status updated to 'sent':
SELECT * FROM nil.email_outbox WHERE "to" = 'test@example.com';
```

### 3. Test Metric Tracking
```bash
# Send test metric
curl -X POST https://your-n8n.app.n8n.cloud/webhook/metric-event \
  -H "Content-Type: application/json" \
  -d '{"event_type": "test_event", "source": "test"}'

# Check in Supabase
SELECT * FROM nil.metric_events WHERE event_type = 'test_event';

# Check in Bot
/dashboard → Metrics → Should see count increment
```

---

## Troubleshooting

### Webhook not receiving data
1. Check n8n workflow is **Active** (toggle at top)
2. Check webhook URL is correct (Test URL tab)
3. Test with curl command from above
4. Check n8n execution log (Executions tab)

### Supabase insert failing
1. Check schema is set to `nil` (not `public`)
2. Check table name matches exactly (case-sensitive)
3. Check RLS policies allow insert (or disable RLS for testing)
4. Check field names match (use `"to"` with quotes for reserved keywords)

### Email/SMS not sending
1. Check credentials are set up correctly
2. Check Gmail/Twilio API limits not exceeded
3. Check error handler logs in n8n
4. Verify status updated to `error` with error message
5. Check `error_message` field in outbox table

### Bot not showing new data
1. Check data exists in Supabase: `SELECT * FROM nil.submissions;`
2. Check bot schema function: `const ops = () => supabase.schema("nil");`
3. Test bot query directly in Supabase: `SELECT * FROM nil.v_search;`
4. Check bot error logs in Render dashboard

---

## Production Checklist

- [ ] All 6 workflows created and **Active**
- [ ] Supabase credentials added with `service_role` key
- [ ] Gmail/Twilio credentials added and tested
- [ ] All webhook URLs updated in Vercel/frontend code
- [ ] Test each workflow with production data
- [ ] Monitor n8n executions for first 24 hours
- [ ] Set up error alerts (n8n → Slack/Email on failure)
- [ ] Document webhook URLs in team wiki

---

## Workflow Import/Export

To share workflows with team:
1. Open workflow in n8n
2. Click **...** menu → **Export**
3. Save JSON file
4. Share with team or commit to repo
5. Import: **...** menu → **Import from File**

---

## 7. Lead Generation (Apify + Hunter.io)

**Import File**: `n8n-lead-generation-workflow.json`  
**Trigger**: Daily at 9 AM  
**Action**: Scrape leads with Apify → Find emails with Hunter.io → Store in `nil.leads`  
**Frequency**: Once per day

### How It Works

1. **Apify Scrapes Leads**: Searches for athletic directors, coaches, administrators
2. **Waits for Results**: 2-minute wait for scraping to complete
3. **Fetches Data**: Gets scraped leads from Apify dataset
4. **Loops Through Each Lead**: Processes one at a time
5. **Hunter.io Email Finding**: Finds professional email addresses
6. **Enriches Lead Data**: Adds email, confidence score, verification status
7. **Stores in Supabase**: Inserts into `nil.leads` table
8. **Telegram Notification**: Summary with total leads, emails found, confidence scores

### Import Instructions

```bash
# 1. Import workflow into n8n
# Go to n8n → Create workflow from file → Select n8n-lead-generation-workflow.json

# 2. Set environment variables in n8n Settings → Environment
APIFY_API_TOKEN=your_apify_token_here
APIFY_ACTOR_ID=your_actor_id  # e.g., apify/google-search-scraper
HUNTER_IO_API_KEY=your_hunter_io_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# 3. Configure Supabase credential
# In workflow → Click any Supabase node → Credentials → Create New
# Name: Supabase NIL Wealth
# Enter SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

# 4. Activate workflow
# Toggle "Active" at top of workflow

# 5. Test manually
# Click "Test workflow" button to run immediately
```

### Telegram Bot Integration

After workflow runs, your Telegram bot will display leads in:
- `/dashboard` → **Leads** card (shows total leads, new today, with emails)
- `/leads` → View all leads with filters
- Lead data automatically synced via shared Supabase database

---

## 8. Email Outreach (Instantly.ai + ChatGPT)

**Import File**: `n8n-email-outreach-workflow.json`  
**Trigger**: Every 4 hours  
**Action**: Get ready leads → Add to Instantly campaign → Instantly handles all sending/follow-ups → Track sequences  
**Frequency**: 6 times per day (every 4 hours)

### How It Works

1. **Queries Ready Leads**: Gets up to 20 leads with `status='ready'` and valid emails
2. **Loops Through Leads**: Processes one at a time
3. **Adds to Instantly Campaign**: Sends lead to Instantly.ai outreach campaign
4. **Instantly Sends Sequence**: All copy, cadence, and follow-ups are managed inside Instantly.ai
5. **Tracks Sequence**: Inserts email sequence record in `nil.email_sequences`
6. **Updates Lead Status**: Changes status to `outreach_started`
7. **Logs Metrics**: Records email sent in `nil.lead_metrics`
8. **Telegram Notification**: Batch summary with total emails sent

### Import Instructions

```bash
# 1. Import workflow into n8n
# Go to n8n → Create workflow from file → Select n8n-email-outreach-workflow.json

# 2. Set environment variables
INSTANTLY_API_KEY=MzAyNDRmZWQtMTk1ZC00OTAyLWJkNjgtN2Q4ZDJmMzg4YTIyOkl4ZERIWlhQc1d6VQ==
INSTANTLY_OUTREACH_CAMPAIGN_ID=your_campaign_id  # Dedicated outreach campaign (not support inbox)
OPENAI_API_KEY=sk-your_openai_key_here
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# 3. Configure credentials
# - Supabase: Same as Lead Generation workflow
# - OpenAI: Create HTTP Header Auth credential with:
#   Name: Authorization
#   Value: Bearer sk-your_openai_key

# 4. Activate workflow
# Toggle "Active" at top

# 5. Test manually
# First ensure you have leads with status='ready' in nil.leads table:
SELECT * FROM nil.leads WHERE status = 'ready' LIMIT 5;
# Then click "Test workflow"
```

### Instantly.ai Setup

1. **Create Campaign**:
   - Log in to Instantly.ai
   - Create new campaign: "NIL Athletic Directors Outreach"
   - Copy Campaign ID from URL (appears after `/campaign/`)
  - Set `INSTANTLY_OUTREACH_CAMPAIGN_ID` environment variable

2. **Get API Key**:
   - Go to Settings → API & Integrations
   - Copy API key (already provided: `MzAyNDRmZWQtMTk1ZC00OTAyLWJkNjgtN2Q4ZDJmMzg4YTIyOkl4ZERIWlhQc1d6VQ==`)

3. **Configure Email Sequence in Instantly**:
   - Email 1: Intro (sent via n8n with custom intro)
   - Email 2: Social proof (automatically sent by Instantly after 2 days)
   - Email 3: Value proposition (automatically sent after 4 days)
   - Email 4: Urgency (automatically sent after 7 days)
   - Email 5: Breakup (automatically sent after 10 days)

### Telegram Bot Integration

After workflow runs, your Telegram bot shows:
- `/dashboard` → **Email Outreach** card (emails sent today, open rate, reply rate)
- `/sequences` → View all email sequences with status
- `/metrics` → Detailed performance metrics

---

## 9. Support Handler (Instantly.ai Replies)

**Import File**: `n8n-support-handler-workflow.json`  
**Trigger**: Every 15 minutes  
**Action**: Check Instantly.ai for replies → Create support tickets → Update leads → Notify Telegram  
**Frequency**: 96 times per day (every 15 minutes)

### How It Works

1. **Polls Instantly.ai**: Gets campaign email analytics
2. **Filters Recent Replies**: Only processes replies from last 24 hours
3. **Loops Through Replies**: Processes one at a time
4. **Finds Lead in Database**: Matches email to lead in `nil.leads`
5. **Creates Support Ticket**: Inserts into `nil.support_tickets`
6. **Updates Lead Status**: Changes status to `replied`
7. **Logs Reply Metric**: Records in `nil.lead_metrics`
8. **Telegram Alert**: Real-time notification with lead details and message preview

### Import Instructions

```bash
# 1. Import workflow into n8n
# Go to n8n → Create workflow from file → Select n8n-support-handler-workflow.json

# 2. Set environment variables (same as Email Outreach)
INSTANTLY_API_KEY=MzAyNDRmZWQtMTk1ZC00OTAyLWJkNjgtN2Q4ZDJmMzg4YTIyOkl4ZERIWlhQc1d6VQ==
INSTANTLY_OUTREACH_CAMPAIGN_ID=your_campaign_id
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# 3. Configure Supabase credential (same as other workflows)

# 4. Activate workflow
# Toggle "Active" at top

# 5. Test manually
# Send a test reply in Instantly.ai campaign
# Wait 15 minutes or click "Test workflow"
# Check Telegram for notification
```

### Telegram Bot Integration

When someone replies to your outreach:
- **Instant Telegram Alert**: Shows lead name, email, organization, message preview
- `/support` → View all support tickets
- `/dashboard` → **Support** card (new tickets, pending, resolved)
- Bot replies: "✅ Support ticket created. Check /support to respond"

### Reply Handling Workflow

```
1. Lead replies to Instantly.ai email
2. n8n detects reply within 15 minutes
3. Support ticket created automatically
4. Telegram alert sent to you
5. You respond via /support command in bot
6. Lead status updated throughout process
```

---

## Complete Automation System Overview

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     COMPLETE NIL AUTOMATION                      │
└─────────────────────────────────────────────────────────────────┘

1. LEAD GENERATION (Daily 9 AM)
   ┌──────────┐      ┌──────────────┐      ┌──────────────┐
   │  Apify   │─────▶│  Hunter.io   │─────▶│  nil.leads   │
   │ Scraper  │      │ Email Finder │      │   (Ready)    │
   └──────────┘      └──────────────┘      └──────────────┘
                                                    │
                                                    ▼
2. EMAIL OUTREACH (Every 4 hours)                   │
   ┌──────────────┐   ┌──────────────┐   ┌────────▼───────┐
   │   ChatGPT    │──▶│ Instantly.ai │──▶│ nil.email_     │
   │ Personalize  │   │  Campaign    │   │ sequences      │
   └──────────────┘   └──────────────┘   └────────────────┘
                             │
                             ▼
3. SUPPORT HANDLING (Every 15 min)
   ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
   │ Instantly.ai │──▶│   Process    │──▶│ nil.support_   │
   │   Replies    │   │    Reply     │   │   tickets      │
   └──────────────┘   └──────────────┘   └────────────────┘
                                                    │
                                                    ▼
4. TELEGRAM BOT (Real-time)
   ┌──────────────────────────────────────────────────────┐
   │  /dashboard → View all metrics & cards               │
   │  /leads → Manage leads                                │
   │  /sequences → Track email sequences                   │
   │  /support → Respond to replies                        │
   │  /metrics → Detailed analytics                        │
   └──────────────────────────────────────────────────────┘
```

### Database Schema (Shared Between n8n & Telegram Bot)

All workflows write to `nil` schema in Supabase:

```sql
-- Leads from Apify + Hunter.io
nil.leads (id, full_name, email, phone, organization, title, state, status, source, email_confidence, raw_data)

-- Email sequences from Instantly.ai
nil.email_sequences (id, lead_id, sequence_number, email_type, subject, body, status, sent_at, opened_at, clicked_at, replied_at)

-- Support tickets from replies
nil.support_tickets (id, lead_id, contact_name, contact_email, subject, message, source, status, priority, assigned_to, resolved_at)

-- Performance metrics
nil.lead_metrics (id, lead_id, metric_type, metric_value, metadata, recorded_at)
```

### Environment Variables Reference

**Required for all 3 workflows:**

```bash
# Instantly.ai (Email Outreach + Support)
INSTANTLY_API_KEY=MzAyNDRmZWQtMTk1ZC00OTAyLWJkNjgtN2Q4ZDJmMzg4YTIyOkl4ZERIWlhQc1d6VQ==
INSTANTLY_OUTREACH_CAMPAIGN_ID=your_campaign_id

# Apify (Lead Generation)
APIFY_API_TOKEN=your_apify_token
APIFY_ACTOR_ID=apify/google-search-scraper  # or your preferred scraper

# Hunter.io (Lead Generation)
HUNTER_IO_API_KEY=your_hunter_io_key

# OpenAI (Email Personalization)
OPENAI_API_KEY=sk-your_openai_key

# Telegram (All notifications)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Supabase (Database for all workflows)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_key
```

### Setup Order (Complete System)

1. **Run SQL migrations** (from COMPLETE_AUTOMATION_GUIDE.md):
   ```sql
   -- Creates nil.leads, nil.email_sequences, nil.support_tickets, nil.lead_metrics
   ```

2. **Import 3 workflows** into n8n:
   - `n8n-lead-generation-workflow.json`
   - `n8n-email-outreach-workflow.json`
   - `n8n-support-handler-workflow.json`

3. **Set environment variables** in n8n Settings → Environment (see above)

4. **Configure Instantly.ai**:
   - Create campaign
   - Set up 5-email sequence
   - Copy Campaign ID

5. **Activate all 3 workflows** in n8n

6. **Test each workflow manually**:
   - Lead Generation: Click "Test workflow", check Telegram for summary
   - Email Outreach: Ensure leads with `status='ready'` exist, test workflow
   - Support Handler: Send test reply in Instantly, wait 15 min

7. **Monitor Telegram bot**:
   - Type `/dashboard` to see all cards update in real-time
   - Check notifications for each workflow execution

---

## Troubleshooting Complete Automation

### Lead Generation Issues

**No leads scraped:**
- Check Apify Actor ID is correct
- Verify Apify API token has credits remaining
- Check Apify execution log for errors
- Test search query manually in Apify console

**No emails found:**
- Hunter.io API key may be invalid or out of credits
- Check lead domains are valid (needs proper `.edu` or `.org` domain)
- Lower confidence threshold if needed

### Email Outreach Issues

**No leads picked up:**
- Check leads exist with `status='ready'` and non-null `email`:
  ```sql
  SELECT COUNT(*) FROM nil.leads WHERE status='ready' AND email IS NOT NULL;
  ```
- Verify workflow schedule is active

**Instantly.ai errors:**
- Campaign ID must match exactly
- API key format: base64 encoded (already provided)
- Check daily sending limits in Instantly dashboard

**ChatGPT errors:**
- OpenAI API key must start with `sk-`
- Check API credits/billing
- HTTP Header Auth credential format: `Authorization: Bearer sk-...`

### Support Handler Issues

**No replies detected:**
- Replies must be in Instantly.ai campaign (check campaign analytics)
- Workflow checks last 24 hours only
- Instantly.ai may delay reply sync (can take 5-15 minutes)

**Duplicate tickets:**
- Workflow filters recent replies to avoid duplicates
- If issue persists, add unique constraint to `support_tickets.lead_id`

### Telegram Notifications Not Sending

**Check bot configuration:**
```bash
# Test Telegram bot token
curl https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe

# Test sending message
curl -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  -d "text=Test from n8n workflows"
```

**Common issues:**
- `TELEGRAM_CHAT_ID` must be numeric (your personal chat ID or group ID)
- Bot must be started (send `/start` in Telegram before workflows can message you)
- Check n8n execution log for HTTP 403/400 errors

---

## Production Checklist (Complete System)

- [ ] All 3 workflows imported and **Active**
- [ ] All environment variables set in n8n
- [ ] Supabase credential configured with `service_role` key
- [ ] OpenAI HTTP Header Auth credential created
- [ ] Instantly.ai campaign created with 5-email sequence
- [ ] SQL migrations executed (4 tables created)
- [ ] Telegram bot tested (receives notifications)
- [ ] Lead Generation workflow tested manually
- [ ] Email Outreach workflow tested with sample lead
- [ ] Support Handler workflow tested with sample reply
- [ ] Monitor executions for first 24 hours
- [ ] Set up error alerts (n8n → Telegram on failure)
- [ ] Document Campaign ID and API keys in secure location

---

## Support

- **n8n Docs**: https://docs.n8n.io
- **Supabase Docs**: https://supabase.com/docs
- **Bot Code**: [src/index.js](src/index.js)
- **Schema**: [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql)
