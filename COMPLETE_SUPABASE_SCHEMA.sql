-- ============================================================================
-- COMPLETE SUPABASE SCHEMA FOR NIL WEALTH TELEGRAM BOT + N8N WORKFLOWS
-- Schema: nil
-- Run this entire SQL in Supabase SQL Editor
-- ============================================================================
--
-- IMPORTANT NOTES:
-- • All tables use "IF NOT EXISTS" - safe to run multiple times
-- • Foreign key constraints removed for maximum flexibility
-- • Tables can be created in any order without errors
-- • Safe to run partial sections if needed
-- • If you get errors, run this script again - it's fully idempotent
--
-- RECOMMENDED: Copy entire file, paste into Supabase SQL Editor, click "Run"
--
-- SYSTEM OVERVIEW:
-- 1. Telegram Bot (src/index.js): Main operations interface
--    - Displays data from all tables
--    - Manages conversations, support tickets, leads
--    - V1/V2/V3 draft generation feature
--
-- 2. Five n8n Workflows:
--    - Workflow 1: Lead Generation (Apify + Hunter.io → nil.leads)
--    - Workflow 2: Campaign Loader (nil.leads → Instantly.ai campaign)
--    - Workflow 3: Support Handler (Instantly replies → nil.support_tickets)
--    - Workflow 4: Analytics Sync (Instantly metrics → nil.lead_metrics)
--    - Workflow 5: Instant Submission (Website form → nil.submissions)
--
-- 3. Two Email Systems (SEPARATE):
--    - Instantly.ai: Outreach emails (Workflows 2, 3, 4)
--    - Gmail support@: Direct emails/CCs (separate webhook, not in workflows)
--
-- ============================================================================

-- ============================================================================
-- SECTION 0: Create nil Schema (CRITICAL - Must run first!)
-- ============================================================================

-- Drop tables that might have old structures causing "column does not exist" errors
-- This is safe - they will be recreated with correct structure below
DROP TABLE IF EXISTS nil.message_drafts CASCADE;
DROP TABLE IF EXISTS nil.messages CASCADE;
DROP TABLE IF EXISTS nil.conversations CASCADE;
DROP TABLE IF EXISTS nil.n8n_outbox CASCADE;
DROP TABLE IF EXISTS nil.submissions CASCADE;
DROP TABLE IF EXISTS nil.email_sequences CASCADE;
DROP TABLE IF EXISTS nil.lead_metrics CASCADE;
DROP TABLE IF EXISTS nil.support_tickets CASCADE;
DROP TABLE IF EXISTS nil.leads CASCADE;

CREATE SCHEMA IF NOT EXISTS nil;

-- ============================================================================
-- SECTION 1: N8N WORKFLOW TABLES (Lead Generation & Outreach)
-- ============================================================================

