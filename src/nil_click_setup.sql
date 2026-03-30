begin;

create schema if not exists nil;

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
  meta jsonb
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
alter table nil.click_events add column if not exists guide_key text;
alter table nil.click_events add column if not exists person_key text;
alter table nil.click_events add column if not exists actor_type text;
alter table nil.click_events add column if not exists actor_id text;
alter table nil.click_events add column if not exists is_coach_self_click boolean default false;
alter table nil.click_events add column if not exists dedupe_key text;
alter table nil.click_events add column if not exists is_unique_forwarded boolean default false;

-- Backfill click_type from kind or event_type if null
update nil.click_events
set click_type = coalesce(nullif(kind,''), nullif(event_type,''), 'website_click')
where click_type is null;

-- Set a safe default so future inserts never hit NOT NULL
alter table nil.click_events alter column click_type set default 'website_click';

update nil.click_events
set created_at = coalesce(created_at, event_time, clicked_at, now())
where created_at is null;

alter table nil.click_events alter column created_at set default now();
alter table nil.click_events alter column source set default 'cloudflare';
alter table nil.click_events alter column value set default 1;

create index if not exists idx_click_events_created_at on nil.click_events (created_at desc);
create index if not exists idx_click_events_kind on nil.click_events (kind);
create index if not exists idx_click_events_event_type on nil.click_events (event_type);
create index if not exists idx_click_events_coach_id on nil.click_events (coach_id);
create index if not exists idx_click_events_guide_key on nil.click_events (guide_key);
create index if not exists idx_click_events_person_key on nil.click_events (person_key);
create index if not exists idx_click_events_dedupe_key on nil.click_events (dedupe_key);

create table if not exists nil.click_link_registry (
  id bigserial primary key,
  dedupe_key text not null,
  coach_id text,
  campaign_id text,
  guide_key text,
  person_key text,
  actor_type text,
  actor_id text,
  source text default 'cloudflare',
  link text,
  is_coach_self_click boolean default false,
  first_seen_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table nil.click_link_registry add column if not exists dedupe_key text;
alter table nil.click_link_registry add column if not exists coach_id text;
alter table nil.click_link_registry add column if not exists campaign_id text;
alter table nil.click_link_registry add column if not exists guide_key text;
alter table nil.click_link_registry add column if not exists person_key text;
alter table nil.click_link_registry add column if not exists actor_type text;
alter table nil.click_link_registry add column if not exists actor_id text;
alter table nil.click_link_registry add column if not exists source text default 'cloudflare';
alter table nil.click_link_registry add column if not exists link text;
alter table nil.click_link_registry add column if not exists is_coach_self_click boolean default false;
alter table nil.click_link_registry add column if not exists first_seen_at timestamptz default now();
alter table nil.click_link_registry add column if not exists created_at timestamptz default now();

update nil.click_link_registry
set dedupe_key = md5(
  coalesce(coach_id, '') || '|' ||
  coalesce(guide_key, '') || '|' ||
  coalesce(person_key, '') || '|' ||
  coalesce(actor_id, '') || '|' ||
  coalesce(created_at::text, now()::text)
)
where dedupe_key is null;

create unique index if not exists idx_click_link_registry_dedupe on nil.click_link_registry (dedupe_key);
create unique index if not exists idx_click_link_registry_coach_guide_person
  on nil.click_link_registry (coach_id, guide_key, person_key)
  where coach_id is not null and guide_key is not null and person_key is not null;
create index if not exists idx_click_link_registry_coach on nil.click_link_registry (coach_id);
create index if not exists idx_click_link_registry_guide on nil.click_link_registry (guide_key);
create index if not exists idx_click_link_registry_person on nil.click_link_registry (person_key);

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

commit;
