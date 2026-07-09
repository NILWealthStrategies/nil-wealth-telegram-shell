-- ============================================================================
-- CLICK EVENTS RETENTION (60 DAYS)
-- Purpose: keep recent click data, prune older rows automatically.
-- Safe: idempotent install script for Supabase/Postgres.
-- ============================================================================

begin;

create extension if not exists pg_cron;

-- Find the best timestamp column and ensure it is indexed for retention scans.
do $$
declare
  v_ts_col text;
begin
  select c.column_name
  into v_ts_col
  from information_schema.columns c
  where c.table_schema = 'nil'
    and c.table_name = 'click_events'
    and c.column_name in ('created_at', 'recorded_at', 'timestamp')
  order by case c.column_name
    when 'created_at' then 1
    when 'recorded_at' then 2
    when 'timestamp' then 3
    else 999
  end
  limit 1;

  if v_ts_col is null then
    raise exception 'nil.click_events is missing created_at/recorded_at/timestamp; cannot install retention';
  end if;

  execute format(
    'create index if not exists idx_click_events_retention_ts on nil.click_events (%I)',
    v_ts_col
  );
end $$;

create table if not exists nil.click_event_retention_log (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  cutoff timestamptz not null,
  retain_days integer not null,
  timestamp_column text not null,
  deleted_count integer not null
);

create or replace function nil.prune_click_events(
  retain_days integer default 60,
  batch_size integer default 50000
)
returns integer
language plpgsql
security definer
set search_path = public, nil
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(retain_days, 1));
  v_deleted integer := 0;
  v_total integer := 0;
  v_ts_col text;
  v_sql text;
begin
  select c.column_name
  into v_ts_col
  from information_schema.columns c
  where c.table_schema = 'nil'
    and c.table_name = 'click_events'
    and c.column_name in ('created_at', 'recorded_at', 'timestamp')
  order by case c.column_name
    when 'created_at' then 1
    when 'recorded_at' then 2
    when 'timestamp' then 3
    else 999
  end
  limit 1;

  if v_ts_col is null then
    raise exception 'nil.click_events is missing created_at/recorded_at/timestamp; cannot prune';
  end if;

  v_sql := format(
    $fmt$
    with doomed as (
      select id
      from nil.click_events
      where %I < $1
      order by %I asc
      limit $2
    )
    delete from nil.click_events ce
    using doomed
    where ce.id = doomed.id
    $fmt$,
    v_ts_col,
    v_ts_col
  );

  loop
    execute v_sql using v_cutoff, greatest(batch_size, 1000);
    get diagnostics v_deleted = row_count;
    v_total := v_total + v_deleted;

    exit when v_deleted = 0;
    perform pg_sleep(0.05);
  end loop;

  insert into nil.click_event_retention_log (cutoff, retain_days, timestamp_column, deleted_count)
  values (v_cutoff, greatest(retain_days, 1), v_ts_col, v_total);

  return v_total;
end;
$$;

-- Replace any previous job with the same name.
do $$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'nil-click-events-retention'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

-- Daily at 03:17 UTC.
select cron.schedule(
  'nil-click-events-retention',
  '17 3 * * *',
  $$select nil.prune_click_events(60, 50000);$$
);

-- Optional one-time run immediately after install:
-- select nil.prune_click_events(60, 50000);

commit;
