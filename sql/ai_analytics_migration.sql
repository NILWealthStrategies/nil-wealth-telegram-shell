-- Migration: Add AI version tracking and analytics columns to email_sequences
-- Run this in Supabase SQL Editor

-- Add columns for AI-generated email versions
alter table nil.email_sequences 
add column if not exists ai_version_used text, -- 'v1', 'v2', or 'v3'
add column if not exists ai_all_versions jsonb, -- stores all 3 generated versions
add column if not exists selection_reason text, -- why this version was chosen
add column if not exists opened_at timestamptz,
add column if not exists clicked_at timestamptz,
add column if not exists replied_at timestamptz;

-- Update lead_metrics table to support more event types
comment on column nil.lead_metrics.metric_type is 'email_sent | email_open | email_click | email_forward | email_reply | email_bounce';

-- Create index for faster analytics queries
create index if not exists idx_email_sequences_lead_id on nil.email_sequences(lead_id);
create index if not exists idx_lead_metrics_type_date on nil.lead_metrics(metric_type, recorded_at);
create index if not exists idx_leads_email on nil.leads(email);

-- Add follow-up tracking to leads
alter table nil.leads
add column if not exists last_reply_at timestamptz,
add column if not exists follow_up_scheduled_at timestamptz,
add column if not exists engagement_score int default 0; -- calculated from opens/clicks/replies

-- Function to calculate engagement score
create or replace function nil.calculate_engagement_score(p_lead_id uuid)
returns int
language plpgsql
as $$
declare
  v_score int := 0;
  v_opens int;
  v_clicks int;
  v_replies int;
begin
  -- Count engagement events
  select 
    coalesce(sum(case when metric_type = 'email_open' then metric_value else 0 end), 0),
    coalesce(sum(case when metric_type = 'email_click' then metric_value else 0 end), 0),
    coalesce(sum(case when metric_type = 'email_reply' then metric_value else 0 end), 0)
  into v_opens, v_clicks, v_replies
  from nil.lead_metrics
  where lead_id = p_lead_id;
  
  -- Calculate score (opens=1 point, clicks=5 points, replies=20 points)
  v_score := (v_opens * 1) + (v_clicks * 5) + (v_replies * 20);
  
  return v_score;
end;
$$;

-- Trigger to update engagement_score automatically
create or replace function nil.update_engagement_score_trigger()
returns trigger
language plpgsql
as $$
begin
  update nil.leads
  set engagement_score = nil.calculate_engagement_score(NEW.lead_id)
  where lead_id = NEW.lead_id;
  
  return NEW;
end;
$$;

drop trigger if exists trg_update_engagement_score on nil.lead_metrics;
create trigger trg_update_engagement_score
after insert or update on nil.lead_metrics
for each row
execute function nil.update_engagement_score_trigger();

-- View for Telegram bot analytics dashboard
create or replace view nil.v_analytics_summary as
select
  -- Today's stats
  count(distinct case when date(l.created_at) = current_date then l.lead_id end) as leads_today,
  count(distinct case when date(lm.recorded_at) = current_date and lm.metric_type = 'email_sent' then lm.lead_id end) as emails_sent_today,
  count(distinct case when date(lm.recorded_at) = current_date and lm.metric_type = 'email_open' then lm.lead_id end) as opens_today,
  count(distinct case when date(lm.recorded_at) = current_date and lm.metric_type = 'email_click' then lm.lead_id end) as clicks_today,
  count(distinct case when date(lm.recorded_at) = current_date and lm.metric_type = 'email_reply' then lm.lead_id end) as replies_today,
  
  -- All-time stats
  count(distinct l.lead_id) as total_leads,
  count(distinct case when lm.metric_type = 'email_sent' then lm.lead_id end) as total_emails_sent,
  count(distinct case when lm.metric_type = 'email_open' then lm.lead_id end) as total_opens,
  count(distinct case when lm.metric_type = 'email_click' then lm.lead_id end) as total_clicks,
  count(distinct case when lm.metric_type = 'email_reply' then lm.lead_id end) as total_replies,
  
  -- Rates
  round(
    (count(distinct case when lm.metric_type = 'email_open' then lm.lead_id end)::numeric / 
     nullif(count(distinct case when lm.metric_type = 'email_sent' then lm.lead_id end), 0)) * 100, 
    1
  ) as open_rate_pct,
  round(
    (count(distinct case when lm.metric_type = 'email_click' then lm.lead_id end)::numeric / 
     nullif(count(distinct case when lm.metric_type = 'email_sent' then lm.lead_id end), 0)) * 100, 
    1
  ) as click_rate_pct,
  round(
    (count(distinct case when lm.metric_type = 'email_reply' then lm.lead_id end)::numeric / 
     nullif(count(distinct case when lm.metric_type = 'email_sent' then lm.lead_id end), 0)) * 100, 
    1
  ) as reply_rate_pct
from nil.leads l
left join nil.lead_metrics lm on l.lead_id = lm.lead_id;

-- View for top performing leads (by engagement)
create or replace view nil.v_top_leads as
select
  l.lead_id,
  l.full_name,
  l.email,
  l.organization,
  l.title,
  l.status,
  l.engagement_score,
  count(distinct case when lm.metric_type = 'email_open' then lm.id end) as opens,
  count(distinct case when lm.metric_type = 'email_click' then lm.id end) as clicks,
  count(distinct case when lm.metric_type = 'email_reply' then lm.id end) as replies
from nil.leads l
left join nil.lead_metrics lm on l.lead_id = lm.lead_id
group by l.lead_id, l.full_name, l.email, l.organization, l.title, l.status, l.engagement_score
order by l.engagement_score desc
limit 50;

-- Grant permissions
grant all on nil.email_sequences to service_role;
grant all on nil.leads to service_role;
grant all on nil.lead_metrics to service_role;
grant select on nil.v_analytics_summary to service_role;
grant select on nil.v_top_leads to service_role;

-- Success message
do $$
begin
  raise notice '✅ Migration complete! Added AI version tracking, analytics columns, engagement scoring, and dashboard views.';
end$$;
