-- ============================================================================
-- CLICK TRACKING SYSTEM: COMPLETE SQL MIGRATION
-- Nil Wealth Telegram Bot + Cloudflare Worker Integration
-- ============================================================================
--
-- This migration creates all tables, indexes, and views needed for:
-- 1. Recording clicks from Instantly.ai campaign emails
-- 2. Tracking parent guide section clicks via Cloudflare Worker
-- 3. Enrollment button clicks from application forms
-- 4. Dashboard analytics (daily, weekly, monthly, yearly aggregations)
--
-- Safe to run multiple times (uses IF NOT EXISTS)
-- ============================================================================

-- ============================================================================
-- SECTION 1: CLICK EVENTS TABLE (Core)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.click_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identifiers
  lead_id UUID,                              -- FK to nil.leads (optional - may be null for anonymous clicks)
  lead_email TEXT,                           -- Denormalized for quick lookup
  
  -- Click classification
  click_type TEXT NOT NULL,                  -- 'email_link' | 'guide_section' | 'enroll_button' | 'dashboard_view'
  url TEXT,                                  -- Full URL clicked
  
  -- Link tracking
  cloudflare_worker_id TEXT,                 -- Tracking code from CF Worker (e.g., 'a1b2c3d4')
  link_position INTEGER,                     -- Which link in email (1st, 2nd, etc.)
  link_anchor_text TEXT,                     -- Text of the link
  
  -- Device & Browser Info
  device_type TEXT,                          -- 'mobile' | 'desktop' | 'unknown'
  email_client TEXT,                         -- 'Gmail' | 'Outlook' | 'Apple Mail' | 'Yahoo' | 'Other' | 'Unknown'
  user_agent TEXT,                           -- Full user agent string
  ip_address TEXT,
  
  -- Geographic
  location JSONB,                            -- { country, state, city, latitude, longitude }
  
  -- Parent Guide Specific
  parent_guide_section TEXT,                 -- Section ID if click_type = 'guide_section'
  parent_guide_page TEXT,                    -- Page name if guide click
  
  -- Enrollment Specific
  enrollment_step TEXT,                      -- 'step_1' | 'step_2' | 'step_3' if click_type = 'enroll_button'
  enrollment_form_field TEXT,                -- Which field was clicked
  
  -- Email Campaign Info
  email_id UUID,                             -- FK to nil.messages (if trackable)
  email_campaign_id TEXT,                    -- Instantly.ai campaign ID
  email_sequence_number INTEGER,             -- Which email in sequence (1, 2, 3)
  email_template_version TEXT,               -- 'v1' | 'v2' | 'v3' (AI version)
  
  -- UTM Tracking
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  
  -- Referrer & Context
  referer TEXT,
  
  -- Source System
  recorded_by TEXT DEFAULT 'unknown',        -- 'instantly' | 'cloudflare' | 'telegram_bot' | 'direct' | 'unknown'
  recorded_from_ip TEXT,                     -- IP of system that recorded this event
  
  -- Metadata & Extensibility
  metadata JSONB,                            -- Flexible storage for additional data
  
  -- Timestamps
  "timestamp" TIMESTAMPTZ DEFAULT now(),
  recorded_at TIMESTAMPTZ DEFAULT now(),
  
  -- Deduplication
  instantly_event_id TEXT,                   -- Unique ID from Instantly API (prevents duplicates)
  CONSTRAINT unique_instantly_event UNIQUE(instantly_event_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_click_events_lead_id 
  ON nil.click_events(lead_id);

CREATE INDEX IF NOT EXISTS idx_click_events_lead_email 
  ON nil.click_events(lead_email);

CREATE INDEX IF NOT EXISTS idx_click_events_type 
  ON nil.click_events(click_type);

CREATE INDEX IF NOT EXISTS idx_click_events_timestamp 
  ON nil.click_events("timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_click_events_recorded_at 
  ON nil.click_events(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_click_events_device 
  ON nil.click_events(device_type);

CREATE INDEX IF NOT EXISTS idx_click_events_email_client 
  ON nil.click_events(email_client);

CREATE INDEX IF NOT EXISTS idx_click_events_guide_section 
  ON nil.click_events(parent_guide_section) 
  WHERE click_type = 'guide_section';

CREATE INDEX IF NOT EXISTS idx_click_events_date_type 
  ON nil.click_events(DATE("timestamp"), click_type);

CREATE INDEX IF NOT EXISTS idx_click_events_lead_date 
  ON nil.click_events(lead_id, "timestamp" DESC);

-- Partial indexes for performance
CREATE INDEX IF NOT EXISTS idx_click_events_mobile 
  ON nil.click_events(lead_id, "timestamp") 
  WHERE device_type = 'mobile';

CREATE INDEX IF NOT EXISTS idx_click_events_desktop 
  ON nil.click_events(lead_id, "timestamp") 
  WHERE device_type = 'desktop';

-- ============================================================================
-- SECTION 2: HELPER TABLE - CLICK LINK REGISTRY
-- ============================================================================
--
-- Store metadata about tracking links created by the system
-- Helps correlate tracking codes with actual content
--

CREATE TABLE IF NOT EXISTS nil.click_link_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Link identification
  tracking_code TEXT UNIQUE NOT NULL,        -- CF Worker code (e.g., 'a1b2c3d4')
  destination_url TEXT NOT NULL,             -- Where this link redirects to
  
  -- Link classification
  link_type TEXT,                            -- 'program_link' | 'guide' | 'enroll' | 'other'
  link_label TEXT,                           -- Human-readable name
  link_description TEXT,
  
  -- Campaign context
  campaign_id TEXT,                          -- Instantly.ai campaign ID
  email_template_version TEXT,               -- 'v1' | 'v2' | 'v3'
  email_sequence_number INTEGER,
  
  -- Parent guide context
  guide_section TEXT,                        -- If this is a guide link
  guide_page TEXT,
  
  -- Enrollment context
  enrollment_step TEXT,                      -- If this is an enrollment link
  
  -- UTM Parameters
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  
  -- Metadata
  metadata JSONB,
  
  -- Lifecycle
  created_by TEXT,                           -- 'n8n_workflow_4' | 'telegram_bot' | 'api'
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,                    -- Optional expiration
  is_active BOOLEAN DEFAULT true,
  
  -- Stats
  total_clicks INTEGER DEFAULT 0,
  unique_clickers INTEGER DEFAULT 0,
  last_clicked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_click_link_registry_code 
  ON nil.click_link_registry(tracking_code);

CREATE INDEX IF NOT EXISTS idx_click_link_registry_campaign 
  ON nil.click_link_registry(campaign_id);

CREATE INDEX IF NOT EXISTS idx_click_link_registry_guide 
  ON nil.click_link_registry(guide_section);

-- ============================================================================
-- SECTION 3: DAILY AGGREGATIONS TABLE (Materialized)
-- ============================================================================
--
-- Pre-computed daily summaries for fast dashboard queries
-- Refresh every night at midnight EST
--

CREATE TABLE IF NOT EXISTS nil.click_analytics_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  click_date DATE NOT NULL,
  
  -- Totals by type
  email_link_clicks INTEGER DEFAULT 0,
  email_link_leads INTEGER DEFAULT 0,
  
  guide_section_clicks INTEGER DEFAULT 0,
  guide_section_leads INTEGER DEFAULT 0,
  top_guide_section TEXT,
  
  enroll_button_clicks INTEGER DEFAULT 0,
  enroll_button_leads INTEGER DEFAULT 0,
  
  dashboard_view_clicks INTEGER DEFAULT 0,
  dashboard_view_leads INTEGER DEFAULT 0,
  
  -- Device breakdown
  mobile_clicks INTEGER DEFAULT 0,
  desktop_clicks INTEGER DEFAULT 0,
  unknown_device_clicks INTEGER DEFAULT 0,
  
  -- Email client breakdown
  gmail_clicks INTEGER DEFAULT 0,
  outlook_clicks INTEGER DEFAULT 0,
  apple_mail_clicks INTEGER DEFAULT 0,
  yahoo_clicks INTEGER DEFAULT 0,
  other_client_clicks INTEGER DEFAULT 0,
  
  -- Aggregates
  total_clicks INTEGER DEFAULT 0,
  unique_leads INTEGER DEFAULT 0,
  unique_devices INTEGER DEFAULT 0,
  unique_email_clients INTEGER DEFAULT 0,
  
  -- Conversion metrics
  email_to_guide_conversion NUMERIC,
  email_to_enroll_conversion NUMERIC,
  
  -- Geographic
  top_country TEXT,
  top_state TEXT,
  unique_countries INTEGER DEFAULT 0,
  unique_states INTEGER DEFAULT 0,
  
  -- Refresh tracking
  computed_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_click_date UNIQUE(click_date)
);

CREATE INDEX IF NOT EXISTS idx_click_analytics_daily_date 
  ON nil.click_analytics_daily(click_date DESC);

-- ============================================================================
-- SECTION 4: VIEWS FOR TELEGRAM BOT DASHBOARD
-- ============================================================================

-- Summary view: Today's (or specified day's) click summary
CREATE OR REPLACE VIEW nil.v_click_summary_today AS
SELECT
  COUNT(*) as total_clicks,
  COUNT(DISTINCT click_type) as click_types_recorded,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_section_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_button_clicks,
  COUNT(DISTINCT email_client) as unique_email_clients,
  (
    SELECT STRING_AGG(DISTINCT col, ', ')
    FROM (
      VALUES 
        (parent_guide_section)
    ) AS subquery(col)
    WHERE parent_guide_section IS NOT NULL
  ) as guide_sections_clicked
FROM nil.click_events
WHERE DATE("timestamp") = CURRENT_DATE;

-- Daily summary across date range
CREATE OR REPLACE VIEW nil.v_click_daily_summary AS
SELECT
  DATE("timestamp") as click_date,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT click_type) as click_types,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_clicks,
  COUNT(DISTINCT email_client) as email_clients_used,
  ROUND(
    (COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END)::numeric / COUNT(*)::numeric * 100),
    1
  ) as mobile_pct,
  ROUND(
    (COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END)::numeric / COUNT(*)::numeric * 100),
    1
  ) as desktop_pct
