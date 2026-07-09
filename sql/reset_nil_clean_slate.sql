-- Full NIL data reset (clean slate)
-- Purpose: remove all row data from every BASE TABLE in schema nil.
-- Safety: views and schema objects are preserved; only table rows are removed.

begin;

do $$
declare
  truncate_sql text;
begin
  select
    'truncate table ' || string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename) || ' restart identity cascade'
  into truncate_sql
  from pg_tables
  where schemaname = 'nil';

  if truncate_sql is null then
    raise notice 'No base tables found in schema nil. Nothing to truncate.';
  else
    execute truncate_sql;
    raise notice 'All nil base tables truncated with RESTART IDENTITY CASCADE.';
  end if;
end $$;

commit;

-- Optional verification:
-- select schemaname, relname as table_name, n_live_tup as estimated_rows
-- from pg_stat_user_tables
-- where schemaname = 'nil'
-- order by relname;