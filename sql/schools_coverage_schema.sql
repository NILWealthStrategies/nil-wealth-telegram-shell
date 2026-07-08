-- ============================================================================
-- NIL WEALTH STRATEGIES - SCHOOLS COVERAGE SCHEMA
-- Supabase schema for the schools market coverage dashboard
--
-- Why this works:
-- 1. The bot reads only two coverage views:
--    - nil.v_global_coverage_summary
--    - nil.v_active_states_with_responses
-- 2. Those views are built from normalized tables, so the dashboard can compute:
--    - total schools in database
--    - schools reached/contacted
--    - schools responded
--    - coaches contacted/responded
--    - counties reached
--    - active states with outreach
-- 3. The state breakdown only shows rows where outreach actually exists.
-- 4. The school total denominator comes from nil.schools_registry, so the
--    dashboard can show "contacted / total" accurately.
--
-- Notes:
-- - This schema is intentionally normalized.
-- - It does not require 50 separate state tables.
-- - If you already have a schools import pipeline, point it at nil.schools_registry.
-- - If you already have a message/email pipeline, write outreach rows into
--   nil.school_outreach_events.
-- ============================================================================

begin;

create schema if not exists nil;

-- ============================================================================
-- 1) MASTER SCHOOL REGISTRY
-- ============================================================================
-- One row per school in the database.
-- This is the source of truth for the total school counts shown in the dashboard.
create table if not exists nil.schools_registry (
  id bigserial primary key,
  school_id text unique not null,
  school_name text not null,
  school_type text,
  state text not null,
  county text,
  city text,
  zip_code text,
  latitude numeric,
  longitude numeric,
  phone text,
  website text,
  total_students integer,
  grades text,
  sports_offered text,
  athletic_conference text,
  principal_name text,
  principal_email text,
  athletic_director_name text,
  athletic_director_email text,
  source text default 'nces',
  imported_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_schools_registry_state on nil.schools_registry(state);
create index if not exists idx_schools_registry_state_city on nil.schools_registry(state, city);
create index if not exists idx_schools_registry_county on nil.schools_registry(county);
create index if not exists idx_schools_registry_name on nil.schools_registry(school_name);
create index if not exists idx_schools_registry_school_id on nil.schools_registry(school_id);

-- ============================================================================
-- 2) OUTREACH / CONTACT EVENTS
-- ============================================================================
-- One row per outreach event, reply, or manual contact record.
-- This is the table the coverage views aggregate.
create table if not exists nil.school_outreach_events (
  id bigserial primary key,
  school_id bigint references nil.schools_registry(id) on delete cascade,
  state text,
  county text,
  school_name text,
  coach_name text,
  coach_email text,
  contact_method text default 'email',
  message_direction text default 'outbound',
  contact_status text default 'sent',
  first_contact_at timestamptz,
  last_contact_at timestamptz default now(),
  response_received boolean default false,
  response_at timestamptz,
  school_response_received boolean default false,
  school_response_date timestamptz,
  school_response_type text,
  notes text,
  source text default 'bot',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_school_outreach_events_school_id on nil.school_outreach_events(school_id);
create index if not exists idx_school_outreach_events_state on nil.school_outreach_events(state);
create index if not exists idx_school_outreach_events_county on nil.school_outreach_events(county);
create index if not exists idx_school_outreach_events_coach_email on nil.school_outreach_events(coach_email);
create index if not exists idx_school_outreach_events_last_contact_at on nil.school_outreach_events(last_contact_at desc);
create index if not exists idx_school_outreach_events_response_received on nil.school_outreach_events(response_received);
create index if not exists idx_school_outreach_events_school_response_received on nil.school_outreach_events(school_response_received);

-- Optional manual review table for uncertain matches or imports.
create table if not exists nil.school_outreach_review (
  id bigserial primary key,
  coach_email text not null,
  coach_name text,
  email_subject text,
  email_body text,
  email_state text,
  email_domain text,
  possible_school_names text[],
  possible_school_ids bigint[],
  match_confidence numeric default 0,
  suggested_school_id bigint references nil.schools_registry(id),
  suggested_school_name text,
  suggested_city text,
  suggested_state text,
  reviewed_by text,
  reviewed_at timestamptz,
  confirmed_school_id bigint references nil.schools_registry(id),
  review_notes text,
  status text default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_school_outreach_review_status on nil.school_outreach_review(status);
create index if not exists idx_school_outreach_review_state on nil.school_outreach_review(email_state);
create index if not exists idx_school_outreach_review_created_at on nil.school_outreach_review(created_at desc);

-- ============================================================================
-- 3) CONFIG / KNOWN TOTALS
-- ============================================================================
-- Optional reference values for display and validation.
create table if not exists nil.config_totals (
  key text primary key,
  value bigint,
  description text,
  updated_at timestamptz default now()
);

insert into nil.config_totals (key, value, description)
values
  ('total_us_schools', 130589, 'Total K-12 schools in the United States'),
  ('total_us_public_schools', 98267, 'Total public schools in the United States'),
  ('total_us_private_schools', 29378, 'Total private schools in the United States'),
  ('total_us_charter_schools', 3944, 'Total charter schools in the United States'),
  ('total_us_public_high_schools', 24460, 'Total public high schools in the United States')
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();

-- ============================================================================
-- 4) HELPER VIEW: ACTIVE SCHOOL ROWS
-- ============================================================================
-- This view deduplicates to one row per school and keeps only schools with
-- at least one outreach event, so the state breakdown only shows active states.
create or replace view nil.v_active_school_rows as
select distinct on (sr.id)
  sr.id as school_pk,
  sr.school_id,
  sr.school_name,
  sr.state,
  sr.county,
  sr.city,
  sr.athletic_director_name,
  sr.athletic_director_email,
  coalesce(soe.last_contact_at, soe.created_at, sr.imported_at) as last_contact_at,
  coalesce(soe.response_received, false) as response_received,
  coalesce(soe.school_response_received, false) as school_response_received,
  coalesce(soe.coach_email, sr.athletic_director_email) as coach_email,
  coalesce(soe.coach_name, sr.athletic_director_name) as coach_name
