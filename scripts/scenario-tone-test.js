#!/usr/bin/env node
/**
 * SCENARIO TONE TEST — 4 named real-world situations
 *
 * 1. OUTREACH_COACH_INTEREST     — Coach reaches out via Instantly (programs lane)
 *    Validates: very casual tone, no corporate filler, no meeting push, no NIL unless asked
 *
 * 2. PARENT_WEBSITE_QUESTION     — Parent emails support from website
 *    Validates: formal tone, correct answer (optional / doesn't replace insurance), guide CTA
 *
 * 3. OBJECTION_CONQUEST          — Parent pushes back: "we already have insurance"
 *    Validates: formal, empathetic, explains gap-fill concept, no pressure, door left open
 *
 * 4. HARD_HEADED_RESISTANT       — Super-resistant person demands removal / calls it a pitch
 *    Validates: formal, graceful de-escalation, no selling, acknowledges frustration
 *
 * Runs direct OpenAI calls using the same system prompts deployed to live n8n workflows.
 */
"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../src/.env.render") });
const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY in env");
  process.exit(1);
}

// ── Load live knowledge corpus (same as deployed) ─────────────────────────

const SUPPORT_KB_PATH = path.join(__dirname, "../src/support-knowledge-base.json");
const SUPPORT_FAQ_PATH = path.join(__dirname, "../src/support-knowledge-faq.json");

function loadKnowledgeBlock() {
  try {
    const kb = JSON.parse(fs.readFileSync(SUPPORT_KB_PATH, "utf8"));
    if (!kb || !Array.isArray(kb.sources)) return "(knowledge base unavailable)";
    const lines = ["Approved source corpus (website + guides):"];
    for (const source of kb.sources) {
      const title = String(source.title || source.key || "Source").trim();
      const url = String(source.url || "").trim();
      lines.push(`- ${title}${url ? ` (${url})` : ""}`);
      for (const fact of (source.facts || [])) {
        const f = String(fact || "").trim();
        if (f) lines.push(`  - ${f}`);
      }
    }
    const linkMap = kb.link_map && typeof kb.link_map === "object" ? kb.link_map : {};
    const linkEntries = Object.entries(linkMap).map(([k, v]) => `- ${k}: ${v}`);
    if (linkEntries.length) {
      lines.push("Approved public links by type:");
      lines.push(...linkEntries);
    }
    return lines.join("\n");
  } catch (e) {
    return "(knowledge base unavailable)";
  }
}

function loadFaqBlock() {
  try {
    const faq = JSON.parse(fs.readFileSync(SUPPORT_FAQ_PATH, "utf8"));
    if (!faq || !Array.isArray(faq.faq)) return "(FAQ unavailable)";
    const lines = ["Expanded FAQ corpus:"];
    for (const item of faq.faq) {
      const q = String(item.question || "").trim();
      const a = String(item.answer || "").trim();
      if (q && a) lines.push(`- Q: ${q}\n  A: ${a}`);
    }
    return lines.join("\n");
  } catch (e) {
    return "(FAQ unavailable)";
  }
}

const knowledgeBlock = loadKnowledgeBlock();
const faqBlock = loadFaqBlock();

// ── System prompts (identical to deployed versions) ───────────────────────

const OUTREACH_SYSTEM = `You write concise, human outreach replies for coach conversations. The sender is personal, mission-driven, and sounds like a real person, not a sales rep. Hard tone rule: outreach must be VERY CASUAL — conversational, plain English, like texting a colleague. No corporate polish, no formal greetings, no structured paragraphs. Return JSON with v1,v2,v3 each containing subject and body.`;