FROM nil.click_events
GROUP BY DATE("timestamp")
ORDER BY click_date DESC;

-- Weekly summary
CREATE OR REPLACE VIEW nil.v_click_weekly_summary AS
SELECT
  DATE_TRUNC('week', "timestamp")::DATE as week_start,
  (DATE_TRUNC('week', "timestamp")::DATE + INTERVAL '6 days')::DATE as week_end,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_clicks,
  ROUND(
    (COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END)::numeric / COUNT(*)::numeric * 100),
    1
  ) as mobile_pct,
  ROUND(
    (COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END)::numeric / COUNT(*)::numeric * 100),
    1
  ) as desktop_pct,
  COUNT(DISTINCT email_client) as email_clients_used
FROM nil.click_events
GROUP BY DATE_TRUNC('week', "timestamp")
ORDER BY week_start DESC;

-- Monthly summary
CREATE OR REPLACE VIEW nil.v_click_monthly_summary AS
SELECT
  DATE_TRUNC('month', "timestamp")::DATE as month_start,
  (DATE_TRUNC('month', "timestamp") + INTERVAL '1 month' - INTERVAL '1 day')::DATE as month_end,
  EXTRACT(MONTH FROM "timestamp")::INTEGER as month_num,
  EXTRACT(YEAR FROM "timestamp")::INTEGER as year_num,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_clicks,
  ROUND(
    AVG(CAST(
      (SELECT COUNT(*) FROM nil.click_events ce2 
       WHERE DATE(ce2."timestamp") = DATE(ce1."timestamp")) 
    AS NUMERIC)),
    1
  ) as avg_daily_clicks,
  COUNT(DISTINCT DATE("timestamp")) as active_days,
  COUNT(DISTINCT email_client) as email_clients_used,
  MAX(CASE WHEN click_type = 'guide_section' THEN parent_guide_section END) as top_guide_section
