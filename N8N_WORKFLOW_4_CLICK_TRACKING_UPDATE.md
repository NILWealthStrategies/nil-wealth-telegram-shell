# N8N Workflow 4 Integration: Click Tracking (Updated)

## Overview

This guide updates **Workflow 4: NIL Analytics Sync** to record email clicks from Instantly.ai into the new `nil.click_events` table.

**Current Status**: Workflow 4 only syncs Opens, Bounces, Replies  
**After Update**: Also records Clicks with full metadata

---

## Current Workflow 4 Structure

```
├── Trigger: Cron (Every 30 minutes)
├── Step 1: Get Campaign Analytics (HTTP GET Instantly API)
│   └─ Returns: List of all email events (opens, clicks, bounces, replies)
├── Step 2: Loop each event
├── Step 3: Lookup lead by email
├── Step 4: Map event type (open → 'email_open', click → 'email_click')
├── Step 5: Insert into nil.lead_metrics
│   └─ Columns: lead_id, metric_type, recorded_at, metadata, instantly_event_id
├── Step 6: Update lead engagement_score
└── Step 7: Notify Telegram (summary message)
```

---

## New Steps to Add

### **Step 5B: NEW - Insert Click Events (Parallel to Step 5)**

Between Step 5 (Insert lead_metrics) and Step 6 (Update engagement_score), add:

#### **Node Name**: `Supabase: Insert Click Events`

**Type**: Supabase Node

**Operation**: Insert

**Table**: `nil.click_events`

**Data Mapping**:

```json
{
  "lead_id": "{{ $node['Lookup Lead'].data.lead_id }}",
  "lead_email": "{{ $node['Get Campaign Analytics'].data.emailAddress }}",
  "click_type": "email_link",
  "url": "{{ $node['Extract Click URL'].data.clicked_link }}",
  "cloudflare_worker_id": "{{ $node['Extract CF ID'].data.cf_worker_id }}",
  "link_anchor_text": "{{ $node['Extract Click URL'].data.link_text }}",
  "device_type": "{{ $node['Extract Click Metadata'].data.device_type }}",
  "email_client": "{{ $node['Detect Email Client'].data.email_client }}",
  "user_agent": "{{ $node['Get Campaign Analytics'].data.userAgent }}",
  "ip_address": "{{ $node['Get Campaign Analytics'].data.ipAddress }}",
  "location": {
    "country": "{{ $node['Get Campaign Analytics'].data.country }}",
    "state": "{{ $node['Get Campaign Analytics'].data.state }}",
    "city": "{{ $node['Get Campaign Analytics'].data.city }}",
    "latitude": "{{ $node['Get Campaign Analytics'].data.latitude }}",
    "longitude": "{{ $node['Get Campaign Analytics'].data.longitude }}"
  },
  "email_campaign_id": "{{ $node['Get Campaign Analytics'].data.campaignId }}",
  "email_sequence_number": "{{ $node['Get Campaign Analytics'].data.sequenceNumber }}",
  "email_template_version": "{{ $node['Get Campaign Analytics'].data.templateVersion }}",
  "utm_source": "email",
  "utm_medium": "outreach",
  "utm_campaign": "{{ $node['Get Campaign Analytics'].data.campaignName }}",
  "utm_content": "{{ $node['Get Campaign Analytics'].data.templateVersion }}_seq_{{ $node['Get Campaign Analytics'].data.sequenceNumber}}",
  "referer": "{{ $node['Get Campaign Analytics'].data.referer }}",
  "recorded_by": "instantly",
  "recorded_from_ip": "{{ $node['Get Campaign Analytics'].data.systemIp }}",
  "metadata": {
    "instantly_event_id": "{{ $node['Get Campaign Analytics'].data.eventId }}",
    "event_timestamp": "{{ $node['Get Campaign Analytics'].data.clickTimestamp }}",
    "email_id": "{{ $node['Get Campaign Analytics'].data.emailId }}",
    "recipient_email": "{{ $node['Get Campaign Analytics'].data.emailAddress }}",
    "raw_instantly_data": "{{ $node['Get Campaign Analytics'].data }}"
  },
  "instantly_event_id": "{{ $node['Get Campaign Analytics'].data.eventId }}",
  "timestamp": "{{ $node['Get Campaign Analytics'].data.clickTimestamp }}"
}
```

---

### Helper Nodes to Add (First)

Before Step 5B, add these helper nodes to extract and detect click details:

#### **Node 4A (New)**: `Extract Click URL`

**Type**: Function (JavaScript)