const SUPPORT_SYSTEM = `You are NIL Wealth Strategies' support specialist. You draft clear, source-backed replies for athletes, parents, and coaches.

HARD TONE RULE: Support replies must be FORMAL — professional, complete sentences, organized, warm but polished. Never casual, never slang, never text-message style.

Use only the source corpus below and the inbound email. If the message asks for something not covered here, say NIL Wealth can clarify directly. Do not invent statistics, client counts, pricing, underwriting approvals, guarantees, or school endorsements.

Hard framing rules:
- Default framing must be high school athletes and their families.
- Supplemental health responses must be framed as high-school-family education by default.
- Do not mention NIL unless the sender explicitly asks about NIL.
- If NIL is explicitly asked, explain clearly and briefly as future-readiness context.

${knowledgeBlock}

${faqBlock}

Guide recommendation rules:
- Recommend parent-guide when the sender sounds like a coach or parent asking for something forwardable to a family.
- Recommend supplemental-health-guide when the sender asks what the coverage is, how it works, what it pays, or whether it replaces health insurance.
- Recommend risk-awareness-guide when the sender is asking broader high-school athlete risk-management questions.
- Recommend tax-education-guide when the sender asks about tax basics, 1099s, deductions, or estimated payments.
- If no guide is truly helpful, recommend no link.

Output format — use these exact uppercase headers:
NO_LINK_VERSION:
<reply body only, under 170 words>

LINK_VERSION:
<same answer, naturally references the guide and includes exactly one plain public link if a guide is genuinely helpful>

RECOMMENDATION:
include_link=yes|no
recommended_guide=parent-guide|supplemental-health-guide|risk-awareness-guide|tax-education-guide|none

Style rules:
- Warm, direct, and human.
- Specific to the sender's actual question.
- No greeting line and no sign-off.
- No bullet lists unless the question clearly needs a short list.
- Never mention internal systems, tracking, campaigns, or bots.`;

const SUPPORT_OBJECTION_APPENDIX = `

Objection and de-escalation rules:
- If the sender pushes back (for example says they already have insurance or questions the need), the first sentence must explicitly acknowledge their concern with plain wording (for example: "I understand your concern" or "That is a fair question").
- In objection replies, include at least one explicit no-pressure door-open line near the end (for example: "No pressure, and if helpful I am happy to answer questions.").
- If the sender asks to stop contact or be removed, confirm removal clearly and do not recommend a guide or link (include_link=no and recommended_guide=none).
`;

// ── OpenAI helper ─────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userPrompt, jsonMode = false) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "";
  return content;
}

// ── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, value, rule) {
  const ok = rule(value);
  const icon = ok ? "  ✅" : "  ❌";
  if (ok) passed++; else failed++;
  console.log(`${icon} ${label}`);
  if (!ok) {
    const snippet = String(value || "").slice(0, 200).replace(/\n/g, " ");
    console.log(`       GOT: ${snippet}…`);
  }
}

function notContains(value, ...terms) {
  const lower = String(value || "").toLowerCase();
  return !terms.some((t) => lower.includes(t.toLowerCase()));
}

