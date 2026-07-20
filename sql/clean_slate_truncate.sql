-- =============================================================================
-- NIL WEALTH STRATEGIES — CLEAN SLATE TRUNCATE
-- Schema: nil  (tables verified live against Supabase 2026-07-20)
-- PURPOSE: Empties all rows in operational tables back to 0.
-- Tables and columns are NOT dropped — structure stays 100% intact.
-- Reference/registry tables (coaches, schools, people) are commented out.
-- =============================================================================

-- Disable triggers temporarily to speed up truncation
SET session_replication_role = replica;

-- ---------------------------------------------------------------------------
-- SECTION 1 — EVENT / ANALYTICS DATA
-- ---------------------------------------------------------------------------
TRUNCATE nil.click_events             RESTART IDENTITY CASCADE;
TRUNCATE nil.eapp_visits              RESTART IDENTITY CASCADE;
TRUNCATE nil.analytics_metrics        RESTART IDENTITY CASCADE;
TRUNCATE nil.metric_events            RESTART IDENTITY CASCADE;
TRUNCATE nil.school_outreach_events   RESTART IDENTITY CASCADE;
TRUNCATE nil.processed_events         RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 2 — OPERATIONAL QUEUES & OUTBOXES
-- ---------------------------------------------------------------------------
TRUNCATE nil.email_outbox             RESTART IDENTITY CASCADE;
TRUNCATE nil.sms_outbox               RESTART IDENTITY CASCADE;
TRUNCATE nil.n8n_outbox               RESTART IDENTITY CASCADE;
TRUNCATE nil.ops_events               RESTART IDENTITY CASCADE;
TRUNCATE nil.dead_letters             RESTART IDENTITY CASCADE;
TRUNCATE nil.dead_letter_events       RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 3 — CONVERSATIONS / SUPPORT
-- ---------------------------------------------------------------------------
TRUNCATE nil.messages                 RESTART IDENTITY CASCADE;
TRUNCATE nil.message_drafts           RESTART IDENTITY CASCADE;
TRUNCATE nil.conversations            RESTART IDENTITY CASCADE;
TRUNCATE nil.support_tickets          RESTART IDENTITY CASCADE;
TRUNCATE nil.card_mirrors             RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 4 — LEADS / PIPELINE / OUTREACH
-- ---------------------------------------------------------------------------
TRUNCATE nil.lead_metrics             RESTART IDENTITY CASCADE;
TRUNCATE nil.leads                    RESTART IDENTITY CASCADE;
TRUNCATE nil.calls                    RESTART IDENTITY CASCADE;
TRUNCATE nil.submissions              RESTART IDENTITY CASCADE;
TRUNCATE nil.events                   RESTART IDENTITY CASCADE;
TRUNCATE nil.email_sequences          RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- SECTION 5 — REFERENCE DATA (uncomment only for full reset)
-- WARNING: Wipes coaches DB, schools DB, people profiles.
-- You must re-import this data after wiping.
-- ---------------------------------------------------------------------------
-- TRUNCATE nil.coaches               RESTART IDENTITY CASCADE;
-- TRUNCATE nil.schools_registry      RESTART IDENTITY CASCADE;
-- TRUNCATE nil.people                RESTART IDENTITY CASCADE;
-- TRUNCATE nil.click_link_registry   RESTART IDENTITY CASCADE;

-- Re-enable triggers
SET session_replication_role = DEFAULT;

-- ---------------------------------------------------------------------------
-- VERIFY: All counts should be 0 after running
-- ---------------------------------------------------------------------------
SELECT 'click_events'          AS tbl, COUNT(*) AS rows FROM nil.click_events          UNION ALL
SELECT 'eapp_visits',                  COUNT(*) FROM nil.eapp_visits                   UNION ALL
SELECT 'analytics_metrics',            COUNT(*) FROM nil.analytics_metrics             UNION ALL
SELECT 'metric_events',                COUNT(*) FROM nil.metric_events                 UNION ALL
SELECT 'school_outreach_events',       COUNT(*) FROM nil.school_outreach_events        UNION ALL
SELECT 'processed_events',             COUNT(*) FROM nil.processed_events              UNION ALL
SELECT 'email_outbox',                 COUNT(*) FROM nil.email_outbox                  UNION ALL
SELECT 'sms_outbox',                   COUNT(*) FROM nil.sms_outbox                    UNION ALL
SELECT 'n8n_outbox',                   COUNT(*) FROM nil.n8n_outbox                    UNION ALL
SELECT 'ops_events',                   COUNT(*) FROM nil.ops_events                    UNION ALL
SELECT 'dead_letters',                 COUNT(*) FROM nil.dead_letters                  UNION ALL
SELECT 'dead_letter_events',           COUNT(*) FROM nil.dead_letter_events            UNION ALL
SELECT 'conversations',                COUNT(*) FROM nil.conversations                 UNION ALL
SELECT 'messages',                     COUNT(*) FROM nil.messages                      UNION ALL
SELECT 'support_tickets',              COUNT(*) FROM nil.support_tickets               UNION ALL
SELECT 'card_mirrors',                 COUNT(*) FROM nil.card_mirrors                  UNION ALL
SELECT 'lead_metrics',                 COUNT(*) FROM nil.lead_metrics                  UNION ALL
SELECT 'leads',                        COUNT(*) FROM nil.leads                         UNION ALL
SELECT 'calls',                        COUNT(*) FROM nil.calls                         UNION ALL
SELECT 'submissions',                  COUNT(*) FROM nil.submissions                   UNION ALL
SELECT 'events',                       COUNT(*) FROM nil.events                        UNION ALL
SELECT 'email_sequences',              COUNT(*) FROM nil.email_sequences
ORDER BY tbl;