FROM nil.click_events ce1
GROUP BY DATE_TRUNC('month', "timestamp"), EXTRACT(MONTH FROM "timestamp"), EXTRACT(YEAR FROM "timestamp")
ORDER BY month_start DESC;

-- Yearly summary
CREATE OR REPLACE VIEW nil.v_click_yearly_summary AS
SELECT
  EXTRACT(YEAR FROM "timestamp")::INTEGER as year,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_clicks,
  COUNT(DISTINCT DATE("timestamp")) as active_days,
  ROUND(AVG(CAST(
    (SELECT COUNT(*) FROM nil.click_events ce2 
     WHERE DATE(ce2."timestamp") = DATE(ce1."timestamp")) 
  AS NUMERIC)), 1) as avg_daily_clicks,
  COUNT(DISTINCT email_client) as email_clients_used,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks
FROM nil.click_events ce1
GROUP BY EXTRACT(YEAR FROM "timestamp")
ORDER BY year DESC;

-- Device breakdown across all time
CREATE OR REPLACE VIEW nil.v_click_device_breakdown AS
SELECT
  device_type,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT email_client) as email_clients,
  ROUND((COUNT(*)::numeric / (SELECT COUNT(*) FROM nil.click_events)::numeric * 100), 2) as pct_of_total,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enrollments,
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END)::numeric / 
     COUNT(*)::numeric * 100),
    2
  ) as enroll_conversion_rate
