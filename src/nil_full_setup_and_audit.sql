begin;

create schema if not exists nil;

-- =====================================================
-- 1) CLICK TRACKING SCHEMA (idempotent, safe)
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

commit;

-- =====================================================
-- 3) POST-RUN DIAGNOSTICS (read-only)
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
