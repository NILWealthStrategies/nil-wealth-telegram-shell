# Complete n8n Workflow System Overview

## Executive Summary

This system automates the entire lead management and outreach pipeline:
1. **Generate leads** daily via web scraping + email enrichment
2. **Queue leads for outreach** via Instantly.ai campaign every 4 hours
3. **Collect replies** from Instantly every 15 minutes
4. **Track analytics** hourly (opens, clicks, bounces, replies)
5. **Process instant submissions** from website forms in real-time

The Telegram bot is the **operations and response center**—it displays all this information and lets you manage conversations, draft replies, and monitor metrics.

---

## System Architecture Diagram

```
Leads → Campaign → Outreach → Replies → Support Tickets → Bot Dashboard
  ↓        ↓          ↓          ↓           ↓              ↓
Apify   n8n Loader  Instantly   n8n        n8n         Telegram Bot
Hunter                Handler    Handler    Instant      (Display + Control)
.io                                        Submit
```

---

## Workflow 1: NIL Lead Generation (Apify + Hunter.io)

**Purpose:** Automatically discover and enrich leads with email addresses  
**Frequency:** Daily at 9 AM EST  
**Duration:** ~3 minutes (includes 2-minute Apify wait)

### How It Works

#### Step 1: Daily Trigger
- **Node:** `Daily Trigger` (Cron: `0 9 * * *`)
- **Action:** Fires every day at 9 AM EST
- **Output:** Starts the workflow

#### Step 2: Start Apify Scrape
- **Node:** `Start Apify Scrape` (HTTP POST to Apify API)
- **Input:** 
  - Search query: `athletic director site:edu` (customizable)
  - Max results: `50` (per run)
- **Action:** Launches Apify actor (web scraper configured to find athletic directors, coaches, compliance officers at colleges/universities)
- **Output:** Run ID and dataset ID

#### Step 3: Wait for Scrape
- **Node:** `Wait for Scrape` (120 second delay)
- **Action:** Pauses 2 minutes to allow Apify to complete scraping
- **Output:** Ready to fetch results

#### Step 4: Get Scraped Leads
- **Node:** `Get Scraped Leads` (HTTP GET from Apify)
- **Input:** Uses run ID from Step 2
- **Action:** Retrieves all scraped results from Apify dataset
- **Output:** Array of leads with name, domain, phone, location, job title

**Sample Output:**
```json
{
  "name": "John Smith",
  "domain": "college.edu",
  "phone": "+1-555-0000",
  "state": "Georgia",
  "jobTitle": "Athletic Director"
}
```

#### Step 5: Parse Leads
- **Node:** `Parse Leads` (Code/JavaScript)
- **Input:** Raw Apify results
- **Action:** Extracts and normalizes fields
- **Output:** Structured lead objects with:
  - `full_name`: extracted name
  - `organization`: university name
  - `website`: domain
  - `title`: job title
  - `state`: location
  - `source`: "apify_google" etc.

#### Step 6: Loop Over Leads (Batch Processing)
- **Node:** `Loop Over Leads` (SplitInBatches: 1 lead per iteration)
- **Action:** Iterates through each scraped lead one at a time
- **Output:** Individual lead object to next node

#### Step 7: Find Email (Hunter.io)
- **Node:** `Find Email (Hunter.io)` (HTTP GET Hunter API)
- **Input:** 
  - Domain: extracted from Apify result
  - First name, last name: parsed from full name
- **Action:** Queries Hunter.io email finder API to find valid work email for this person
- **Output:** Email address + confidence score

**How Hunter.io Works:**
- Takes domain + person name
- Returns most likely business email (e.g., `john.smith@college.edu`)
- Includes confidence score (0-100)
- Marks as verified/unverified

#### Step 8: Enrich Lead
- **Node:** `Enrich Lead` (Code)
- **Input:** Apify lead + Hunter.io email result
- **Action:** Combines all data, determines status
  - If email found → status = "ready"
  - If no email → status = "no_email"
- **Output:** Fully enriched lead object

**Sample Output:**
```json
{
  "full_name": "John Smith",
  "email": "john.smith@college.edu", // or null
  "organization": "Georgia Tech",
  "title": "Athletic Director",
  "state": "GA",
  "email_confidence": 85,
  "status": "ready"
}
```

#### Step 9: Insert Lead to Supabase
- **Node:** `Insert Lead to Supabase` (Supabase insert)
- **Input:** Enriched lead object
- **Action:** Inserts into `nil.leads` table
- **Output:** Lead ID + timestamp

**Supabase Table: `nil.leads`**
```
lead_id (PK)
full_name
email
phone
organization
title
state
website
linkedin_url
source
status (ready | no_email | outreach_started | replied | bounced)
email_confidence
created_at
updated_at
```

#### Step 10: Loop Back
- **Node:** `Loop Back` (NoOp)
- **Action:** Signals to loop processor to fetch next lead
- **Output:** Triggers next iteration

