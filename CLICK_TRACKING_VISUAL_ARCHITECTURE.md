# Click Tracking System: Visual Architecture & Quick Lookup

---

## System Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLICK TRACKING ECOSYSTEM                          │
└─────────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════════════╗
║                              DATA SOURCES (Click Origins)                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

Source 1: EMAIL CAMPAIGNS                Source 2: WEBSITE GUIDE
┌─────────────────────────────┐         ┌──────────────────────────────┐
│ Instantly.ai Campaign        │         │ Parent Guide Page            │
│ ├─ Coach receives email      │         │ ├─ Parent opens guide        │
│ ├─ Coach clicks link         │         │ ├─ Parent clicks sections    │
│ └─ Link redirects to site    │         │ └─ JavaScript logs click     │
└──────────┬──────────────────┘         └──────────────┬───────────────┘
           │                                           │
           │ (Instantly.ai API)                        │ (CF Worker)
           ↓                                           ↓

┌──────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER (Link Tracking)                     │
│  https://niltracker.yourdomain.com/r/{code}                             │
│                                                                          │
│  Features:                                                              │
│  ├─ Redirect short link → actual URL                                  │
│  ├─ Capture device type (mobile/desktop)                               │
│  ├─ Get IP geolocation (CF headers)                                    │
│  ├─ Detect email client (user agent)                                   │
│  ├─ Log request metadata                                               │
│  └─ Send to Supabase (async)                                           │
└──────────┬───────────────────────────────────────────────────────────────┘
           │
           │ (Every click + metadata)
           ↓

╔══════════════════════════════════════════════════════════════════════════════╗
║                          N8N WORKFLOW 4 (Processor)                           ║
║  "Analytics Sync" - Runs every 30 minutes                                    ║
║                                                                              ║
║  Steps:                                                                      ║
║  1. Get Campaign Analytics (HTTP GET to Instantly.ai)                       ║
║  2. Filter for click events only                                            ║
║  3. Extract click URL, link text, position                                  ║
║  4. Detect email client from user agent                                     ║
║  5. Extract CF tracking code                                               ║
║  6. Lookup lead by email address                                           ║
║  7. INSERT to nil.click_events (with full metadata)                        ║
║  8. UPDATE nil.click_link_registry (stats)                                 ║
║  9. INSERT to nil.lead_metrics (legacy compat)                             ║
║  10. Update lead engagement_score                                          ║
║  11. Notify Telegram bot (summary message)                                 ║
╚──────────────┬──────────────────────────────────────────────────────────────╝
               │
               │ (INSERT / UPDATE)
               ↓

