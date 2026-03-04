# Twin.so Clarification: Answers to Your Questions

**Date**: March 4, 2026  
**Status**: Complete System Architecture Clarification  
**From**: Nil-Wealth Backend Team

---

## Executive Summary

Your "Instantly Reply Monitor" is correct for **one part** of the system (email reply processing). But you're missing the **complete picture**. Below we clarify each question and provide the exact workflow/code integration points.

---

## Question 1: SendGrid/Twilio Integration for Website Form Submissions

### Answer: Not SendGrid. Use the Bot's `/api/submissions` Endpoint

**Your Question**: "Do you have a separate agent or system handling website form submissions that should trigger SendGrid emails and Twilio SMS?"

**Our Answer**: Yes, there IS a system, but it's **NOT SendGrid for initial outreach**. Here's the correct flow:

```
Website Form Submission
    ↓
POST to Telegram Bot: /api/submissions
    ↓
Bot creates nil.submissions + nil.n8n_outbox (queued)
    ↓
Bot notifies you via Telegram dashboard
    ↓
Twin.so polls: GET /api/nil-outbox/claim
    ↓
Twin.so processes (send email via Instantly.ai, not SendGrid)
    ↓
Twin.so reports back: POST /api/nil-outbox/result
```

**What You Must Do**:
1. Implement the `/api/submissions` client in your workflow
2. Poll `/api/nil-outbox/claim` every 30 seconds
3. For each claimed submission:
   - Send email via **Instantly.ai** (not SendGrid) using the campaign template
   - POST event: `{ event_type: "outbox.email.sent", submission_id }`
4. Report back: POST `/api/nil-outbox/result/{batch_id}`

**Code Example** (pseudocode):
```javascript
// 1. Website form → bot
async function submitForm(formData) {
  const res = await fetch("https://bot-domain/api/submissions", {
    method: "POST",
    headers: { "x-nil-secret": BASE_WEBHOOK_SECRET },
    body: JSON.stringify({
      idempotency_key: uuidv4(),
      first_name: formData.firstName,
      last_name: formData.lastName,
      email: formData.email,
      phone: formData.phone,
      state: formData.state,
      role: formData.role,
      coverage_accident: formData.coverageAccident,
      coverage_hospital_indemnity: formData.coverageHospital
    })
  });
  return res.json(); // { ok, submission_id }
}

// 2. Workflow polls for work
async function claimWork() {
  const res = await fetch("https://bot-domain/api/nil-outbox/claim?limit=10", {
    method: "GET",
    headers: { "x-nil-secret": BASE_WEBHOOK_SECRET }
  });
  return res.json(); // { batch_id, items: [...], count }
}

// 3. Process each submission
for (const item of items) {
  // Send via Instantly.ai
  await instantly.sendEmail({
    to: item.email,
    campaign_id: "57ebe130-68e3-4ee0-bde8-a60c090ef176",
    variables: { name: item.first_name }
  });

  // Report to bot
  await fetch("https://bot-domain/ops/ingest", {
    method: "POST",
    headers: { "x-nil-secret": BASE_WEBHOOK_SECRET },
    body: JSON.stringify({
      event_type: "outbox.email.sent",
      submission_id: item.submission_id,
      timestamp: new Date().toISOString(),
      metadata: { email: item.email, subject: "..." }
    })
  });
}

// 4. Confirm results
await fetch(`https://bot-domain/api/nil-outbox/result/${batch_id}`, {
  method: "POST",
  headers: { "x-nil-secret": BASE_WEBHOOK_SECRET },
  body: JSON.stringify({
    results: items.map(item => ({
      claim_id: item.claim_id,
      submission_id: item.submission_id,
      status: "completed",
      result: { workflow_executed: "Accident Coverage Flow", email_sent: true }
    }))
  })
});
```

**Summary**: Website forms → Bot → Twin.so (you own this). NOT SendGrid; it's the bot's `/api/submissions` endpoint + your Instantly.ai outreach.

---

## Question 2: Gmail Support Inbox Monitoring

### Answer: YES, You Need a Separate Workflow

**Your Question**: "Should I create a separate agent to monitor support@mynilwealthstrategies.com for incoming questions?"

**Our Answer**: **YES**. This is SEPARATE from Instantly outreach, and it's critical.

**System**: 
- **Instantly.ai** = Coaches' inboxes (where you send campaign emails)
- **Gmail support@mynilwealthstrategies.com** = Support team's inbox (where coaches REPLY to YOUR QUESTIONS)

Your current "Instantly Reply Monitor" is only watching Instantly.ai for replies to campaign emails. You also need to watch the support inbox for:
1. **Direct replies** from coaches to support@mynilwealthstrategies.com
2. **New questions/inquiries** not from the campaign

**What You Must Create**:

### Workflow: Gmail Support Inbox Monitor

```
Gmail support@mynilwealthstrategies.com
    ↓ (check every 5 minutes)
