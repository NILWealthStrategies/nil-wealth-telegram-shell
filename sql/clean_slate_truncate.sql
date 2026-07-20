-- =============================================================================
-- NIL WEALTH STRATEGIES — CLEAN SLATE TRUNCATE
-- Schema: nil
-- PURPOSE: Empties all rows in operational tables back to 0.
-- Tables and columns are NOT dropped — structure stays 100% intact.
-- Reference/registry tables (coaches, schools, people) are commented out.
-- =============================================================================

-- Disable triggers temporarily to speed up truncation
SET session_replication_role = replica;

-- ---------------------------------------------------------------------------
-- SECTION 1 — EVENT / ANALYTICS DATA
-- Wipes all tracked clicks, visits, metrics
-- ---------------------------------------------------------------------------
TRUNCATE nil.click_events             RESTART IDENTITY CASCADE;
TRUNCATE nil.eapp_visits              RESTART IDENTITY CASCADE;
TRUNCATE nil.analytics_metrics        RESTART IDENTITY CASCADE;
TRUNCATE nil.metric_events            RESTART IDENTITY CASCADE;
TRUNCATE nil.school_outreach_events   RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 2 — OPERATIONAL QUEUES & OUTBOXES
-- Wipes all pending / sent / failed emails, SMS, n8n jobs
-- ---------------------------------------------------------------------------
TRUNCATE nil.email_outbox             RESTART IDENTITY CASCADE;
TRUNCATE nil.sms_outbox               RESTART IDENTITY CASCADE;
TRUNCATE nil.n8n_outbox               RESTART IDENTITY CASCADE;
TRUNCATE nil.ops_events               RESTART IDENTITY CASCADE;
TRUNCATE nil.dead_letters             RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 3 — CONVERSATIONS / SUPPORT
-- Wipes all conversations, messages, drafts, support tickets
-- ---------------------------------------------------------------------------
TRUNCATE nil.messages                 RESTART IDENTITY CASCADE;
TRUNCATE nil.message_drafts           RESTART IDENTITY CASCADE;
TRUNCATE nil.ops_message_drafts       RESTART IDENTITY CASCADE;
TRUNCATE nil.conversations            RESTART IDENTITY CASCADE;
TRUNCATE nil.support_tickets          RESTART IDENTITY CASCADE;
TRUNCATE nil.card_mirrors             RESTART IDENTITY CASCADE;
TRUNCATE nil.undo_log                 RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 4 — LEADS / PIPELINE
-- Wipes all leads, metrics, calls, submissions
-- ---------------------------------------------------------------------------
TRUNCATE nil.lead_metrics             RESTART IDENTITY CASCADE;
TRUNCATE nil.leads                    RESTART IDENTITY CASCADE;
TRUNCATE nil.calls                    RESTART IDENTITY CASCADE;
TRUNCATE nil.submissions              RESTART IDENTITY CASCADE;
TRUNCATE nil.consultations            RESTART IDENTITY CASCADE;
TRUNCATE nil.events                   RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 5 — REFERENCE DATA (uncomment only to full reset)
-- WARNING: This wipes your coaches DB, schools DB, and people profiles.
-- You will need to re-import this data after wiping.
-- ---------------------------------------------------------------------------
-- TRUNCATE nil.coaches               RESTART IDENTITY CASCADE;
-- TRUNCATE nil.schools_registry      RESTART IDENTITY CASCADE;
-- TRUNCATE nil.people                RESTART IDENTITY CASCADE;
-- TRUNCATE nil.click_link_registry   RESTART IDENTITY CASCADE;
-- TRUNCATE nil.items                 RESTART IDENTITY CASCADE;
-- TRUNCATE nil.settings              RESTART IDENTITY CASCADE;

-- Re-enable triggers
SET session_replication_role = DEFAULT;

-- ---------------------------------------------------------------------------
-- VERIFY: Row counts after truncation (should all be 0)
-- ---------------------------------------------------------------------------
SELECT
  'click_events'           AS tbl, COUNT(*) AS rows FROM nil.click_events           UNION ALL
SELECT 'eapp_visits',                 COUNT(*) FROM nil.eapp_visits                 UNION ALL
SELECT 'analytics_metrics',           COUNT(*) FROM nil.analytics_metrics           UNION ALL
SELECT 'metric_events',               COUNT(*) FROM nil.metric_events               UNION ALL
SELECT 'school_outreach_events',      COUNT(*) FROM nil.school_outreach_events      UNION ALL
SELECT 'email_outbox',                COUNT(*) FROM nil.email_outbox                UNION ALL
SELECT 'sms_outbox',                  COUNT(*) FROM nil.sms_outbox                  UNION ALL
SELECT 'n8n_outbox',                  COUNT(*) FROM nil.n8n_outbox                  UNION ALL
SELECT 'ops_events',                  COUNT(*) FROM nil.ops_events                  UNION ALL
SELECT 'dead_letters',                COUNT(*) FROM nil.dead_letters                UNION ALL
SELECT 'conversations',               COUNT(*) FROM nil.conversations               UNION ALL
SELECT 'messages',                    COUNT(*) FROM nil.messages                    UNION ALL
SELECT 'support_tickets',             COUNT(*) FROM nil.support_tickets             UNION ALL
SELECT 'lead_metrics',                COUNT(*) FROM nil.lead_metrics                UNION ALL
SELECT 'leads',                       COUNT(*) FROM nil.leads                       UNION ALL
SELECT 'calls',                       COUNT(*) FROM nil.calls                       UNION ALL
SELECT 'submissions',                 COUNT(*) FROM nil.submissions
ORDER BY tbl;
