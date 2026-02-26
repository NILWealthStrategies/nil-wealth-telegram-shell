-- ============================================================================
-- COMPLETE SUPABASE SCHEMA FOR nil-wealth-telegram-shell
-- Using nil schema for clean organization
-- Run this entire SQL in Supabase SQL Editor
-- ============================================================================
--
-- INTEGRATIONS OVERVIEW:
-- 1. Telegram Bot: Main interface for viewing/managing data (src/index.js)
-- 2. n8n Webhooks: Automation workflows that INSERT into these tables
--    - Example: n8n receives Vercel form → POSTs to /api/submission → INSERTs nil.submissions
--    - Example: n8n receives email → POSTs to /api/conversation → INSERTs nil.conversations + nil.messages
-- 3. Vercel Forms: Website submissions → n8n → nil.submissions table
--    - Submission data stored in JSONB submission_payload field
-- ============================================================================

-- ============================================================================
-- SECTION 0: Create nil Schema (CRITICAL - Must run first!)
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS nil;

-- ============================================================================
-- SECTION 1: Base Tables (conversations, people, calls, submissions, messages, coaches, metrics)
-- ============================================================================

-- Conversations: Email threads, support tickets, client communications
CREATE TABLE IF NOT EXISTS nil.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_key TEXT,
  contact_email TEXT,
  contact_id TEXT,
  subject TEXT,
  preview TEXT,
  pipeline TEXT DEFAULT 'open',
  source TEXT DEFAULT 'default',
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

-- People: Contacts, clients, athletes
CREATE TABLE IF NOT EXISTS nil.people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT UNIQUE,
  role TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_people_email ON nil.people(email);

-- Submissions: Vercel form submissions (athlete enrollments, contact forms)
-- submission_payload contains full form data as JSONB for flexibility
CREATE TABLE IF NOT EXISTS nil.submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id TEXT UNIQUE,
  client_id TEXT,
  contact_id TEXT,
  athlete_name TEXT,
  state TEXT,
  coverage_accident TEXT,
  coverage_hospital_indemnity TEXT,
  coverage_type TEXT,
  coach_id TEXT,
  coach_name TEXT,
  pool_label TEXT,
  submission_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submissions_client_id ON nil.submissions(client_id);
CREATE INDEX IF NOT EXISTS idx_submissions_contact_id ON nil.submissions(contact_id);
CREATE INDEX IF NOT EXISTS idx_submissions_submission_id ON nil.submissions(submission_id);
CREATE INDEX IF NOT EXISTS idx_submissions_coach_id ON nil.submissions(coach_id);

-- Calls: Scheduled calls with clients/athletes
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

-- Messages: Individual emails/messages within a conversation thread
CREATE TABLE IF NOT EXISTS nil.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES nil.conversations(id),
  direction TEXT,
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

-- Coaches: Athletic coaches and their programs
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

-- Metric Events: Analytics tracking (link clicks, page visits, actions taken)
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
-- SECTION 2: Email Outbox (nil schema)
-- ============================================================================

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
  status TEXT DEFAULT 'queued',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON nil.email_outbox(status);
CREATE INDEX IF NOT EXISTS idx_email_outbox_created_at ON nil.email_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_card_key ON nil.email_outbox(card_key);

-- ============================================================================
-- SECTION 3: SMS Outbox (nil schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.sms_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "to" TEXT NOT NULL,
  text TEXT,
  client_id TEXT,
  card_key TEXT,
  trace_id TEXT,
  status TEXT DEFAULT 'queued',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sms_outbox_status ON nil.sms_outbox(status);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_created_at ON nil.sms_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_card_key ON nil.sms_outbox(card_key);

-- ============================================================================
-- SECTION 4: Card Mirrors (nil schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.card_mirrors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_key TEXT NOT NULL,
  mirror_card_key TEXT NOT NULL,
  relationship_type TEXT DEFAULT 'linked',
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_mirror UNIQUE(card_key, mirror_card_key)
);

CREATE INDEX IF NOT EXISTS idx_card_mirrors_card_key ON nil.card_mirrors(card_key);
CREATE INDEX IF NOT EXISTS idx_card_mirrors_mirror_key ON nil.card_mirrors(mirror_card_key);

-- ============================================================================
-- SECTION 5: Message Drafts (nil schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.message_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT,
  card_key TEXT,
  draft_content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_drafts_client_id ON nil.message_drafts(client_id);
CREATE INDEX IF NOT EXISTS idx_message_drafts_card_key ON nil.message_drafts(card_key);

-- ============================================================================
-- SECTION 6: Dead Letter Queue (nil schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_data JSONB,
  context TEXT,
  trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_created_at ON nil.dead_letters(created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_trace_id ON nil.dead_letters(trace_id);

-- ============================================================================
-- SECTION 7: Events Ledger (nil schema)
-- ============================================================================

CREATE TABLE IF NOT EXISTS nil.ops_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
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
-- SECTION 8: Search View (nil schema)
-- ============================================================================

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
  s.submission_payload::text as preview,
  '' as email,
  'new' as status,
  2 as priority_tier,
  NULL as next_action_at,
  s.created_at,
  'submission:' || s.id::text as card_key,
  'submission' AS source_type
FROM nil.submissions s
ORDER BY updated_at DESC;

-- ============================================================================
-- SECTION 9: Triage Due Now View (nil schema)
-- ============================================================================

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

-- ============================================================================
-- SECTION 10: Conversations Card View (nil schema)
-- For needs_reply counts and conversation queries with pipeline filtering
-- ============================================================================

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

-- ============================================================================
-- SECTION 11: Coach Followups Due Now View (nil schema)
-- For counting and listing conversations in followups pipeline that need action
-- ============================================================================

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

-- ============================================================================
-- SECTION 12: Calls Card View (nil schema)
-- For call queries and today's calls counting
-- ============================================================================

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


-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
-- All 7 base tables created in nil schema:
--   1. conversations  (email threads, support tickets)
--   2. people         (contacts, clients)
--   3. submissions    (Vercel form data)
--   4. calls          (scheduled calls)
--   5. messages       (individual emails in threads)
--   6. coaches        (athletic coaches)
--   7. metric_events  (analytics tracking)
--
-- All 6 operational tables created in nil schema:
--   1. email_outbox   (queued outgoing emails)
--   2. sms_outbox     (queued outgoing SMS)
--   3. card_mirrors   (linked cards/conversations)
--   4. message_drafts (saved draft messages)
--   5. dead_letters   (error queue)
--   6. ops_events     (event ledger)
--
-- All 5 views created in nil schema:
--   1. v_search                    (unified search across conversations, people, submissions)
--   2. v_triage_due_now            (urgent/needs_reply conversations)
--   3. v_conversations_card        (conversations with all fields for filtering)
--   4. v_coach_followups_due_now   (followup conversations due now)
--   5. v_calls_card                (calls with all fields for filtering)
--
-- Bot code automatically uses nil schema via: const ops = () => supabase.schema("nil");
-- All 67 database queries route through ops() → nil schema exclusively
-- No fallback logic - nil schema only
--
-- INTEGRATIONS:
-- • Telegram Bot: Queries/displays data from all tables via src/index.js
-- • n8n Webhooks: POST to /api/submission, /api/conversation → INSERTs into nil tables
-- • Vercel Forms: Submit → n8n workflow → nil.submissions table (JSONB payload)
-- ============================================================================
