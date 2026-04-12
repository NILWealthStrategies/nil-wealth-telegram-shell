create schema if not exists nil;

create table if not exists nil.support_knowledge_faq (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  question text not null,
  answer text not null,
  updated_at timestamptz not null default now(),
  unique (source_key, question)
);

insert into nil.support_knowledge_faq (source_key, question, answer)
values
  ('parent-guide', 'Is supplemental coverage required?', 'No. Coverage is optional and family-driven.'),
  ('parent-guide', 'Does this replace major medical insurance?', 'No. Supplemental coverage works alongside major medical and does not replace primary health insurance.'),
  ('main-site', 'What are the enrollment steps?', 'Review the education page, submit the short request form, receive secure enrollment access, review options and complete enrollment only if you choose.'),
  ('main-site', 'How long does approval usually take?', 'Underwriting is typically completed in about 1 to 3 business days after submission, depending on carrier process.'),
  ('supplemental-health-guide', 'Who handles enrollment and claims?', 'The insurance carrier handles enrollment, underwriting, policy administration, and claims. NIL Wealth provides educational support.'),
  ('main-site', 'Who can enroll?', 'Adults can enroll directly. For minors, a parent or legal guardian completes enrollment.'),
  ('supplemental-health-guide', 'What can cash benefits be used for?', 'Families can use benefits for deductibles, copays, bills, travel, recovery expenses, and income disruption during covered events.'),
  ('supplemental-health-guide', 'Is this only for sports injuries?', 'No. Coverage may also apply to covered everyday accidents and covered hospital events, based on policy terms.'),
  ('parent-guide', 'What if school insurance exists already?', 'School athletic coverage may be limited by scope, caps, and secondary status. Supplemental coverage is designed to help address gaps.'),
  ('main-site', 'Is pricing fixed for everyone?', 'No. Pricing is carrier-determined and varies by state, age, selected benefits, and other carrier factors.'),
  ('supplemental-health-guide', 'Can benefits stack if an accident leads to hospitalization?', 'Covered benefits may stack across selected coverages according to policy schedules and terms.'),
  ('supplemental-health-guide', 'Can coverage continue through school or job changes?', 'Coverage is generally portable when policy terms are maintained.'),
  ('parent-guide', 'Where should families start if they just want a forwardable overview?', 'Start with the Parent Guide for a clear, forwardable educational overview.'),
  ('risk-awareness-guide', 'What are the four core risks in NIL risk awareness?', 'Income risk, tax/compliance risk, liability risk, and decision risk.'),
  ('risk-awareness-guide', 'What does misinsured vs underinsured mean?', 'Many families are misinsured (wrong fit) rather than simply underinsured (too little limit).'),
  ('tax-education-guide', 'Are taxes usually withheld from NIL income?', 'Usually no. NIL income is often reported on 1099 forms and taxes are not automatically withheld.'),
  ('tax-education-guide', 'How much should athletes set aside for taxes?', 'A practical educational baseline is roughly 25 to 30 percent until exact estimates are calculated.'),
  ('tax-education-guide', 'What estimated tax dates are commonly referenced?', 'April 15, June 15, September 15, and January 15.'),
  ('tax-education-guide', 'Does the standard deduction remove self-employment tax?', 'No. The standard deduction may reduce income tax but does not remove self-employment tax exposure.'),
  ('main-site', 'Can NIL Wealth give individualized legal, tax, or medical advice in support replies?', 'Support replies are educational and should not provide individualized legal, tax, or medical advice.'),
  ('main-site', 'Can support guarantee coverage approval, claim payouts, or exact outcomes?', 'No. Support should never guarantee underwriting, claims outcomes, or specific coverage results.'),
  ('parent-guide', 'Can support claim school endorsement?', 'No. Support should not state or imply school endorsement unless formally and explicitly approved.'),
  ('parent-guide', 'What if a family asks whether this is a sales requirement?', 'State clearly that this is educational, optional, and family-driven with no requirement to enroll.'),
  ('risk-awareness-guide', 'What if someone asks for legal interpretation of a policy contract?', 'Provide educational context only and recommend consulting licensed legal professionals for legal interpretation.'),
  ('tax-education-guide', 'What if someone asks for personalized tax filing decisions?', 'Provide educational guidance and recommend formal professional tax engagement for individual filing decisions.'),
  ('risk-awareness-guide', 'How should support answer concerns about pressure or urgency?', 'Use a no-pressure tone and reinforce that families can review options at their own pace.'),
  ('main-site', 'How can people contact support directly?', 'Support contact is available through support@mynilwealthstrategies.com and the website contact channels.'),
  ('main-site', 'Is there a quick text path to enrollment access?', 'Yes. Quick enroll by text is available at (855) 515-9844.'),
  ('parent-guide', 'What should be said when asked about medical bill gaps after injuries?', 'Explain that families often face deductibles, copays, coinsurance, travel, and income disruption even with primary insurance.'),
  ('supplemental-health-guide', 'How should support handle objections about replacing health insurance?', 'Clearly state supplemental coverage is designed to supplement, not replace, primary health insurance.')
on conflict (source_key, question) do update
set
  answer = excluded.answer,
  updated_at = now();
