begin;

create schema if not exists nil;

-- =====================================================
-- 1) CORE PATCHES + CLICK TRACKING SCHEMA (idempotent, safe)
-- =====================================================
create table if not exists nil.click_events (
  id bigserial primary key,
  kind text,
  click_source text,
  source text,
  event_type text,
  event_time timestamptz,
  clicked_at timestamptz,
  created_at timestamptz,
  value numeric default 1,
  meta jsonb,
  campaign_id text,
  coach_id text,
  link text,
  click_type text
);

alter table nil.click_events add column if not exists kind text;
alter table nil.click_events add column if not exists click_source text;
alter table nil.click_events add column if not exists source text;
alter table nil.click_events add column if not exists event_type text;
alter table nil.click_events add column if not exists event_time timestamptz;
alter table nil.click_events add column if not exists clicked_at timestamptz;
alter table nil.click_events add column if not exists created_at timestamptz;
alter table nil.click_events add column if not exists value numeric default 1;
alter table nil.click_events add column if not exists meta jsonb;
alter table nil.click_events add column if not exists campaign_id text;
alter table nil.click_events add column if not exists coach_id text;
alter table nil.click_events add column if not exists link text;
alter table nil.click_events add column if not exists click_type text;

update nil.click_events
set click_type = coalesce(nullif(kind, ''), nullif(event_type, ''), 'website_click')
where click_type is null;

update nil.click_events
set created_at = coalesce(created_at, event_time, clicked_at, now())
where created_at is null;

alter table nil.click_events alter column created_at set default now();
alter table nil.click_events alter column source set default 'cloudflare';
alter table nil.click_events alter column value set default 1;
alter table nil.click_events alter column click_type set default 'website_click';

create index if not exists idx_click_events_created_at on nil.click_events (created_at desc);
create index if not exists idx_click_events_kind on nil.click_events (kind);
create index if not exists idx_click_events_event_type on nil.click_events (event_type);
create index if not exists idx_click_events_click_type on nil.click_events (click_type);

create or replace view nil.click_events_daily_summary as
select
  date_trunc('day', coalesce(event_time, clicked_at, created_at))::date as day,
  coalesce(
    nullif(kind, ''),
    nullif(event_type, ''),
    nullif(click_source, ''),
    'unknown'
  ) as event_type,
  count(*)::bigint as events_count
from nil.click_events
group by 1, 2;

-- =====================================================
-- 1.5) FULL BOT CORE TABLE NORMALIZATION (idempotent, guarded)
-- =====================================================
do $$
declare
  n8n_outbox_id_udt text;