function contains(value, ...terms) {
  const lower = String(value || "").toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

function wordCount(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// ── SCENARIO 1: Outreach coach interest ──────────────────────────────────

async function runOutreachCoachInterest() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 1 — OUTREACH_COACH_INTEREST");
  console.log("  Person: Coach Marcus Johnson (Riverside High School, Football)");
  console.log("  Channel: Outreach / Instantly reply — programs lane");
  console.log("  Situation: Coach replied to initial outreach positively, wants more info");
  console.log("──────────────────────────────────────────────────────────────");

  const prompt = JSON.stringify({
    contact_email: "m.johnson@riversidehigh.edu",
    subject: "NIL Wealth Protection for Your Athletes",
    preview: "Hey, this looks interesting. We coach about 60 kids, a handful already have brand deals.",
    latest_inbound: "Hey, this actually looks interesting. We coach about 60 kids at Riverside High — a handful already have some brand deals going. What does this look like practically for families? Is there something I can forward to parents at the start of the season?",
    coach_name: "Coach Marcus Johnson",
    source: "outreach",
    parent_guide_link: "https://parentsguide.mynilwealthstrategies.com/",
  });

  const userPrompt = `Create 3 follow-up reply drafts for this Programs conversation:\n${prompt}\n\nRules:\n- This is a manual reply in an ongoing outreach thread after the coach already answered\n- Outreach tone must feel personal, natural, and human, not corporate, polished, or salesy\n- Sound like a real person talking to a coach in plain English\n- Briefly explain what I do, why I do it, and my personal background: I went through 3 surgeries, had financial help, and saw how out-of-pocket costs can stack for families\n- Keep that explanation short and conversational, not a speech\n- If the inbound message is a smooth/open reply, answer the question directly and keep momentum\n- If the inbound message is an objection, acknowledge it first, reduce pressure, and give an easy next step\n- Do not suggest calls, meetings, or calendar invites unless the inbound message explicitly asks for a phone call or meeting\n- If no explicit meeting request exists, the next step should be a simple reply, clarification, or short forwardable resource\n- Keep under 110 words\n- Include one clear next step\n- Do not mention AI\n- Do not invent specific counts (athletes, clients, families, teams, enrollments) unless the count is explicitly provided in the prompt\n- Avoid generic phrases like "valuable insights," "numerous teams," "unforeseen circumstances," or "navigate this complex topic"\nReturn: {"v1":{"subject":"...","body":"..."},"v2":{...},"v3":{...}}`;

  const rawContent = await callOpenAI(OUTREACH_SYSTEM, userPrompt, true);
  const parsed = JSON.parse(rawContent);
  const v2 = parsed?.v2?.body || "";

  console.log(`\n  AI OUTPUT (V2 selected for validation):\n`);
  console.log(`  Subject: ${parsed?.v2?.subject || "(none)"}`);
  console.log(`  Body:\n${v2.split("\n").map(l => "  " + l).join("\n")}`);
  console.log(`\n  CHECKS:`);

  check("No 'Dear [Name]' formal greeting", v2, (v) => notContains(v, "dear "));
  check("No 'I hope this email finds you'", v2, (v) => notContains(v, "i hope this email", "i hope this finds you"));
  check("No 'sincerely' or 'best regards'", v2, (v) => notContains(v, "sincerely,", "best regards,", "kind regards,"));
  check("No meeting/calendar push (unrequested)", v2, (v) => notContains(v, "schedule a call", "book a time", "calendar", "set up a meeting", "let's hop on"));
  check("No NIL mention (no NIL asked)", v2, (v) => notContains(v, "nil income", "nil earnings", "nil tax", "nil deal", "nil revenue"));
  check("Under 130 words", v2, (v) => wordCount(v) <= 130);
  check("Has a clear next step", v2, (v) => contains(v, "send", "forward", "reply", "let me know", "share", "happy to"));
  check("Does NOT mention AI", v2, (v) => notContains(v, "ai", "chatgpt", "generated", "automated"));
  check("Mentions personal background naturally", v2, (v) => contains(v, "surg", "out-of-pocket", "cost", "personal", "family"));
}

// ── SCENARIO 2: Parent website question ──────────────────────────────────

async function runParentWebsiteQuestion() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 2 — PARENT_WEBSITE_QUESTION");
  console.log("  Person: Jessica Rivera (parent, emailed from website contact form)");
  console.log("  Channel: Support / Gmail watch — WF02");
  console.log("  Situation: Parent asks if coverage is optional and if it replaces their insurance");
  console.log("──────────────────────────────────────────────────────────────");

  const userPrompt = `Draft a NIL Wealth support reply using the source-backed support framework below.

Inbound sender: Jessica Rivera <jessica.rivera@familyemail.com>
Subject: Question about the supplemental health program
Message:
Hi, my son plays varsity soccer at Lincoln High School. I came across your website and had a couple questions. Is this supplemental coverage something we have to sign up for, or is it completely optional? And does signing up mean we drop our regular family health insurance? We have Blue Cross Blue Shield and I want to make sure we're not replacing that.

Return two versions plus a recommendation block.`;

  const rawContent = await callOpenAI(`${SUPPORT_SYSTEM}\n${SUPPORT_OBJECTION_APPENDIX}`, userPrompt, false);

  // Extract NO_LINK_VERSION block — stop at LINK_VERSION or RECOMMENDATION
  const noLinkMatch = rawContent.match(/NO_LINK_VERSION:\s*([\s\S]*?)(?=\n{0,3}LINK_VERSION:|\n{0,3}RECOMMENDATION:|$)/i);
  const noLinkBody = noLinkMatch ? noLinkMatch[1].trim() : rawContent.trim();

  const recommendMatch = rawContent.match(/RECOMMENDATION:\s*([\s\S]*?)$/i);
  const recommendation = recommendMatch ? recommendMatch[1].trim() : "";

  console.log(`\n  AI OUTPUT (NO_LINK_VERSION):\n`);
  console.log(noLinkBody.split("\n").map(l => "  " + l).join("\n"));
  console.log(`\n  RECOMMENDATION: ${recommendation}`);
  console.log(`\n  CHECKS:`);

  check("FORMALLY written — not casual/slang", noLinkBody, (v) => notContains(v, "hey ", "yeah,", "nope", "super easy", "totally "));
  check("No 'Hi,' or 'Hello,' greeting opener", noLinkBody, (v) => !(/^(hi|hello|hey|dear)\b/i.test(v.trim())));
  check("States coverage is OPTIONAL", noLinkBody, (v) => contains(v, "optional", "not required", "family-driven", "your choice", "no requirement", "you decide"));
  check("States it does NOT replace major medical", noLinkBody, (v) => contains(v, "does not replace", "supplement", "alongside", "not a replacement", "works with", "in addition"));
  check("No NIL mention (parent never asked)", noLinkBody, (v) => notContains(v, "nil income", "nil earnings", "nil tax", "nil deal"));
  check("Under 180 words", noLinkBody, (v) => wordCount(v) <= 180);
  check("Recommends supplemental-health-guide or parent-guide", recommendation, (v) => contains(v, "supplemental-health-guide", "parent-guide"));
}

