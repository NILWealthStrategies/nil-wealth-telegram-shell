# Click Tracking System: Complete Breakdown
**Nil Wealth Telegram Bot + Cloudflare Worker Integration**  
**Date**: March 5, 2026  
**Version**: 1.0

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Click Tracking Architecture](#click-tracking-architecture)
3. [Data Model & Storage](#data-model--storage)
4. [Cloudflare Worker Integration](#cloudflare-worker-integration)
5. [Recording Clicks Through Supabase](#recording-clicks-through-supabase)
6. [Time-Based Aggregations](#time-based-aggregations)
7. [Dashboard Implementation](#dashboard-implementation)
8. [Claude AI Workflow Integration](#claude-ai-workflow-integration)
9. [Implementation Checklist](#implementation-checklist)

---

## Executive Summary

This system tracks **4 types of clicks** across your funnel:

| Click Type | Source | Tracked Via | Use Case |
|-----------|--------|-------------|----------|
| **Email Link Clicks** | Instantly.ai campaign emails | Instantly API webhook | Opens/clicks on program links in outreach emails |
| **Parent Guide Clicks** | Program guide PDF/webpage | Cloudflare Worker redirects | Tracks which sections parents explore |
| **Enrollment Button Clicks** | Application form submission | Button event → Telegram bot | Parent clicks "Enroll" or "Get Started" |
| **Dashboard Metric Clicks** | Telegram commands | Telegram callback queries | Admin views metrics over time |

---

## Click Tracking Architecture

### System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    N8N WORKFLOW LAYER                           │
│  (Workflow 4: Instantly.ai Analytics Sync - Every 30 min)       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │  Instantly.ai API: /analytics/campaign/{id} │ (Gets opens/clicks)
        └─────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │  Cloudflare Worker Link Tracking Bot        │ 
        │  (Extracts click data from webhooks)        │
        └─────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │  Parse & Enrich Click Metadata:             │
        │  • Link URL / Section (parent guide)        │
        │  • Device type (email client)               │
        │  • Geographic location (if available)       │
        │  • Timestamp                                │
        │  • Lead email / ID                          │
        └─────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │  Supabase nil.lead_metrics INSERT:          │
        │  {                                          │
        │    metric_type: "email_click",              │
        │    lead_id: UUID,                           │
        │    recorded_at: TIMESTAMP,                  │
        │    metadata: {                              │
        │      url: "https://...",                    │
        │      link_type: "program_guide|enroll|...", │
        │      cf_worker_id: "redirect-123",         │
        │      device: "mobile|desktop|unknown",      │
        │      location: { lat, lon },                │
        │      email_client: "Gmail|Outlook|..."      │
        │    }                                        │
        │  }                                          │
        └─────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │  Telegram Bot Dashboard Queries             │
        │  (Admin views /analytics, /dashboard)       │
        └─────────────────────────────────────────────┘
```

---

## Data Model & Storage

### 1. Lead Metrics Table (Already Exists)

**Location**: `nil.lead_metrics`

```sql
CREATE TABLE IF NOT EXISTS nil.lead_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,                              -- FK to nil.leads
  metric_type TEXT NOT NULL,                 -- email_sent | email_open | email_click | email_bounce | email_reply
  metric_value INTEGER DEFAULT 1,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB,                            -- CLICK DETAILS STORED HERE
  instantly_event_id TEXT UNIQUE             -- Deduplication from Instantly API
);
```

### 2. Click Metadata Structure

When `metric_type = "email_click"`, `metadata` JSONB contains:

```json
{
  "click_type": "program_link|enroll_button|guide_section",
  "url": "https://nilwealthstrategies.com/programs?utm_content=email_1",
  "cloudflare_worker_id": "cf-redirect-a1b2c3d4",
  "link_position": 1,                        // Which link in email (1st, 2nd, etc.)
  "link_anchor_text": "Learn About Coverage",
  "device_type": "mobile|desktop|unknown",
  "email_client": "Gmail|Outlook|Apple Mail|Yahoo|Other|Unknown",
  "ip_address": "192.168.1.1",              // From CF Worker
  "location": {
    "country": "USA",
    "state": "GA",
    "city": "Atlanta",
    "latitude": 33.7490,
    "longitude": -84.3880
  },
  "parent_guide_section": "coverage_options|eligibility|pricing|faq", // IF guide click
  "enrollment_step": "step_1|step_2|step_3",   // IF enroll click
  "email_campaign_id": "campaign_id_xyz",
  "email_sequence_number": 1,                // Which email in sequence (v1, v2, v3)
  "email_template_version": "v3",            // AI version used
  "timestamp_ms": 1709652000000,
  "utm_tracking": {
    "utm_source": "email",
    "utm_medium": "outreach",
    "utm_campaign": "q1_2026",
    "utm_content": "email_v3_seq_1"
  }
}
```

### 3. New Clicks Table (Recommended Addition)

For detailed per-click analysis:

```sql
CREATE TABLE IF NOT EXISTS nil.click_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  email_id UUID,                    -- FK to nil.messages (if trackable)
  click_type TEXT NOT NULL,         -- "email_link" | "enroll" | "guide_section"
  url TEXT,
  cloudflare_worker_id TEXT,
  metadata JSONB,                   -- All enriched data
  device_type TEXT,                 -- mobile | desktop | unknown
  email_client TEXT,                -- Gmail | Outlook | etc
  ip_address TEXT,
  geographic_location JSONB,        -- { country, state, city, lat, lon }
  parent_guide_section TEXT,        -- For guide clicks: which section
  timestamp TIMESTAMPTZ DEFAULT now(),
  recorded_by TEXT DEFAULT 'instantly' -- 'instantly' | 'cloudflare' | 'direct'
);

-- Indexes for dashboard queries
CREATE INDEX idx_click_events_lead_id ON nil.click_events(lead_id);
CREATE INDEX idx_click_events_type ON nil.click_events(click_type);
CREATE INDEX idx_click_events_timestamp ON nil.click_events(timestamp DESC);
CREATE INDEX idx_click_events_device ON nil.click_events(device_type);
CREATE INDEX idx_click_events_section ON nil.click_events(parent_guide_section);
```

### 4. Click Analytics Summary View

```sql
CREATE OR REPLACE VIEW nil.v_click_analytics_summary AS
SELECT
  -- Daily totals
  COUNT(DISTINCT CASE 
    WHEN DATE(c.timestamp) = CURRENT_DATE 
      AND c.click_type = 'email_link' 
    THEN c.id 
  END) as email_clicks_today,
  
  COUNT(DISTINCT CASE 
    WHEN DATE(c.timestamp) = CURRENT_DATE 
      AND c.click_type = 'guide_section' 
    THEN c.id 
  END) as guide_clicks_today,
  
  COUNT(DISTINCT CASE 
    WHEN DATE(c.timestamp) = CURRENT_DATE 
      AND c.click_type = 'enroll_button' 
    THEN c.id 
  END) as enroll_clicks_today,
  
  COUNT(DISTINCT CASE 
    WHEN DATE(c.timestamp) = CURRENT_DATE 
    THEN c.lead_id 
  END) as unique_clickers_today,
  
  -- Weekly totals
  COUNT(DISTINCT CASE 
    WHEN c.timestamp >= NOW() - INTERVAL '7 days' 
    THEN c.id 
  END) as total_clicks_7d,
  
  COUNT(DISTINCT CASE 
    WHEN c.timestamp >= NOW() - INTERVAL '7 days' 
    THEN c.lead_id 
  END) as unique_clickers_7d,
  
  -- Monthly totals
  COUNT(DISTINCT CASE 
    WHEN DATE_TRUNC('month', c.timestamp) = DATE_TRUNC('month', NOW()) 
    THEN c.id 
  END) as total_clicks_month,
  
  COUNT(DISTINCT CASE 
    WHEN DATE_TRUNC('month', c.timestamp) = DATE_TRUNC('month', NOW()) 
    THEN c.lead_id 
  END) as unique_clickers_month,
  
  -- All-time totals
  COUNT(*) as all_time_clicks,
  COUNT(DISTINCT c.lead_id) as all_time_unique_leads,
  
  -- Device breakdown
  COUNT(DISTINCT CASE 
    WHEN c.device_type = 'mobile' 
    THEN c.id 
  END) as mobile_clicks,
  COUNT(DISTINCT CASE 
    WHEN c.device_type = 'desktop' 
    THEN c.id 
  END) as desktop_clicks,
  
  -- Email client breakdown
  COUNT(DISTINCT CASE 
    WHEN c.email_client = 'Gmail' 
    THEN c.id 
  END) as gmail_clicks,
  COUNT(DISTINCT CASE 
    WHEN c.email_client = 'Outlook' 
    THEN c.id 
  END) as outlook_clicks,
  COUNT(DISTINCT CASE 
    WHEN c.email_client = 'Apple Mail' 
    THEN c.id 
  END) as apple_mail_clicks,
  
  -- Top guide sections
  MAX(CASE 
    WHEN c.click_type = 'guide_section' 
    THEN c.parent_guide_section 
  END) as top_guide_section,
  
  -- Conversion rate (enroll clicks / total email opens)
  ROUND(
    (COUNT(DISTINCT CASE 
      WHEN c.click_type = 'enroll_button' 
      THEN c.id 
    END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE 
      WHEN c.click_type = 'email_link' 
      THEN c.id 
    END), 0)) * 100,
    2
  ) as email_to_enroll_conversion_rate
  
FROM nil.click_events c;
```

---

## Cloudflare Worker Integration

### Purpose
Create short, trackable links that redirect to your actual content while capturing:
- Click timestamp
- Device type (mobile/desktop)
- Geographic location (IP geolocation)
- Referrer (email source)

### Cloudflare Worker Code

**Deploy to**: `https://niltracker.yourdomain.com` (or your CF domain)

```javascript
/**
 * Cloudflare Worker: Link Tracking Redirect Bot
 * Deployed to: niltracker.yourdomain.com
 * 
 * Usage:
 * - https://niltracker.yourdomain.com/r/{code}
 * - Example: https://niltracker.yourdomain.com/r/a1b2c3d4
 */

// KV Namespace (set up in CF Dashboard)
const CLICK_TRACKING_KV = 'CLICK_TRACKING';      // Stores redirect mapping
const ANALYTICS_QUEUE = 'click_analytics_queue'; // For async processing

// Supabase config (set in CF environment)
const SUPABASE_URL = 'https://bjyxaprcdbwougewbauw.supabase.co';
const SUPABASE_SERVICE_KEY = 'your-service-key'; // Read from CF Secret

interface ClickEvent {
  code: string;
  lead_email?: string;
  lead_id?: string;
  timestamp: number;
  ip_address: string;
  country: string;
  state?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  device_type: 'mobile' | 'desktop' | 'unknown';
  email_client?: string;
  user_agent: string;
  referer: string;
  click_type: string; // 'program_link' | 'guide_section' | 'enroll'
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // CORS handling
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Route: GET /r/{code} - Redirect and track
    if (pathname.startsWith('/r/')) {
      const code = pathname.slice(3);
      return handleRedirect(code, request, env, ctx);
    }

    // Route: POST /track - Direct event posting
    if (pathname === '/track' && request.method === 'POST') {
      return handleDirectTrack(request, env, ctx);
    }

    // Route: GET /health - Health check
    if (pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Handle /r/{code} redirect with click tracking
 */
async function handleRedirect(
  code: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // 1. Look up redirect URL from KV
  const redirectUrl = await env.CLICK_TRACKING.get(code);
  if (!redirectUrl) {
    return new Response('Link not found', { status: 404 });
  }

  // 2. Extract click parameters from query string
  const leadEmail = url.searchParams.get('le') || undefined;
  const leadId = url.searchParams.get('li') || undefined;
  const clickType = url.searchParams.get('ct') || 'program_link';
  const guideSection = url.searchParams.get('gs') || undefined;
  const emailClient = url.searchParams.get('ec') || 'Unknown';

  // 3. Gather device & geo information
  const userAgent = request.headers.get('user-agent') || '';
  const referer = request.headers.get('referer') || '';
  const ipAddress = request.headers.get('cf-connecting-ip') || '';
  const country = request.headers.get('cf-ipcountry') || 'Unknown';
  const latitude = parseFloat(request.headers.get('cf-latitude') || '0');
  const longitude = parseFloat(request.headers.get('cf-longitude') || '0');

  // Device detection
  const deviceType = detectDevice(userAgent);

  // 4. Build click event
  const clickEvent: ClickEvent = {
    code,
    lead_email: leadEmail,
    lead_id: leadId,
    timestamp: Date.now(),
    ip_address: ipAddress,
    country,
    latitude: latitude !== 0 ? latitude : undefined,
    longitude: longitude !== 0 ? longitude : undefined,
    device_type: deviceType,
    email_client: emailClient,
    user_agent: userAgent,
    referer,
    click_type: clickType,
  };

  // 5. Queue event for async processing (don't block redirect)
  ctx.waitUntil(processClickEvent(clickEvent, env));

  // 6. Redirect immediately
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirectUrl,
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * Handle direct /track POST for non-email clicks
 */
async function handleDirectTrack(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const body = (await request.json()) as ClickEvent;

    // Validate required fields
    if (!body.code || !body.click_type) {
      return new Response(
        JSON.stringify({ error: 'Missing code or click_type' }),
        { status: 400 }
      );
    }

    ctx.waitUntil(processClickEvent(body, env));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
    });
  }
}

/**
 * Process click event and send to Supabase
 */
async function processClickEvent(
  event: ClickEvent,
  env: Env
): Promise<void> {
  try {
    // 1. Look up link details from KV or cache
    const linkLabel = await env.CLICK_TRACKING.get(`meta:${event.code}`) || 'unknown';

    // 2. Extract state from IP geolocation (if available)
    const state = event.country === 'US' 
      ? await getStateFromIP(event.ip_address, env)
      : undefined;

    // 3. Build insert payload
    const payload = {
      click_type: event.click_type,
      lead_email: event.lead_email,
      lead_id: event.lead_id,
      timestamp: new Date(event.timestamp).toISOString(),
      metadata: {
        code: event.code,
        link_label: linkLabel,
        device_type: event.device_type,
        email_client: event.email_client,
        ip_address: event.ip_address,
        location: {
          country: event.country,
          state,
          latitude: event.latitude,
          longitude: event.longitude,
        },
        user_agent: event.user_agent,
        referer: event.referer,
        parent_guide_section: event.click_type === 'guide_section' 
          ? undefined 
          : undefined,
      },
    };

    // 4. Send to Supabase
    const response = await fetch(`${SUPABASE_URL}/rest/v1/nil.click_events`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('Supabase error:', await response.text());
    }
  } catch (error) {
    console.error('Click tracking error:', error);
    // Don't throw - silently fail to not break the redirect
  }
}

/**
 * Detect device type from user agent
 */
function detectDevice(userAgent: string): 'mobile' | 'desktop' | 'unknown' {
  if (!userAgent) return 'unknown';

  const mobilePatterns = [
    /mobile/i,
    /iphone/i,
    /ipad/i,
    /android/i,
    /blackberry/i,
    /windows phone/i,
  ];

  return mobilePatterns.some((pattern) => pattern.test(userAgent))
    ? 'mobile'
    : 'desktop';
}

/**
 * Stub: Get state from IP geolocation
 * In production, use: MaxMind GeoIP2 or IP2Location via CF service binding
 */
async function getStateFromIP(
  ipAddress: string,
  env: Env
): Promise<string | undefined> {
  // Placeholder - implement with IP geolocation service
  return undefined;
}
```

### Setting Up Cloudflare Worker

**Step 1: Deploy Worker**
```bash
# Install Wrangler
npm install -g wrangler@latest

# Create worker project
wrangler init niltracker-worker

# Deploy
wrangler deploy
```

**Step 2: Set Up KV Namespace**
```bash
# Create KV namespace
wrangler kv:namespace create "CLICK_TRACKING"
wrangler kv:namespace create "CLICK_TRACKING" --preview

# Update wrangler.toml with:
[[kv_namespaces]]
binding = "CLICK_TRACKING"
id = "<your-kv-id>"
preview_id = "<your-kv-preview-id>"
```

**Step 3: Create Tracking Links**

Use this API to create short tracking links:

```javascript
/**
 * Create a new tracking link in Cloudflare KV
 * 
 * Code: 'a1b2c3d4'
 * Maps to: 'https://nilwealthstrategies.com/programs?utm_...'
 */
async function createTrackingLink(code, redirectUrl, metadata) {
  // Call CF API or use wrangler to write to KV:
  // await env.CLICK_TRACKING.put(code, redirectUrl);
  // await env.CLICK_TRACKING.put(`meta:${code}`, JSON.stringify(metadata));
}

// In your N8N workflow, create links like:
const trackingUrl = `https://niltracker.yourdomain.com/r/a1b2c3d4?le=coach@gmail.com&li=lead-uuid&ct=program_link&ec=Gmail`;
// Then insert this into the HTML email template
```

---

## Recording Clicks Through Supabase

### Method 1: Directly from Instantly.ai Webhook

**In N8N Workflow 4 (Analytics Sync):**

```json
{
  "node": "Supabase: Insert Click Events",
  "operation": "INSERT into nil.click_events",
  "mapping": {
    "lead_id": "{{ $node['Get Campaign Analytics'].data.lead_id }}",
    "click_type": "email_link",
    "url": "{{ $node['Parse Instantly Event'].data.clicked_link }}",
    "cloudflare_worker_id": "{{ $node['Extract CF ID'].data.cf_id }}",
    "metadata": {
      "instantly_event: {{ $node['Get Campaign Analytics'].data }}",
      "device_type": "{{ $node['Parse Device'].data.type }}",
      "email_client": "{{ $node['Detect Email Client'].data.client }}",
      "location": {
        "country": "{{ $node['Geo Lookup'].data.country }}",
        "state": "{{ $node['Geo Lookup'].data.state }}"
      }
    },
    "timestamp": "{{ $now }}",
    "recorded_by": "instantly"
  }
}
```

### Method 2: Via Cloudflare Worker Direct API Call

**From Telegram Bot when processing events:**

```javascript
// In src/index.js - when handling /ops/ingest webhook
async function recordClickEvent(data) {
  try {
    const { data: result, error } = await ops()
      .from('click_events')
      .insert({
        lead_id: data.lead_id,
        click_type: data.click_type,
        url: data.url,
        cloudflare_worker_id: data.cf_worker_id,
        metadata: data.metadata,
        timestamp: new Date().toISOString(),
        recorded_by: 'telegram_bot'
      });

    if (error) throw error;
    console.log('Click recorded:', result);
  } catch (err) {
    console.error('Failed to record click:', err);
  }
}
```

### Method 3: Bulk Backfill from Instantly.ai Historical Data

```sql
-- Backfill clicks from lead_metrics where metric_type = 'click'
INSERT INTO nil.click_events 
  (lead_id, click_type, timestamp, metadata, recorded_by)
SELECT 
  lm.lead_id,
  'email_link' as click_type,
  lm.recorded_at as timestamp,
  lm.metadata,
  'instantly_backfill' as recorded_by
FROM nil.lead_metrics lm
WHERE lm.metric_type = 'email_click'
  AND NOT EXISTS (
    SELECT 1 FROM nil.click_events ce 
    WHERE ce.lead_id = lm.lead_id 
      AND ce.timestamp = lm.recorded_at
  );
```

---

## Time-Based Aggregations

### Daily Breakdown

```sql
-- Daily click count by type
CREATE OR REPLACE VIEW nil.v_clicks_daily AS
SELECT
  DATE(timestamp) as click_date,
  click_type,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT device_type) as devices_used,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_count,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_count
FROM nil.click_events
GROUP BY DATE(timestamp), click_type
ORDER BY click_date DESC;
```

### Weekly Breakdown

```sql
-- Weekly aggregate (ISO week)
CREATE OR REPLACE VIEW nil.v_clicks_weekly AS
SELECT
  DATE_TRUNC('week', timestamp)::DATE as week_start,
  DATE_TRUNC('week', timestamp)::DATE + INTERVAL '6 days' as week_end,
  click_type,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  ROUND(
    COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END)::numeric 
    / COUNT(*)::numeric * 100,
    1
  ) as mobile_pct,
  ROUND(
    COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END)::numeric 
    / COUNT(*)::numeric * 100,
    1
  ) as desktop_pct
FROM nil.click_events
GROUP BY DATE_TRUNC('week', timestamp), click_type
ORDER BY week_start DESC;
```

### Monthly Breakdown

```sql
-- Monthly aggregate
CREATE OR REPLACE VIEW nil.v_clicks_monthly AS
SELECT
  DATE_TRUNC('month', timestamp)::DATE as month_start,
  LAST_DAY(DATE_TRUNC('month', timestamp)::DATE) as month_end,
  click_type,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT email_client) as email_clients_used,
  MAX(CASE WHEN click_type = 'guide_section' 
    THEN parent_guide_section END) as top_guide_section,
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END)::numeric 
     / COUNT(*)::numeric) * 100,
    2
  ) as enroll_conversion_rate
