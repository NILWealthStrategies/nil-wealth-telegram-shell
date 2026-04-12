create schema if not exists nil;

create table if not exists nil.support_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  title text not null,
  url text not null,
  facts jsonb not null default '[]'::jsonb,
  guardrails jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into nil.support_knowledge_documents (source_key, title, url, facts, guardrails)
values
  (
    'main-site',
    'NIL Wealth Main Site',
    'https://mynilwealthstrategies.com/',
    $$[
      "NIL Wealth Strategies is an education-first platform helping athletes and families understand NIL income, risk, and financial decisions.",
      "Core positioning is protection-first planning and financial education before mistakes become costly.",
      "Primary education lanes include Risk Awareness, Tax Education and Income Clarity, and Supplemental Health education.",
      "Supplemental health enrollment flow is structured and carrier-issued, with eligibility and underwriting handled by the insurance carrier.",
      "Enrollment FAQ: enrollment is optional, family-driven, and completed through the carrier's secure electronic process.",
      "Enrollment steps FAQ: review education page, submit short interest form, receive secure carrier enrollment link, complete application only if you choose.",
      "Timing FAQ: underwriting is typically completed in about 1 to 3 business days after submission, depending on carrier process.",
      "Eligibility FAQ: adults can enroll directly, and a parent or legal guardian enrolls for minors.",
      "Cost FAQ: pricing is carrier-determined and varies by state, age, plan design, and risk factors; support should avoid quoting fixed pricing.",
      "Carrier FAQ: NIL Wealth provides education and guidance, while the insurance carrier handles enrollment, underwriting, and claims.",
      "Quick enroll by text is available at (855) 515-9844.",
      "Support contact includes support@mynilwealthstrategies.com and website contact pages."
    ]$$::jsonb,
    $$[
      "Do not imply guaranteed outcomes, coverage approval, or school endorsement.",
      "Do not claim NIL Wealth issues insurance policies directly."
    ]$$::jsonb
  ),
  (
    'parent-guide',
    'Parent Education Guide',
    'https://parentsguide.mynilwealthstrategies.com/',
    $$[
      "This guide is educational only and is designed to help families understand injury-related financial risk and coverage concepts.",
      "Participation in supplemental coverage is optional and family-driven.",
      "Supplemental coverage works alongside major medical and is not a replacement for health insurance.",
      "FAQ: school and coaches are not selling or requiring coverage; families make independent enrollment decisions.",
      "Families often face out-of-pocket costs after injuries: deductibles, copays, coinsurance, travel, and lost work time.",
      "School athletic coverage may be limited by event scope, benefit caps, and secondary status.",
      "Accident and hospital indemnity style plans can pay cash benefits directly to policyholders for covered events.",
      "How to enroll FAQ: review the supplemental health page, submit the request form, receive secure enrollment access, and complete enrollment only if desired.",
      "Claims/admin FAQ: enrollment, policy administration, and claims are handled directly by Aflac, not by schools or NIL Wealth.",
      "Enrollment and claims are administered by Aflac; NIL Wealth provides educational guidance and process clarity."
    ]$$::jsonb,
    $$[
      "Avoid personalized insurance advice.",
      "Avoid promising specific claim outcomes or pricing."
    ]$$::jsonb
  ),
  (
    'supplemental-health-guide',
    'Supplemental Health Protection Guide',
    'https://supplementalhealth.mynilwealthstrategies.com/',
    $$[
      "Supplemental health insurance is optional coverage that works with existing health insurance.",
      "Cash benefits are paid directly to the policyholder for covered events according to policy schedules.",
      "FAQ: benefits are paid according to policy terms and covered events; support should avoid guaranteeing outcomes.",
      "Benefits can be used flexibly for deductibles, copays, bills, travel, income disruption, and recovery expenses.",
      "Coverage examples include accident insurance and hospital indemnity insurance for covered events.",
      "Benefits may stack when multiple coverages apply to the same covered event, subject to policy terms.",
      "FAQ: this is not limited to sports incidents; covered everyday accidents and hospital events may also qualify based on policy terms.",
      "FAQ: school coverage can be limited, often secondary, and may not cover all off-season or non-school activities.",
      "How to enroll FAQ: complete the website form, receive secure electronic enrollment access, review final pricing/eligibility in-carrier, then choose whether to enroll.",
      "Portability FAQ: coverage is generally portable across school, job, and location changes when policy terms are maintained.",
      "Coverage is typically portable across job, school, and location changes when premiums are maintained.",
      "Enrollment, underwriting, and claims are handled by the carrier; NIL Wealth remains educational and support-focused."
    ]$$::jsonb,
    $$[
      "Do not represent benefits as universal or guaranteed.",
      "Do not characterize educational material as legal, tax, or medical advice."
    ]$$::jsonb
  ),
  (
    'risk-awareness-guide',
    'Risk Awareness Guide',
    'https://riskawareness.mynilwealthstrategies.com/',
    $$[
      "The guide defines four athlete risk categories: income risk, tax/compliance risk, liability risk, and decision risk.",
      "FAQ: the guide is awareness-first and is intended to reduce preventable mistakes, not pressure decisions.",
      "Athlete income can be unstable due to injury, role changes, eligibility, market shifts, and renewal uncertainty.",
      "Tax timing and estimated payment mistakes can create penalties and stress even when earnings are strong.",
      "Liability exposure can come from auto events, social situations, camps, and side business activity.",
      "Decision risk often comes from pressure, urgency, and unclear downside understanding.",
      "FAQ: insurance is contract-based; coverage depends on occurrence timing, covered perils, exclusions, limits, and conditions.",
      "Insurance is contract-based and depends on occurrence timing, covered perils, exclusions, limits, deductibles, and conditions.",
      "Many households are misinsured rather than simply underinsured.",
      "FAQ: umbrella and excess liability are educational topics in the guide and should not be framed as individualized legal advice."
    ]$$::jsonb,
    $$[
      "Do not provide legal conclusions or claim determinations.",
      "Do not present risk education as an individualized recommendation."
    ]$$::jsonb
  ),
  (
    'tax-education-guide',
    'Tax Education Guide',
    'https://taxeducation.mynilwealthstrategies.com/',
    $$[
      "Most NIL earnings are taxable and commonly reported on 1099-NEC or 1099-MISC, with no automatic withholding.",
      "Athletes often face both income tax and self-employment tax obligations.",
      "A practical baseline is saving roughly 25-30% of NIL payments for taxes until exact estimates are calculated.",
      "FAQ: no withholding does not mean no tax due; it often means the athlete must set funds aside and pay directly.",
      "Estimated tax due dates are typically April 15, June 15, September 15, and January 15.",
      "FAQ: the standard deduction can reduce income tax but does not remove self-employment tax exposure.",
      "Business expense tracking can reduce taxable profit when expenses are ordinary and necessary for NIL activity.",
      "The standard deduction may reduce income tax but does not eliminate self-employment tax exposure.",
      "FAQ: this guide is educational and not personalized tax filing advice; individual cases may need formal EA or tax professional support.",
      "The guide is educational, not personalized tax advice, and some cases require formal professional engagement."
    ]$$::jsonb,
    $$[
      "Do not provide personalized tax filing conclusions.",
      "Do not state exact tax outcomes without full tax context."
    ]$$::jsonb
  )
on conflict (source_key) do update
set
  title = excluded.title,
  url = excluded.url,
  facts = excluded.facts,
  guardrails = excluded.guardrails,
  updated_at = now();