begin
  if to_regclass('nil.conversations') is not null then
    alter table nil.conversations add column if not exists lane text;
    alter table nil.conversations add column if not exists status text;
    alter table nil.conversations add column if not exists normalized_email text;
    alter table nil.conversations add column if not exists cc_support_suggested boolean;
    alter table nil.conversations add column if not exists cc_support_enabled boolean;
    alter table nil.conversations add column if not exists cc_support_locked_at timestamptz;
    alter table nil.conversations add column if not exists needs_support_handoff boolean;
    alter table nil.conversations add column if not exists needs_support_handoff_at timestamptz;
    alter table nil.conversations add column if not exists handoff_detected_reason text;
    alter table nil.conversations add column if not exists gmail_thread_id text;
    alter table nil.conversations add column if not exists message_id_header text;
    alter table nil.conversations add column if not exists in_reply_to text;
    alter table nil.conversations add column if not exists "references" text;
    alter table nil.conversations add column if not exists mirror_conversation_id text;
    alter table nil.conversations add column if not exists outreach_from_email text;
    alter table nil.conversations add column if not exists gmail_url text;
    alter table nil.conversations add column if not exists role text;
    alter table nil.conversations add column if not exists deleted_at timestamptz;

    alter table nil.conversations alter column cc_support_suggested set default false;
    alter table nil.conversations alter column cc_support_enabled set default false;
    alter table nil.conversations alter column needs_support_handoff set default false;
  end if;

  if to_regclass('nil.messages') is not null then
    alter table nil.messages add column if not exists sender text;
    alter table nil.messages add column if not exists source_ref text;
    alter table nil.messages add column if not exists subject text;
    alter table nil.messages add column if not exists is_deleted boolean;
    alter table nil.messages add column if not exists deleted_at timestamptz;
    alter table nil.messages alter column is_deleted set default false;
  end if;

  if to_regclass('nil.message_drafts') is not null then
    alter table nil.message_drafts add column if not exists selected boolean;
    alter table nil.message_drafts add column if not exists created_at timestamptz;
    alter table nil.message_drafts alter column selected set default false;
    alter table nil.message_drafts alter column created_at set default now();
  end if;

  if to_regclass('nil.submissions') is not null then
    alter table nil.submissions add column if not exists n8n_status text;
    alter table nil.submissions add column if not exists n8n_last_error text;
    alter table nil.submissions add column if not exists n8n_sent_at timestamptz;
    alter table nil.submissions add column if not exists created_at timestamptz;
    alter table nil.submissions add column if not exists deleted_at timestamptz;
    alter table nil.submissions alter column n8n_status set default 'queued';
    alter table nil.submissions alter column created_at set default now();
  end if;

  if to_regclass('nil.n8n_outbox') is not null then
    alter table nil.n8n_outbox add column if not exists status text;
    alter table nil.n8n_outbox add column if not exists payload jsonb;
    alter table nil.n8n_outbox add column if not exists idempotency_key text;
    alter table nil.n8n_outbox add column if not exists attempt_count integer;
    alter table nil.n8n_outbox add column if not exists retry_count integer;
      alter table nil.n8n_outbox add column if not exists outbox_id bigint;
      alter table nil.n8n_outbox add column if not exists next_attempt_at timestamptz;
    alter table nil.n8n_outbox add column if not exists sent_at timestamptz;
    alter table nil.n8n_outbox add column if not exists dead_at timestamptz;
    alter table nil.n8n_outbox add column if not exists message_id text;
    alter table nil.n8n_outbox add column if not exists last_error text;
    alter table nil.n8n_outbox add column if not exists created_at timestamptz;
    alter table nil.n8n_outbox add column if not exists updated_at timestamptz;

    alter table nil.n8n_outbox alter column status set default 'queued';
    alter table nil.n8n_outbox alter column attempt_count set default 0;
    alter table nil.n8n_outbox alter column retry_count set default 0;
    alter table nil.n8n_outbox alter column created_at set default now();
    alter table nil.n8n_outbox alter column updated_at set default now();

      -- Backward-compatible key normalization for older schemas that used "id" only.
      -- Some environments use UUID for id, which cannot be cast to bigint.
      if exists (
        select 1
        from information_schema.columns
        where table_schema = 'nil' and table_name = 'n8n_outbox' and column_name = 'id'
      ) then
        select c.udt_name
        into n8n_outbox_id_udt
        from information_schema.columns c
        where c.table_schema = 'nil'
          and c.table_name = 'n8n_outbox'
          and c.column_name = 'id'
        limit 1;

        if n8n_outbox_id_udt in ('int2', 'int4', 'int8') then
          execute 'update nil.n8n_outbox set outbox_id = id::bigint where outbox_id is null and id is not null';
        end if;
      end if;

      create sequence if not exists nil.n8n_outbox_outbox_id_seq;
      alter sequence nil.n8n_outbox_outbox_id_seq owned by nil.n8n_outbox.outbox_id;
      alter table nil.n8n_outbox alter column outbox_id set default nextval('nil.n8n_outbox_outbox_id_seq');
      update nil.n8n_outbox set outbox_id = nextval('nil.n8n_outbox_outbox_id_seq') where outbox_id is null;

      perform setval(
        'nil.n8n_outbox_outbox_id_seq',
        greatest((select coalesce(max(outbox_id), 0) from nil.n8n_outbox), 1),
        true
      );
  end if;

  if to_regclass('nil.ops_events') is not null then
    alter table nil.ops_events add column if not exists trace_id text;
    alter table nil.ops_events add column if not exists idempotency_key text;
    alter table nil.ops_events add column if not exists entity_type text;
    alter table nil.ops_events add column if not exists entity_id text;
    alter table nil.ops_events add column if not exists payload jsonb;
    alter table nil.ops_events add column if not exists created_at timestamptz;
    alter table nil.ops_events alter column created_at set default now();
  end if;

  if to_regclass('nil.dead_letters') is not null then
    alter table nil.dead_letters add column if not exists received_at timestamptz;
    alter table nil.dead_letters add column if not exists error text;
    alter table nil.dead_letters add column if not exists payload jsonb;
    alter table nil.dead_letters alter column received_at set default now();
  end if;