FROM nil.click_events
GROUP BY DATE_TRUNC('month', timestamp), click_type
ORDER BY month_start DESC;
```

### Yearly Breakdown

```sql
-- Yearly summary
CREATE OR REPLACE VIEW nil.v_clicks_yearly AS
SELECT
  EXTRACT(YEAR FROM timestamp)::INTEGER as year,
  click_type,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT DATE(timestamp)) as active_days,
  ROUND(AVG(EXTRACT(DAY FROM timestamp))::numeric, 1) as avg_clicks_per_day,
  COUNT(DISTINCT email_client) as email_clients_used,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks
FROM nil.click_events
GROUP BY EXTRACT(YEAR FROM timestamp), click_type
ORDER BY year DESC;
```

---

## Dashboard Implementation

### Telegram Bot: `/analytics` Command Enhancement

```javascript
// In src/index.js - Route: /analytics

bot.command('analytics', async (ctx) => {
  try {
    const { data: clicks, error } = await ops()
      .from('v_click_analytics_summary')
      .select('*')
      .single();

    if (error) throw error;

    const text = `📊 CLICK ANALYTICS DASHBOARD

🔗 EMAIL LINK CLICKS
├─ Today: ${clicks.email_clicks_today || 0}
├─ This Week: ${clicks.total_clicks_7d || 0}
├─ This Month: ${clicks.total_clicks_month || 0}
└─ All Time: ${clicks.all_time_clicks || 0}

📱 GUIDE SECTION CLICKS
├─ Today: ${clicks.guide_clicks_today || 0}
├─ Top Section: ${clicks.top_guide_section || 'N/A'}
└─ Total: ${clicks.guide_total || 0}

✅ ENROLLMENT CLICKS
├─ Today: ${clicks.enroll_clicks_today || 0}
├─ Conversion Rate: ${clicks.email_to_enroll_conversion_rate || 0}%
└─ Total: ${clicks.enroll_total || 0}

👥 UNIQUE CLICKERS
├─ Today: ${clicks.unique_clickers_today || 0}
├─ This Week: ${clicks.unique_clickers_7d || 0}
├─ This Month: ${clicks.unique_clickers_month || 0}
└─ All Time: ${clicks.all_time_unique_leads || 0}

📲 DEVICE BREAKDOWN
├─ Mobile: ${clicks.mobile_clicks || 0} (${calculateMobilePercent(clicks)}%)
├─ Desktop: ${clicks.desktop_clicks || 0} (${calculateDesktopPercent(clicks)}%)
└─ Mobile-to-Desktop Ratio: ${calculateMobileRatio(clicks)}:1

📧 EMAIL CLIENT BREAKDOWN
├─ Gmail: ${clicks.gmail_clicks || 0}
├─ Outlook: ${clicks.outlook_clicks || 0}
├─ Apple Mail: ${clicks.apple_mail_clicks || 0}
└─ Other: ${calculateOtherClients(clicks)}`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📅 Daily', 'ANALYTICS:daily'),
       Markup.button.callback('📊 Weekly', 'ANALYTICS:weekly'),
       Markup.button.callback('📈 Monthly', 'ANALYTICS:monthly')],
      [Markup.button.callback('🎯 Yearly', 'ANALYTICS:yearly'),
       Markup.button.callback('📍 Geographic', 'ANALYTICS:geo')],
      [Markup.button.callback('⬅ Dashboard', 'DASH:back')]
    ]);

    await ctx.reply(text, keyboard);
  } catch (err) {
    console.error('Analytics error:', err);
    await ctx.reply('❌ Failed to load analytics');
  }
});
```

### Daily View Implementation

```javascript
// Callback: ANALYTICS:daily
bot.action('ANALYTICS:daily', async (ctx) => {
  try {
    const { data: dailyData, error } = await ops()
      .from('v_clicks_daily')
      .select('*')
      .order('click_date', { ascending: false })
      .limit(7); // Last 7 days

    if (error) throw error;

    let text = '📅 LAST 7 DAYS - CLICK BREAKDOWN\n\n';
    
    dailyData.forEach(day => {
      text += `${day.click_date}\n`;
      text += `├─ Total: ${day.total_clicks}\n`;
      text += `├─ Unique Leads: ${day.unique_leads}\n`;
      text += `├─ Mobile: ${day.mobile_count} | Desktop: ${day.desktop_count}\n`;
      text += `└─ Avg per Lead: ${(day.total_clicks / day.unique_leads).toFixed(2)}\n\n`;
    });

    await ctx.editMessageText(text, 
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Weekly', 'ANALYTICS:weekly')],
        [Markup.button.callback('⬅ Back', 'ANALYTICS:refresh')]
      ])
    );
  } catch (err) {
    console.error('Daily analytics error:', err);
    await ctx.answerCbQuery('❌ Failed to load daily analytics');
  }
});
```

### Weekly View Implementation

```javascript
// Callback: ANALYTICS:weekly
bot.action('ANALYTICS:weekly', async (ctx) => {
  try {
    const { data: weeklyData, error } = await ops()
      .from('v_clicks_weekly')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(12); // Last 12 weeks (3 months)

    if (error) throw error;

    let text = '📊 WEEKLY CLICK TRENDS (Last 12 Weeks)\n\n';
    
    weeklyData.forEach(week => {
      const weekLabel = `${week.week_start} → ${week.week_end}`;
      text += `${weekLabel}\n`;
      text += `├─ Total Clicks: ${week.total_clicks}\n`;
      text += `├─ Unique Leads: ${week.unique_leads}\n`;
      text += `├─ Mobile: ${week.mobile_pct}% | Desktop: ${week.desktop_pct}%\n`;
      text += `└─ By Type: ${formatClickTypeBreakdown(week)}\n\n`;
    });

    await ctx.editMessageText(text,
      Markup.inlineKeyboard([
        [Markup.button.callback('📈 Monthly', 'ANALYTICS:monthly')],
        [Markup.button.callback('⬅ Back', 'ANALYTICS:refresh')]
      ])
    );
  } catch (err) {
    console.error('Weekly analytics error:', err);
    await ctx.answerCbQuery('❌ Failed to load weekly analytics');
  }
});
```

### Monthly View Implementation

```javascript
// Callback: ANALYTICS:monthly
bot.action('ANALYTICS:monthly', async (ctx) => {
  try {
    const { data: monthlyData, error } = await ops()
      .from('v_clicks_monthly')
      .select('*')
      .order('month_start', { ascending: false })
      .limit(12); // Last 12 months

    if (error) throw error;

    let text = '📈 MONTHLY PERFORMANCE (Last 12 Months)\n\n';
    
    monthlyData.forEach(month => {
      const monthLabel = new Date(month.month_start)
        .toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
      
      text += `${monthLabel}\n`;
      text += `├─ Total Clicks: ${month.total_clicks}\n`;
      text += `├─ Unique Leads: ${month.unique_leads}\n`;
      text += `├─ Active Days: ${month.active_days}\n`;
      text += `├─ Top Guide Section: ${month.top_guide_section || 'N/A'}\n`;
      text += `└─ Enroll Conversion: ${month.enroll_conversion_rate}%\n\n`;
    });

    await ctx.editMessageText(text,
      Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Yearly', 'ANALYTICS:yearly')],
        [Markup.button.callback('⬅ Back', 'ANALYTICS:refresh')]
      ])
    );
  } catch (err) {
    console.error('Monthly analytics error:', err);
    await ctx.answerCbQuery('❌ Failed to load monthly analytics');
  }
});
```

### Yearly Summary Implementation

```javascript
// Callback: ANALYTICS:yearly
bot.action('ANALYTICS:yearly', async (ctx) => {
  try {
    const { data: yearlyData, error } = await ops()
      .from('v_clicks_yearly')
      .select('*')
      .order('year', { ascending: false });

    if (error) throw error;

    let text = '🎉 YEAR SUMMARY - CLICK PERFORMANCE\n\n';
    
    yearlyData.forEach(year => {
      text += `${year.year}\n`;
      text += `├─ Total Clicks: ${year.total_clicks}\n`;
      text += `├─ Unique Leads: ${year.unique_leads}\n`;
      text += `├─ Active Days: ${year.active_days}\n`;
      text += `├─ Avg Daily: ${year.avg_clicks_per_day} clicks\n`;
      text += `├─ Email Clients: ${year.email_clients_used}\n`;
      text += `├─ Mobile Clicks: ${year.mobile_clicks}\n`;
      text += `├─ Desktop Clicks: ${year.desktop_clicks}\n`;
      text += `└─ Mobile Ratio: ${(year.mobile_clicks / year.desktop_clicks).toFixed(2)}:1\n\n`;
    });

    text += '📊 Year-over-Year Comparison: ';
    if (yearlyData.length >= 2) {
      const growth = (
        ((yearlyData[0].total_clicks - yearlyData[1].total_clicks) 
        / yearlyData[1].total_clicks) * 100
      ).toFixed(1);
      text += `${growth}% ${growth > 0 ? '📈 increase' : '📉 decrease'}`;
    } else {
      text += 'Insufficient data';
    }

    await ctx.editMessageText(text,
      Markup.inlineKeyboard([
        [Markup.button.callback('📍 Geographic', 'ANALYTICS:geo')],
        [Markup.button.callback('⬅ Back', 'ANALYTICS:refresh')]
      ])
    );
  } catch (err) {
    console.error('Yearly analytics error:', err);
    await ctx.answerCbQuery('❌ Failed to load yearly analytics');
  }
});
```

### Geographic Breakdown

```javascript
// Callback: ANALYTICS:geo
bot.action('ANALYTICS:geo', async (ctx) => {
  try {
    const { data: geoData, error } = await ops()
      .from('click_events')
      .select(`
        metadata->>'country' as country,
        metadata->>'state' as state,
        COUNT(*) as clicks,
        COUNT(DISTINCT lead_id) as unique_leads
      `)
      .groupBy(['metadata->>country', 'metadata->>state'])
      .order('clicks', { ascending: false })
      .limit(20);

    if (error) throw error;

    let text = '📍 GEOGRAPHIC BREAKDOWN\n\n';
    
    let currentCountry = '';
    geoData.forEach(row => {
      if (row.country !== currentCountry) {
        text += `\n${row.country}\n`;
        currentCountry = row.country;
      }
      text += `├─ ${row.state || 'Unknown'}: ${row.clicks} clicks (${row.unique_leads} leads)\n`;
    });

    await ctx.editMessageText(text,
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Back to Analytics', 'ANALYTICS:refresh')],
        [Markup.button.callback('⬅ Dashboard', 'DASH:back')]
      ])
    );
  } catch (err) {
    console.error('Geographic analytics error:', err);
    await ctx.answerCbQuery('❌ Failed to load geographic data');
  }
});
```

---

## Claude AI Workflow Integration

### How Claude Interprets Clicks in N8N

**In Workflow 4: Analytics Sync**

Claude (or your workflow logic) should:

1. **Parse Instantly.ai analytics data** and identify clicks
2. **Extract metadata** from each click (link, device, client)
3. **Enrich with context** (which lead, which email sequence)
4. **Categorize clicks** (program link vs. enrollment vs. guide)
5. **Insert to Supabase** with full metadata

### Example N8N Workflow Steps

```json
{
  "workflow": "Workflow 4: Analytics Sync",
  "step_1": {
    "name": "Get Campaign Analytics",
    "node": "HTTP: GET Instantly.ai API",
    "endpoint": "https://api.instantly.ai/v1/analytics/campaign/{CAMPAIGN_ID}/emails",
    "output": [
      {
        "email_id": "e123",
        "lead_email": "coach@gmail.com",
        "link_clicked": "https://nilwealthstrategies.com/programs",
        "clicks": 2,
        "click_timestamp": "2026-03-05T10:30:00Z",
        "device_type": "mobile",
        "email_client": "Gmail"
      }
    ]
  },
  
  "step_2": {
    "name": "Detect Click Type",
    "node": "Function: JavaScript",
    "logic": {
      "if": "link_url.includes('/programs')",
      "then": "click_type = 'program_link'"
    }
  },
  
  "step_3": {
    "name": "Lookup Lead ID",
    "node": "Supabase: Query leads by email",
    "query": "SELECT lead_id FROM nil.leads WHERE email = ?",
    "param": "{{ $node['Get Campaign Analytics'].data.lead_email }}"
  },
  
  "step_4": {
    "name": "Insert Click Event",
    "node": "Supabase: Insert",
    "table": "nil.click_events",
    "data": {
      "lead_id": "{{ $node['Lookup Lead ID'].data.lead_id }}",
      "click_type": "{{ $node['Detect Click Type'].data.click_type }}",
      "url": "{{ $node['Get Campaign Analytics'].data.link_clicked }}",
      "timestamp": "{{ $node['Get Campaign Analytics'].data.click_timestamp }}",
      "metadata": {
        "device_type": "{{ $node['Get Campaign Analytics'].data.device_type }}",
        "email_client": "{{ $node['Get Campaign Analytics'].data.email_client }}",
        "email_id": "{{ $node['Get Campaign Analytics'].data.email_id }}"
      }
    }
  },
  
  "step_5": {
    "name": "Update Lead Engagement Score",
    "node": "Supabase: Function Call",
    "function": "nil.calculate_engagement_score(lead_id)"
  },
  
  "step_6": {
    "name": "Notify Telegram of Click Activity",
    "node": "HTTP: POST webhook",
    "url": "https://api.telegram.org/bot{TOKEN}/sendMessage",
    "data": {
      "chat_id": "{{ ADMIN_CHAT_ID }}",
      "text": "📊 Click recorded: {{ lead_email }} clicked program link via {{ email_client }}"
    }
  }
}
```

### Parent Guide Click Tracking

When a parent visits your guide and clicks on sections:

```javascript
// Embedded in HTML guide (nilwealthstrategies.com/guide)
// This code captures section clicks and sends to CF Worker

