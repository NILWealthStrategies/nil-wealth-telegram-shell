# Complete N8N Lead Generation & Outreach Automation

**What this does:**
1. ✅ Generates leads via Apify (web scraper)
2. ✅ Finds emails via Hunter.io
3. ✅ Sends 5-email outreach sequence via Gmail
4. ✅ Uses ChatGPT to personalize each email
5. ✅ Handles support emails from replies
6. ✅ Tracks everything in Supabase (cards view)
7. ✅ Sends Telegram updates

---

## Setup (5 Steps)

### Step 1: Get API Keys

| Service | Where to Get | What It Does |
|---------|-------------|------------|
| **Apify** | https://apify.com/account/integrations | Web scraping for leads |
| **Hunter.io** | https://app.hunter.io/api | Find emails for people |
| **OpenAI** | https://platform.openai.com/api-keys | ChatGPT personalization |
| **Gmail** | n8n credential setup | Send outreach emails |
| **Telegram Bot** | @BotFather | Notifications |
| **Supabase** | Your project | Store leads & track |

### Step 2: Create Supabase Tables

Run this SQL in Supabase:

```sql
-- Leads table
create table if not exists nil.leads (
  lead_id uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text not null,
  email text unique not null,
  phone text,
  website text,
  source text default 'apify',
  status text default 'new', -- new | outreach_1 | outreach_2 | replied | converted
  outreach_sent_at timestamptz,
  reply_received_at timestamptz,
  last_email_subject text,
  created_at timestamptz default now()
);

-- Email sequences table (tracks which email in sequence was sent)
create table if not exists nil.email_sequences (
  sequence_id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references nil.leads(lead_id),
  email_number int (1-5),
  sent_at timestamptz,
  open_count int default 0,
  reply_received boolean default false,
  created_at timestamptz default now()
);

-- Support conversations (from replies)
create table if not exists nil.support_tickets (
  ticket_id uuid primary key default gen_random_uuid(),
  lead_id uuid references nil.leads(lead_id),
  from_email text not null,
  subject text,
  body text,
  status text default 'open', -- open | replied | closed
  assigned_to text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Dashboard metrics
create table if not exists nil.lead_metrics (
  metric_date date primary key default today(),
  leads_generated int default 0,
  emails_sent int default 0,
  replies_received int default 0,
  conversion_rate numeric,
  updated_at timestamptz default now()
);
```

### Step 3: Set n8n Environment Variables

In n8n Settings → Environment:

```
APIFY_API_TOKEN = <your-apify-token>
HUNTER_IO_API_KEY = <your-hunter-io-key>
OPENAI_API_KEY = <your-openai-key>
SUPABASE_URL = https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY = <service-role-key>
TELEGRAM_BOT_TOKEN = <bot-token>
TELEGRAM_CHAT_ID = <your-chat-id>
NIL_SECRET = <your-secret>
```

### Step 4: Add n8n Credentials

**Gmail:**
1. In n8n, click <setting icon> → **Credentials**
2. Click **+ Create New**
3. Search **Gmail**
4. Authenticate with Google account
5. Save

**OpenAI:**
1. In n8n, click <setting icon> → **Credentials**
2. Click **+ Create New**
3. Search **OpenAI**
4. Paste API key
5. Save

**Apify:**
1. Create credential with API token

**Hunter.io:**
1. Create credential with API key

### Step 5: Import Workflow JSON

(See below for complete JSON export)

---

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ LEAD GENERATION                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. Schedule Trigger (Daily at 9 AM)                             │
│    ↓                                                              │
│ 2. Apify: Scrape target companies                              │
│    ↓                                                              │
│ 3. Hunter.io: Find emails for each company                     │
│    ↓                                                              │
│ 4. Supabase: Insert leads into nil.leads                       │
│    ↓                                                              │
│ 5. Telegram: Notify "X leads found today"                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ EMAIL OUTREACH SEQUENCE                                         │
├─────────────────────────────────────────────────────────────────┤
│ 6. Query leads where status = 'new'                             │
│    ↓                                                              │
│ 7. For each lead:                                               │
│    7a. ChatGPT: Generate Email 1 (intro)                       │
│    7b. Gmail: Send Email 1                                      │
│    7c. Supabase: Update status = 'outreach_1'                  │
│    7d. Wait 2 days                                              │
│    7e. ChatGPT: Generate Email 2 (value prop)                  │
│    7f. Gmail: Send Email 2                                      │
│    ... (repeat for emails 3, 4, 5)                              │
│    7z. Telegram: Notify "Email sent to {name}"                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ SUPPORT EMAIL HANDLING                                          │
├─────────────────────────────────────────────────────────────────┤
│ 8. Gmail Trigger: Receive reply/support email                  │
│    ↓                                                              │
│ 9. Supabase: Insert into nil.support_tickets                   │
│    ↓                                                              │
│ 10. ChatGPT: Auto-generate support reply                        │
│    ↓                                                              │
│ 11. Gmail: Send auto-reply (optional, configurable)            │
│    ↓                                                              │
│ 12. Telegram: Alert "New support ticket from {email}"          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ DASHBOARD CARDS                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Card 1: Leads Generated Today                                   │
│ Card 2: Emails Sent This Week                                   │
│ Card 3: Reply Rate (%)                                          │
│ Card 4: Qualified Leads                                         │
│ Card 5: Open Rate Tracking                                      │
│                                                                   │
│ (All pull from nil.lead_metrics table)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Workflow Execution Flow

