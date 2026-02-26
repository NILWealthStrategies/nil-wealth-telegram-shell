# Deployment Guide: Telegram Bot + Supabase + n8n + Vercel

## Overview
Complete deployment instructions for the nil-wealth Telegram bot with integrations.

---

## 1. Database Setup (Supabase)

### Step 1: Run SQL Schema
1. Open Supabase Dashboard → SQL Editor
2. Copy entire contents of `SUPABASE_SCHEMA.sql`
3. Paste and execute
4. Verify creation:
   - **13 Tables**: conversations, people, submissions, calls, messages, coaches, metric_events, email_outbox, sms_outbox, card_mirrors, message_drafts, dead_letters, ops_events
   - **5 Views**: v_search, v_triage_due_now, v_conversations_card, v_coach_followups_due_now, v_calls_card

### Step 2: Get Credentials
```bash
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## 2. Bot Deployment (Render)

### Step 1: Environment Variables
Set in Render dashboard:
```bash
TELEGRAM_BOT_TOKEN=7123456789:AAH...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJhbG...
PORT=3000
NODE_ENV=production
```

### Step 2: Deploy Code
```bash
git push origin main
# Render auto-deploys from GitHub
```

### Step 3: Verify Bot
1. Open Telegram
2. Message your bot: `/dashboard`
3. Should see dashboard with all buttons working

---

## 3. n8n Webhook Integration

### Use Case 1: Vercel Form → Submissions
When someone submits a form on your Vercel website, n8n receives it and stores in Supabase.

**n8n Workflow:**
```
Webhook Trigger → Transform Data → Supabase Insert
```

**Webhook URL:**
```
https://your-n8n.com/webhook/vercel-submission
```

**Supabase Insert Node Configuration:**
- **Table**: `submissions`
- **Schema**: `nil`
- **Fields to Insert**:
  ```json
  {
    "submission_id": "{{ $json.submissionId }}",
    "client_id": "{{ $json.clientId }}",
    "athlete_name": "{{ $json.athleteName }}",
    "state": "{{ $json.state }}",
    "coverage_accident": "{{ $json.coverageAccident }}",
    "coverage_hospital_indemnity": "{{ $json.coverageHospitalIndemnity }}",
    "coverage_type": "{{ $json.coverageType }}",
    "coach_id": "{{ $json.coachId }}",
    "coach_name": "{{ $json.coachName }}",
    "pool_label": "{{ $json.poolLabel }}",
    "submission_payload": {{ $json }}
  }
  ```

**Vercel Form Setup:**
Add to your form submission handler:
```javascript
// pages/api/submit.js
export default async function handler(req, res) {
  if (req.method === 'POST') {
    const formData = req.body;
    
    // Forward to n8n webhook
    await fetch('https://your-n8n.com/webhook/vercel-submission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    
    res.status(200).json({ success: true });
  }
}
```

---

### Use Case 2: Email Received → Conversation
When an email arrives (via Gmail API, IMAP, etc.), n8n creates a conversation + message.

**n8n Workflow:**
```
Email Trigger → Extract Data → Upsert Conversation → Insert Message
```

**Supabase Upsert Conversation:**
- **Table**: `conversations`
- **Schema**: `nil`
- **Conflict Target**: `thread_key`
- **Fields**:
  ```json
  {
    "thread_key": "{{ $json.threadId }}",
    "contact_email": "{{ $json.from }}",
    "subject": "{{ $json.subject }}",
    "preview": "{{ $json.preview }}",
    "pipeline": "needs_reply",
    "source": "email",
    "updated_at": "{{ $now }}"
  }
  ```

**Supabase Insert Message:**
- **Table**: `messages`
- **Schema**: `nil`
- **Fields**:
  ```json
  {
    "conversation_id": "{{ $json.conversations[0].id }}",
    "direction": "inbound",
    "from_email": "{{ $json.from }}",
    "to_email": "{{ $json.to }}",
    "subject": "{{ $json.subject }}",
    "body": "{{ $json.body }}",
    "preview": "{{ $json.preview }}"
  }
  ```

---

### Use Case 3: Send Queued Emails
Bot queues emails in `nil.email_outbox`, n8n polls and sends them.

**n8n Workflow:**
```
Schedule Trigger (every 1 min) → Supabase Query → Loop Send → Update Status
```

**Supabase Query Configuration:**
- **Table**: `email_outbox`
- **Schema**: `nil`
- **Filters**: `status` = `queued`
- **Limit**: 10
- **Order**: `created_at ASC`

**Send Email Node:**
- Use Gmail, SendGrid, or SMTP node
- Map fields:
  - To: `{{ $json.to }}`
  - Subject: `{{ $json.subject }}`
  - HTML: `{{ $json.html }}`
  - CC: `{{ $json.cc }}`
  - BCC: `{{ $json.bcc }}`

**Update Status Node:**
- **Table**: `email_outbox`
- **Schema**: `nil`
- **Update Where**: `id` = `{{ $json.id }}`
- **Fields**:
  ```json
  {
    "status": "sent",
    "sent_at": "{{ $now }}"
  }
  ```

---

### Use Case 4: Track Metrics
When users click links, visit pages, n8n logs to `metric_events`.

**n8n Workflow:**
```
Webhook Trigger → Supabase Insert
```

**Example Webhook Payloads:**
```json
// Program link opened
{
  "event_type": "program_link_open",
  "source": "programs",
  "data": { "coach_id": "coach-123", "link_url": "https://..." }
}

// Coverage explored
{
  "event_type": "coverage_exploration",
  "source": "support",
  "data": { "client_id": "client-456", "coverage_type": "accident" }
}

// Enrollment clicked
{
  "event_type": "enroll_click",
  "source": "programs",
  "data": { "coach_id": "coach-123" }
}
```

**Supabase Insert:**
- **Table**: `metric_events`
- **Schema**: `nil`
- **Fields**: Map all payload fields directly

---

## 4. Schema Reference

### Core Data Flow
```
Vercel Form → n8n → nil.submissions → Telegram Bot displays
Email Received → n8n → nil.conversations + nil.messages → Bot shows thread
Bot queues email → nil.email_outbox → n8n polls & sends
User clicks link → n8n → nil.metric_events → Bot shows in metrics card
```

### Key Tables & Their Purpose

| Table | Purpose | Written By | Read By |
|-------|---------|-----------|---------|
| `conversations` | Email threads, tickets | n8n, Bot | Bot |
| `people` | Contact directory | n8n, Bot | Bot |
| `submissions` | Website form data | n8n | Bot |
| `calls` | Scheduled calls | n8n, Bot | Bot |
| `messages` | Email/message content | n8n, Bot | Bot |
| `coaches` | Coach profiles | Bot, Manual | Bot |
| `metric_events` | Analytics | n8n | Bot |
| `email_outbox` | Queued emails | Bot | n8n (sends), Bot |
| `sms_outbox` | Queued SMS | Bot | n8n (sends), Bot |
| `card_mirrors` | Linked cards | Bot | Bot |
| `message_drafts` | Saved drafts | Bot | Bot |
| `dead_letters` | Error queue | Bot | Bot (debugging) |
| `ops_events` | Event ledger | Bot | Bot (audit log) |

---

## 5. Testing Checklist

### Database Setup
- [ ] All 13 tables exist in `nil` schema
- [ ] All 5 views exist in `nil` schema
- [ ] Can query: `SELECT * FROM nil.conversations LIMIT 1;`

### Bot Functionality
- [ ] `/dashboard` loads without errors
- [ ] All filter buttons work (All, Support, Programs)
- [ ] Queue views load (Triage, Completed, etc.)
- [ ] Card detail views open correctly
- [ ] Error messages display (not blank screens)

### n8n Integration
- [ ] Vercel submission webhook creates record in `nil.submissions`
- [ ] Email webhook creates conversation + message
- [ ] Queued email polling workflow runs every minute
- [ ] Metric tracking webhook logs to `nil.metric_events`

### Vercel Forms
- [ ] Form submission triggers n8n webhook
- [ ] Data appears in Bot dashboard within 30 seconds
- [ ] JSONB payload stores complete form data

---

## 6. Troubleshooting

### "Relation does not exist" errors
**Problem**: Tables not created in correct schema  
**Fix**: Re-run `SUPABASE_SCHEMA.sql` in Supabase SQL Editor

### Bot buttons show errors
**Problem**: Views missing (v_conversations_card, v_coach_followups_due_now, v_calls_card)  
**Fix**: Views are in schema file, ensure you ran entire SQL script

### n8n can't insert data
**Problem**: Supabase RLS policies blocking inserts  
**Fix**: Either disable RLS or create policies:
```sql
ALTER TABLE nil.submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role" ON nil.submissions FOR ALL 
  USING (auth.role() = 'service_role');
```

### Vercel forms not appearing
**Problem**: n8n webhook not receiving data  
**Fix**: Test webhook directly with curl:
```bash
curl -X POST https://your-n8n.com/webhook/vercel-submission \
  -H "Content-Type: application/json" \
  -d '{"test": "data", "clientId": "test-123"}'
```

---

## 7. Production Deployment Sequence

1. **Supabase**: Run `SUPABASE_SCHEMA.sql` (creates 18 objects)
2. **Render**: Deploy bot code with env vars
3. **Test Bot**: `/dashboard` in Telegram
4. **n8n**: Create 4 workflows (submissions, emails, outbox, metrics)
5. **Vercel**: Update form handler to POST to n8n webhook
6. **Test E2E**: Submit form → Check Bot shows submission

---

## Support

- **Bot Code**: [src/index.js](src/index.js) (4867 lines, all using `nil` schema)
- **Schema**: [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) (18 tables/views)
- **Verification**: `node --check src/index.js` (exit 0 = valid)