╔══════════════════════════════════════════════════════════════════════════════╗
║                      SUPABASE (Data Storage & Analytics)                      ║
║                                                                              ║
║  Core Tables:                                                               ║
║  ├─ nil.click_events            (Raw click events - 1 row per click)       ║
║  ├─ nil.click_link_registry     (Link metadata & stats)                   ║
║  └─ nil.click_analytics_daily   (Pre-computed daily summaries)            ║
║                                                                              ║
║  Views (Real-time Queries):                                                 ║
║  ├─ v_click_summary_today       (Today's total clicks)                     ║
║  ├─ v_click_daily_summary       (Last 90 days breakdown)                   ║
║  ├─ v_click_weekly_summary      (12-week trends)                           ║
║  ├─ v_click_monthly_summary     (12-month trends)                          ║
║  ├─ v_click_yearly_summary      (Year-over-year)                           ║
║  ├─ v_click_device_breakdown    (Mobile vs Desktop)                        ║
║  ├─ v_click_email_client_breakdown (Gmail, Outlook, etc)                   ║
║  ├─ v_click_top_guide_sections  (Most-clicked sections)                    ║
║  ├─ v_click_geographic_breakdown(Country/State distribution)               ║
║  ├─ v_click_conversion_funnel   (Email → Guide → Enroll flow)              ║
║  └─ v_click_lead_stats          (Per-lead click history)                   ║
╚──────────────┬──────────────────────────────────────────────────────────────╝
               │
               │ (SELECT queries)
               ↓

╔══════════════════════════════════════════════════════════════════════════════╗
║                    TELEGRAM BOT DASHBOARD (Visualization)                     ║
║                                                                              ║
║  Commands:                                                                  ║
║  ├─ /analytics                  (Main dashboard)                            ║
║     ├─ Button: 📅 Daily        → Show last 7 days breakdown                ║
║     ├─ Button: 📊 Weekly       → Show 12-week trends                       ║
║     ├─ Button: 📈 Monthly      → Show 12-month trends                      ║
║     ├─ Button: 🎯 Yearly       → Show year summary + YoY growth            ║
║     ├─ Button: 📍 Geographic   → Show clicks by country/state              ║
║     ├─ Button: 📱 Devices      → Show mobile vs desktop breakdown          ║
║     ├─ Button: 📚 Top Guides   → Show most-clicked guide sections          ║
║     └─ Button: 🔍 Conversion   → Show email → guide → enroll funnel        ║
║                                                                              ║
║  Keyboard Navigation:                                                       ║
║  └─ Each view has "Back" button → Returns to main dashboard                ║
║                                                                              ║
║  Real-time Updates:                                                         ║
║  ├─ Cached for 5 minutes (optimized)                                       ║
║  ├─ Always-fresh when "Refresh" clicked                                    ║
║  └─ Async updates don't block Telegram                                     ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## Data Flow: From Click to Dashboard

### Timeline of a Single Click

```
T=0s   Coach receives email from Instantly.ai campaign
       ┌─────────────────────────────────────────────────────┐
       │ Subject: "Learn About Our Programs"                 │
       │ Click here → [Program Link]                         │
       │            (https://niltracker.yourdomain.com/r/a1b2c3d4)
       └─────────────────────────────────────────────────────┘

T=10s  Coach opens email in Gmail and clicks link
       ├─ Browser: Mozilla/5.0 (iPhone; CPU iPhone OS 15_0)
       ├─ IP: 192.168.1.1 (from CF headers)
       └─ Referrer: null (email doesn't send referrer)

T=11s  Request hits Cloudflare Worker
       ├─ Detect: Device = mobile (from user agent)
       ├─ Detect: Email Client = Gmail (from UA)
       ├─ Lookup: Location data (CF returns: GA, Atlanta)
       ├─ Enrichment complete
       └─ Redirect: To actual site + track async

T=12s  CF Worker sends click to Supabase
       ├─ INSERT into nil.click_events
       ├─ Columns: lead_email, device_type, email_client, location, etc
       └─ Return immediately (don't block redirect)

T=13s  Coach sees website (nil.click_events insert completed)

T=14s  CF Worker updates KV (link stats):
       ├─ increment total_clicks for tracking code
       └─ set last_clicked_at timestamp

T=30m  N8N Workflow 4 runs (scheduled every 30 min)
       ├─ GET Instantly API: /analytics/campaign/xyz/emails
       ├─ Response: [{ event: 'click', link: 'programs', timestamp: 'T+10s', ... }]
       ├─ Loop: Process each click event
       ├─ Lookup: Find lead by email (coach@gmail.com)
       ├─ INSERT to nil.click_events (dedup by instantly_event_id)
       ├─ UPDATE nil.click_link_registry counts
       ├─ Calculate: New engagement_score for lead
       └─ Notify Telegram: "✅ Analytics Sync: 42 clicks recorded"

T=30m+  Admin opens Telegram and types: /analytics
        ├─ Bot queries: SELECT * FROM v_click_summary_today
        ├─ Response: 42 clicks today, 8 unique leads, 6 mobile, 2 desktop
        ├─ Keyboard: Button options for daily/weekly/monthly/yearly
        └─ Send: Nice formatted message with buttons

T=30m+5s Admin clicks "Weekly" button
         ├─ Bot queries: SELECT * FROM v_click_weekly_summary (12 weeks)
         ├─ Parse and format response
         ├─ Edit message with weekly breakdown
         └─ Show buttons for other timeframes

Total Latency:
  Click → Captured: ~2 seconds
  Captured → Dashboard: ~30 minutes (N8N schedule) + instant (from Supabase)
  User Request → Response: ~1 second
```

---

## Data Model: Tables & Views

### Core Table Structure

```sql
nil.click_events (Raw Events - 1 row per click)
├─ Identifiers
│  ├─ id (UUID, PK)
│  ├─ lead_id (FK to nil.leads)
│  └─ lead_email (indexed for quick lookup)
├─ Click Classification
│  ├─ click_type (email_link | guide_section | enroll_button | dashboard_view)
│  ├─ url (what was clicked)
│  ├─ cloudflare_worker_id (tracking code)
│  └─ link_anchor_text (click text)
├─ Device & Browser
│  ├─ device_type (mobile | desktop | unknown)
│  ├─ email_client (Gmail, Outlook, Apple Mail, etc)
│  ├─ user_agent (full string)
│  └─ ip_address
├─ Geographic
│  └─ location (JSONB)
│     ├─ country
│     ├─ state
│     ├─ city
│     ├─ latitude
│     └─ longitude
├─ Email Campaign Info
│  ├─ email_campaign_id
│  ├─ email_sequence_number (1, 2, 3, ...)
│  └─ email_template_version (v1, v2, v3)
├─ Guide Specific
│  └─ parent_guide_section (if guide click)
├─ Enrollment Specific
│  └─ enrollment_step (if enroll click)
├─ UTM Tracking
│  └─ utm_* (source, medium, campaign, content, term)
├─ Metadata
│  └─ metadata (JSONB - extensible)
├─ Timestamps
│  ├─ timestamp (when click happened)
│  └─ recorded_at (when we logged it)
└─ Deduplication
   └─ instantly_event_id (UNIQUE - prevents duplicates)

Indexes (13 total):
├─ PK on id
├─ idx_click_events_lead_id (fast user queries)
├─ idx_click_events_type (fast type filtering)
├─ idx_click_events_timestamp (fast date range)
├─ idx_click_events_device (fast device filtering)
├─ idx_click_events_email_client (fast client filtering)
├─ idx_click_events_guide_section (fast guide queries)
├─ idx_click_events_date_type (date + type filtering)
└─ ... (5 more for performance)

Storage: ~500 bytes per click
Growth: ~1-2 MB per 1000 clicks
Retention: Forever (can archive > 1 year)
```

---

## Metrics by Time Period

### Daily Level (`v_click_daily_summary`)
```
Shows: Last 7, 30, 90 days
Columns:
  ├─ click_date (DATE)
  ├─ total_clicks (count)
  ├─ unique_leads (distinct lead_id)
  ├─ email_link_clicks
  ├─ guide_clicks
  ├─ enroll_clicks
  ├─ mobile_clicks
  ├─ desktop_clicks
  ├─ mobile_pct / desktop_pct
  ├─ gmail_clicks, outlook_clicks, apple_mail_clicks, yahoo_clicks
  └─ email_clients_used (distinct count)

Use Case: "How many clicks did we get each day this week?"
Query: 1-2ms (indexed on DATE)
```

### Weekly Level (`v_click_weekly_summary`)
```
Shows: 12-week rolling window
Columns:
  ├─ week_start / week_end (DATE range)
  ├─ total_clicks
  ├─ unique_leads
  ├─ email_link_clicks / guide_clicks / enroll_clicks
  ├─ mobile_pct / desktop_pct
  └─ email_clients_used

Use Case: "Which weeks had the most engagement?"
Query: 1-2ms (indexed on DATE_TRUNC)
```

### Monthly Level (`v_click_monthly_summary`)
```
Shows: 12-month rolling window
Columns:
  ├─ month_start / month_num / year_num
  ├─ total_clicks
  ├─ unique_leads
  ├─ active_days (distinct dates with clicks)
  ├─ avg_daily_clicks
  ├─ click breakdown by type
  ├─ top_guide_section
  └─ conversion metrics

Use Case: "How are we trending month-over-month?"
Query: 5ms (aggregates across month)
Caching: Yes (pre-computed daily via scheduled job)
```

### Yearly Level (`v_click_yearly_summary`)
```
Shows: Year-to-date vs. last year vs. all-time
Columns:
  ├─ year (INTEGER)
  ├─ total_clicks
  ├─ unique_leads
  ├─ active_days
  ├─ avg_daily_clicks
  ├─ mobile_clicks / desktop_clicks
  ├─ email_clients_used
  └─ yoy_growth %

Use Case: "How much have we grown year-over-year?"
Query: 10ms (aggregates entire year)
Caching: Yes (nightly refresh)
```

---

## 4 Click Types & Their Behavior

### Type 1: EMAIL_LINK Clicks
```
Source:        Instantly.ai email campaigns
Detection:     Instantly API webhook
Recording:     N8N Workflow 4 (every 30 min)
Metadata:
  ├─ clicked_url: "https://nilwealthstrategies.com/programs?utm_source=email"
  ├─ link_position: 1 (first link in email)
  ├─ campaign_id: "57ebe130-68e3-4ee0-bde8-a60c090ef176"
  ├─ sequence_number: 1 (which email in sequence)
  └─ template_version: "v3" (AI version used)

Example Event:
  ┌─────────────────────────────────────┐
  │ Coach received sequence #1 (v3 AI)  │
  │ Clicked on "Learn About Programs"   │
  │ From: Gmail on iPhone               │
  │ Time: 2026-03-05 10:30:00 UTC       │
  │ Location: Atlanta, GA, USA          │
  │ Status: TRACKED by Instantly + CF   │
  └─────────────────────────────────────┘
```

### Type 2: GUIDE_SECTION Clicks
```
Source:        Parent guide webpage (nilwealthstrategies.com/guide)
Detection:     Embedded JavaScript in HTML
Recording:     Direct POST to Cloudflare Worker or Telegram bot
Metadata:
  ├─ guide_page: "/guide"
  ├─ section_id: "coverage_options|eligibility|pricing|faq"
  ├─ scroll_depth: 0-100 (how far down page)
  └─ time_on_page: seconds

Example Event:
  ┌─────────────────────────────────────┐
  │ Parent visiting guide page          │
  │ Reads coverage section              │
  │ Scrolls down & clicks "FAQ"         │
  │ From: Safari on iPad                │
  │ Time: 2026-03-05 11:45:00 UTC       │
  │ Location: New York, NY, USA         │
  │ Status: TRACKED by CF Worker        │
  └─────────────────────────────────────┘
```

### Type 3: ENROLL_BUTTON Clicks
```
Source:        Application form / enrollment page
Detection:     Form click event handler (JavaScript)
Recording:     Button click → POST to Telegram bot
Metadata:
  ├─ enrollment_step: "step_1|step_2|step_3"
  ├─ form_field: "athlete_name|sport|coverage_type"
  └─ session_id: tracking across form steps

Example Event:
  ┌─────────────────────────────────────┐
  │ Parent on enrollment form           │
  │ Clicked "Next" to go to step 2      │
  │ From: Chrome on Desktop             │
  │ Time: 2026-03-05 12:00:00 UTC       │
  │ Location: Los Angeles, CA, USA      │
  │ Status: TRACKED by form JS          │
  └─────────────────────────────────────┘
```

### Type 4: DASHBOARD_VIEW Clicks
```
Source:        Telegram bot admin dashboard
Detection:     Callback query from button clicks
Recording:     Bot logs admin button interaction
Metadata:
  ├─ admin_id: Telegram user ID who clicked
  ├─ button_action: "view_daily|view_weekly|view_geo"
  └─ response_time: milliseconds to generate view

Example Event:
  ┌─────────────────────────────────────┐
  │ Admin clicks "Weekly" button        │
  │ From: iTelegram Desktop App         │
  │ Time: 2026-03-05 14:00:00 UTC       │
  │ Response: Loaded in 850ms           │
  │ Status: TRACKED by bot              │
  └─────────────────────────────────────┘

Note: These are ADMIN views, not customer engagement!
```

---

## Dashboard Command Hierarchy

```
/analytics (Main Command)
│
├─ 📅 Daily (Last 7 days)
│  ├─ Date breakdown
│  ├─ Mobile vs Desktop
│  ├─ Email clients
│  └─ Back to Main
│
├─ 📊 Weekly (Last 12 weeks)
│  ├─ Week-over-week trends
│  ├─ Device percentages
│  ├─ Top performers
│  └─ Back to Main
│
├─ 📈 Monthly (Last 12 months)
│  ├─ Month-over-month trends
│  ├─ Active days per month
│  ├─ Top guide sections
│  └─ Back to Main
│
├─ 🎯 Yearly (All years)
│  ├─ Year summary
│  ├─ Total clicks all-time
│  ├─ YoY growth rate
│  └─ Back to Main
│
├─ 📍 Geographic (Country/State)
│  ├─ Clicks by country
│  ├─ Clicks by state
│  ├─ Conversion by region
│  └─ Back to Main
│
├─ 📱 Devices (Mobile vs Desktop)
│  ├─ Total clicks by device
│  ├─ Device %
│  ├─ Email clients per device
│  └─ Back to Main
│
├─ 📚 Top Guides (Most-clicked sections)
│  ├─ Guide section rankings
│  ├─ Clicks + unique leads
│  ├─ Mobile vs Desktop per section
│  └─ Back to Main
│
└─ 🔍 Conversion Funnel
   ├─ Email → Guide conversion %
   ├─ Guide → Enroll conversion %
   ├─ Email → Enroll conversion %
   └─ Back to Main
```

---

## Performance Metrics

### Query Performance

```
Operation                          Time    Cached?   Volume
───────────────────────────────────────────────────────────
v_click_summary_today            ~1ms    5 min     100 rows
v_click_daily_summary (7d)       ~2ms    5 min     7 rows
v_click_weekly_summary (12w)     ~3ms    5 min     12 rows
v_click_monthly_summary (12m)    ~5ms    1 day     12 rows
v_click_yearly_summary           ~10ms   1 day     5+ rows
v_click_device_breakdown         ~2ms    5 min     3 rows
v_click_email_client_breakdown   ~2ms    5 min     8 rows
v_click_geographic_breakdown     ~10ms   5 min     50-200 rows
v_click_conversion_funnel        ~3ms    5 min     1 row
v_click_lead_stats (top 100)     ~20ms   N/A       100 rows
───────────────────────────────────────────────────────────
Bulk Export (all clicks, 1M rows) ~5sec  N/A       N/A
```

### Storage Growth

```
Per Click Event:    ~500 bytes (metadata + indexes)
Per 1000 Clicks:    ~500 KB
Per 10k Clicks:     ~5 MB
Per 100k Clicks:    ~50 MB
Per 1M Clicks:      ~500 MB

Annual Growth (1k clicks/day):
  Year 1:  365 clicks/day × 365 days × 0.5 KB = ~67 MB
  Year 3:  ~200 MB
  Year 5:  ~330 MB

Archive Strategy (Recommended):
  Keep Last 3 years: Hot storage (~300 MB)
  Archive > 3 years: Cold storage (Supabase backup)
  Delete Personal Data (GDPR): After 1 year (IP addresses)
```

---

## Integration Points

### With N8N Workflow 4
```
Input:  Instantly.ai API response (email analytics)
Output: nil.click_events + nil.lead_metrics INSERT

Data Mapping:
├─ Instantly.eventId → nil.click_events.instantly_event_id (UNIQUE)
├─ Instantly.email → Lead lookup → nil.click_events.lead_id
├─ Instantly.clickUrl → nil.click_events.url
├─ Instantly.deviceType → nil.click_events.device_type
├─ Instantly.userAgent → Device/Client detection
├─ Instantly.ipAddress → mil.click_events.ip_address
└─ Instantly.timestamp → nil.click_events.timestamp

Frequency: Every 30 minutes (tunable)
Latency: ~5-10 seconds per batch
Failure Mode: Retry with exponential backoff, DLQ on 3 failures
```

### With Telegram Bot
```
Input:  Admin clicks /analytics command
Output: Formatted messages + inline keyboards

Data Flow:
├─ Bot receives: /analytics command
├─ Query Supabase: SELECT * FROM v_click_summary_today
├─ Parse response → Format text
├─ Create inline keyboard (7 buttons)
├─ Send to Telegram: await ctx.reply(text, keyboard)
└─ User clicks button → Callback handler → Repeat

Caching:
├─ V1: No cache (fresh every click) - 200-500ms response
├─ V2: 5-minute cache + force-refresh button - 50ms response
└─ Recommended: V2 for best UX

Error Handling:
├─ DB down: Show "Service temporarily unavailable"
├─ View missing: Show "View not found (table issue)"
└─ Timeout: Show with [Retry] button
```

### With Cloudflare Worker
```
Input:  HTTP request to https://niltracker.yourdomain.com/r/{code}
Output: Redirect + Click logged in Supabase

Process:
├─ GET /r/abc123
├─ Look up destination URL from KV: CLICK_TRACKING["abc123"]
├─ Capture: Device, IP, email client, location
├─ Async: Send to Supabase
├─ Return: 302 Redirect to destination
└─ User sees website (no lag from tracking)

Error Handling:
├─ Code not found: Return 404
├─ Supabase down: Still redirect (tracking optional)
├─ Rate limit: Cloudflare built-in (100 req/sec default)
└─ Max latency: <100ms before redirect

Cost:
├─ KV read: $0.50 per 1M reads
├─ KV write: $5.00 per 1M writes
├─ Worker execution: Included in CF plan
└─ Est. cost: $1-5/month for 10k clicks/day
```

---

## Troubleshooting Quick Reference

| Problem | Cause | Solution |
|---------|-------|----------|
| No clicks showing | N8N not running | Check Workflow 4 status, logs |
| Clicks delayed | N8N 30-min schedule | Check last execution time |
| Duplicate clicks | Instant event_id | Check UNIQUE constraint |
| Dashboard slow | No indexes | Run migration again |
| CF Worker 500 | Invalid KV read | Verify KV namespace setup |
| Missing device type | User agent empty | CF Worker should detect "unknown" |
| Dashboard button broken | Missing view | Check view exists: `SELECT FROM v_click_daily_summary` |
| Geographic data null | Not CF deployed | Geolocation only works on CF production |

---

**For detailed implementation, see: CLICK_TRACKING_COMPREHENSIVE_GUIDE.md**  
**For quick setup, see: CLICK_TRACKING_QUICK_REFERENCE.md**