end $$;

create index if not exists idx_conversations_updated_at on nil.conversations (updated_at desc);
create index if not exists idx_conversations_pipeline_updated on nil.conversations (pipeline, updated_at desc);
create index if not exists idx_conversations_email on nil.conversations (contact_email);
create index if not exists idx_conversations_normalized_email on nil.conversations (normalized_email);
create index if not exists idx_conversations_needs_handoff on nil.conversations (needs_support_handoff, needs_support_handoff_at desc);
create index if not exists idx_conversations_cc_support on nil.conversations (cc_support_suggested, cc_support_enabled);

create index if not exists idx_messages_conversation_created on nil.messages (conversation_id, created_at desc);
create index if not exists idx_messages_direction_created on nil.messages (direction, created_at desc);

create index if not exists idx_message_drafts_lookup on nil.message_drafts (conversation_id, kind, selected, created_at desc);

create index if not exists idx_n8n_outbox_status_next_attempt on nil.n8n_outbox (status, next_attempt_at asc);
create unique index if not exists idx_n8n_outbox_outbox_id_unique on nil.n8n_outbox (outbox_id);
create index if not exists idx_n8n_outbox_submission on nil.n8n_outbox (submission_id);
create index if not exists idx_n8n_outbox_idempotency on nil.n8n_outbox (idempotency_key);
create index if not exists idx_n8n_outbox_created_at on nil.n8n_outbox (created_at desc);

create index if not exists idx_ops_events_event_created on nil.ops_events (event_type, created_at desc);
create index if not exists idx_ops_events_trace on nil.ops_events (trace_id);
create index if not exists idx_ops_events_idempotency on nil.ops_events (idempotency_key);

create index if not exists idx_dead_letters_received_at on nil.dead_letters (received_at desc);

-- =====================================================
-- 2) STRICT RELATION AUDIT (47 expected nil relations)
-- =====================================================
do $$
declare
  missing text;
begin
  with expected(rel) as (
    values
      ('analytics_metrics'),
      ('calls'),
      ('card_mirrors'),
      ('click_analytics_daily'),
      ('click_events'),
      ('click_link_registry'),
      ('coaches'),
      ('conversations'),
      ('dead_letter_events'),
      ('dead_letters'),
      ('drafts'),
      ('eapp_visits'),
      ('email_messages'),
      ('email_outbox'),
      ('email_sequences'),
      ('events'),
      ('lead_metrics'),
      ('lead_sources'),
      ('leads'),
      ('message_drafts'),
      ('messages'),
      ('metric_events'),
      ('n8n_outbox'),
      ('ops_events'),
      ('people'),
      ('processed_events'),
      ('sms_outbox'),
      ('submissions'),
      ('support_tickets'),
      ('v_analytics_summary'),
      ('v_calls_card'),
      ('v_click_conversion_funnel'),
      ('v_click_daily_summary'),
      ('v_click_device_breakdown'),
      ('v_click_email_client_breakdown'),
      ('v_click_geographic_breakdown'),
      ('v_click_lead_stats'),
      ('v_click_monthly_summary'),
      ('v_click_summary_today'),
      ('v_click_top_guide_sections'),
      ('v_click_weekly_summary'),
      ('v_click_yearly_summary'),
      ('v_coach_followups_due_now'),
      ('v_conversations_card'),
      ('v_search'),
      ('v_top_leads'),
      ('v_triage_due_now')
  ), present(rel) as (
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'nil'
      and c.relkind in ('r','v','m','p','f')
  )
  select string_agg(e.rel, ', ' order by e.rel)
  into missing
  from expected e
  left join present p on p.rel = e.rel
  where p.rel is null;

  if missing is not null then
    raise exception 'Missing required nil relations: %', missing;
  end if;