#### Step 11: Summarize Results
- **Node:** `Summarize Results` (Code)
- **Input:** All completed lead insertions
- **Action:** Counts total, with_email, without_email, high_confidence
- **Output:** Summary object

#### Step 12: Notify Telegram
- **Node:** `Notify Telegram Success` (HTTP POST)
- **Input:** Summary stats
- **Action:** Posts message to Telegram ops chat
- **Output:** ✅ Lead Generation Complete (X leads, Y with email)

---

### Telegram Bot Alignment: `/leads` Command

When you run `/leads` in the Telegram bot, it displays:
- **Total Leads:** Count from `nil.leads` table
- **New Today:** Leads created in last 24 hours
- **With Email:** Ready status count
- **Status Dashboard:** ready | started | replied | no_email | bounced

The bot also provides filtering by status, so you can see which leads are ready for outreach vs. already contacted.

---

## Workflow 2: NIL Instantly Campaign Loader (Email Outreach)

**Purpose:** Queue generated leads into Instantly.ai campaign for automated outreach  
**Frequency:** Every 4 hours (6x per day)  
**Duration:** ~5-15 minutes depending on number of ready leads

### How It Works

#### Step 1: Every 4 Hours Trigger
- **Node:** `Every 4 Hours` (Cron: `0 */4 * * *`)
- **Action:** Triggers at 12am, 4am, 8am, 12pm, 4pm, 8pm
- **Output:** Starts the workflow

#### Step 2: Get Ready Leads
- **Node:** `Get Ready Leads` (Supabase query)
- **Query Conditions:**
  - `status = "ready"` (not yet contacted)
  - `email IS NOT NULL` (has valid email)
- **Sort:** By `created_at` ascending (oldest first—first-come-first-served)
- **Limit:** 20 leads per 4-hour batch
- **Output:** Array of up to 20 ready leads

#### Step 3: Check If Leads Exist
- **Node:** `Check If Leads Exist` (If/Else condition)
- **Condition:** `count > 0`?
- **True:** Process leads
- **False:** Skip to summarize (no leads waiting)

#### Step 4: Loop Over Leads
- **Node:** `Loop Over Leads` (SplitInBatches: 1 lead per iteration)
- **Action:** Processes each lead one at a time
- **Output:** Individual lead object

#### Step 5: Detect Role & Strategy (Support Exclusion)
- **Node:** `Detect Role & Strategy` (Code)
- **Action:** 
  ```javascript
  const email = String(leadData.email || '').toLowerCase().trim();
  
  // CRITICAL: Exclude support inbox from outreach
  if (email === 'support@mynilwealthstrategies.com' || 
      email === 'support@mynilwealthstrategis.com') {
    return []; // Skip this lead entirely
  }
  ```
- **Purpose:** Ensures support inbox NEVER gets outreach emails (only replies)
- **Output:** Filtered lead with first name, last name, organization, title

**This is the key separation:**
- **Programs lane (outreach):** Coaches, athletic directors, trainers → sent to Instantly campaign
- **Support lane (replies):** support@mynilwealthstrategies.com → receives replies only, excluded from campaign

#### Step 6: **[LEGACY - NO LONGER USED] Generate 3 Email Versions**
- **Node:** `Generate 3 Email Versions` (Commented out / bypassed)
- **Why removed:** Instantly handles all copy personalization via campaign templates
- **What was:** Usually calls ChatGPT to generate pain-point, opportunity, social-proof variants

#### Step 7: **[LEGACY - NO LONGER USED] Select Best Version**
- **Node:** `Select Best Version` (Commented out)
- **Why removed:** Instantly template selection happens in Instantly.ai UI, not in workflow

#### Step 8: **[LEGACY - NO LONGER USED] Prepare Email Data**
- **Node:** `Prepare Email Data` (Commented out)
- **Why removed:** Instantly API doesn't need pre-selected versions

#### Step 9: Add to Instantly Campaign
- **Node:** `Add to Instantly Campaign` (HTTP POST to Instantly API)
- **Endpoint:** `https://api.instantly.ai/v1/lead/add`
- **Input:**
  ```json
  {
    "api_key": "$INSTANTLY_API_KEY",
    "campaign_id": "$INSTANTLY_OUTREACH_CAMPAIGN_ID",
    "email": "john.smith@college.edu",
    "first_name": "John",
    "last_name": "Smith",
    "company_name": "Georgia Tech",
    "personalization": "Athletic Director",
    "custom_intro": "" // Empty—let Instantly template handle copy
  }
  ```
- **Action:** Registers lead in Instantly campaign
- **Output:** Instantly lead ID + status

**What Instantly Does:**
- Stores lead in campaign
- Assigns to active campaign sequences
- Instantly handles:
  - Email template rendering
  - Personalization (name, company, role)
  - Follow-up scheduling (3-5 emails over 2-3 weeks)
  - Bounce/unsubscribe management
  - Reply detection

