# Message for Twin.so Team

## Issue: Missing Tables

You're seeing errors because `nil.leads` and `nil.lead_metrics` don't exist in the current Supabase database.

## Solution: Run Complete Schema

**Run this file in Supabase SQL Editor:**  
📄 **`COMPLETE_SUPABASE_SCHEMA.sql`**

### How to Run:

1. Open Supabase Dashboard → SQL Editor
2. Copy entire contents of `COMPLETE_SUPABASE_SCHEMA.sql`
3. Paste into SQL Editor
4. Click "Run" button

### What It Creates:

**New tables for n8n workflows (4):**
- ✅ `nil.leads` - Scraped leads from Apify (Workflow 1)
- ✅ `nil.lead_metrics` - Email analytics from Instantly (Workflow 4)
- ✅ `nil.support_tickets` - Reply tracking (Workflow 3)
- ✅ `nil.email_sequences` - Sequence tracking (Workflow 2)

**Plus keeps ALL existing tables:**
- ✅ `nil.coaches` (unchanged)
- ✅ `nil.metric_events` (unchanged)
- ✅ `nil.conversations` (unchanged)
- ✅ `nil.submissions` (unchanged)
- ✅ All other existing tables

### Safety Guarantees:

```sql
CREATE TABLE IF NOT EXISTS nil.leads (...)
```

- **IF NOT EXISTS** = Won't break anything
- **No DROP statements** = Won't delete data
- **No foreign keys** = No constraint errors
- **Idempotent** = Safe to run multiple times

### After Running Schema:

Your workflow queries will work:
```sql
-- This will now work:
INSERT INTO nil.leads (full_name, email, organization, ...)

-- This will now work:
INSERT INTO nil.lead_metrics (lead_id, metric_type, metric_value, ...)
```

### Schema Structure:

```
nil.leads
├── lead_id (UUID, primary key)
├── full_name (TEXT)
├── email (TEXT, unique)
├── organization (TEXT)
├── title (TEXT)
├── state (TEXT)
├── status (TEXT) - 'ready', 'outreach_started', 'replied', 'bounced'
├── engagement_score (INTEGER 0-100)
├── source (TEXT) - 'apify', 'manual', 'import'
└── metadata (JSONB)

nil.lead_metrics
├── metric_id (UUID, primary key)
├── lead_id (UUID) - links to nil.leads
├── metric_type (TEXT) - 'email_sent', 'open', 'click', 'reply', 'bounce'
├── metric_value (INTEGER)
├── recorded_at (TIMESTAMPTZ)
├── metadata (JSONB)
└── instantly_event_id (TEXT, unique) - deduplication key
```

### Why New Tables vs Old Tables?

**Old approach (what you're trying):**
- Use `nil.coaches` for leads → ❌ Coaches are different from leads
- Use `nil.metric_events` for engagement → ❌ Generic events table, no lead relationship

**New approach (designed for workflows):**
- Use `nil.leads` for leads → ✅ Purpose-built for Apify scraping
- Use `nil.lead_metrics` for engagement → ✅ Linked to leads, tracks Instantly events

### Workflow Data Flow:

```
Workflow 1: Apify → Hunter.io → INSERT nil.leads (status='ready')
Workflow 2: SELECT nil.leads WHERE status='ready' → Instantly API → UPDATE status='outreach_started'
Workflow 3: Instantly API (replies) → INSERT nil.support_tickets
Workflow 4: Instantly API (analytics) → INSERT nil.lead_metrics → UPDATE nil.leads.engagement_score
Workflow 5: Website form → INSERT nil.submissions
```

### Next Steps:

1. ✅ Run `COMPLETE_SUPABASE_SCHEMA.sql` in Supabase (takes ~10 seconds)
2. ✅ Verify tables exist: `SELECT * FROM nil.leads LIMIT 1;`
3. ✅ Import workflow JSONs into n8n
4. ✅ Configure credentials (Instantly, Apify, Hunter.io, Supabase)
5. ✅ Test each workflow manually

### If You Get Errors:

**"relation already exists"** → Ignore, that's fine (IF NOT EXISTS)  
**"schema nil does not exist"** → Run line 38 first: `CREATE SCHEMA IF NOT EXISTS nil;`  
**Any other error** → Run the entire script again (it's idempotent)

### Verification Query:

After running, test with:
```sql
-- Check all tables exist
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'nil' 
ORDER BY table_name;

-- Should see:
-- nil.leads ✅
-- nil.lead_metrics ✅
-- nil.support_tickets ✅
-- nil.email_sequences ✅
-- nil.conversations ✅
-- nil.submissions ✅
-- (plus 16 more tables)
```

### Questions?

The schema is designed to:
- ✅ Work with all 5 n8n workflow JSONs (no modifications needed)
- ✅ Support Telegram bot queries (via ops() helper)
- ✅ Handle Instantly.ai integration
- ✅ Track full lead lifecycle: scraped → outreach → replied

Just run the SQL file - everything should work after that!

---

## TL;DR

```bash
# 1. Copy COMPLETE_SUPABASE_SCHEMA.sql
# 2. Paste into Supabase SQL Editor
# 3. Click Run
# 4. Done - nil.leads and nil.lead_metrics now exist
```

**File:** `COMPLETE_SUPABASE_SCHEMA.sql` (668 lines, all tables + views)  
**Time:** ~10 seconds to run  
**Safe:** Yes, uses IF NOT EXISTS, no data deletion  
**Ready:** Import workflow JSONs after this completes