from nil.schools_registry sr
join nil.school_outreach_events soe
  on soe.school_id = sr.id
where sr.state is not null
order by sr.id, coalesce(soe.last_contact_at, soe.created_at, sr.imported_at) desc;

-- ============================================================================
-- 5) GLOBAL COVERAGE SUMMARY VIEW
-- ============================================================================
-- Matches the fields read by src/index.js.
create or replace view nil.v_global_coverage_summary as
select
  (select count(*) from nil.schools_registry where state is not null) as schools_in_database,
  count(distinct soe.school_id) as schools_reached,
  count(distinct case when soe.school_response_received = true then soe.school_id end) as schools_responded,
  count(distinct soe.coach_email) as coaches_contacted,
  count(distinct case when soe.response_received = true then soe.coach_email end) as coaches_responded,
  count(distinct sr.county) as counties_reached,
  count(distinct sr.state) as states_with_activity
from nil.schools_registry sr
join nil.school_outreach_events soe
  on soe.school_id = sr.id
where sr.state is not null;

-- ============================================================================
-- 6) ACTIVE STATES WITH RESPONSES VIEW
-- ============================================================================
-- Matches the fields read by src/index.js and only returns states with outreach.
-- If a state has no outreach, it will not appear here.
create or replace view nil.v_active_states_with_responses as
select
  sr.state,
  count(distinct sr.id) as schools_in_state,
  count(distinct soe.school_id) as schools_contacted,
  count(distinct case when soe.school_response_received = true then soe.school_id end) as schools_responded,
  count(distinct soe.coach_email) as coaches_contacted,
  count(distinct case when soe.response_received = true then soe.coach_email end) as coaches_responded,
  count(distinct sr.county) as counties_reached,
  max(coalesce(soe.last_contact_at, soe.created_at)) as last_contact_at
from nil.schools_registry sr
join nil.school_outreach_events soe
  on soe.school_id = sr.id
where sr.state is not null
group by sr.state
having count(distinct soe.school_id) > 0
order by schools_contacted desc, coaches_contacted desc, sr.state asc;

-- ============================================================================
-- 7) OPTIONAL SUMMARY VIEW FOR ALL STATES
-- ============================================================================
-- Useful if you want a complete 50-state coverage table later.
create or replace view nil.v_schools_per_state as
select
  state,
  count(*) as schools_in_state,
  count(distinct county) as counties_in_state
from nil.schools_registry
where state is not null
group by state
order by state;

-- ============================================================================
-- 8) VERIFICATION
-- ============================================================================
select
  'Schools coverage schema ready' as status,
  (select count(*) from nil.schools_registry) as schools_registry_count,
  (select count(*) from nil.school_outreach_events) as outreach_events_count,
  (select count(*) from nil.config_totals) as config_totals_count;

commit;