New unread email from coach?
    ↓
Webhook POST to /ops/ingest:
{
  "event_type": "outbox.email.received",
  "submission_id": "submissionid_xyz",  // matched by 'from' address
  "timestamp": "2026-03-04T...",
  "metadata": {
    "from": "coach@gmail.com",
    "subject": "Re: Your insurance question",
    "body": "Yes, I'm interested...",
    "source": "gmail_support"
  }
}
    ↓
Bot updates nil.conversations
Bot updates pipeline (urgent → active, reset SLA)
Bot sends Telegram alert to rep
```

**Implementation**:
```javascript
// Gmail API polling (every 5 minutes)
async function checkSupportInbox() {
  const messages = await gmail.users.messages.list({
    userId: "support@mynilwealthstrategies.com",
    q: "is:unread", // only new messages
    maxResults: 10
  });

  for (const msg of messages.data.messages) {
    const body = await gmail.users.messages.get({ 
      userId: "support@mynilwealthstrategies.com", 
      id: msg.id 
    });
    
    const senderEmail = extractFromAddress(body.payload.headers);
    const submissionId = await lookupSubmissionByEmail(senderEmail); // Query DB
    
    if (submissionId) {
      // Post to bot
      await fetch("https://bot-domain/ops/ingest", {
        method: "POST",
        headers: { "x-nil-secret": BASE_WEBHOOK_SECRET },
        body: JSON.stringify({
          event_type: "outbox.email.received",
          submission_id: submissionId,
          timestamp: new Date().toISOString(),
          metadata: {
            from: senderEmail,
            subject: body.payload.headers.find(h => h.name === "Subject").value,
            body: extractPlainText(body.payload),
            source: "gmail_support"
          }
        })
      });

      // Mark as read (so you don't process twice)
      await gmail.users.messages.modify({
        userId: "support@mynilwealthstrategies.com",
        id: msg.id,
        requestBody: { removeLabelIds: ["UNREAD"] }
      });
    }
  }
}