**Conversation Flow in Instantly:**
```
Day 1 (9am):  Email #1 (Introduction) → Lead added
Day 3 (10am): Email #2 (Value prop) if no reply
Day 5 (2pm):  Email #3 (Social proof) if no reply
Day 10 (4pm): Email #4 (Final reach) if no reply
```

#### Step 10: Track Sequence in Supabase
- **Node:** `Track Sequence in Supabase` (Supabase insert)
- **Table:** `nil.email_sequences`
- **Fields:**
  - `lead_id`: Link to lead
  - `sequence_number`: 1 (intro email)
  - `email_type`: "intro"
  - `status`: "queued"
  - `scheduled_at`: Now + 5 minutes (ready for Instantly)
- **Purpose:** Track which leads have been queued; allows resume if job fails

#### Step 11: Update Lead Status
- **Node:** `Update Lead Status` (Supabase update)
- **Query:** Find lead by ID
- **Update:**
  ```json
  {
    "status": "outreach_started",
    "last_contacted_at": "2026-03-03T14:23:00Z"
  }
  ```
- **Purpose:** Mark lead as no longer "ready"; indicates outreach has begun

#### Step 12: Log Metric
- **Node:** `Log Metric` (Supabase insert)
- **Table:** `nil.lead_metrics`
- **Insert:**
  ```json
  {
    "lead_id": "123",
    "metric_type": "email_sent",
    "metric_value": 1,
    "metadata": { "campaign": "instantly_outreach", "sequence": 1 }
  }
  ```
- **Purpose:** Track "email sent" event for analytics dashboard

#### Step 13: Loop Back
- **Node:** `Loop Back` (NoOp)
- **Action:** Signals to process next lead

#### Step 14: Summarize Batch
- **Node:** `Summarize Batch` (Code)
- **Action:** Counts total leads sent in this batch
- **Output:** `{ total_sent: 12, timestamp: "..." }`

#### Step 15: Notify Telegram
- **Node:** `Notify Telegram Success` (HTTP POST)
- **Message Format:**
  ```
  📧 Email Outreach Batch Complete
  
  ✅ Sent: 12 emails
  🤖 Campaign: Instantly.ai
  ⏱️ Time: <timestamp>
  
  💡 Check /dashboard for updated metrics
  ```

---

### Telegram Bot Alignment: Dashboard & Metrics

In the Telegram bot:
- **Dashboard shows:** "Email Outreach Batch Running" status
- **/leads command:** Shows "outreach_started" count
- **/analytics command:** Shows "emails sent today" (pulls from lead_metrics)
- **All Queues → Urgent/Needs Reply:** Filters for conversations with replies (from Support Handler workflow)

---

## Workflow 3: NIL Support Handler (Instantly.ai Replies)

**Purpose:** Monitor Instantly.ai for incoming replies and create support tickets  
**Frequency:** Every 15 minutes (24/7)  
**Duration:** ~1-3 minutes

### How It Works

#### Step 1: Every 15 Minutes Trigger
- **Node:** `Every 15 Minutes` (Cron: `*/15 * * * *`)
- **Action:** Runs at :00, :15, :30, :45 of every hour
- **Output:** Starts workflow

#### Step 2: Get Campaign Replies
- **Node:** `Get Campaign Replies` (HTTP GET to Instantly API)
- **Endpoint:** `https://api.instantly.ai/v1/analytics/campaign/{CAMPAIGN_ID}/emails`
- **Parameters:**
  ```
  api_key: $INSTANTLY_API_KEY
  campaign_id: $INSTANTLY_OUTREACH_CAMPAIGN_ID
  skip: 0
  limit: 50
  ```
- **Action:** Retrieves all emails in campaign (both sent and replied)
- **Output:** Array of email records with metadata

**Sample Response:**
```json
{
  "data": [
    {
      "email": "john.smith@college.edu",
      "first_name": "John",
      "last_name": "Smith",
      "replied": true,
      "reply_count": 1,
      "replied_at": "2026-03-03T14:15:00Z",
      "reply_snippet": "Thanks for reaching out! Interested in learning more...",
      "status": "replied"
    }
  ]
}
```

#### Step 3: Filter Recent Replies
- **Node:** `Filter Recent Replies` (Code)
- **Logic:**
  ```javascript
  const replies = allEmails.filter(email => {
    const hasReply = email.replied === true || email.reply_count > 0;
    const replyDate = email.replied_at ? new Date(email.replied_at) : null;
    const isRecent = replyDate && replyDate > yesterday; // Last 24 hours
    
    return hasReply && isRecent;
  });
  ```
- **Purpose:** Only process new replies from the last 24 hours (avoids reprocessing old replies)
- **Output:** Array of new replies

#### Step 4: Check If Replies Exist
- **Node:** `Check If Replies Exist` (If/Else)
- **Condition:** `count > 0`?
- **True:** Process replies
- **False:** Skip to summarize

#### Step 5: Loop Over Replies
- **Node:** `Loop Over Replies` (SplitInBatches: 1 reply per iteration)
- **Action:** Processes each reply one at a time