**Code**:
```javascript
// Extract URL and link text from Instantly event metadata
const event = $input.first().json;

return {
  clicked_link: event.url || event.clickedUrl || "",
  link_text: event.linkAnchor || event.linkText || "Link",
  link_position: event.linkPosition || 1,
  is_first_click: event.isFirstClick || false,
  click_count: event.clickCount || 1
};
```

#### **Node 4B (New)**: `Extract Click Metadata`

**Type**: Function (JavaScript)

**Code**:
```javascript
// Detect device type and extract click metadata
const event = $input.first().json;
const userAgent = event.userAgent || "";

function detectDevice(ua) {
  const mobilePatterns = [
    /mobile/i, /iphone/i, /ipad/i, /android/i, 
    /blackberry/i, /windows phone/i
  ];
  return mobilePatterns.some(p => p.test(ua)) ? "mobile" : "desktop";
}

function detectEmailClient(ua) {
  if (/gmail/i.test(ua)) return "Gmail";
  if (/outlook/i.test(ua) || /ole32/i.test(ua)) return "Outlook";
  if (/mac.*mail|apple/i.test(ua)) return "Apple Mail";
  if (/yahoo/i.test(ua)) return "Yahoo";
  if (/thunderbird/i.test(ua)) return "Thunderbird";
  return "Other";
}

return {
  device_type: detectDevice(userAgent),
  email_client: detectEmailClient(userAgent),
  user_agent: userAgent,
  ip_address: event.ipAddress || event.ip || "",
  country: event.country || "Unknown",
  state: event.state || "",
  city: event.city || "",
  latitude: event.latitude || null,
  longitude: event.longitude || null
};
```

#### **Node 4C (New)**: `Detect Email Client`

**Type**: Function (JavaScript)

**Code**:
```javascript
// More comprehensive email client detection
const event = $input.first().json;
const userAgent = event.userAgent || "";
const ua = userAgent.toLowerCase();

const clients = {
  "Gmail": /gmail|google/i,
  "Outlook": /outlook|ole32|windows-mail/i,
  "Apple Mail": /mac.*mail|apple.*mail/i,
  "Yahoo": /yahoo|ymail/i,
  "Thunderbird": /thunderbird/i,
  "Protonmail": /proton/i,
  "FastMail": /fastmail/i,
  "AOL": /aol/i,
  "Mail.ru": /mailru|mail\.ru/i,
  "Yandex": /yandex/i,
};

let detected = "Unknown";
for (const [client, pattern] of Object.entries(clients)) {
  if (pattern.test(ua)) {
    detected = client;
    break;
  }
}

return {
  email_client: detected,
  confidence: detected !== "Unknown" ? "high" : "low"
};
```

#### **Node 4D (New)**: `Extract CF ID`

**Type**: Function (JavaScript)

**Code**:
```javascript
// Extract Cloudflare Worker tracking code if present
const event = $input.first().json;

// CF Worker ID could come as:
// - cf_worker_id from Instantly webhook
// - In URL as tracking parameter
// - Generated if not present

const cfId = event.cf_worker_id || 
            event.trackingCode || 
            event.cfWorkerId ||
            `instantly-${event.eventId?.substring(0, 8) || 'unknown'}`;

return {
  cf_worker_id: cfId,
  is_cf_tracked: !!event.cf_worker_id,
  source: event.cf_worker_id ? "instantly" : "generated"
};
```

---

## Updated Workflow 4 Configuration

### **Complete Flow Diagram**

```
Trigger: Cron Schedule
  ↓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 1. Get Campaign Analytics (HTTP GET Instantly)
    └─ Output: Array of events (opens, clicks, bounces, replies)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ↓
  For Each Event:
  ↓
  2. Map Event Type
     IF metric_type = "click" THEN continue to Step 3
  ↓
  3. Extract Click URL (NEW)
  ↓
  4a. Extract Click Metadata (NEW)
  ↓
  4b. Detect Email Client (NEW)
  ↓
  4c. Extract CF ID (NEW)
  ↓
  ↓ [Parallel Branches]
  ├──────────────────────────────┬──────────────────────────────┐
  │                              │                              │
  Branch A: OPENS/BOUNCES        Branch B: CLICKS (NEW)        Priority: Both
  │                              │
  5a. Lookup Lead by email       5b. Lookup Lead by email
  │   ↓                          │   ↓
  6a. Insert to lead_metrics     6b. Insert to click_events (NEW)
  │   (type='email_open')        │   (with full metadata)
  │   ↓                          │   ↓
  7a. Update engagement_score    7b. Update link_registry stats (NEW)
  │                              │
  └──────────────────────────────┴──────────────────────────────┘
  ↓
  8. Convert to metric summary
  ↓
  9. POST to Telegram Bot Dashboard Update
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## New Nodes Detailed Configuration

### **Node Type: Supabase > Insert Click Events**

```yaml
Name: "Supabase: Insert Click Events"
Type: "Supabase"
Operation: "Insert rows"