// Run every 5 minutes
setInterval(checkSupportInbox, 5 * 60 * 1000);
```

**Key Tables to Query**:
```sql
-- Find submission by sender email
SELECT submission_id FROM nil.submissions 
WHERE email = $1 
ORDER BY created_at DESC 
LIMIT 1;
```

---

## Question 3: Telegram Bot Code & /ops/ingest Endpoint

### Answer: The Bot is Pre-Built; You Just Call `/ops/ingest`

**Your Question**: "The /ops/ingest endpoint I POST to is part of your Telegram bot. I don't have access to review that code - that's in your index.js file you mentioned."

**Our Answer**: Correct. The bot handles `/ops/ingest` for you. You **only need to POST events to it**. Here's what the bot does internally:

**What `/ops/ingest` Does** (inside bot code):
```javascript
app.post("/ops/ingest", async (req, res) => {
  const { event_type, submission_id, timestamp, metadata } = req.body;

  // 1. Validate auth
  if (req.headers["x-nil-secret"] !== process.env.BASE_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // 2. Route event based on type
  switch (event_type) {
    case "outbox.email.sent":
      // Insert into nil.conversations + nil.messages
      // Update pipeline → 'active'
      break;
    case "outbox.email.received":
      // Insert into nil.conversations (direction=inbound)
      // Update pipeline → 'active' (reset urgent timer)
      break;
    case "call.attempted":
      // Insert into nil.calls
      // Update pipeline based on outcome
      break;
    case "submission.replied":
      // Same as email.received
      break;
    // ... more event types
  }

  // 3. Trigger Telegram dashboard refresh
  await refreshLiveCards();

  // 4. Send Telegram alert if needed (urgent, needs_reply, etc.)
  sendTelegramAlert(submission_id, message);

  return res.status(200).json({ ok: true, event_id, processed_at });
});
```

**Your Job**: Send the right event with the right structure. The bot handles the rest.

**Reference**: [TWIN_SO_INTEGRATION_GUIDE.md - Section 3.4](./TWIN_SO_INTEGRATION_GUIDE.md#34-event-webhook-post-opsingest) lists all valid event types and their metadata format.

---

## Question 4: CC Support in Replies (Automation)

### Answer: Automatic When Reply is Detected

**Your Question**: "When you say 'when I cc support in replies conversation card' - is this a manual workflow or should this be automated?"

**Our Answer**: **This should be 100% AUTOMATED**. Here's how:

### Feature: CC Support Mirroring (Auto)

**When It Triggers**:
- Any email reply from a coach (detected by your Instantly Monitor or Gmail Monitor)

**What Happens**:
1. Email reply detected → you POST `/ops/ingest` event
2. Bot inserts into `nil.conversations` 
3. Bot **automatically BCC's** this conversation to support@mynilwealthstrategies.com
4. Support team sees a copy in their inbox (thread view)
5. Support can reply to coach (and bot auto-detects that reply too)

**You Don't Need to Do Anything Extra** — the bot handles CC automatically.

**Code in Bot** (for reference):
```javascript
// Bot BCC's support on reply detection
if (event_type === "submission.replied") {
  // Insert conversation
  const convo = await createConversation(submission_id, {
    from: metadata.reply_from,
    body: metadata.body,
    source: "email_reply"
  });

  // Auto-BCC support (no action needed from you)
  await notifySupport({
    submission_id,
    conversation_id: convo.id,
    bcc_email: "support@mynilwealthstrategies.com",
    body: metadata.body
  });
}
```

**Summary**: You detect reply → POST event → Bot auto-CC's support. No extra workflow needed.

---

## Complete Architecture (All Systems)

```
┌─────────────────────────────────────────────────────────────┐
│                     WEBSITE FORM SUBMISSION                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST /api/submissions
                       ↓
        ┌──────────────────────────────────────┐
        │   TELEGRAM BOT (Dashboard)           │
        │   - Receives submission               │
        │   - Creates nil.submissions row       │
        │   - Queues in nil.n8n_outbox         │
        │   - Shows card in Telegram            │
        └──┬───────────────────────────────────┘
           │
           ├─────────────────────┬─────────────────────┐
           │                     │                     │
    GET /api/nil-outbox/claim    │                     │
           │                     │                     │
           ↓                     │                     │
  ┌────────────────────────┐    │                     │
  │  TWIN.SO WORKFLOW      │    │                     │
  │  (You)                 │    │                     │
  │  - Claim work          │    │                     │
  │  - Send via Instantly  │    │                     │
  │  - Report back         │    │                     │
  └─────────┬──────────────┘    │                     │
            │                   │                     │
POST /ops/ingest (email.sent)   │                     │
            │                   │                     │
            ↓                   ↓                     │
          ┌──────────────────────────────────────┐    │
          │   COACH RECEIVES EMAIL                │    │
          │   Coach replies to Instantly.ai       │    │
          └──────────┬───────────────────────────┘    │
                     │                                 │
        GET Instantly.ai API (replies)                 │
                     │                                 │
                     ↓                                 │
        ┌────────────────────────────────┐            │
        │  TWIN.SO WORKFLOW               │            │
        │  ("Instantly Reply Monitor")     │            │
        │  - Poll Instantly.ai            │            │
        │  - Find reply                   │            │
        │  - Create nil.conversations     │            │
        └─────────┬──────────────────────┘            │
                  │                                    │
    POST /ops/ingest (outbox.email.received)         │
                  │                                    │
                  └────────────────────────┬───────────┘
                                          │
              ┌───────────────────────────┴────────────┐
              │ GMAIL SUPPORT INBOX MONITOR            │
              │ (Separate Twin.so workflow)             │
              │ - Check support@mynilwealthstrategies │
              │ - Detect reply                        │
              │                                       │
    POST /ops/ingest (outbox.email.received)         │
              └────────────────────┬──────────────────┘
                                   │
                                   ↓
                    ┌──────────────────────────────────┐
                    │   TELEGRAM BOT (Dashboard)       │
                    │   - Updates nil.conversations    │
                    │   - Updates pipeline state       │
                    │   - Auto-BCC's support          │
                    │   - Refreshes dashboard          │
                    │   - Sends Telegram alert to rep  │
                    └──────────────────────────────────┘
```

---

## Summary: What Twin.so Must Do (In Order)

### ✅ Already Configured (Your "Instantly Reply Monitor")
1. Poll Instantly.ai campaign for replies ← YOU HAVE THIS
2. POST to `/ops/ingest` with reply event ← YOU HAVE THIS
3. Database tables + run_log ← YOU HAVE THIS

### ❌ Still Missing (You Must Add)
1. **Website Form → Bot Submission** (`/api/submissions` client)
2. **Outbox Claim Loop** (`GET /api/nil-outbox/claim` every 30 sec)
3. **Outbox Result Reporting** (`POST /api/nil-outbox/result`)
4. **Instantly Outreach Sending** (send via Instantly.ai on claimed submissions)
5. **Gmail Support Inbox Monitor** (separate workflow, poll support@mynilwealthstrategies.com)
6. **Email Received Events** (POST `/ops/ingest` for both Instantly replies AND Gmail replies)

---

## Implementation Checklist

### Phase 1: Website Form → Submission Queue (This Week)
- [ ] Create `/api/submissions` client in Twin.so
- [ ] Create `/api/nil-outbox/claim` polling loop (every 30 sec)
- [ ] Send test form submission via bot endpoint
- [ ] Verify row appears in `nil.n8n_outbox`

### Phase 2: Outreach Email Sending (This Week)
- [ ] For each claimed submission, send email via Instantly.ai
- [ ] POST `/ops/ingest` event: `outbox.email.sent`
- [ ] POST `/api/nil-outbox/result` with completion status
- [ ] Verify bot dashboard shows "Email Sent" status

### Phase 3: Instantly Reply Monitoring (Already Done ✅)
- [ ] Your "Instantly Reply Monitor" is correct
- [ ] Keep polling Instantly.ai for replies
- [ ] POST `/ops/ingest` with `outbox.email.received` events

### Phase 4: Gmail Support Inbox Monitoring (Next Week)
- [ ] Create Gmail API polling workflow
- [ ] Check unread emails in support@mynilwealthstrategies.com every 5 min
- [ ] Match sender to submission_id via database lookup
- [ ] POST `/ops/ingest` with `outbox.email.received` events

### Phase 5: Testing & Validation (After Phase 4)
- [ ] Run [TWIN_SO_INTEGRATION_VERIFY.sh](./TWIN_SO_INTEGRATION_VERIFY.sh) ← tests all 12 points
- [ ] Verify all pipeline states transition correctly
- [ ] Telegram dashboard shows complete end-to-end flow

---

## Reference Documentation

- **Full API Contract**: [TWIN_SO_INTEGRATION_GUIDE.md](./TWIN_SO_INTEGRATION_GUIDE.md)
- **Quick Reference**: [TWIN_SO_QUICK_REFERENCE.txt](./TWIN_SO_QUICK_REFERENCE.txt)
- **Verification Tests**: [TWIN_SO_INTEGRATION_VERIFY.sh](./TWIN_SO_INTEGRATION_VERIFY.sh)
- **Database Schema**: [COMPLETE_SUPABASE_SCHEMA.sql](./COMPLETE_SUPABASE_SCHEMA.sql)

---

## Questions? 

Ask for:
1. API contract details → See Section 3 of TWIN_SO_INTEGRATION_GUIDE.md
2. Event types → See Section 3.4 (Event Webhooks table)
3. Database schema → See COMPLETE_SUPABASE_SCHEMA.sql
4. Testing → Run TWIN_SO_INTEGRATION_VERIFY.sh

This clarification document should answer all of Twin.so's questions. Give them this + the 3 integration files (GUIDE, VERIFY.sh, QUICK_REFERENCE) and they have everything needed.