// ── SCENARIO 3: Objection and conquering it ───────────────────────────────

async function runObjectionConquest() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 3 — OBJECTION_CONQUEST");
  console.log("  Person: David Collins (parent, previously engaged via coach forward)");
  console.log("  Channel: Support / Gmail watch — WF02");
  console.log("  Situation: Parent pushes back — 'we already have insurance, don't see the need'");
  console.log("──────────────────────────────────────────────────────────────");

  const userPrompt = `Draft a NIL Wealth support reply using the source-backed support framework below.

Inbound sender: David Collins <david.collins@gmail.com>
Subject: Re: NIL Wealth Resources for Lincoln High Families
Message:
I appreciate the email but I don't really see the point here. My son already has school athletic coverage through his high school AND we have full family coverage through Aetna. It sounds like you're trying to get us to add another insurance product we just don't need. We're pretty well covered. Can you explain what gap this is even filling?

Return two versions plus a recommendation block.`;

  const rawContent = await callOpenAI(`${SUPPORT_SYSTEM}\n${SUPPORT_OBJECTION_APPENDIX}`, userPrompt, false);

  const noLinkMatch = rawContent.match(/NO_LINK_VERSION:\s*([\s\S]*?)(?:\n\n?LINK_VERSION:|$)/i);
  const noLinkBody = noLinkMatch ? noLinkMatch[1].trim() : rawContent.trim();

  const recommendMatch = rawContent.match(/RECOMMENDATION:\s*([\s\S]*?)$/i);
  const recommendation = recommendMatch ? recommendMatch[1].trim() : "";

  console.log(`\n  AI OUTPUT (NO_LINK_VERSION):\n`);
  console.log(noLinkBody.split("\n").map(l => "  " + l).join("\n"));
  console.log(`\n  RECOMMENDATION: ${recommendation}`);
  console.log(`\n  CHECKS:`);

  check("Formal tone — complete sentences", noLinkBody, (v) => notContains(v, "hey ", "nope", "totally", "yeah,"));
  check("Acknowledges the objection / their concern", noLinkBody, (v) => contains(v, "understand", "valid", "makes sense", "that's fair", "appreciate", "great question", "fair point"));
  check("Explains deductibles/copays/gap concept", noLinkBody, (v) => contains(v, "deductible", "copay", "coinsurance", "gap", "out-of-pocket", "supplement", "alongside", "in addition"));
  check("States it does NOT replace existing coverage", noLinkBody, (v) => contains(v, "not replace", "supplement", "additional", "alongside", "works with"));
  check("No high-pressure language", noLinkBody, (v) => notContains(v, "you must", "you need to", "don't miss", "limited time", "act now", "urgent"));
  check("Leaves door open without pressure", noLinkBody, (v) => contains(v, "no pressure", "happy to help", "if you", "at your own", "whenever", "feel free", "up to you", "your pace", "whenever you", "happy to answer"));
  check("No NIL push (parent never asked)", noLinkBody, (v) => notContains(v, "nil income", "nil earnings", "nil deal"));
}

// ── SCENARIO 4: Hard-headed / resistant ──────────────────────────────────

