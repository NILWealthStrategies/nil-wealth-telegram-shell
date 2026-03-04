# Twin.so Implementation Brief - NIL Wealth n8n Workflows

## 🔴 CRITICAL: Two Separate Email Systems

**Read this before starting:**

1. **Instantly.ai** = Outbound outreach ONLY (cold leads, automated sequences)
   - Workflows 2, 3, 4 use Instantly API
   - Workflow 3 monitors Instantly for **replies to outreach emails**
   - NEVER add support@mynilwealthstrategies.com to Instantly
   
2. **Gmail support@ inbox** = Inbound support ONLY (direct emails, CC'd questions)
   - Separate from Instantly completely
   - May need separate n8n webhook or Zapier integration (see section 5)
   - Not currently handled by the 5 provided workflows

These are **completely separate systems**. Do NOT mix them!

---

## Quick Reference for Workflow Builders

This document provides critical implementation details beyond the detailed overview. Use this alongside `WORKFLOWS_DETAILED_OVERVIEW.md`.

### 🚨 FIRST STEP: Run Database Schema

**BEFORE importing workflows, run this in Supabase SQL Editor:**

📄 **`COMPLETE_SUPABASE_SCHEMA.sql`**

This creates all required tables:
- `nil.leads` (Workflow 1 writes here)
- `nil.lead_metrics` (Workflow 4 writes here)
- `nil.support_tickets` (Workflow 3 writes here)
- `nil.email_sequences` (Workflow 2 writes here)
- Plus 18 more tables for bot functionality

**Takes 10 seconds. Safe to run multiple times.**

See [MESSAGE_FOR_TWIN_SO.md](MESSAGE_FOR_TWIN_SO.md) for detailed instructions.

---

## 1. Workflow Files to Import

You have **5 workflow JSON files** ready to import:

1. `n8n-lead-generation-workflow.json` (406 lines)
2. `n8n-email-outreach-workflow.json` (558 lines) - renamed to "NIL Instantly Campaign Loader"
3. `n8n-support-handler-workflow.json` (496 lines)
4. `n8n-analytics-sync-workflow.json` (416 lines)
5. `n8n-instant-submission-workflow.json` (258 lines)

**Import Method:** n8n → Workflows → Import from File → Select each JSON

### Quick Workflow Reference Table

| # | Workflow Name | Purpose | Data Source | Frequency |
|---|---------------|---------|-------------|-----------|
| 1 | Lead Generation | Scrape new leads | Apify + Hunter.io | Daily 9 AM |
| 2 | Campaign Loader | Add leads to Instantly | Supabase → Instantly API | Every 4 hours |
| 3 | Support Handler | Monitor Instantly replies | Instantly API (replies to outreach) | Every 15 min |
| 4 | Analytics Sync | Track email metrics | Instantly API (opens/clicks) | Every 1 hour |
| 5 | Instant Submission | Process form webhooks | Website form POST | Real-time |

**Note:** Gmail support@mynilwealthstrategies.com is NOT handled by these workflows. See section 5 for Gmail webhook setup.

---

## 2. Required API Credentials (n8n Credentials Panel)

### Supabase (Used by ALL workflows)
```
Type: Postgres / Supabase
Host: bjyxaprcdbwougewbauw.supabase.co
Database: postgres
Schema: nil
User: postgres.bjyxaprcdbwougewbauw
Password: [SUPABASE_SERVICE_ROLE_KEY from .env]
Port: 5432
SSL: Required
```

### Instantly.ai (Workflows 2, 3, 4)
```
API Key: [Need from client]
Base URL: https://api.instantly.ai/api/v1
Campaign ID: [Need from client - single campaign for all outreach]

⚠️ IMPORTANT: 
- Workflow 2: Adds leads to Instantly campaign (outbound)
- Workflow 3: Monitors Instantly API for replies to outreach emails
- Workflow 4: Syncs analytics (opens/clicks/bounces) from Instantly
- These workflows do NOT touch Gmail support@ inbox
```

### Apify (Workflow 1)
```
API Token: [Need from client]
Actor ID: google-search-scraper (or custom actor)
```

### Hunter.io (Workflow 1)
```
API Key: [Need from client]
Endpoint: https://api.hunter.io/v2/email-finder
```

### Telegram Bot (All workflows)
```
Bot Token: 7950661012:AAHXsKQ-d4M1nWXvZ8v5YFmQRbOW7oZdU0c
Chat ID: 7810862886 (admin)
```

### SendGrid (Workflow 5)
```
API Key: [Need from client]
From Email: support@mynilwealthstrategies.com
Template ID: [Need from client, or use generic send]
```

### Twilio (Workflow 5)
```
Account SID: [Need from client]
Auth Token: [Need from client]
From Number: [Need from client]
```

### OpenAI (Not in workflows, used by Telegram bot)
```
API Key: [Need from client]
Model: gpt-4o-mini
Purpose: Reply draft generation (V1/V2/V3 feature)
```

---

## 3. EMAIL ARCHITECTURE - READ THIS FIRST! 🔴

### Two Separate Email Systems (DO NOT MIX)

```
SYSTEM 1: OUTREACH (Instantly.ai)
┌─────────────────────────────────────────────────────────────┐
│  n8n Workflow 1: Scrapes leads → nil.leads (status='ready') │
│         ↓                                                    │
│  n8n Workflow 2: Gets ready leads → Adds to Instantly       │
│         ↓                                                    │
│  Instantly.ai: Sends cold outreach emails automatically     │
│         ↓                                                    │
│  People REPLY to outreach emails → Instantly captures       │
│         ↓                                                    │
│  n8n Workflow 3: Polls Instantly API for replies every 15min│
│         ↓                                                    │
│  Creates support_tickets in database → Telegram alert       │
│         ↓                                                    │
│  n8n Workflow 4: Syncs opens/clicks from Instantly API      │
│                                                              │
│  ⚠️ EXCLUDES: support@mynilwealthstrategies.com             │
│  📧 SENDS FROM: Whatever domain Instantly uses              │
│  🎯 PURPOSE: Cold outbound + reply monitoring               │
└─────────────────────────────────────────────────────────────┘

SYSTEM 2: SUPPORT INBOX (Gmail + n8n)
┌─────────────────────────────────────────────────────────────┐
│  Someone emails support@mynilwealthstrategies.com directly   │
│  OR CCs support@ on a question                               │
│         ↓                                                    │
│  Gmail inbox receives message                                │
│         ↓                                                    │
│  n8n Gmail Trigger OR Zapier webhook                         │
│         ↓                                                    │
│  Creates conversation/support_ticket in database             │
│         ↓                                                    │
│  Telegram bot alerts: "🎯 NEW SUPPORT EMAIL!"               │
│         ↓                                                    │
│  Human reviews in Telegram → Uses V1/V2/V3 draft feature    │
│                                                              │
│  ⚠️ ONLY FOR: Direct emails or CCs to support@             │
│  📧 RECEIVES AT: support@mynilwealthstrategies.com          │
│  🎯 PURPOSE: Handle direct questions/CCs                     │
│  🚨 NEVER add this email to Instantly campaign!             │
└─────────────────────────────────────────────────────────────┘
```

### Why Two Systems?

**Instantly.ai** is for high-volume automated outreach:
- Sends 100+ outreach emails per day
- Automatically captures replies to those outreach emails
- **Workflow 3 monitors Instantly API** for when people reply to outreach
- Tracks deliverability, opens, clicks via Workflow 4
- No human involvement until someone replies (then appears in Telegram)

**Gmail support@ inbox** is for direct contact:
- Receives emails when people email support@ directly
- Receives CCs when someone includes support@ on a question
- **Separate from Instantly** - not part of outreach system
- Each message needs n8n webhook trigger (Gmail → n8n → Telegram)
- Human can use AI drafts (V1/V2/V3) to reply
- Personal touch, not automated blasts

**Critical Rule:** Never add support@mynilwealthstrategies.com to Instantly campaign!

---

## 4. Database Schema (Supabase)

**Schema:** `nil` (NOT `public`)

### Key Tables Workflows Write To:

#### `nil.leads`
```sql
Columns: lead_id, full_name, email, organization, title, state, 
         status, engagement_score, source, created_at, updated_at
Workflow 1 INSERTs: New scraped leads
Workflow 2 UPDATES: status to 'outreach_started'
Workflow 3 UPDATES: status to 'replied'
```

#### `nil.support_tickets`
```sql
Columns: ticket_id, lead_id, contact_email, message, status, 
         priority, created_at, resolved_at
Workflow 3 INSERTs: When replies detected from Instantly
```

#### `nil.lead_metrics`
```sql
Columns: metric_id, lead_id, metric_type, metric_value, 
         recorded_at, metadata
Workflow 2 INSERTs: email_sent events
Workflow 3 INSERTs: reply events
Workflow 4 INSERTs: open, click, bounce events
```

#### `nil.email_sequences`
```sql
Columns: sequence_id, lead_id, sequence_number, status, 
         scheduled_at, sent_at, created_at
Workflow 2 INSERTs: Tracks which sequence step lead is in
```

#### `nil.submissions`
```sql
Columns: submission_id, first_name, last_name, email, phone, 
         state, role, submission_payload, created_at
Workflow 5 INSERTs: Website form submissions
```

**Full schema:** See `SUPABASE_SCHEMA.sql` (437 lines)

---

## 5. Gmail Webhook Setup (For Support Inbox)

**Required for Workflow 3 (Support Handler) to work properly.**

### Option A: Gmail + Zapier/Make → n8n Webhook
```
1. Set up Zapier/Make trigger: "New Email in Gmail"
2. Filter: Only emails TO support@mynilwealthstrategies.com
3. Action: POST to n8n webhook URL
4. Payload:
   {
     "from": "{{email sender}}",
     "to": "support@mynilwealthstrategies.com",
     "subject": "{{email subject}}",
     "body": "{{email body}}",
     "date": "{{email date}}"
   }
```

### Option B: n8n Gmail Trigger (Native)
```
1. In n8n: Add "Gmail Trigger" node
2. Connect Gmail OAuth credentials
3. Set filter: Only emails to support@mynilwealthstrategies.com
4. On new email → Create support_ticket in Supabase
5. Send Telegram alert
```

### Option C: Gmail Webhook via Google Apps Script
```javascript
// In Gmail → Settings → Filters
// Forward all support@ emails to Apps Script webhook
// Apps Script posts to n8n webhook URL
```

**Ask client:** How is your support@ Gmail currently configured?

---

## 6. Critical Implementation Notes

### 🚨 TWO SEPARATE EMAIL SYSTEMS

**CRITICAL: There are TWO separate email flows - do NOT mix them!**

#### System 1: Instantly.ai (OUTREACH ONLY)
- **Purpose:** Send cold outbound emails to new leads (athletic directors, coaches, etc.)
- **Workflows:** 2 (Campaign Loader), 3 (Support Handler), 4 (Analytics Sync)
- **Email Domain:** Whatever domain Instantly uses for outreach
- **Direction:** One-way outbound → Instantly sends, tracks opens/clicks
- **No support inbox involvement**

#### System 2: Gmail + n8n (SUPPORT INBOX ONLY)
- **Purpose:** Handle replies and questions sent TO support@mynilwealthstrategies.com
- **Inbox:** support@mynilwealthstrategies.com (Gmail)
- **Trigger:** When people CC or reply to support@ with questions
- **Flow:** Gmail → n8n webhook → Create conversation/support_ticket → Telegram bot alert
- **Direction:** Inbound only → People reach out to support@
- **No Instantly involvement**

#### Support Inbox Exclusion Code

**Location:** Node "Detect Role & Strategy" in `n8n-email-outreach-workflow.json`

**Code:**
```javascript
if (email === 'support@mynilwealthstrategies.com' || 
    email === 'support@mynilwealthstrategis.com') {
  return []; // Skip outreach - this is support inbox only
}
```

**Why:** The support@ inbox is for RECEIVING questions, not sending outreach.
- `support@mynilwealthstrategies.com` = **RECEIVE questions only** (Gmail → n8n → Telegram bot)
- Instantly campaign = **SEND outreach only** (cold leads, no support inbox)

**Do NOT let support inbox email get added to Instantly campaign!**

---

### 📧 INSTANTLY HANDLES ALL EMAIL COPY

**NEW Architecture (Client requested this change):**
- Instantly.ai **already has templates** configured in the campaign
- Instantly.ai **handles follow-up sequences** automatically
- n8n workflows **do NOT generate email copy** (removed ChatGPT nodes)

**What Workflow 2 Does Now:**
1. Gets leads with `status = 'ready'` from database
2. Excludes support inbox (see above)
3. Adds lead to Instantly campaign with **empty** `custom_intro` field
4. Instantly uses its own templates for Subject + Body + Follow-ups

**What Workflow 2 Does NOT Do:**
- ❌ No ChatGPT API calls for generating emails
- ❌ No custom email copy per lead
- ❌ No V1/V2/V3 email variants

**Client's Reasoning:** Faster implementation, centralized template management in Instantly dashboard, A/B testing via Instantly's built-in features.

---

### 🔄 WORKFLOW TIMING COORDINATION

```
Daily 9 AM:     Workflow 1 runs → Scrapes 50 leads → Inserts with status='ready'
Every 4 hours:  Workflow 2 runs → Gets 20 'ready' leads → Adds to Instantly → Updates status='outreach_started'
Every 15 min:   Workflow 3 runs → Polls Instantly API for replies to outreach emails → Creates support tickets
Every 1 hour:   Workflow 4 runs → Syncs analytics (opens/clicks) from Instantly API → Updates engagement_score
Real-time:      Workflow 5 runs → Webhook triggered by website form → Instant notification

Separate:       Gmail support@ inbox → (Needs n8n Gmail webhook OR Zapier) → Separate support tickets
```

**No conflicts:** Each workflow operates on different data sources:
- Workflow 1: Web scraping (Apify)
- Workflow 2: Instantly API (add leads to campaign)
- Workflow 3: Instantly API (monitor for replies to outreach emails)
- Workflow 4: Instantly API (analytics/metrics)
- Workflow 5: Website form webhook
- Gmail support@: Direct emails/CCs (separate system - may need additional setup)

---

## 7. Webhook Endpoints (Telegram Bot Exposes These)

The Express app (`src/index.js`) exposes these endpoints that n8n can POST to:

### `POST /api/submissions`
- **Purpose:** Receives website form submissions
- **Auth:** `x-webhook-secret` header = `nil_wealth_ops_secure_2026`
- **Payload Example:**
```json
{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "phone": "+14045551234",
  "state": "GA",
  "role": "parent",
  "coverage_accident": true,
  "coverage_hospital_indemnity": false,
  "idempotency_key": "optional-uuid"
}
```
- **Response:** `{ "received": true, "submission_id": "uuid" }`
- **Used by:** Workflow 5 (Instant Submission)

### `POST /api/conversations` (Optional)
- **Purpose:** Create conversation thread from external sources
- **Auth:** Same `x-webhook-secret`
- **Payload:**
```json
{
  "thread_key": "email-thread-id",
  "contact_email": "lead@example.com",
  "subject": "Question about NIL insurance",
  "message": "Body text...",
  "source": "instantly"
}
```

### Bot Webhook (Telegram)
- **URL:** Bot uses polling mode by default (no webhook needed)
- **If deploying to production:** Set webhook to `https://your-domain.com/webhook`

---

## 8. Environment Variables Checklist

Twin.so will need to configure these in n8n:

```bash
# Already configured by client:
TELEGRAM_BOT_TOKEN=7950661012:AAHXsKQ-d4M1nWXvZ8v5YFmQRbOW7oZdU0c
ADMIN_TELEGRAM_IDS=7810862886
SUPABASE_URL=https://bjyxaprcdbwougewbauw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...

# Need from client for workflows:
INSTANTLY_API_KEY=             # Required: Workflows 2, 3, 4
INSTANTLY_OUTREACH_CAMPAIGN_ID= # Required: Workflow 2 (single campaign)
APIFY_API_KEY=                  # Required: Workflow 1
HUNTER_IO_API_KEY=              # Required: Workflow 1
SENDGRID_API_KEY=               # Optional: Workflow 5 (email notifications)
TWILIO_ACCOUNT_SID=             # Optional: Workflow 5 (SMS notifications)
TWILIO_AUTH_TOKEN=              # Optional: Workflow 5
TWILIO_FROM_NUMBER=             # Optional: Workflow 5
OPENAI_API_KEY=                 # Optional: Bot draft feature only (not workflows)

# System:
BASE_WEBHOOK_SECRET=nil_wealth_ops_secure_2026  # For POST /api/submissions
SUPPORT_FROM_EMAIL=support@mynilwealthstrategies.com
```

---

## 9. Testing Each Workflow

### Test Workflow 1 (Lead Generation)
```bash
# Manual trigger in n8n OR wait until 9 AM
# Expected: ~50 leads inserted into nil.leads with status='ready'
# Verify in Supabase:
SELECT lead_id, full_name, email, status FROM nil.leads ORDER BY created_at DESC LIMIT 10;
```

### Test Workflow 2 (Campaign Loader)
```bash
# Prerequisite: Workflow 1 must have created leads with status='ready'
# Manual trigger in n8n
# Expected: Up to 20 leads added to Instantly campaign, status updated to 'outreach_started'
# Verify in Instantly dashboard: Check campaign contacts
# Verify in Supabase:
SELECT email, status FROM nil.leads WHERE status='outreach_started';
```

### Test Workflow 3 (Support Handler - Instantly Replies)
```bash
# NOTE: This workflow monitors Instantly API for replies to OUTREACH emails
# It does NOT monitor the Gmail support@ inbox (that's separate - see section 5)

# Prerequisite: Someone must reply to an outreach email sent by Instantly
# Manual trigger in n8n OR wait 15 minutes for scheduled run
# Expected: Instantly reply detected → support_ticket created
# Verify in Supabase:
SELECT ticket_id, contact_email, message FROM nil.support_tickets ORDER BY created_at DESC LIMIT 5;
# Verify in Telegram: Bot sends "🎯 NEW REPLY RECEIVED!" alert
```

### Test Workflow 4 (Analytics Sync)
```bash
# Prerequisite: Workflow 2 must have sent emails, and recipient opened/clicked
# Manual trigger in n8n
# Expected: Metrics synced from Instantly
# Verify in Supabase:
SELECT lead_id, metric_type, metric_value FROM nil.lead_metrics ORDER BY recorded_at DESC LIMIT 20;
```

### Test Workflow 5 (Instant Submission)
```bash
# Send POST request to bot endpoint:
curl -X POST http://your-bot-url.com/api/submissions \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: nil_wealth_ops_secure_2026" \
  -d '{
    "first_name":"Test",
    "last_name":"User",
    "email":"test@example.com",
    "phone":"+14045551234",
    "state":"GA",
    "role":"parent",
    "coverage_accident":true,
    "coverage_hospital_indemnity":false
  }'

# Expected: 
# 1. 200 OK response
# 2. Row in nil.submissions
# 3. SendGrid email sent (if configured)
# 4. Twilio SMS sent (if configured)  
# 5. Telegram alert: "📬 NEW SUBMISSION: Test User"
```

---

## 10. Telegram Bot Integration Points

The bot (`src/index.js`) displays workflow outputs:

### `/dashboard` Command
Shows:
- Active conversations count (from nil.conversations)
- Support tickets count (from nil.support_tickets - **Workflow 3 output from Instantly replies + Gmail support@ emails**)
- Recent submissions (from nil.submissions - **Workflow 5 output**)
- System metrics

### `/leads` Command
Shows:
- All leads from nil.leads (**Workflow 1 output**)
- Status: ready / outreach_started / replied / bounced (**Workflow 2/3 updates**)
- Engagement score (**Workflow 4 calculates this**)
- Click to view lead details

### `/analytics` Command
Shows:
- Email sent count (**Workflow 2 metric**)
- Opens, clicks (**Workflow 4 metrics**)
- Reply rate (**Workflow 3 metric**)
- Top performing leads

### Draft Feature (V1/V2/V3)
When viewing a conversation/support ticket:
- Click "✍️ Drafts V1/V2/V3" button
- Bot calls OpenAI to generate 3 reply variations
- User selects one (V1/V2/V3)
- User can edit or regenerate
- **Note:** This is bot-side only, not in n8n workflows

---

## 11. Common Pitfalls to Avoid

### ❌ Don't use `public` schema
- All tables are in `nil` schema
- Supabase connection must specify schema: `nil`

### ❌ Don't confuse the two email systems
- **Instantly.ai** = Outreach ONLY (sends cold emails, Workflow 3 monitors replies to those emails)
- **Gmail support@ inbox** = Separate system for direct emails/CCs (needs own webhook setup per section 5)
- **Workflow 3** monitors Instantly API for replies, NOT Gmail inbox
- Check exclusion logic in Workflow 2 node "Detect Role & Strategy" (never add support@ to Instantly)
- Test with both spellings: mynilwealthstrategies / mynilwealthstrategis

### ❌ Don't generate email copy in workflows
- Old architecture used ChatGPT nodes - these are removed
- Instantly templates handle all email copy now
- Just send lead data with empty `custom_intro`

### ❌ Don't hardcode credentials
- Use n8n's credential system
- Never paste raw API keys in workflow nodes

### ❌ Don't skip error handlers
- Each workflow has "On Error" nodes → Send Telegram alert
- Keep these connected so client knows when workflows fail

---

## 12. Deployment Checklist

- [ ] **STEP 0: Run COMPLETE_SUPABASE_SCHEMA.sql in Supabase** (see MESSAGE_FOR_TWIN_SO.md)
- [ ] Verify tables exist: `SELECT * FROM nil.leads LIMIT 1;`
- [ ] Import all 5 workflow JSON files into n8n
- [ ] Configure Supabase credentials (schema: `nil`)
- [ ] Configure Instantly.ai credentials + campaign ID (for OUTREACH ONLY)
- [ ] (Optional) Set up Gmail webhook for support@mynilwealthstrategies.com direct emails (see section 5)
- [ ] Configure Apify credentials (for Workflow 1)
- [ ] Configure Hunter.io credentials (for Workflow 1)
- [ ] Configure Telegram bot token (for alerts)
- [ ] (Optional) Configure SendGrid credentials (for Workflow 5)
- [ ] (Optional) Configure Twilio credentials (for Workflow 5)
- [ ] Verify support inbox exclusion logic in Workflow 2
- [ ] Test Workflow 1 manually → Check leads inserted
- [ ] Test Workflow 2 manually → Check Instantly campaign (NO support@ email!)
- [ ] Test Workflow 3 → Reply to an Instantly outreach email, verify ticket created
- [ ] Test Workflow 4 → Check metrics synced
- [ ] Test Workflow 5 → POST to /api/submissions
- [ ] (Optional) Test Gmail support@ webhook → Verify creates separate tickets
- [ ] Enable all workflow schedules (activate)
- [ ] Monitor Telegram for success/error alerts for 24 hours
- [ ] Verify cron timings are correct (9 AM for Workflow 1, etc.)

---

## 13. Questions to Ask Client

Before finalizing, twin.so should confirm:

1. **Instantly.ai Setup (OUTREACH ONLY):**
   - What is your `INSTANTLY_OUTREACH_CAMPAIGN_ID`?
   - Are your email templates already configured in Instantly?
   - How many follow-ups are in your sequence? (so we know what to expect)
   - What domain/email is Instantly sending FROM? (should NOT be support@)

2. **Gmail Support Inbox (SUPPORT ONLY):**
   - Is support@mynilwealthstrategies.com a Gmail inbox?
   - Do you have n8n webhook configured to trigger on new emails to support@?
   - Or should we set this up? (Gmail → n8n HTTP trigger → Workflow 3)

3. **Apify Configuration:**
   - Which Apify actor are you using? (google-search-scraper or custom?)
   - What search query do you want? (current: "athletic director site:edu")
   - How many results per day? (current: 50)

4. **Lead Volume:**
   - Workflow 1 scrapes 50/day, Workflow 2 processes 20 every 4 hours = max 120/day outreach
   - Is this cadence acceptable, or do you want more/less?

5. **Notification Preferences:**
   - Do you want Telegram alerts for EVERY reply to outreach emails (Workflow 3 from Instantly)?
   - Do you want separate alerts for direct support@ emails?
   - Or only urgent ones?
   - Do you want daily summary instead of real-time?

6. **Form Submissions (Workflow 5):**
   - What is your website form URL that will POST to /api/submissions?
   - Do you want SendGrid template email or plain text?
   - SMS notification for every submission, or only specific states/roles?

---

## Contact & Support

**Client:** Drew McConnell  
**Admin Telegram ID:** 7810862886  
**Bot Token:** 7950661012:AAHXsKQ-d4M1nWXvZ8v5YFmQRbOW7oZdU0c  
**Supabase Project:** bjyxaprcdbwougewbauw  
**GitHub Repo:** NILWealthStrategies/nil-wealth-telegram-shell

**Files to Reference:**
- `WORKFLOWS_DETAILED_OVERVIEW.md` (1,181 lines) - Complete technical deep dive
- `SUPABASE_SCHEMA.sql` (437 lines) - Full database schema
- `N8N_WORKFLOWS.md` - Original workflow documentation
- `src/index.js` (5,958 lines) - Telegram bot source code

---

## Quick Start for Twin.so

**⚠️ CRITICAL: Run database schema FIRST before importing workflows!**

1. **READ MESSAGE_FOR_TWIN_SO.md** - Database setup instructions
2. **Run COMPLETE_SUPABASE_SCHEMA.sql in Supabase** - Creates all 22 tables
3. **Verify tables exist:** `SELECT * FROM nil.leads LIMIT 1;`
4. **READ SECTION 3 FIRST** - Understand the two separate email systems!
5. Read `WORKFLOWS_DETAILED_OVERVIEW.md` for detailed explanations
6. Read this file (TWIN_SO_IMPLEMENTATION_BRIEF.md) for practical setup
7. Import 5 JSON workflow files into n8n
8. Configure credentials in n8n (Supabase, Instantly, Apify, Hunter, Telegram)
9. Set up Gmail webhook for support@ inbox (section 5)
10. Ask client for missing API keys (see section 13)
11. Test each workflow manually
12. Activate schedules
13. Monitor Telegram for 24 hours

**Estimated Setup Time:** 2-4 hours with all credentials available

**MOST COMMON ERROR:** Importing workflows before running schema → "table nil.leads does not exist"  
**FIX:** Run COMPLETE_SUPABASE_SCHEMA.sql first!

---

## Need Help?

Refer back to:
- **Section 3** - Email architecture (MOST IMPORTANT - read first!)
- **WORKFLOWS_DETAILED_OVERVIEW.md** - "How does this work?" questions
- **This document** - "How do I configure this?" questions
- **SUPABASE_SCHEMA.sql** - "What columns exist?" questions
- **src/index.js lines 1-100** - Bot configuration reference

All workflows include error handling nodes that send Telegram alerts. If anything breaks, client will be notified immediately in Telegram chat.

### Key Reminder

```
Instantly.ai = OUTREACH (sends cold emails + captures replies via API)
Gmail support@ = SUPPORT (receives direct emails/CCs - separate system)

Workflow 3 = Monitors Instantly API for replies to outreach emails
Gmail support@ inbox = Needs separate webhook setup (section 5)
```

**Do NOT mix these two systems!**  
**Never add support@mynilwealthstrategies.com to Instantly campaign!**