end $$;

-- =====================================================
-- 3) STRICT BOT RUNTIME COLUMN CONTRACT AUDIT
--    (fails fast if core runtime columns are missing)
-- =====================================================
do $$
declare
  missing text;
begin
  with required_columns(table_name, column_name) as (
    values
      ('conversations', 'id'),
      ('conversations', 'thread_key'),
      ('conversations', 'source'),
      ('conversations', 'pipeline'),
      ('conversations', 'lane'),
      ('conversations', 'status'),
      ('conversations', 'contact_email'),
      ('conversations', 'normalized_email'),
      ('conversations', 'subject'),
      ('conversations', 'preview'),
      ('conversations', 'cc_support_suggested'),
      ('conversations', 'cc_support_enabled'),
      ('conversations', 'needs_support_handoff'),
      ('conversations', 'needs_support_handoff_at'),
      ('conversations', 'handoff_detected_reason'),
      ('conversations', 'gmail_thread_id'),
      ('conversations', 'message_id_header'),
      ('conversations', 'in_reply_to'),
      ('conversations', 'references'),
      ('conversations', 'mirror_conversation_id'),
      ('conversations', 'created_at'),
      ('conversations', 'updated_at'),

      ('messages', 'id'),
      ('messages', 'conversation_id'),
      ('messages', 'direction'),
      ('messages', 'sender'),
      ('messages', 'source_ref'),
      ('messages', 'body'),
      ('messages', 'preview'),
      ('messages', 'created_at'),

      ('message_drafts', 'conversation_id'),
      ('message_drafts', 'kind'),
      ('message_drafts', 'version'),
      ('message_drafts', 'subject'),
      ('message_drafts', 'body'),
      ('message_drafts', 'selected'),
      ('message_drafts', 'created_at'),

      ('submissions', 'submission_id'),
      ('submissions', 'email'),
      ('submissions', 'n8n_status'),
      ('submissions', 'n8n_last_error'),
      ('submissions', 'n8n_sent_at'),
      ('submissions', 'created_at'),

      ('n8n_outbox', 'outbox_id'),
      ('n8n_outbox', 'submission_id'),
      ('n8n_outbox', 'idempotency_key'),
      ('n8n_outbox', 'payload'),
      ('n8n_outbox', 'status'),
      ('n8n_outbox', 'attempt_count'),
      ('n8n_outbox', 'retry_count'),
      ('n8n_outbox', 'next_attempt_at'),
      ('n8n_outbox', 'created_at'),
      ('n8n_outbox', 'updated_at'),
      ('n8n_outbox', 'last_error'),
      ('n8n_outbox', 'message_id'),
      ('n8n_outbox', 'sent_at'),
      ('n8n_outbox', 'dead_at'),

      ('ops_events', 'event_type'),
      ('ops_events', 'source'),
      ('ops_events', 'trace_id'),
      ('ops_events', 'idempotency_key'),
      ('ops_events', 'entity_type'),
      ('ops_events', 'entity_id'),
      ('ops_events', 'payload'),
      ('ops_events', 'created_at'),

      ('dead_letters', 'received_at'),
      ('dead_letters', 'error'),
      ('dead_letters', 'payload'),

      ('click_events', 'click_type'),
      ('click_events', 'kind'),
      ('click_events', 'source'),
      ('click_events', 'event_time'),
      ('click_events', 'created_at')
  ),
  present_columns as (
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'nil'
  )
  select string_agg(rc.table_name || '.' || rc.column_name, ', ' order by rc.table_name, rc.column_name)
  into missing
  from required_columns rc
  left join present_columns pc
    on pc.table_name = rc.table_name
   and pc.column_name = rc.column_name
  where pc.column_name is null;

  if missing is not null then
    raise exception 'Missing required nil columns for bot runtime: %', missing;
  end if;