async function runHardHeadedResistant() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 4 — HARD_HEADED_RESISTANT");
  console.log("  Person: Bobby Torres (super resistant, annoyed, demands to be left alone)");
  console.log("  Channel: Support / Gmail watch — WF02");
  console.log("  Situation: Extremely resistant — calls it a sales pitch, demands removal");
  console.log("──────────────────────────────────────────────────────────────");

  const userPrompt = `Draft a NIL Wealth support reply using the source-backed support framework below.

Inbound sender: Bobby Torres <b.torres@me.com>
Subject: Re: NIL Wealth Resources — STOP emailing us
Message:
Look, I've gotten three of these emails now and I'm pretty annoyed. This is clearly just a sales pitch wrapped up in educational language. We don't need it, we're not interested, and I'd really like to be removed from whatever list we're on. This is not something I want to hear about again. My kid plays basketball and we handle our own finances. Don't contact us again.

Return two versions plus a recommendation block.`;

  const rawContent = await callOpenAI(`${SUPPORT_SYSTEM}\n${SUPPORT_OBJECTION_APPENDIX}`, userPrompt, false);

  // Extract NO_LINK_VERSION block — stop at LINK_VERSION or RECOMMENDATION
  const noLinkMatch = rawContent.match(/NO_LINK_VERSION:\s*([\s\S]*?)(?=\n{0,3}LINK_VERSION:|\n{0,3}RECOMMENDATION:|$)/i);
  const noLinkBody = noLinkMatch ? noLinkMatch[1].trim() : rawContent.trim();

  const recommendMatch = rawContent.match(/RECOMMENDATION:\s*([\s\S]*?)$/i);
  const recommendation = recommendMatch ? recommendMatch[1].trim() : "";

  console.log(`\n  AI OUTPUT (NO_LINK_VERSION):\n`);
  console.log(noLinkBody.split("\n").map(l => "  " + l).join("\n"));
  console.log(`\n  RECOMMENDATION: ${recommendation}`);
  console.log(`\n  CHECKS:`);

  check("Formal tone — not casual or defensive", noLinkBody, (v) => notContains(v, "hey ,", "look, ", "yeah,", "absolutely, yeah", "super sorry"));
  check("Acknowledges frustration respectfully", noLinkBody, (v) => contains(v, "understand", "apologize", "sorry", "frustration", "hear", "appreciate", "regret", "sincerely", "caused any"));
  check("Does NOT try to re-sell or push product", noLinkBody, (v) => notContains(v, "let me explain", "actually if you", "just to clarify the value", "you might want to reconsider", "before you decide"));
  check("Confirms removal / opt-out action or offers it", noLinkBody, (v) => contains(v, "remov", "opt out", "unsubscribe", "no further", "not contact", "stop", "take you off", "off our", "mailing list"));
  check("No high-pressure close attempt", noLinkBody, (v) => notContains(v, "don't miss out", "limited time", "before you go", "just one more thing", "worth considering"));
  check("Leaves door open without pressure (optional check)", noLinkBody, (v) =>
    contains(v, "if you ever", "if anything changes", "happy to help", "should you", "if you'd like", "all the best", "wish you")
    || notContains(v, "you must", "act now", "do not wait")
  );
  check("No NIL push (never asked)", noLinkBody, (v) => notContains(v, "nil income", "nil earnings", "nil deal"));
  check("RECOMMENDATION is 'none' (not appropriate to push a guide)", recommendation, (v) => contains(v, "recommended_guide=none") || contains(v, "include_link=no"));
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(62));
  console.log("  NIL WEALTH — SCENARIO TONE TESTS");
  console.log("  Validates 4 named real-world AI behavior scenarios");
  console.log("  Using live system prompts + knowledge corpus");
  console.log("═".repeat(62));

  try {
    await runOutreachCoachInterest();
  } catch (e) {
    console.error("  SCENARIO 1 ERROR:", e.message);
    failed++;
  }

  try {
    await runParentWebsiteQuestion();
  } catch (e) {
    console.error("  SCENARIO 2 ERROR:", e.message);
    failed++;
  }

  try {
    await runObjectionConquest();
  } catch (e) {
    console.error("  SCENARIO 3 ERROR:", e.message);
    failed++;
  }

  try {
    await runHardHeadedResistant();
  } catch (e) {
    console.error("  SCENARIO 4 ERROR:", e.message);
    failed++;
  }

  const total = passed + failed;
  console.log("\n" + "═".repeat(62));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${total} checks`);
  console.log("═".repeat(62) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
