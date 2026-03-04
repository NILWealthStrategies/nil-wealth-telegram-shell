# NIL Wealth Telegram Bot + n8n Workflows

Complete automation system for lead generation, outreach, and support management.

---

## 🚀 Quick Start for Twin.so Team

### Step 1: Run Database Schema (5 minutes)

**READ THIS FIRST:** [MESSAGE_FOR_TWIN_SO.md](MESSAGE_FOR_TWIN_SO.md)

1. Open Supabase SQL Editor
2. Copy entire [COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql) file
3. Paste and click "Run"
4. Verify: `SELECT * FROM nil.leads LIMIT 1;`

**⚠️ DO NOT import workflows until schema is created!**

---

### Step 2: Read Implementation Guide (10 minutes)

**Primary Documentation:** [TWIN_SO_IMPLEMENTATION_BRIEF.md](TWIN_SO_IMPLEMENTATION_BRIEF.md)

Key sections:
- **Section 3:** Two separate email systems (CRITICAL - read first!)
- **Section 2:** API credentials needed
- **Section 6:** Support inbox exclusion logic
- **Section 12:** Deployment checklist

---

### Step 3: Import Workflows (15 minutes)

Import these 5 JSON files into n8n:

1. [n8n-lead-generation-workflow.json](n8n-lead-generation-workflow.json) - Apify + Hunter.io scraping
2. [n8n-email-outreach-workflow.json](n8n-email-outreach-workflow.json) - Instantly campaign loader
3. [n8n-support-handler-workflow.json](n8n-support-handler-workflow.json) - Reply monitoring
4. [n8n-analytics-sync-workflow.json](n8n-analytics-sync-workflow.json) - Metrics tracking
5. [n8n-instant-submission-workflow.json](n8n-instant-submission-workflow.json) - Form submissions

---

### Step 4: Configure Credentials

See section 2 in [TWIN_SO_IMPLEMENTATION_BRIEF.md](TWIN_SO_IMPLEMENTATION_BRIEF.md) for:
- Supabase (schema: `nil`)
- Instantly.ai API + Campaign ID
- Apify API
- Hunter.io API
- Telegram bot token

**Ask client for missing keys:** See section 13 questions

---

### Step 5: Test & Deploy

1. Test each workflow manually (section 9)
2. Verify support@ exclusion (section 6)
3. Activate workflow schedules
4. Monitor Telegram for 24 hours

---

## 📊 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ SYSTEM 1: OUTREACH (Instantly.ai)                          │
├─────────────────────────────────────────────────────────────┤
│ Workflow 1: Apify → Hunter.io → nil.leads                  │
│ Workflow 2: nil.leads → Instantly campaign                 │
│ Workflow 3: Instantly replies → nil.support_tickets        │
│ Workflow 4: Instantly analytics → nil.lead_metrics         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SYSTEM 2: SUPPORT INBOX (Gmail)                            │
├─────────────────────────────────────────────────────────────┤
│ Gmail support@ → n8n webhook → nil.conversations           │
│ (Separate system - not in these 5 workflows)               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SYSTEM 3: WEBSITE FORMS                                    │
├─────────────────────────────────────────────────────────────┤
│ Workflow 5: Form POST → nil.submissions → Email/SMS        │
└─────────────────────────────────────────────────────────────┘
```

**NEVER add support@mynilwealthstrategies.com to Instantly campaign!**

---

## 📁 File Guide

### For Twin.so (Workflow Builders)
- ✅ **[MESSAGE_FOR_TWIN_SO.md](MESSAGE_FOR_TWIN_SO.md)** - Read FIRST
- ✅ **[COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql)** - Run in Supabase (step 0)
- ✅ **[TWIN_SO_IMPLEMENTATION_BRIEF.md](TWIN_SO_IMPLEMENTATION_BRIEF.md)** - Implementation guide
- ✅ **5 workflow JSON files** - Import into n8n

### For Client (Reference)
- 📖 **[WORKFLOWS_DETAILED_OVERVIEW.md](WORKFLOWS_DETAILED_OVERVIEW.md)** - Technical deep dive
- 📖 **[N8N_WORKFLOWS.md](N8N_WORKFLOWS.md)** - Architecture overview
- 🤖 **[src/index.js](src/index.js)** - Telegram bot source code

### Historical (Context Only)
- 📜 **[SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql)** - Old schema (don't use)
- 📜 **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)** - Old deployment guide (outdated)

---

## 🔑 Required API Keys

Ask client for these (section 13 of implementation brief):

**Required:**
- INSTANTLY_API_KEY
- INSTANTLY_OUTREACH_CAMPAIGN_ID
- APIFY_API_KEY
- HUNTER_IO_API_KEY

**Optional:**
- OPENAI_API_KEY (bot V1/V2/V3 draft feature)
- SENDGRID_API_KEY (Workflow 5 emails)
- TWILIO credentials (Workflow 5 SMS)

---

## 🎯 Success Criteria

After setup, you should see:

✅ Workflow 1: New leads in `nil.leads` (status='ready')  
✅ Workflow 2: Leads added to Instantly campaign (status='outreach_started')  
✅ Workflow 3: Replies create tickets in `nil.support_tickets`  
✅ Workflow 4: Metrics populate `nil.lead_metrics`  
✅ Workflow 5: Form submissions create `nil.submissions` + alerts  
✅ Telegram bot: All commands work (`/dashboard`, `/leads`, `/analytics`)

---

## 🐛 Common Issues

### "Table nil.leads does not exist"
**Cause:** Imported workflows before running schema  
**Fix:** Run [COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql) in Supabase

### "Cannot insert into nil.lead_metrics"
**Cause:** Using old schema (nil.metric_events) instead of new schema  
**Fix:** Run [COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql) to create new tables

### "support@mynilwealthstrategies.com added to campaign"
**Cause:** Exclusion logic not working  
**Fix:** Check node "Detect Role & Strategy" in Workflow 2 (lines 89-95 of JSON)

---

## 📞 Support

**Implementation Questions:** See [TWIN_SO_IMPLEMENTATION_BRIEF.md](TWIN_SO_IMPLEMENTATION_BRIEF.md) section 13  
**Technical Questions:** See [WORKFLOWS_DETAILED_OVERVIEW.md](WORKFLOWS_DETAILED_OVERVIEW.md)  
**Schema Questions:** See [COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql) header comments

---

## ⏱️ Timeline

- Schema setup: 5 minutes
- Read documentation: 10 minutes
- Import workflows: 15 minutes
- Configure credentials: 30 minutes
- Test workflows: 45 minutes
- Deploy & monitor: 30 minutes

**Total: ~2.5 hours** (assuming all API keys available)

---

## 🚦 Start Here

1. 📋 **[MESSAGE_FOR_TWIN_SO.md](MESSAGE_FOR_TWIN_SO.md)** ← Read this first
2. 🗄️ **[COMPLETE_SUPABASE_SCHEMA.sql](COMPLETE_SUPABASE_SCHEMA.sql)** ← Run this second
3. 📖 **[TWIN_SO_IMPLEMENTATION_BRIEF.md](TWIN_SO_IMPLEMENTATION_BRIEF.md)** ← Read this third
4. 🔧 Import 5 workflow JSONs into n8n
5. ✅ Test and deploy

**Questions?** All answers are in the documentation above. Start with MESSAGE_FOR_TWIN_SO.md.