Configuration:
  Database: "Production"
  Table: "nil.click_events"
  Columns:
    - lead_id
    - lead_email
    - click_type (always "email_link" for this workflow)
    - url
    - cloudflare_worker_id
    - link_anchor_text
    - device_type
    - email_client
    - user_agent
    - ip_address
    - location (JSON)
    - email_campaign_id
    - email_sequence_number
    - email_template_version
    - utm_source
    - utm_medium
    - utm_campaign
    - utm_content
    - referer
    - recorded_by (always "instantly")
    - recorded_from_ip
    - metadata (JSON)
    - timestamp
    - instantly_event_id

Return Data: "Data of inserted rows"
```

---

### **Node Type: Supabase > Update Link Registry**

**NEW Optional Step** - Updates click counts on tracking links

```yaml
Name: "Supabase: Update Link Registry"
Type: "Supabase"
Operation: "Update rows"

Filter:
  tracking_code = "{{ $node['Extract CF ID'].data.cf_worker_id }}"

Update Data:
  total_clicks: "{{ $node['Supabase: Update Link Registry'].data.total_clicks + 1 }}"
  last_clicked_at: "{{ $node['Get Campaign Analytics'].data.clickTimestamp }}"
```

---

## Conditional Logic for Click Events

### **Node Name**: `Should Process Click?`

**Type**: Function (JavaScript)

**Place it**: After "Get Campaign Analytics" in loop

**Code**:
```javascript
const event = $input.first().json;
const eventType = event.type || event.metric_type || "";

// Only process click events for this branch
if (eventType.toLowerCase().includes("click")) {
  return { shouldProcess: true };
} else {
  return { shouldProcess: false };
}
```

Then set **Conditional** ahead of Step 5B (Insert Click Events):
```
Enable If: 
  $node['Should Process Click?'].data.shouldProcess === true
```

---

## Error Handling

### **Node Name**: `Handle Click Insert Errors`

**Type**: Function (JavaScript)

**Code**:
```javascript
// Graceful degradation if click insert fails
try {
  const result = $input.first().json;
  return {
    success: !result.error,
    error: result.error || null,
    clickId: result.id || null,
    retryable: result.message?.includes("connection") || false
  };
} catch (err) {
  return {
    success: false,
    error: err.message,
    retryable: true
  };
}
```

---

## Testing the Updated Workflow

### **Test 1: Manual Trigger**

Send a test webhook from Instantly.ai:

```json
{
  "event": "click",
  "eventId": "test_click_12345",
  "emailAddress": "coach@example.com",
  "campaignId": "test_campaign_id",
  "url": "https://nilwealthstrategies.com/programs",
  "clickedUrl": "https://nilwealthstrategies.com/programs?utm_source=email&utm_campaign=test",
  "linkAnchor": "Learn About Programs",
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)",
  "ipAddress": "192.168.1.1",
  "country": "USA",
  "state": "GA",
  "city": "Atlanta",
  "latitude": 33.7490,
  "longitude": -84.3880,
  "clickTimestamp": "2026-03-05T10:30:00Z",
  "deviceType": "mobile",
  "emailClient": "Gmail"
}
```

### **Test 2: Verify Database Insert**

Query Supabase:
```sql
SELECT * FROM nil.click_events 
ORDER BY timestamp DESC 
LIMIT 1;
```

Expected output:
```
id       | lead_id | click_type  | url                      | device_type | email_client | timestamp
────────┼─────────┼─────────────┼──────────────────────────┼─────────────┼──────────────┼──────────────────
uuid    | uuid    | email_link  | https://nilwealthstrategies.com/programs | mobile | Gmail | 2026-03-05 10:30:00
```

### **Test 3: Check Dashboard View**

```sql
SELECT * FROM nil.v_click_summary_today;
```

Should show:
- `email_link_clicks: 1`
- `unique_leads: 1`
- `mobile_clicks: 1`
- `gmail_clicks: 1`

---

## Migration Path (No Downtime)

### **Step 1**: Deploy SQL Migration
```bash
# In Supabase SQL Editor, run:
-- Click Tracking Migration (from sql/click_tracking_migration.sql)
```

### **Step 2**: Update Workflow 4 (Keep Old Running)
- Add new click detection steps
- Test with 10 sample events
- Deploy to staging first

### **Step 3**: Enable Click Recording
- Turn on the new "Insert Click Events" node
- Monitor error logs for 1 hour
- No data loss - Instantly.ai events are deduplicated by `instantly_event_id`

### **Step 4**: Backfill Historical Clicks
```sql
-- After Workflow 4 is updated, backfill from lead_metrics
INSERT INTO nil.click_events 
  (lead_id, click_type, url, timestamp, metadata, instantly_event_id, recorded_by)