FROM nil.click_events
GROUP BY device_type
ORDER BY total_clicks DESC;

-- Email client breakdown
CREATE OR REPLACE VIEW nil.v_click_email_client_breakdown AS
SELECT
  email_client,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  ROUND((COUNT(*)::numeric / (SELECT COUNT(*) FROM nil.click_events)::numeric * 100), 2) as pct_of_total,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enrollments,
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END)::numeric / 
     COUNT(*)::numeric * 100),
    2
  ) as enroll_conversion_rate
FROM nil.click_events
WHERE email_client IS NOT NULL
GROUP BY email_client
ORDER BY total_clicks DESC;

-- Top guide sections
CREATE OR REPLACE VIEW nil.v_click_top_guide_sections AS
SELECT
  parent_guide_section,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END) as mobile_clicks,
  COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END) as desktop_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as follow_up_enrollments,
  ROUND(
    (COUNT(*)::numeric / (SELECT COUNT(*) FROM nil.click_events WHERE click_type = 'guide_section')::numeric * 100),
    2
  ) as pct_of_guide_clicks,
  MAX("timestamp") as last_clicked_at
FROM nil.click_events
WHERE click_type = 'guide_section' AND parent_guide_section IS NOT NULL
GROUP BY parent_guide_section
ORDER BY total_clicks DESC;

-- Geographic breakdown
CREATE OR REPLACE VIEW nil.v_click_geographic_breakdown AS
SELECT
  COALESCE(location->>'country', 'Unknown') as country,
  COALESCE(location->>'state', 'Unknown') as state,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT lead_id) as unique_leads,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enrollments,
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END)::numeric / 
     COUNT(*)::numeric * 100),
    2
  ) as enroll_conversion_rate,
  ROUND(
    (COUNT(*)::numeric / (SELECT COUNT(*) FROM nil.click_events)::numeric * 100),
    2
  ) as pct_of_total_clicks
FROM nil.click_events
GROUP BY 
  COALESCE(location->>'country', 'Unknown'),
  COALESCE(location->>'state', 'Unknown')
ORDER BY total_clicks DESC;

-- Conversion funnel: email clicks → guide clicks → enrollments
CREATE OR REPLACE VIEW nil.v_click_conversion_funnel AS
SELECT
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END) as leads_with_email_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN lead_id END) as leads_with_guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN lead_id END) as leads_with_enrollments,
  
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN lead_id END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END), 0) * 100),
    2
  ) as email_to_guide_conversion_rate,
  
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN lead_id END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN lead_id END), 0) * 100),
    2
  ) as guide_to_enroll_conversion_rate,
  
  ROUND(
    (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN lead_id END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END), 0) * 100),
    2
  ) as email_to_enroll_conversion_rate
FROM nil.click_events;

-- Lead-level click stats
CREATE OR REPLACE VIEW nil.v_click_lead_stats AS
SELECT
  lead_id,
  lead_email,
  COUNT(*) as total_clicks,
  COUNT(DISTINCT DATE("timestamp")) as active_days,
  MAX("timestamp") as last_clicked_at,
  COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END) as email_link_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END) as guide_clicks,
  COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END) as enroll_clicks,
  COUNT(DISTINCT device_type) as device_types_used,
  COUNT(DISTINCT email_client) as email_clients_used,
  STRING_AGG(DISTINCT parent_guide_section, ', ' ORDER BY parent_guide_section) as guide_sections_viewed
FROM nil.click_events
WHERE lead_id IS NOT NULL
GROUP BY lead_id, lead_email
ORDER BY total_clicks DESC;

