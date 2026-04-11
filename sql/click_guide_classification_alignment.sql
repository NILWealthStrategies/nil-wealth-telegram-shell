-- Align guide click classification so child-guide clicks are not collapsed into parent-guide metrics.
-- Date: 2026-04-11
-- Safe to run multiple times.

begin;

-- 1) Normalize guide_key -> canonical event kind for historical rows.
--    This corrects rows where older payloads used generic guide labels.
update nil.click_events
set
  kind = case
    when guide_key = 'supplemental-health-guide' then 'supplemental_health_guide_click'
    when guide_key = 'risk-awareness-guide' then 'risk_awareness_guide_click'
    when guide_key = 'tax-education-guide' then 'tax_education_guide_click'
    when guide_key = 'parent-guide' then 'parent_guide_click'
    when guide_key = 'enroll' then 'enroll_click'
    when guide_key = 'eapp' then 'eapp_visit'
    else kind
  end,
  click_type = case
    when guide_key = 'supplemental-health-guide' then 'supplemental_health_guide_click'
    when guide_key = 'risk-awareness-guide' then 'risk_awareness_guide_click'
    when guide_key = 'tax-education-guide' then 'tax_education_guide_click'
    when guide_key = 'parent-guide' then 'parent_guide_click'
    when guide_key = 'enroll' then 'enroll_click'
    when guide_key = 'eapp' then 'eapp_visit'
    else click_type
  end,
  event_type = case
    when guide_key = 'supplemental-health-guide' then 'supplemental_health_guide_click'
    when guide_key = 'risk-awareness-guide' then 'risk_awareness_guide_click'
    when guide_key = 'tax-education-guide' then 'tax_education_guide_click'
    when guide_key = 'parent-guide' then 'parent_guide_click'
    when guide_key = 'enroll' then 'enroll_click'
    when guide_key = 'eapp' then 'eapp_visit'
    else event_type
  end
where guide_key in ('parent-guide', 'supplemental-health-guide', 'risk-awareness-guide', 'tax-education-guide', 'enroll', 'eapp')
  and (
    coalesce(kind, '') in (
      '',
      'guide_click',
      'guide_open',
      'program_link_open',
      'program_guide_open',
      'parent_guide_open',
      'parent_guide_click',
      'coverage_exploration',
      'coverage_click',
      'coverage_link_open',
      'sh_click',
      'risk_awareness_click',
      'tax_education_click'
    )
    or coalesce(click_type, '') in ('', 'guide_click', 'guide_open')
    or coalesce(event_type, '') in ('', 'guide_click', 'guide_open')
  );

-- 2) Optional index to accelerate guide_key-based metric repair/queries.
create index if not exists idx_click_events_guide_key_created_at
  on nil.click_events (guide_key, created_at desc);

commit;