#### Step 6: Find Lead in Supabase
- **Node:** `Find Lead in Supabase` (Supabase query)
- **Query:** 
  ```sql
  SELECT * FROM nil.leads 
  WHERE email = '{reply_email}' 
  LIMIT 1
  ```
- **Output:** Lead record if found, or null if new sender

#### Step 7: Process Reply Data
- **Node:** `Process Reply Data` (Code)
- **Logic:**
  ```javascript
  if (leadResults.length === 0) {
    // Lead doesn't exist (new contact?)
    return { lead_exists: false, reply_email: "...", ... };
  }
  
  // Lead found - use their name, org, etc.
  const lead = leadResults[0];
  return { lead_exists: true, lead_id: lead.id, ... };
  ```
- **Purpose:** Prepare data for ticket creation (use lead info if available)
- **Output:** Processed reply with lead metadata

#### Step 8: Create Support Ticket
- **Node:** `Create Support Ticket` (Supabase insert)
- **Table:** `nil.support_tickets`
- **Insert:**
  ```json
  {
    "lead_id": "123 or null",
    "contact_name": "John Smith",
    "contact_email": "john.smith@college.edu",
    "subject": "Reply to NIL Outreach",
    "message": "Thanks for reaching out! Interested in learning more...",
    "source": "instantly_reply",
    "status": "new",
    "priority": "medium"
  }
  ```
- **Purpose:** Create operatable ticket in support queue
- **Supabase Table: `nil.support_tickets`**
  ```
  ticket_id (PK)
  lead_id (FK to leads, nullable)
  contact_name
  contact_email
  subject
  message
  source (instantly_reply | form_submission | email)
  status (new | in_progress | resolved | closed)
  priority (low | medium | high)
  created_at
  updated_at
  ```

#### Step 9: Update Lead Status
- **Node:** `Update Lead Status` (Supabase update)
- **Condition:** Only if `lead_id` exists
- **Update:**
  ```json
  {
    "status": "replied",
    "last_reply_at": "2026-03-03T14:15:00Z"
  }
  ```
- **Purpose:** Mark lead as no longer in "outreach_started"—they've engaged!

#### Step 10: Log Reply Metric
- **Node:** `Log Reply Metric` (Supabase insert)
- **Table:** `nil.lead_metrics`
- **Insert:**
  ```json
  {
    "lead_id": "123",
    "metric_type": "email_reply",
    "metric_value": 1,
    "metadata": { "source": "instantly", "replied_at": "..." }
  }
  ```
- **Purpose:** Track reply event for analytics

#### Step 11: Notify Telegram Reply
- **Node:** `Notify Telegram Reply` (HTTP POST)
- **Message:**
  ```
  🎯 NEW REPLY RECEIVED!
  
  👤 From: John Smith
  📧 Email: john.smith@college.edu
  🏢 Org: Georgia Tech
  
  💬 Message Preview:
  Thanks for reaching out! Interested in learning more...
  
  ✅ Support ticket created
  ⏱️ <timestamp>
  
  💡 Check /dashboard to respond
  ```
- **Action:** Immediately alerts Telegram admins of new engagement

#### Step 12: Loop Back
- **Node:** `Loop Back` (NoOp)
- **Action:** Process next reply

#### Step 13: Summarize Replies
- **Node:** `Summarize Replies` (Code)
- **Output:** Count of replies processed

#### Step 14: Notify Telegram Summary
- **Node:** `Notify Telegram Summary` (HTTP POST)
- **Message:**
  ```
  ✅ Support Check Complete
  
  📬 New Replies: 3
  ⏱️ <timestamp>
  ```

---

### Telegram Bot Alignment: Support Workflows

In the Telegram bot:
- **/dashboard → "Needs Reply":** Queries conversations with `status = "replied"` in leads table
- **Reply card displays:** Contact info + reply message + link to support system
- **✍️ Drafts button:** Generates V1/V2/V3 responses using OpenAI (gpt-4o-mini)
- **📤 Send button:** Locks draft selection → sends reply back to support email
- **Support Handler workflow creates conversations:** Each ticket becomes a conversation in bot that you can reply to

---

## Workflow 4: NIL Analytics Sync (Instantly.ai Tracking)

**Purpose:** Sync Instantly campaign metrics (opens, clicks, bounces, replies) into analytics tables  
**Frequency:** Every hour (24/7)  
**Duration:** ~2-5 minutes

### How It Works

#### Step 1: Every Hour Trigger
- **Node:** `Every Hour` (Cron: `0 * * * *`)
- **Action:** Runs at :00 of every hour
- **Output:** Starts workflow

#### Step 2: Get Campaign Analytics
- **Node:** `Get Campaign Analytics` (HTTP GET Instantly API)
- **Endpoint:** `https://api.instantly.ai/v1/analytics/campaign/{CAMPAIGN_ID}/emails`
- **Parameters:**
  ```
  api_key: $INSTANTLY_API_KEY
  campaign_id: $INSTANTLY_OUTREACH_CAMPAIGN_ID
  skip: 0
  limit: 100 (to get all emails with events)
  ```