end $$;

commit;

-- =====================================================
-- 4) POST-RUN DIAGNOSTICS (read-only)
-- =====================================================
-- A) All expected relations + object kind
with expected(rel) as (
  values
    ('analytics_metrics'),
    ('calls'),
    ('card_mirrors'),
    ('click_analytics_daily'),
    ('click_events'),
    ('click_link_registry'),
    ('coaches'),
    ('conversations'),
    ('dead_letter_events'),
    ('dead_letters'),
    ('drafts'),
    ('eapp_visits'),
    ('email_messages'),
    ('email_outbox'),
    ('email_sequences'),
    ('events'),
    ('lead_metrics'),
    ('lead_sources'),
    ('leads'),
    ('message_drafts'),
    ('messages'),
    ('metric_events'),
    ('n8n_outbox'),
    ('ops_events'),
    ('people'),
    ('processed_events'),
    ('sms_outbox'),
    ('submissions'),
    ('support_tickets'),
    ('v_analytics_summary'),
    ('v_calls_card'),
    ('v_click_conversion_funnel'),
    ('v_click_daily_summary'),
    ('v_click_device_breakdown'),
    ('v_click_email_client_breakdown'),
    ('v_click_geographic_breakdown'),
    ('v_click_lead_stats'),
    ('v_click_monthly_summary'),
    ('v_click_summary_today'),
    ('v_click_top_guide_sections'),
    ('v_click_weekly_summary'),
    ('v_click_yearly_summary'),
    ('v_coach_followups_due_now'),
    ('v_conversations_card'),
    ('v_search'),
    ('v_top_leads'),
    ('v_triage_due_now')
)
select
  e.rel as relation,
  case c.relkind
    when 'r' then 'table'
    when 'v' then 'view'
    when 'm' then 'materialized_view'
    when 'p' then 'partitioned_table'
    when 'f' then 'foreign_table'
    else c.relkind::text
  end as relation_type
from expected e
left join pg_class c on c.relname = e.rel
left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'nil'
order by e.rel;

-- B) Urgent visibility diagnostics (why urgent count may have changed)
select pipeline, count(*) as conversations
from nil.conversations
group by pipeline
order by pipeline;

select source, pipeline, count(*) as conversations
from nil.conversations
group by source, pipeline
order by source, pipeline;

select count(*) as overdue_needs_reply_24h
from nil.conversations
where pipeline = 'needs_reply'
  and updated_at < now() - interval '24 hours';

select
  id,
  source,
  pipeline,
  updated_at,
  contact_email,
  subject
from nil.conversations
where pipeline = 'needs_reply'
  and updated_at < now() - interval '24 hours'
order by updated_at asc
limit 50;

-- C) Click diagnostics
select
  coalesce(nullif(kind,''), nullif(event_type,''), nullif(click_source,''), 'unknown') as event_type,
  count(*) as clicks_24h
from nil.click_events
where coalesce(event_time, clicked_at, created_at) >= now() - interval '24 hours'
group by 1
order by clicks_24h desc;

-- D) n8n outbox queue diagnostics
select status, count(*) as rows
from nil.n8n_outbox
group by status
order by status;

select
  count(*) as queued_over_30m
from nil.n8n_outbox
where status = 'queued'
  and coalesce(next_attempt_at, created_at) < now() - interval '30 minutes';