SELECT 
  lm.lead_id,
  'email_link' as click_type,
  lm.metadata->>'url' as url,
  lm.recorded_at as timestamp,
  lm.metadata,
  lm.instantly_event_id,
  'lead_metrics_backfill' as recorded_by
FROM nil.lead_metrics lm
WHERE lm.metric_type = 'email_click'
  AND NOT EXISTS (
    SELECT 1 FROM nil.click_events ce 
    WHERE ce.instantly_event_id = lm.instantly_event_id
  );
```

---

## Notification Update

### **Updated Telegram Message**

Change the notification from:

```plain
📊 Analytics Sync Complete
├─ Opens: 12
├─ Bounces: 2
└─ Replies: 3
```

To:

```plain
📊 Analytics Sync Complete
├─ Opens: 12
├─ Clicks: 5
├─ Bounces: 2
└─ Replies: 3

📍 Top Clicked Link: "Learn About Programs"
🌐 Devices: 3 mobile, 2 desktop
```

---

## Configuration in Telegram Bot

In `src/index.js`, update the analytics command to show clicks:

```javascript
async function sbMetricSummary({ source = "all", window = "month" }) {
  try {
    // Get click summary
    const { data: clicks, error: clickError } = await ops()
      .from('v_click_summary_today')
      .select('*')
      .single();

    if (!clickError && clicks) {
      return {
        ...existingMetrics,
        emailClicksToday: clicks.email_link_clicks,
        guideClicksToday: clicks.guide_section_clicks,
        enrollClicksToday: clicks.enroll_button_clicks,
        deviceBreakdown: `${clicks.mobile_clicks} mobile, ${clicks.desktop_clicks} desktop`
      };
    }
  } catch (err) {
    console.error('Click metrics error:', err);
  }
}
```

---

## Performance Tuning

### **Recommended Indexes** (Already in Migration)

```sql
CREATE INDEX idx_click_events_date_type 
  ON nil.click_events(DATE("timestamp"), click_type);

CREATE INDEX idx_click_events_lead_date 
  ON nil.click_events(lead_id, "timestamp" DESC);
```

### **Scheduled Daily Refresh**

Add a cron-triggered workflow to refresh `nil.click_analytics_daily`:

```javascript
// After Workflow 4 completes, run:
await supabase.rpc('refresh_click_analytics_daily', { 
  p_date: new Date().toISOString().split('T')[0] 
});
```

---

## FAQ

### Q: Will this slow down Workflow 4?
**A**: No. Click insertion is parallel to lead_metrics insertion. Adds ~200ms per batch.

### Q: Do we lose historical clicks?
**A**: No. Run the backfill query after deploying. All Instantly.ai events since campaign start are recoverable.

### Q: What if Instantly.ai sends duplicate click events?
**A**: The `instantly_event_id` UNIQUE constraint prevents duplicates automatically.

### Q: How do we track Cloudflare Worker clicks?
**A**: CF Worker posts directly to `/track` endpoint (separate HTTP node in workflow). Or CF Worker forwards to Telegram bot webhook.

---

## Next: Cloudflare Worker Setup

After completing N8N workflow updates, proceed to [CLOUDFLARE_WORKER_DEPLOYMENT.md](./CLOUDFLARE_WORKER_DEPLOYMENT.md) for the link tracking service.

---

**Workflow Test Checklist**:
- [ ] Helper nodes (Extract URL, Metadata, Email Client, CF ID) added
- [ ] "Should Process Click?" conditional added
- [ ] "Insert Click Events" node configured with all mappings
- [ ] "Update Link Registry" node connected
- [ ] Test with sample click event
- [ ] Verify database insert
- [ ] Check Telegram notification
- [ ] Monitor error logs for 24 hours
- [ ] Backfill historical clicks
- [ ] Update bot dashboard command