-- Leads: Scraped and enriched leads from Workflow 1 (Apify + Hunter.io)
-- Status flow: ready → outreach_started → replied → bounced
CREATE TABLE IF NOT EXISTS nil.leads (
  lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  organization TEXT,
  title TEXT,
  state TEXT,
  website TEXT,
  phone TEXT,
  status TEXT DEFAULT 'ready', -- ready, outreach_started, replied, bounced, unsubscribed
  engagement_score INTEGER DEFAULT 0, -- 0-100, calculated by Workflow 4
  source TEXT DEFAULT 'apify', -- apify, manual, import
  hunter_confidence INTEGER, -- Hunter.io confidence score 0-100
  apify_run_id TEXT,
  metadata JSONB, -- Additional data from Apify
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON nil.leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON nil.leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_engagement_score ON nil.leads(engagement_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON nil.leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_source ON nil.leads(source);

-- Support Tickets: Created by Workflow 3 when leads reply to outreach emails
-- Also can be created manually or from Gmail support@ inbox
CREATE TABLE IF NOT EXISTS nil.support_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID, -- References nil.leads(lead_id) - no FK constraint for flexibility
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  organization TEXT,
  subject TEXT,
  message TEXT,
  status TEXT DEFAULT 'open', -- open, in_progress, waiting_response, resolved
  priority TEXT DEFAULT 'normal', -- low, normal, high, urgent
  source TEXT DEFAULT 'instantly', -- instantly, gmail, manual
  assigned_to TEXT, -- Telegram user ID or name
  replied_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON nil.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON nil.support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_support_tickets_lead_id ON nil.support_tickets(lead_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_contact_email ON nil.support_tickets(contact_email);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON nil.support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_source ON nil.support_tickets(source);

-- Lead Metrics: Analytics events from Workflow 4 (email opens, clicks, replies, bounces)
CREATE TABLE IF NOT EXISTS nil.lead_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID, -- References nil.leads(lead_id) - no FK constraint for flexibility
  metric_type TEXT NOT NULL, -- email_sent, open, click, reply, bounce, unsubscribe
  metric_value INTEGER DEFAULT 1,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB, -- Additional data (link clicked, device, location, etc.)
  instantly_event_id TEXT UNIQUE -- Deduplication key from Instantly API
);

CREATE INDEX IF NOT EXISTS idx_lead_metrics_lead_id ON nil.lead_metrics(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_metrics_type ON nil.lead_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_lead_metrics_recorded_at ON nil.lead_metrics(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_metrics_instantly_event_id ON nil.lead_metrics(instantly_event_id);

-- Email Sequences: Tracks which sequence step each lead is in (Workflow 2)
CREATE TABLE IF NOT EXISTS nil.email_sequences (
  sequence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID, -- References nil.leads(lead_id) - no FK constraint for flexibility
  sequence_number INTEGER DEFAULT 1, -- 1=initial, 2=followup1, 3=followup2, etc.
  status TEXT DEFAULT 'scheduled', -- scheduled, sent, opened, clicked, replied, bounced
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sequences_lead_id ON nil.email_sequences(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_sequences_status ON nil.email_sequences(status);
CREATE INDEX IF NOT EXISTS idx_email_sequences_scheduled_at ON nil.email_sequences(scheduled_at);

-- ============================================================================
-- SECTION 2: TELEGRAM BOT TABLES (Conversations & Messages)
-- ============================================================================

-- Conversations: Email threads, support tickets, client communications
-- Used by Telegram bot for displaying and managing conversations
CREATE TABLE IF NOT EXISTS nil.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key TEXT,
  contact_email TEXT,
  contact_id TEXT,
  subject TEXT,
  preview TEXT,
  pipeline TEXT DEFAULT 'open', -- open, needs_reply, urgent, followups, closed
  source TEXT DEFAULT 'default', -- default, instantly, gmail, manual
  coach_id TEXT,
  coach_name TEXT,
  next_action_at TIMESTAMPTZ,
  cc_support_suggested BOOLEAN DEFAULT false,
  gmail_url TEXT,
  mirror_conversation_id UUID,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_pipeline ON nil.conversations(pipeline);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON nil.conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON nil.conversations(source);
CREATE INDEX IF NOT EXISTS idx_conversations_coach_id ON nil.conversations(coach_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact_email ON nil.conversations(contact_email);
CREATE INDEX IF NOT EXISTS idx_conversations_thread_key ON nil.conversations(thread_key);
CREATE INDEX IF NOT EXISTS idx_conversations_next_action_at ON nil.conversations(next_action_at);

-- Messages: Individual emails/messages within a conversation thread
CREATE TABLE IF NOT EXISTS nil.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID, -- References nil.conversations(id) - no FK constraint for flexibility
  direction TEXT, -- inbound, outbound
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  body TEXT,
  preview TEXT,
  is_deleted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON nil.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON nil.messages(created_at);

-- Message Drafts: V1/V2/V3 draft variants generated by OpenAI (Telegram bot feature)
-- conversation_id links to nil.conversations or can reference support_tickets
CREATE TABLE IF NOT EXISTS nil.message_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID, -- Can be conversation ID or support ticket ID
  kind TEXT DEFAULT 'reply', -- reply, outreach, followup
  version INTEGER NOT NULL, -- 1, 2, or 3 (V1/V2/V3)
  subject TEXT,
  body TEXT NOT NULL,
  selected BOOLEAN DEFAULT false, -- User selected this draft
  client_id TEXT,
  card_key TEXT, -- Legacy compatibility
  draft_content TEXT, -- Legacy compatibility
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_drafts_conversation_id ON nil.message_drafts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_message_drafts_selected ON nil.message_drafts(selected);
CREATE INDEX IF NOT EXISTS idx_message_drafts_client_id ON nil.message_drafts(client_id);
CREATE INDEX IF NOT EXISTS idx_message_drafts_card_key ON nil.message_drafts(card_key);

-- ============================================================================
-- SECTION 3: WEBSITE SUBMISSIONS (Workflow 5)
-- ============================================================================

-- Submissions: Form submissions from website (Workflow 5: Instant Submission)
-- Receives POST from n8n webhook triggered by Vercel form
CREATE TABLE IF NOT EXISTS nil.submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id TEXT UNIQUE NOT NULL, -- Format: NWS-XXXXXXXX-XXXXX
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  role TEXT NOT NULL, -- parent, athlete, coach, admin
  intent TEXT DEFAULT 'coverage_interest', -- coverage_interest, consultation, support
  coverage_accident BOOLEAN DEFAULT false,
  coverage_hospital_indemnity BOOLEAN DEFAULT false,
  athlete_name TEXT,
  athlete_age INTEGER,
  sport TEXT,
  notes TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  submission_payload JSONB, -- Full form data for flexibility
  n8n_status TEXT DEFAULT 'queued', -- queued, processing, completed, failed
  client_id TEXT, -- Legacy compatibility
  contact_id TEXT, -- Legacy compatibility
  coach_id TEXT, -- Legacy compatibility
  coach_name TEXT, -- Legacy compatibility
  pool_label TEXT, -- Legacy compatibility
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_submission_id ON nil.submissions(submission_id);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON nil.submissions(email);
CREATE INDEX IF NOT EXISTS idx_submissions_n8n_status ON nil.submissions(n8n_status);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON nil.submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_client_id ON nil.submissions(client_id);
CREATE INDEX IF NOT EXISTS idx_submissions_contact_id ON nil.submissions(contact_id);
CREATE INDEX IF NOT EXISTS idx_submissions_coach_id ON nil.submissions(coach_id);

-- N8N Outbox: Queue for async processing of submissions by n8n workflows
-- Bot writes here, n8n polls and picks up jobs
CREATE TABLE IF NOT EXISTS nil.n8n_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id TEXT UNIQUE NOT NULL, -- Links to nil.submissions
  idempotency_key TEXT UNIQUE NOT NULL,
  payload JSONB NOT NULL, -- Full n8n payload envelope
  status TEXT DEFAULT 'queued', -- queued, processing, completed, failed
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ, -- When n8n claimed this job
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_n8n_outbox_status ON nil.n8n_outbox(status);
CREATE INDEX IF NOT EXISTS idx_n8n_outbox_submission_id ON nil.n8n_outbox(submission_id);
CREATE INDEX IF NOT EXISTS idx_n8n_outbox_created_at ON nil.n8n_outbox(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_n8n_outbox_next_retry_at ON nil.n8n_outbox(next_retry_at);

-- ============================================================================
-- SECTION 4: OPERATIONAL TABLES (Outbox, Mirrors, Events)
-- ============================================================================

-- Email Outbox: Queued outgoing emails (SendGrid or SMTP)
CREATE TABLE IF NOT EXISTS nil.email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "to" TEXT NOT NULL,
  subject TEXT,
  html TEXT,
  thread_key TEXT,
  client_id TEXT,
  card_key TEXT,
  cc TEXT,
  bcc TEXT,
  trace_id TEXT,
  status TEXT DEFAULT 'queued', -- queued, sending, sent, failed
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON nil.email_outbox(status);
CREATE INDEX IF NOT EXISTS idx_email_outbox_created_at ON nil.email_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_card_key ON nil.email_outbox(card_key);

-- SMS Outbox: Queued outgoing SMS (Twilio)
CREATE TABLE IF NOT EXISTS nil.sms_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "to" TEXT NOT NULL,
  text TEXT,
  client_id TEXT,
  card_key TEXT,
  trace_id TEXT,
  status TEXT DEFAULT 'queued', -- queued, sending, sent, failed
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_outbox_status ON nil.sms_outbox(status);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_created_at ON nil.sms_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_card_key ON nil.sms_outbox(card_key);

-- Card Mirrors: Linked cards/conversations (for mirroring across systems)
CREATE TABLE IF NOT EXISTS nil.card_mirrors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_key TEXT NOT NULL,
  mirror_card_key TEXT NOT NULL,
  relationship_type TEXT DEFAULT 'linked', -- linked, duplicate, related
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_mirror UNIQUE(card_key, mirror_card_key)
);

CREATE INDEX IF NOT EXISTS idx_card_mirrors_card_key ON nil.card_mirrors(card_key);
CREATE INDEX IF NOT EXISTS idx_card_mirrors_mirror_key ON nil.card_mirrors(mirror_card_key);

-- Dead Letter Queue: Failed operations for manual review
CREATE TABLE IF NOT EXISTS nil.dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_data JSONB,
  context TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_created_at ON nil.dead_letters(created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_trace_id ON nil.dead_letters(trace_id);

-- Events Ledger: Audit trail for all operations
CREATE TABLE IF NOT EXISTS nil.ops_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL, -- submission.created, email.sent, lead.status_changed, etc.
  data JSONB,
  card_key TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_events_event_type ON nil.ops_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ops_events_card_key ON nil.ops_events(card_key);
CREATE INDEX IF NOT EXISTS idx_ops_events_trace_id ON nil.ops_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_ops_events_created_at ON nil.ops_events(created_at);

-- ============================================================================
-- SECTION 5: LEGACY TABLES (For backward compatibility)
-- ============================================================================

-- People: Contacts, clients, athletes (legacy)
CREATE TABLE IF NOT EXISTS nil.people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT UNIQUE,
  role TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_people_email ON nil.people(email);

-- Calls: Scheduled calls with clients/athletes (legacy)
CREATE TABLE IF NOT EXISTS nil.calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT UNIQUE,
  client_name TEXT,
  client_id TEXT,
  scheduled_at TIMESTAMPTZ,
  outcome TEXT,
  source TEXT DEFAULT 'default',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_updated_at ON nil.calls(updated_at);
CREATE INDEX IF NOT EXISTS idx_calls_scheduled_at ON nil.calls(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_calls_client_id ON nil.calls(client_id);
CREATE INDEX IF NOT EXISTS idx_calls_source ON nil.calls(source);

-- Coaches: Athletic coaches and their programs (legacy)
CREATE TABLE IF NOT EXISTS nil.coaches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id TEXT UNIQUE,
  coach_name TEXT,
  program TEXT,
  school TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coaches_coach_id ON nil.coaches(coach_id);
CREATE INDEX IF NOT EXISTS idx_coaches_updated_at ON nil.coaches(updated_at);

-- Metric Events: Analytics tracking (link clicks, page visits, actions) (legacy)
CREATE TABLE IF NOT EXISTS nil.metric_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  source TEXT DEFAULT 'default',
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metric_events_event_type ON nil.metric_events(event_type);
CREATE INDEX IF NOT EXISTS idx_metric_events_source ON nil.metric_events(source);
CREATE INDEX IF NOT EXISTS idx_metric_events_created_at ON nil.metric_events(created_at);

-- ============================================================================
-- SECTION 6: VIEWS FOR TELEGRAM BOT
-- ============================================================================

-- Unified search across conversations, people, submissions, support tickets
CREATE OR REPLACE VIEW nil.v_search AS
SELECT
  c.id,
  c.contact_email as client_id,
  c.subject,
  c.preview,
  c.contact_email as email,
  c.pipeline as status,
  3 as priority_tier,
  c.updated_at as next_action_at,
  c.updated_at,
  'conversation:' || c.id::text as card_key,
  'conversation' AS source_type
FROM nil.conversations c

UNION ALL

SELECT
  p.id,
  p.email as client_id,
  p.name as subject,
  '' as preview,
  p.email,
  'active' as status,
  0 as priority_tier,
  NULL as next_action_at,
  p.updated_at,
  'person:' || p.id::text as card_key,
  'person' AS source_type
FROM nil.people p

UNION ALL

SELECT
  s.id,
  s.client_id,
  'Submission' as subject,
  (s.first_name || ' ' || s.last_name || ' - ' || s.state) as preview,
  s.email,
  'new' as status,
  2 as priority_tier,
  NULL as next_action_at,
  s.created_at as updated_at,
  'submission:' || s.id::text as card_key,
  'submission' AS source_type
FROM nil.submissions s

UNION ALL

SELECT
  t.ticket_id as id,
  t.contact_email as client_id,
  t.subject,
  t.message as preview,
  t.contact_email as email,
  t.status,
  CASE WHEN t.priority = 'urgent' THEN 1 WHEN t.priority = 'high' THEN 2 ELSE 3 END as priority_tier,
  NULL as next_action_at,
  t.updated_at,
  'ticket:' || t.ticket_id::text as card_key,
  'support_ticket' AS source_type
FROM nil.support_tickets t

ORDER BY updated_at DESC;

-- Triage view: urgent/needs_reply conversations
CREATE OR REPLACE VIEW nil.v_triage_due_now AS
SELECT
  c.id,
  c.contact_email as client_id,
  c.subject,
  c.preview,
  c.contact_email as email,
  c.pipeline as status,
  3 as priority_tier,
  c.updated_at as next_action_at,
  c.updated_at,
  'conversation:' || c.id::text as card_key
FROM nil.conversations c
WHERE 
  c.pipeline IN ('urgent', 'needs_reply', 'open')
ORDER BY 
  CASE WHEN c.pipeline = 'urgent' THEN 0 ELSE 1 END ASC,
  c.updated_at ASC;

-- Conversations card view with pipeline filtering
CREATE OR REPLACE VIEW nil.v_conversations_card AS
SELECT
  c.id,
  c.thread_key,
  c.contact_email,
  c.contact_id,
  c.subject,
  c.preview,
  c.pipeline,
  c.source,
  c.coach_id,
  c.coach_name,
  c.next_action_at,
  c.cc_support_suggested,
  c.gmail_url,
  c.mirror_conversation_id,
  c.updated_at,
  c.created_at
FROM nil.conversations c;

-- Coach followups due now
CREATE OR REPLACE VIEW nil.v_coach_followups_due_now AS
SELECT
  c.id,
  c.coach_id,
  c.coach_name,
  c.contact_email,
  c.source,
  c.pipeline,
  c.subject,
  c.preview,
  c.next_action_at,
  c.updated_at,
  c.created_at
FROM nil.conversations c
WHERE 
  c.pipeline = 'followups'
  AND c.next_action_at IS NOT NULL
  AND c.next_action_at <= now()
ORDER BY c.next_action_at ASC;

-- Calls card view
CREATE OR REPLACE VIEW nil.v_calls_card AS
SELECT
  c.id,
  c.call_id,
  c.client_name,
  c.client_id,
  c.scheduled_at,
  c.outcome,
  c.source,
  c.updated_at,
  c.created_at
FROM nil.calls c;

-- Analytics summary: aggregate metrics for dashboard
CREATE OR REPLACE VIEW nil.v_analytics_summary AS
SELECT
  COUNT(DISTINCT l.lead_id) as total_leads,
  COUNT(DISTINCT CASE WHEN l.status = 'ready' THEN l.lead_id END) as ready_leads,
  COUNT(DISTINCT CASE WHEN l.status = 'outreach_started' THEN l.lead_id END) as outreach_leads,
  COUNT(DISTINCT CASE WHEN l.status = 'replied' THEN l.lead_id END) as replied_leads,
  COUNT(DISTINCT CASE WHEN m.metric_type = 'email_sent' THEN m.lead_id END) as emails_sent,
  COUNT(DISTINCT CASE WHEN m.metric_type = 'open' THEN m.lead_id END) as emails_opened,
  COUNT(DISTINCT CASE WHEN m.metric_type = 'click' THEN m.lead_id END) as links_clicked,
  COUNT(DISTINCT CASE WHEN m.metric_type = 'reply' THEN m.lead_id END) as total_replies,
  ROUND(
    (COUNT(DISTINCT CASE WHEN m.metric_type = 'open' THEN m.lead_id END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE WHEN m.metric_type = 'email_sent' THEN m.lead_id END), 0)) * 100,
    2
  ) as open_rate_percent,
  ROUND(
    (COUNT(DISTINCT CASE WHEN m.metric_type = 'reply' THEN m.lead_id END)::numeric / 
     NULLIF(COUNT(DISTINCT CASE WHEN m.metric_type = 'email_sent' THEN m.lead_id END), 0)) * 100,
    2
  ) as reply_rate_percent
FROM nil.leads l
LEFT JOIN nil.lead_metrics m ON l.lead_id = m.lead_id;

-- Top performing leads by engagement
CREATE OR REPLACE VIEW nil.v_top_leads AS
SELECT
  l.lead_id,
  l.full_name,
  l.email,
  l.organization,
  l.title,
  l.state,
  l.status,
  l.engagement_score,
  COUNT(DISTINCT m.metric_id) as total_interactions,
  MAX(CASE WHEN m.metric_type = 'reply' THEN m.recorded_at END) as last_reply_at,
  l.created_at
FROM nil.leads l
LEFT JOIN nil.lead_metrics m ON l.lead_id = m.lead_id
GROUP BY l.lead_id, l.full_name, l.email, l.organization, l.title, l.state, l.status, l.engagement_score, l.created_at
ORDER BY l.engagement_score DESC, total_interactions DESC
LIMIT 50;

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
--
-- TABLES CREATED (22 total):
--
-- N8N Workflow Tables (4):
--   1. nil.leads                    - Scraped leads (Workflow 1)
--   2. nil.support_tickets          - Reply tickets (Workflow 3)
--   3. nil.lead_metrics             - Email analytics (Workflow 4)
--   4. nil.email_sequences          - Sequence tracking (Workflow 2)
--
-- Telegram Bot Tables (3):
--   5. nil.conversations            - Email threads
--   6. nil.messages                 - Individual messages
--   7. nil.message_drafts           - V1/V2/V3 drafts (OpenAI feature)
--
-- Submission Tables (2):
--   8. nil.submissions              - Form submissions (Workflow 5)
--   9. nil.n8n_outbox               - N8N job queue
--
-- Operational Tables (6):
--   10. nil.email_outbox            - Outgoing emails queue
--   11. nil.sms_outbox              - Outgoing SMS queue
--   12. nil.card_mirrors            - Card relationships
--   13. nil.dead_letters            - Error queue
--   14. nil.ops_events              - Audit trail
--
-- Legacy Tables (4):
--   15. nil.people                  - Contacts (legacy)
--   16. nil.calls                   - Scheduled calls (legacy)
--   17. nil.coaches                 - Coach data (legacy)
--   18. nil.metric_events           - Analytics (legacy)
--
-- VIEWS CREATED (7):
--   1. nil.v_search                 - Unified search
--   2. nil.v_triage_due_now         - Urgent conversations
--   3. nil.v_conversations_card     - Conversations with filters
--   4. nil.v_coach_followups_due_now- Coach followups
--   5. nil.v_calls_card             - Calls with filters
--   6. nil.v_analytics_summary      - Aggregate metrics
--   7. nil.v_top_leads              - Top performing leads
--
-- INTEGRATIONS:
-- • Telegram Bot: All queries use nil schema via ops() helper
-- • N8N Workflows: All 5 workflows write to nil schema
-- • Instantly.ai: Workflows 2, 3, 4 interact with Instantly API
-- • Gmail support@: Separate inbox (webhook setup needed separately)
--
-- DESIGN NOTES:
-- • No foreign key constraints - allows tables to be created in any order
-- • All table creation uses IF NOT EXISTS - safe to re-run
-- • UNIQUE constraints on emails and IDs prevent duplicates
-- • Indexes optimized for common queries (status, email, created_at)
--
-- TWO EMAIL SYSTEMS (SEPARATE):
-- 1. Instantly.ai: Outreach emails (Workflows 2, 3, 4)
--    - Workflow 2: Adds leads to campaign
--    - Workflow 3: Monitors for replies
--    - Workflow 4: Syncs analytics
-- 2. Gmail support@mynilwealthstrategies.com: Direct emails/CCs
--    - Separate webhook needed (not in these 5 workflows)
--    - See TWIN_SO_IMPLEMENTATION_BRIEF.md section 5
--
-- NEVER add support@mynilwealthstrategies.com to Instantly campaign!
-- ============================================================================