<script>
  const TRACKER_DOMAIN = 'https://niltracker.yourdomain.com';
  const LEAD_EMAIL = new URLSearchParams(window.location.search).get('le');
  const LEAD_ID = new URLSearchParams(window.location.search).get('li');

  document.querySelectorAll('[data-section]').forEach(section => {
    section.addEventListener('click', (e) => {
      const sectionName = e.currentTarget.dataset.section;
      
      // Track in Cloudflare Worker
      fetch(`${TRACKER_DOMAIN}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: generateCode(),
          lead_email: LEAD_EMAIL,
          lead_id: LEAD_ID,
          click_type: 'guide_section',
          parent_guide_section: sectionName,
          timestamp: Date.now(),
          ip_address: getClientIP(),
          user_agent: navigator.userAgent,
        })
      });
    });
  });

  function generateCode() {
    return 'guide-' + Math.random().toString(36).substr(2, 9);
  }

  function getClientIP() {
    // Note: Web doesn't have direct access; CF Worker can see it
    return 'client-side-ip';
  }
</script>
```

---

## Implementation Checklist

### Phase 1: Database Setup ✅
- [ ] Run migration: `CLICK_TRACKING_COMPREHENSIVE_GUIDE.md` SQL sections
- [ ] Create `nil.click_events` table
- [ ] Create views: `v_click_analytics_summary`, `v_clicks_daily`, `v_clicks_weekly`, `v_clicks_monthly`, `v_clicks_yearly`
- [ ] Set up indexes on `lead_id`, `click_type`, `timestamp`

### Phase 2: Cloudflare Worker ✅
- [ ] Deploy Cloudflare Worker code
- [ ] Set up KV namespace: `CLICK_TRACKING`
- [ ] Configure environment variables (Supabase URL, API key)
- [ ] Test: `https://niltracker.yourdomain.com/r/test-code`
- [ ] Create link mapping endpoints

### Phase 3: N8N Workflow Integration ✅
- [ ] Update Workflow 4 to insert clicks into `nil.click_events`
- [ ] Add "Detect Click Type" step
- [ ] Add "Lookup Lead ID" step
- [ ] Test end-to-end from Instantly.ai API to Supabase

### Phase 4: Telegram Bot Dashboard ✅
- [ ] Implement `/analytics` command
- [ ] Add `ANALYTICS:daily` callback
- [ ] Add `ANALYTICS:weekly` callback
- [ ] Add `ANALYTICS:monthly` callback
- [ ] Add `ANALYTICS:yearly` callback
- [ ] Add `ANALYTICS:geo` callback
- [ ] Test all views with sample data

### Phase 5: Parent Guide Integration ✅
- [ ] Add click tracking JavaScript to guide HTML
- [ ] Create guide section mappings (sections → click codes)
- [ ] Test guide clicks populate Cloudflare Worker
- [ ] Verify data flows to Supabase

### Phase 6: Reporting & Optimization ✅
- [ ] Create daily summary email (via Telegram)
- [ ] Set up trending alerts (unusual click activity)
- [ ] Identify top-performing sections
- [ ] A/B test different link placements
- [ ] Monitor mobile vs. desktop conversion rates

---

## Query Reference for Dashboard

### Get All Clicks in Last 7 Days
```sql
SELECT 
  click_type,
  COUNT(*) as total,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT device_type) as device_types,
  COUNT(DISTINCT email_client) as email_clients
FROM nil.click_events
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY click_type
ORDER BY total DESC;
```

### Top Guide Sections
```sql
SELECT 
  parent_guide_section,
  COUNT(*) as clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  ROUND(
    (COUNT(*)::numeric / (SELECT COUNT(*) FROM nil.click_events 
      WHERE click_type = 'guide_section'))::numeric * 100,
    2
  ) as pct_of_guide_clicks
FROM nil.click_events
WHERE click_type = 'guide_section'
GROUP BY parent_guide_section
ORDER BY clicks DESC;
```

### Mobile vs. Desktop Performance
```sql
SELECT 
  device_type,
  COUNT(*) as clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  ROUND(AVG(CAST(
    (SELECT COUNT(*) FROM nil.click_events ce2 
     WHERE ce2.lead_id = ce.lead_id AND ce2.click_type = 'enroll_button') 
    AS numeric
  )), 2) as avg_enrollments_per_lead
FROM nil.click_events ce
GROUP BY device_type;
```

### Email Client Performance
```sql
SELECT 
  email_client,
  COUNT(*) as clicks,
  COUNT(DISTINCT lead_id) as leads,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enrollments,
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END)::numeric 
     / COUNT(*)::numeric) * 100,
    2
  ) as enroll_rate
FROM nil.click_events
GROUP BY email_client
ORDER BY clicks DESC;
```

---

## Success Metrics

After implementation, track:

1. **Email Click-Through Rate (CTR)**: clicks / emails sent
2. **Guide Engagement**: unique leads clicking guide sections
3. **Mobile Optimization**: mobile CTR vs. desktop CTR
4. **Conversion Funnel**: program link clicks → guide views → enrollment clicks
5. **Top Drivers**: which links/sections drive most enrollments
6. **Time-to-Click**: average time from email open to first click
7. **Geographic Patterns**: which states/states generate most clicks
8. **Email Client Performance**: Gmail vs. Outlook vs. Apple Mail CLT rates

---

## Troubleshooting

### Clicks not appearing in dashboard?
1. Verify Cloudflare Worker is deployed: `curl https://niltracker.yourdomain.com/health`
2. Check KV namespace: `wrangler kv:key list CLICK_TRACKING`
3. Review Supabase logs for insert errors
4. Verify lead_id mapping exists in `nil.leads`

### Missing geographic data?
- Cloudflare Worker uses CF-provided headers (CF-IPCountry, CF-Latitude, CF-Longitude)
- These are only available when deployed to Cloudflare (not local testing)
- Ensure CF Worker is running in production

### Performance issues with large click volumes?
- Add pagination to dashboard queries
- Archive old clicks (> 1 year) to separate table
- Use materialized views for daily/weekly/monthly aggregations
- Consider read replicas for analytics queries

---

## Next Steps

1. **SQL Migration**: Run migration scripts in Supabase
2. **CF Worker Deploy**: Deploy code to your Cloudflare account
3. **N8N Integration**: Update Workflow 4 with click recording
4. **Telegram Bot Update**: Add analytics dashboard commands
5. **Guide Integration**: Add click tracking JavaScript
6. **Testing**: Send test emails, capture clicks, verify data flow
7. **Monitoring**: Set up alerts for anomalies
8. **Reporting**: Schedule weekly/monthly summaries

---

**Questions?** Review the queries in the sections above or consult your Supabase/Cloudflare documentation.