- **Output:** Full email dataset with event flags

**Events Tracked by Instantly:**
- `sent`: Email successfully delivered
- `opened`: Recipient opened email (if tracking enabled)
- `clicked`: Recipient clicked link
- `replied`: Recipient sent reply
- `bounced`: Email delivery failed
- `unsubscribed`: Recipient unsubscribed

#### Step 3: Parse & Transform Events
- **Node:** `Parse Events` (Code, conceptually)
- **Logic:** For each email with events, extract:
  ```json
  {
    "lead_id": "123",
    "email": "john.smith@college.edu",
    "opened_at": "2026-03-02T10:15:00Z",
    "clicked_at": "2026-03-02T10:20:00Z",
    "replied_at": "2026-03-02T14:30:00Z",
    "bounced_at": null,
    "unsubscribed_at": null
  }
  ```

#### Step 4: Match to Leads
- **Node:** `Match to Leads` (Supabase join)
- **Logic:** For each email, find corresponding lead by email address
- **Purpose:** Link Instantly events to our lead records

#### Step 5: Insert/Update Metrics
- **Node:** `Insert Metrics` (Supabase operations)
- **For each event type detected:**
  ```sql
  INSERT INTO nil.lead_metrics (lead_id, metric_type, metric_value, metadata)
  VALUES (123, 'email_open', 1, {...})
  ```
  
**Metric Types:**
- `email_sent`: Email queued or delivered
- `email_open`: Recipient opened email
- `email_click`: Recipient clicked link
- `email_reply`: Recipient sent reply
- `email_bounce`: Email bounced
- `email_unsubscribe`: Recipient unsubscribed

#### Step 6: Update Lead Timestamps
- **Node:** `Update Timestamps` (Supabase update)
- **Updates:**
  ```json
  {
    "opened_at": "2026-03-02T10:15:00Z if opened",
    "clicked_at": "2026-03-02T10:20:00Z if clicked",
    "replied_at": "2026-03-02T14:30:00Z if replied"
  }
  ```

#### Step 7: Calculate Engagement Score
- **Node:** `Calculate Engagement` (Code)
- **Logic:**
  ```javascript
  let score = 0;
  if (opened) score += 5;
  if (clicked) score += 10;
  if (replied) score += 25;
  if (bounced) score -= 15;
  ```
- **Purpose:** Rank leads by engagement for triage

#### Step 8: Update Lead Engagement
- **Node:** `Update Engagement` (Supabase update)
- **Update:** `engagement_score` field in leads table

#### Step 9: Notify Telegram Summary
- **Node:** `Notify Telegram Summary` (HTTP POST)
- **Message:**
  ```
  📊 Analytics Sync Complete
  
  📧 Emails sent: 120
  👁️ Opens: 45 (37.5%)
  🔗 Clicks: 12 (10%)
  💬 Replies: 3 (2.5%)
  ❌ Bounces: 2
  
  ⏱️ <timestamp>
  ```

---

### Telegram Bot Alignment: Analytics Dashboard

In the Telegram bot:
- **/dashboard → "Metrics":** Shows:
  - Total opens, clicks, replies
  - Open rate, click rate, reply rate
  - Monthly breakdown
  - Best week/month
  - Trends
- **/leads → Status view:** Sorted by engagement_score (highest first)
- **Conversation cards:** Display engagement metrics when you open a conversation

---

## Workflow 5: NIL Instant Submission (Vercel → SMS + Email)

**Purpose:** Process website form submissions with instant SMS + Email alerts  
**Frequency:** Real-time (triggered by form submission)  
**Duration:** ~5 seconds

### How It Works

#### Step 1: Webhook Trigger
- **Node:** `Webhook Trigger` (n8n webhook)
- **Endpoint:** `https://your-n8n-instance/webhook/vercel-instant-submission`
- **Method:** POST
- **Input:** JSON payload from Vercel form
  ```json
  {
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane@example.com",
    "phone": "+1-404-555-1234",
    "state": "California",
    "role": "parent",
    "coverage_accident": true,
    "coverage_hospital_indemnity": false,
    "athlete_name": "Sarah Doe",
    "sport": "Swimming",
    "notes": "Very interested"
  }
  ```

