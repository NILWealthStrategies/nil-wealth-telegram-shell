-- ============================================================================
-- CLICK EVENTS RETENTION UNINSTALL
-- Purpose: remove scheduled retention job and retention objects.
-- ============================================================================

begin;

do $$
declare
  j record;
  has_pg_cron boolean;
begin
  select exists(select 1 from pg_extension where extname = 'pg_cron') into has_pg_cron;

  if has_pg_cron then
    for j in select jobid from cron.job where jobname = 'nil-click-events-retention'
    loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
end $$;

drop function if exists nil.prune_click_events(integer, integer);
drop table if exists nil.click_event_retention_log;
drop index if exists nil.idx_click_events_retention_ts;

commit;
