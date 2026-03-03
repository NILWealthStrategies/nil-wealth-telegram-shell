-- NIL Wealth: n8n Outbox Pattern Migration
-- Schema: nil (NOT ops)
-- Run this in Supabase SQL Editor

begin;

-- Ensure pgcrypto extension for gen_random_uuid()
create extension if not exists pgcrypto;

-- Create n8n_outbox table in nil schema
create table if not exists nil.n8n_outbox (
  outbox_id uuid primary key default gen_random_uuid(),
  submission_id text not null,
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'queued', -- queued|sending|sent|failed
  attempt_count int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Unique constraint on submission_id (prevents duplicates)
create unique index if not exists n8n_outbox_submission_id_uq
on nil.n8n_outbox (submission_id);

-- Index for efficient claim queries
create index if not exists n8n_outbox_status_next_attempt_idx
on nil.n8n_outbox (status, next_attempt_at);

-- Add n8n tracking columns to submissions table
alter table nil.submissions
  add column if not exists n8n_status text not null default 'queued',
  add column if not exists n8n_last_error text,
  add column if not exists n8n_sent_at timestamptz;

-- Create atomic claim function for n8n outbox
create or replace function nil.claim_n8n_outbox(limit_count int default 25)
returns table (
  submission_id text,
  idempotency_key text,
  payload jsonb,
  attempt_count int
)
language plpgsql
as $$
declare
  claimed_ids uuid[];
begin
  -- Atomically claim rows by selecting FOR UPDATE and marking as 'sending'
  with claimed as (
    select outbox_id
    from nil.n8n_outbox
    where status = 'queued'
      and next_attempt_at <= now()
    order by created_at asc
    limit limit_count
    for update skip locked
  ),
  updated as (
    update nil.n8n_outbox
    set 
      status = 'sending',
      attempt_count = attempt_count + 1
    where outbox_id in (select outbox_id from claimed)
    returning nil.n8n_outbox.outbox_id, 
              nil.n8n_outbox.submission_id, 
              nil.n8n_outbox.idempotency_key, 
              nil.n8n_outbox.payload,
              nil.n8n_outbox.attempt_count
  )
  select 
    updated.submission_id,
    updated.idempotency_key,
    updated.payload,
    updated.attempt_count
  from updated;
end;
$$;

commit;