#### Step 2: Validate Submission
- **Node:** `Validate Submission` (Code)
- **Action:**
  ```javascript
  const submissionId = body.idempotency_key || 
    `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const submission = {
    submission_id: submissionId,
    first_name: body.first_name || '',
    email: body.email || '',
    phone: body.phone || '',
    state: body.state || '',
    role: body.role || 'parent',
    coverage_accident: body.coverage_accident || false,
    coverage_hospital_indemnity: body.coverage_hospital_indemnity || false,
    athlete_name: body.athlete_name || '',
    sport: body.sport || '',
    notes: body.notes || ''
  };
  
  return [{ json: submission }];
  ```
- **Purpose:** Normalize fields, generate idempotency key for deduplication
- **Output:** Standardized submission object

#### Step 3: Store in Supabase
- **Node:** `Store in Supabase` (Supabase insert)
- **Table:** `nil.submissions`
- **Insert:**
  ```json
  {
    "submission_id": "sub_1704186000000_abc123",
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane@example.com",
    "phone": "+1-404-555-1234",
    "state": "California",
    "role": "parent",
    "coverage_accident": true,
    "coverage_hospital_indemnity": false,
    "athlete_name": "Sarah Doe",
    "sport": "Swimming",
    "notes": "Very interested",
    "submission_payload": { ...full_payload... },
    "created_at": "2026-03-03T14:30:00Z"
  }
  ```
- **Supabase Table: `nil.submissions`**
  ```
  submission_id (PK)
  first_name
  last_name
  email
  phone
  state
  role (parent | athlete | coach | trainer | other)
  coverage_accident (boolean)
  coverage_hospital_indemnity (boolean)
  athlete_name
  sport
  notes
  submission_payload (JSON)
  created_at
  ```

#### Step 4: Send Email via SendGrid
- **Node:** `Send Email via SendGrid` (HTTP POST SendGrid API)
- **Email Details:**
  - **To:** jane@example.com
  - **From:** hello@mynilwealthstrategies.com
  - **Template:** Dynamic SendGrid template
  - **Personalization:**
    ```json
    {
      "first_name": "Jane",
      "athlete_name": "Sarah Doe",
      "sport": "Swimming",
      "coverage_type": "Accident Coverage",
      "calendly_link": "https://calendly.com/protection-mynilwealthstrategies/questions"
    }
    ```
- **Template renders:** Welcome email with Calendly link
- **Output:** Message ID from SendGrid

#### Step 5: Send SMS via Twilio
- **Node:** `Send SMS via Twilio` (HTTP POST Twilio API)
- **SMS Details:**
  - **To:** +1-404-555-1234 (from submission)
  - **From:** $TWILIO_FROM_NUMBER
  - **Body:**
    ```
    Hi Jane! Thanks for submitting your details. 
    Our team will follow up shortly. 
    Schedule a call: https://calendly.com/protection-mynilwealthstrategies/questions
    ```
- **Output:** SID from Twilio (message tracked)

#### Step 6: Alert Telegram
- **Node:** `Notify Telegram` (HTTP POST Telegram API)
- **Message:**
  ```
  🎉 NEW FORM SUBMISSION
  
  👤 Jane Doe
  📧 jane@example.com
  📱 +1-404-555-1234
  
  🏃 Athlete: Sarah Doe
  🏊 Sport: Swimming
  
  📋 Coverage:
  ✓ Accident Coverage
  ✗ Hospital Indemnity
  
  💬 Notes: Very interested
  
  ✅ Email sent
  ✅ SMS sent
  ⏱️ <timestamp>
  ```
- **Output:** Telegram message delivered

#### Step 7: Return Success Response
- **Node:** `Return Success` (Webhook response)
- **Response:**
  ```json
  {
    "success": true,
    "submission_id": "sub_1704186000000_abc123",
    "message": "Submission processed. Email and SMS sent."
  }
  ```
- **HTTP Status:** 200 OK

---

### Telegram Bot Alignment: Submissions Queue

In the Telegram bot:
- **/dashboard → "Submissions":** Shows recent form submissions
- **Click to open:** Full submission details + phone (clickable tel: link) + email
- **Submission card displays:** Coverage selections, athlete info, notes
- **Parent flow:** Submission → Email sent → SMS sent → Creates person record → Can link to future lead/conversation

---

## Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       TELEGRAM BOT OPERATIONS                    │
│  (Display, Filter, Respond, Draft, Send, Monitor)               │
└──────────────────────┬────────────────────────────────────────┬──┘
                       │                                        │
        Reads/Updates  │                              Reads/Updates
                       ▼                                        ▼
    ┌────────────────────────────┐       ┌───────────────────────────┐
    │   SUPABASE (Database)       │       │   OPENAI (Draft Gen)      │
    ├────────────────────────────┤       │  (gpt-4o-mini for V1/V2/V3)
    │ leads                      │       └───────────────────────────┘
    │ support_tickets            │
    │ conversations              │     ┌───────────────────────────┐
    │ messages                   │     │  INSTANTLY.AI (Campaign)   │
    │ email_sequences            │     ├───────────────────────────┤
    │ lead_metrics               │     │ • Queues leads            │
    │ submissions                │     │ • Renders templates       │
    │ message_drafts             │     │ • Tracks opens/clicks     │
    └────────────────────────────┘     │ • Detects replies         │
             ▲                         │ • Manages follow-ups      │
             │                         └───────────────────────────┘
             │                                   ▲
             │                                   │
        Inserts/Updates               API calls (polling)
        Via n8n                              │
             │                               │
    ┌────────┴──────────────────────────────┴────────────────┐
    │                n8n WORKFLOWS (5 Total)                  │
    ├──────────────────────────────────────────────────────┤
    │                                                        │
    │  1. LEAD GENERATION (9am daily)                       │
    │     Apify → Hunter.io → Supabase                      │
    │     Output: 50 new leads with emails                  │
    │                                                        │
    │  2. CAMPAIGN LOADER (every 4 hours)                   │
    │     Get "ready" leads → Filter support → Instantly    │
    │     Output: 20 leads queued for outreach              │
    │                                                        │
    │  3. SUPPORT HANDLER (every 15 minutes)                │
    │     Instantly replies → Support tickets → Telegram    │
    │     Output: New tickets for Telegram bot              │
    │                                                        │
    │  4. ANALYTICS SYNC (every hour)                       │
    │     Instantly events → Metrics table → Engagement     │
    │     Output: Opens/clicks/replies tracked              │
    │                                                        │
    │  5. INSTANT SUBMISSION (real-time webhook)            │
    │     Form → SendGrid/Twilio → Supabase → Telegram      │
    │     Output: Immediate alerts + contact created        │
    │                                                        │
    └──────────────────────────────────────────────────────┘
             │
             │ Creates/Updates
             │
    ┌────────▼──────────────────┐
    │  EXTERNAL SERVICES         │
    ├────────────────────────────┤
    │ • Apify (Web scraping)     │
    │ • Hunter.io (Email lookup) │
    │ • Instantly.ai (Outreach)  │
    │ • SendGrid (Email)         │
    │ • Twilio (SMS)             │
    │ • OpenAI (Draft generation)│
    └────────────────────────────┘
```

