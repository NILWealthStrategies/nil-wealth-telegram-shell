# n8n Workflow Reference

Complete n8n workflow configurations for nil-wealth Telegram bot integrations.

---

## Table of Contents
1. [Vercel Form Submissions](#1-vercel-form-submissions)
2. [Email to Conversation](#2-email-to-conversation)
3. [Email Outbox Processor](#3-email-outbox-processor)
4. [SMS Outbox Processor](#4-sms-outbox-processor)
5. [Metric Event Tracking](#5-metric-event-tracking)
6. [Call Scheduler](#6-call-scheduler)

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

## Support

- **n8n Docs**: https://docs.n8n.io
- **Supabase Docs**: https://supabase.com/docs
- **Bot Code**: [src/index.js](src/index.js)
- **Schema**: [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql)