-- ============================================================================
-- SECTION 5: REFRESH FUNCTION FOR DAILY MATERIALIZED VIEW
-- ============================================================================

CREATE OR REPLACE FUNCTION nil.refresh_click_analytics_daily(p_date DATE DEFAULT CURRENT_DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO nil.click_analytics_daily (click_date, email_link_clicks, email_link_leads, guide_section_clicks, guide_section_leads, top_guide_section, enroll_button_clicks, enroll_button_leads, dashboard_view_clicks, dashboard_view_leads, mobile_clicks, desktop_clicks, unknown_device_clicks, gmail_clicks, outlook_clicks, apple_mail_clicks, yahoo_clicks, other_client_clicks, total_clicks, unique_leads, unique_devices, unique_email_clients, email_to_guide_conversion, email_to_enroll_conversion, top_country, top_state, unique_countries, unique_states, computed_at)
  SELECT
    p_date,
    COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN id END),
    COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END),
    COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN id END),
    COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN lead_id END),
    (SELECT parent_guide_section FROM nil.click_events WHERE DATE("timestamp") = p_date AND click_type = 'guide_section' GROUP BY parent_guide_section ORDER BY COUNT(*) DESC LIMIT 1),
    COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN id END),
    COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN lead_id END),
    COUNT(DISTINCT CASE WHEN click_type = 'dashboard_view' THEN id END),
    COUNT(DISTINCT CASE WHEN click_type = 'dashboard_view' THEN lead_id END),
    COUNT(DISTINCT CASE WHEN device_type = 'mobile' THEN id END),
    COUNT(DISTINCT CASE WHEN device_type = 'desktop' THEN id END),
    COUNT(DISTINCT CASE WHEN device_type = 'unknown' THEN id END),
    COUNT(DISTINCT CASE WHEN email_client = 'Gmail' THEN id END),
    COUNT(DISTINCT CASE WHEN email_client = 'Outlook' THEN id END),
    COUNT(DISTINCT CASE WHEN email_client = 'Apple Mail' THEN id END),
    COUNT(DISTINCT CASE WHEN email_client = 'Yahoo' THEN id END),
    COUNT(DISTINCT CASE WHEN email_client NOT IN ('Gmail', 'Outlook', 'Apple Mail', 'Yahoo') THEN id END),
    COUNT(*),
    COUNT(DISTINCT lead_id),
    COUNT(DISTINCT device_type),
    COUNT(DISTINCT email_client),
    ROUND(
      (COUNT(DISTINCT CASE WHEN click_type = 'guide_section' THEN lead_id END)::numeric / 
       NULLIF(COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END), 0) * 100),
      2
    ),
    ROUND(
      (COUNT(DISTINCT CASE WHEN click_type = 'enroll_button' THEN lead_id END)::numeric / 
       NULLIF(COUNT(DISTINCT CASE WHEN click_type = 'email_link' THEN lead_id END), 0) * 100),
      2
    ),
    (SELECT location->>'country' FROM nil.click_events WHERE DATE("timestamp") = p_date GROUP BY location->>'country' ORDER BY COUNT(*) DESC LIMIT 1),
    (SELECT location->>'state' FROM nil.click_events WHERE DATE("timestamp") = p_date AND location->>'country' = 'USA' GROUP BY location->>'state' ORDER BY COUNT(*) DESC LIMIT 1),
    COUNT(DISTINCT location->>'country'),
    COUNT(DISTINCT location->>'state'),
    NOW()
  FROM nil.click_events
  WHERE DATE("timestamp") = p_date
  ON CONFLICT (click_date) DO UPDATE SET
    email_link_clicks = EXCLUDED.email_link_clicks,
    email_link_leads = EXCLUDED.email_link_leads,
    guide_section_clicks = EXCLUDED.guide_section_clicks,
    guide_section_leads = EXCLUDED.guide_section_leads,
    top_guide_section = EXCLUDED.top_guide_section,
    enroll_button_clicks = EXCLUDED.enroll_button_clicks,
    enroll_button_leads = EXCLUDED.enroll_button_leads,
    dashboard_view_clicks = EXCLUDED.dashboard_view_clicks,
    dashboard_view_leads = EXCLUDED.dashboard_view_leads,
    mobile_clicks = EXCLUDED.mobile_clicks,
    desktop_clicks = EXCLUDED.desktop_clicks,
    unknown_device_clicks = EXCLUDED.unknown_device_clicks,
    gmail_clicks = EXCLUDED.gmail_clicks,
    outlook_clicks = EXCLUDED.outlook_clicks,
    apple_mail_clicks = EXCLUDED.apple_mail_clicks,
    yahoo_clicks = EXCLUDED.yahoo_clicks,
    other_client_clicks = EXCLUDED.other_client_clicks,
    total_clicks = EXCLUDED.total_clicks,
    unique_leads = EXCLUDED.unique_leads,
    unique_devices = EXCLUDED.unique_devices,
    unique_email_clients = EXCLUDED.unique_email_clients,
    email_to_guide_conversion = EXCLUDED.email_to_guide_conversion,
    email_to_enroll_conversion = EXCLUDED.email_to_enroll_conversion,
    top_country = EXCLUDED.top_country,
    top_state = EXCLUDED.top_state,
    unique_countries = EXCLUDED.unique_countries,
    unique_states = EXCLUDED.unique_states,
    computed_at = NOW();