---

## Workflow Timing & Coordination

### Daily Cycle (24-hour view)

```
00:00 (midnight)
  ↓
04:00 → Campaign Loader runs (Batch 1)
  ↓
08:00 → Campaign Loader runs (Batch 2)
  ↓
09:00 → LEAD GENERATION runs (Apify scrape)
  ↓
10:00 → Analytics Sync runs
  ↓
12:00 → Campaign Loader runs (Batch 3)
  ↓
Every 15 minutes: SUPPORT HANDLER checks for replies
Every 1 hour: ANALYTICS SYNC refreshes metrics
Every form submit: INSTANT SUBMISSION webhook fires
```

### Queue Status Example

**4:00 AM - Campaign Loader runs:**
- Picks 20 leads with status="ready"
- Sends to Instantly
- Updates their status to "outreach_started"
- Logs "email_sent" metric

**4:15 AM - Support Handler runs (no new replies yet)**

**9:00 AM - Lead Generation runs:**
- Scrapes 50 new contacts
- Finds emails for 45 of them
- Inserts as status="ready"

**12:00 PM - Campaign Loader runs:**
- Finds 20+ leads with status="ready" (new ones from 9am + any not yet sent)
- Sends second batch to Instantly

**12:15 PM - Support Handler runs:**
- Checks Instantly: "john.smith@college.edu replied 12:05 PM"
- Creates support_ticket
- Updates lead status to "replied"
- Posts Telegram alert

**1:00 PM - Analytics Sync runs:**
- Gets all campaign emails from Instantly
- 45 opened, 8 clicked, 1 replied
- Inserts metrics
- Updates engagement_scores

---

## Key Alignment Points: Bot ↔ Workflows

### 1. **Lead Display** (`/leads` command)

**What the bot shows:**
- Total leads (from leads table)
- Status breakdown (ready | outreach_started | replied | bounced)
- Top 10 by engagement_score
- "New Today" count

**What workflows feed it:**
- Lead Generation → Inserts into leads table (status="ready" or "no_email")
- Campaign Loader → Updates status to "outreach_started"
- Support Handler → Updates status to "replied"
- Analytics Sync → Updates engagement_score

### 2. **Dashboard/Metrics**

**What the bot shows:**
- Emails sent (from lead_metrics, type="email_sent")
- Opens (type="email_open")
- Clicks (type="email_click")
- Replies (type="email_reply")
- Rates (click_rate_pct, open_rate_pct, etc.)

**What workflows feed it:**
- Campaign Loader → Logs "email_sent" metrics
- Analytics Sync → Logs "email_open", "email_click", "email_reply" metrics
- Support Handler → Can log reply metrics explicitly

### 3. **Needs Reply Queue**

**What the bot shows:**
- Conversations/tickets with status="replied" in leads table
- Contact info + reply message preview

**What workflows feed it:**
- Support Handler → Creates support_tickets when reply detected
- Support Handler → Updates lead status to "replied"

### 4. **Drafts System** (Bot Feature)

**What the bot does:**
- Opens conversation
- Tap "✍️ Drafts V1/V2/V3"
- Calls OpenAI to generate 3 reply options
- Stores in message_drafts table
- Let's you pick, edit, regenerate
- Sends selected draft via email to support inbox