select
  outbox_id,
  submission_id,
  status,
  attempt_count,
  retry_count,
  created_at,
  next_attempt_at,
  last_error
from nil.n8n_outbox
where status in ('queued', 'sending', 'failed', 'dead')
order by coalesce(next_attempt_at, created_at) asc
limit 50;

-- E) Dead-letter diagnostics
select
  count(*) as dead_letters_7d
from nil.dead_letters
where received_at >= now() - interval '7 days';

select
  received_at,
  error,
  left(payload::text, 300) as payload_preview
from nil.dead_letters
order by received_at desc
limit 30;

-- F) Message and draft integrity diagnostics
select
  count(*) as conversations_without_messages
from nil.conversations c
where not exists (
  select 1
  from nil.messages m
  where m.conversation_id = c.id
);

select
  count(*) as conversations_without_selected_draft
from nil.conversations c
where not exists (
  select 1
  from nil.message_drafts d
  where d.conversation_id = c.id
    and d.kind = 'conversation'
    and d.selected = true
);

-- G) Freshness diagnostics for key ingestion/event tables
with freshness as (
  select 'ops_events'::text as relation, max(created_at) as latest_at from nil.ops_events
  union all
  select 'metric_events'::text as relation, max(created_at) as latest_at from nil.metric_events
  union all
  select 'click_events'::text as relation, max(created_at) as latest_at from nil.click_events
  union all
  select 'dead_letter_events'::text as relation, max(created_at) as latest_at from nil.dead_letter_events
)
select
  relation,
  latest_at,
  extract(epoch from (now() - latest_at))::bigint as seconds_since_latest
from freshness
order by relation;

-- H) CC support + threading continuity diagnostics
select
  count(*) as cc_enabled_rows
from nil.conversations
where cc_support_enabled = true;

select
  count(*) as handoff_pending_rows
from nil.conversations
where needs_support_handoff = true
  and coalesce(cc_support_suggested, false) = false;

select
  count(*) as missing_thread_context_rows
from nil.conversations
where (gmail_thread_id is null or gmail_thread_id = '')
  and (message_id_header is null or message_id_header = '')
  and (in_reply_to is null or in_reply_to = '')
  and ("references" is null or "references" = '');

-- Thread-context gaps by source (helps spot lane/provider-specific issues)
select
  coalesce(source, 'unknown') as source,
  count(*) as missing_thread_context_rows
from nil.conversations
where (gmail_thread_id is null or gmail_thread_id = '')
  and (message_id_header is null or message_id_header = '')
  and (in_reply_to is null or in_reply_to = '')
  and ("references" is null or "references" = '')
group by coalesce(source, 'unknown')
order by missing_thread_context_rows desc;

-- Recent-window split: if recent is high, current workflow likely regressing.
select
  count(*) filter (
    where coalesce(updated_at, created_at, now()) >= now() - interval '7 days'
  ) as missing_thread_context_recent_7d,
  count(*) filter (
    where coalesce(updated_at, created_at, now()) < now() - interval '7 days'
  ) as missing_thread_context_older,
  count(*) as missing_thread_context_total
from nil.conversations
where (gmail_thread_id is null or gmail_thread_id = '')
  and (message_id_header is null or message_id_header = '')
  and (in_reply_to is null or in_reply_to = '')
  and ("references" is null or "references" = '');

select
  source,
  count(*) as rows
from nil.conversations
where coalesce(cc_support_suggested, false) = true
group by source
order by rows desc;

-- I) n8n result consistency diagnostics
select
  status,
  count(*) as rows,
  count(*) filter (where status = 'sent' and sent_at is null) as sent_missing_sent_at,
  count(*) filter (where status = 'failed' and coalesce(last_error, '') = '') as failed_missing_error,
  count(*) filter (where status = 'dead' and dead_at is null) as dead_missing_dead_at
from nil.n8n_outbox
group by status
order by status;