END;
$$;

-- ============================================================================
-- SECTION 6: PERMISSIONS
-- ============================================================================

GRANT ALL ON nil.click_events TO service_role;
GRANT ALL ON nil.click_link_registry TO service_role;
GRANT ALL ON nil.click_analytics_daily TO service_role;

GRANT SELECT ON nil.v_click_summary_today TO service_role;
GRANT SELECT ON nil.v_click_daily_summary TO service_role;
GRANT SELECT ON nil.v_click_weekly_summary TO service_role;
GRANT SELECT ON nil.v_click_monthly_summary TO service_role;
GRANT SELECT ON nil.v_click_yearly_summary TO service_role;
GRANT SELECT ON nil.v_click_device_breakdown TO service_role;
GRANT SELECT ON nil.v_click_email_client_breakdown TO service_role;
GRANT SELECT ON nil.v_click_top_guide_sections TO service_role;
GRANT SELECT ON nil.v_click_geographic_breakdown TO service_role;
GRANT SELECT ON nil.v_click_conversion_funnel TO service_role;
GRANT SELECT ON nil.v_click_lead_stats TO service_role;

-- ============================================================================
-- SECTION 7: MIGRATION SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ Click Tracking System Migration Complete!';
  RAISE NOTICE '';
  RAISE NOTICE 'Tables created:';
  RAISE NOTICE '  - nil.click_events (main click tracking table)';
  RAISE NOTICE '  - nil.click_link_registry (tracking link registry)';
  RAISE NOTICE '  - nil.click_analytics_daily (daily materialized view)';
  RAISE NOTICE '';
  RAISE NOTICE 'Views created (11 total):';
  RAISE NOTICE '  - v_click_summary_today';
  RAISE NOTICE '  - v_click_daily_summary';
  RAISE NOTICE '  - v_click_weekly_summary';
  RAISE NOTICE '  - v_click_monthly_summary';
  RAISE NOTICE '  - v_click_yearly_summary';
  RAISE NOTICE '  - v_click_device_breakdown';
  RAISE NOTICE '  - v_click_email_client_breakdown';
  RAISE NOTICE '  - v_click_top_guide_sections';
  RAISE NOTICE '  - v_click_geographic_breakdown';
  RAISE NOTICE '  - v_click_conversion_funnel';
  RAISE NOTICE '  - v_click_lead_stats';
  RAISE NOTICE '';
  RAISE NOTICE 'Functions created:';
  RAISE NOTICE '  - nil.refresh_click_analytics_daily()';
  RAISE NOTICE '';
  RAISE NOTICE 'Indexes created (13 total) for optimal performance';
  RAISE NOTICE '';
  RAISE NOTICE 'Next Steps:';
  RAISE NOTICE '  1. Deploy Cloudflare Worker code';
  RAISE NOTICE '  2. Update N8N Workflow 4 to insert clicks';
  RAISE NOTICE '  3. Update Telegram bot to query dashboard views';
  RAISE NOTICE '  4. Create scheduled job to refresh daily analytics';
  RAISE NOTICE '';
  RAISE NOTICE 'System ready for click tracking!';
END;
$$;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