**What workflows don't do here:**
- Workflows don't generate drafts (bot does this live)
- Workflows don't edit messages (bot does this)
- Workflows don't send support responses (bot does this by inserting into email_outbox table, which a separate Outbox Sender workflow processes)

### 5. **Form Submissions Queue**

**What the bot shows:**
- New submissions (from submissions table)
- Contact info + coverage selections

**What workflows feed it:**
- Instant Submission → Inserts submission record (when webhook fires)
- Instant Submission → Sends email + SMS immediately
- Instant Submission → Posts Telegram alert

---

## Error Handling & Reliability

### Workflow 1 (Lead Generation)

**Potential Failures:**
- Apify scrape times out or returns 0 results
- Hunter.io API returns errors
- Supabase insert fails (duplicate email)

**Fallbacks:**
- If Apify fails: Telegram error alert, retry next day
- If Hunter fails: Mark as status="no_email", still insert
- If Supabase fails: Telegram error alert, logs issue for manual review

### Workflow 2 (Campaign Loader)

**Potential Failures:**
- Instantly API rejects lead (invalid email)
- No "ready" leads available
- Supabase query fails

**Fallbacks:**
- If Instantly rejects: Mark lead as status="bounced" before retry
- If no leads: Just summarize (0 sent) and notify
- If Supabase fails: Retry on next 4-hour run

### Workflow 3 (Support Handler)

**Potential Failures:**
- Instantly API returns 0 replies (normal)
- Lead not found in Supabase (new contact)
- Supabase insert fails

**Fallbacks:**
- If 0 replies: Normal operation, just summarize
- If lead not found: Still create ticket with email/name only
- If insert fails: Telegram error alert

### Workflow 4 (Analytics Sync)

**Potential Failures:**
- Instantly API slow/unavailable
- Lead not found when matching
- Metrics insert fails

**Fallbacks:**
- If API unavailable: Retry next hour
- If lead not found: Skip metrics for that email (data mismatch)
- If insert fails: Telegram error alert

### Workflow 5 (Instant Submission)

**Potential Failures:**
- SendGrid rejects email (invalid recipient)
- Twilio fails (invalid phone number)
- Supabase insert fails

**Fallbacks:**
- If SendGrid fails: Still process (log error, notify Telegram error)
- If Twilio fails: Still process (log error, notify Telegram error)
- Idempotency key prevents duplicate submissions (same key = skip)

---

## Summary Table

| Workflow | Trigger | Frequency | Input | Output | Bot Display |
|----------|---------|-----------|-------|--------|------------|
| Lead Gen | 9am EST | 1x daily | Google results | 50 leads (45 with email) | `/leads - total count` |
| Campaign | Every 4h | 6x daily | Leads (ready status) | 20 leads → Instantly | `/leads - outreach_started count` |
| Support | Every 15m | 96x daily | Instantly replies | Support tickets | Dashboard "Needs Reply" queue |
| Analytics | Every 1h | 24x daily | Instantly events | Metrics + scores | `/analytics - rates & breakdown` |
| Submission | Real-time | On form submit | Form data | Email + SMS sent | Dashboard "Submissions" queue |

---

## How to Monitor & Troubleshoot

### In Telegram Bot

- **/dashboard** → Check queue sizes, alert summary
- **/leads** → Verify new leads added, status progression
- **/analytics** → Monitor engagement metrics
- Dashboard "Urgent" queue → Any workflow errors posted here

### In Supabase

1. Open [supabase.com](https://supabase.com) → Your project
2. Go to SQL Editor
3. Run:
   ```sql
   -- Check lead progression
   SELECT status, COUNT(*) FROM nil.leads GROUP BY status;
   
   -- Check recent replies
   SELECT * FROM nil.support_tickets 
   WHERE created_at > now() - interval '24 hours'
   ORDER BY created_at DESC;
   
   -- Check metrics growth (last 24h)
   SELECT metric_type, COUNT(*) FROM nil.lead_metrics 
   WHERE created_at > now() - interval '24 hours'
   GROUP BY metric_type;
   ```

### In n8n

1. Open [n8n.cloud](https://n8n.cloud) → Your n8n instance
2. For each workflow, check **Executions** tab
3. Green = Success, Red = Failed
4. Click execution to see logs/errors

---

## Next Steps: Deployment Checklist

- [ ] Set environment variables (APIFY_ACTOR_ID, HUNTER_IO_API_KEY, etc.)
- [ ] Import all 5 workflow JSONs into n8n
- [ ] Activate workflows (enable schedule triggers)
- [ ] Run Lead Generation manually (test Apify + Hunter)
- [ ] Monitor first Campaign Loader run
- [ ] Verify first Telegram notifications
- [ ] Test Support Handler with manual reply in Instantly
- [ ] Test Instant Submission with form submission
- [ ] Run Analytics Sync to populate metrics
- [ ] Check Dashboard in Telegram for all data flowing
- [ ] Review bot `/leads`, `/analytics` commands
- [ ] Test draft generation + send flow
- [ ] Go live!