### Daily (9 AM)
- Apify scrapes companies from target list
- Hunter finds emails
- 15-50 new leads added to Supabase
- Telegram notifies you

### Staggered (Throughout week)
- Email 1 sent → Wait 2 days
- Email 2 sent → Wait 2 days
- Email 3 sent → Wait 3 days
- Email 4 sent → Wait 5 days
- Email 5 sent

### Real-time
- Reply arrives → Stored as support ticket
- ChatGPT generates auto-response
- You get notified in Telegram

### Dashboard
- Every 6 hours: Recalculate metrics
- Cards show: leads, emails, conversions, reply rate

---

## Email Sequence Templates

**Email 1 (Day 0):** Introduction
```
Subject: Quick thought on {company_name} + {your_product}

Hi {contact_name},

I've been following {company_name} and think there's potential to improve {pain_point}.

Would you be open to a 15-min call to explore?

Best,
{your_name}
```

**Email 2 (Day 2):** Social proof
```
Subject: Re: Quick thought - case study inside

Hi {contact_name},

Following up on my previous note. We just helped {similar_company} achieve {result}.

I think the same approach could work for {company_name}.

Available for a call this week?

Best,
{your_name}
```

**Email 3 (Day 4):** Value proposition
```
Subject: {company_name} + growth opportunity

Hi {contact_name},

Saw {company_name} just {recent_news}. Perfect timing for what we do.

We help companies like yours {specific_benefit} in 30 days.

Interested?

Best,
{your_name}
```

**Email 4 (Day 7):** Sense of urgency
```
Subject: Last attempt - exclusive offer

Hi {contact_name},

This is my last attempt to connect. We're extending a special offer to {industry} companies through {date}.

If {company_name} is interested, this is the time.

Let's talk?

Best,
{your_name}
```

**Email 5 (Day 12):** Breakup email
```
Subject: Check in

Hi {contact_name},

I'm removing you from my list as it doesn't seem like the right timing.

If things change and you want to explore {solution}, feel free to reach out.

Best of luck,
{your_name}
```

---

## Testing the Workflow

### Test 1: Add a Test Lead
```sql
INSERT INTO nil.leads (company_name, contact_name, email, website, source)
VALUES ('Test Company', 'John Doe', 'john@testco.com', 'testco.com', 'manual-test');
```

### Test 2: Run Workflow
Click **Test Workflow** in n8n

### Test 3: Check Results
```sql
SELECT * FROM nil.leads ORDER BY created_at DESC LIMIT 5;
SELECT * FROM nil.email_sequences ORDER BY created_at DESC LIMIT 5;
SELECT * FROM nil.lead_metrics WHERE metric_date = TODAY();
```

---

## Environment Variables All In One

```
APIFY_API_TOKEN=apify_...
HUNTER_IO_API_KEY=hunter_...
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
NIL_SECRET=your-secret
```

---

## Complete Workflow JSON

See: `n8n-complete-lead-automation.json` (next file)

---

## What's Included

✅ Lead scraping (Apify)
✅ Email finding (Hunter.io)
✅ 5-email sequence (Gmail + ChatGPT)
✅ Support email handling (auto-reply)
✅ Telegram notifications (all events)
✅ Supabase tracking (metrics + dashboards)
✅ Error handling (retry logic)
✅ Delay between emails (smart scheduling)
✅ Cards dashboard (live metrics)

---

## Next Steps

1. Copy the JSON file
2. Import into n8n
3. Set env vars
4. Add credentials (Gmail, OpenAI, Apify, Hunter)
5. Click **Activate**
6. Watch it work

---

Done! Tell me when you're ready for the JSON export.
