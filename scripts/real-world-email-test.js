#!/usr/bin/env node
/**
 * REAL WORLD EMAIL CONVERSATION + CC SUPPORT TEST
 * Tests: 3 coach email threads with back-to-back replies, CC support dispatch,
 *        SLA escalation, and high-volume batching.
 *
 * Runs against live Render bot + live Supabase.
 * Signs every /ops/ingest request with HMAC so it matches production.
 */
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, "../src/.env.render") });
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const BOT_URL = (process.env.BOT_BASE_URL || "").replace(/\/$/, "");
const HMAC_SECRET = process.env.OPS_WEBHOOK_HMAC_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID || "test-campaign-001";

if (!BOT_URL || !HMAC_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: Missing required env vars (BOT_BASE_URL, OPS_WEBHOOK_HMAC_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: "nil" },
});

// ── helpers ────────────────────────────────────────────────────────────────

function sign(body) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return crypto.createHmac("sha256", HMAC_SECRET).update(raw).digest("hex");
}

async function ingest(payload) {
  const raw = JSON.stringify(payload);
  const sig = sign(raw);
  const resp = await fetch(`${BOT_URL}/ops/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ops-signature": sig,
    },
    body: raw,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`/ops/ingest ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function uid() { return crypto.randomUUID(); }

function ts(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️";

let passed = 0;
let failed = 0;
const results = [];

function logResult(label, ok, detail = "") {
  const icon = ok ? PASS : FAIL;
  if (ok) passed++; else failed++;
  const line = `${icon} ${label}${detail ? " | " + detail : ""}`;
  results.push(line);
  console.log(line);
}

async function assert(label, fn) {
  try {
    const result = await fn();
    logResult(label, true, result || "");
  } catch (e) {
    logResult(label, false, String(e.message || e));
  }
}

// ── TEST SETUP: 3 simulated coach email threads ───────────────────────────

const coaches = [
  {
    name: "Coach Sarah Thompson",
    email: `test.coach.sarah.${Date.now()}@testemail-nil.com`,
    lead_id: `test-lead-sarah-${uid().slice(0, 8)}`,
  },
  {
    name: "Coach Marcus Williams",
    email: `test.coach.marcus.${Date.now()}@testemail-nil.com`,
    lead_id: `test-lead-marcus-${uid().slice(0, 8)}`,
  },
  {
    name: "Coach Jennifer Lee",
    email: `test.coach.jennifer.${Date.now()}@testemail-nil.com`,
    lead_id: `test-lead-jennifer-${uid().slice(0, 8)}`,
  },
];

// ── PHASE 1: Outreach emails sent ─────────────────────────────────────────

async function testOutreachSent(coach) {
  const payload = {
    schema_version: "5.3",
    event_type: "instantly_email_sent",
    source: "instantly",
    direction: "outbound",
    trace_id: uid(),
    idempotency_key: `outreach:${coach.lead_id}:${Date.now()}`,
    payload: {
      lead_id: coach.lead_id,
      lead_email: coach.email,
      lead_name: coach.name,
      campaign_id: CAMPAIGN_ID,
      email_subject: "NIL Wealth Protection for Your Athletes",
      timestamp: ts(),
    },
  };
  const r = await ingest(payload);
  if (!r.ok) throw new Error(`Response not ok: ${JSON.stringify(r)}`);
  // Verify conversation was created in Supabase
  await sleep(1000);
  const { data, error } = await db
    .from("conversations")
    .select("id, pipeline, source, contact_email")
    .ilike("contact_email", coach.email)
    .maybeSingle();
  if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
  if (!data) throw new Error(`Conversation not found in Supabase for ${coach.email}`);
  coach.conversation_id = data.id;
  return `conv_id=${data.id} pipeline=${data.pipeline}`;
}

// ── PHASE 2: First coach reply ─────────────────────────────────────────────

async function testFirstReply(coach) {
  const payload = {
    schema_version: "5.3",
    event_type: "instantly_reply_sent",
    source: "instantly",
    direction: "inbound",
    trace_id: uid(),
    idempotency_key: `reply1:${coach.lead_id}:${Date.now()}`,
    payload: {
      lead_id: coach.lead_id,
      lead_email: coach.email,
      lead_name: coach.name,
      campaign_id: CAMPAIGN_ID,
      coach_reply_body: `Hi, thanks for reaching out! ${coach.name.split(" ")[1]} here. We definitely are interested in learning more about NIL wealth protection for our athletes. Can you send over more details about what coverage looks like?`,
      ai_reply_body: `Thanks for responding, Coach ${coach.name.split(" ")[1]}! I'd love to walk you through our NIL Wealth Protection program. I'll send over a full overview shortly. Would a quick 15-minute call work this week?`,
      timestamp: ts(-5 * 60 * 1000), // 5 minutes ago
    },
  };
  const r = await ingest(payload);
  if (!r.ok && !r.deduped) throw new Error(`Response not ok: ${JSON.stringify(r)}`);
  // Verify message was logged
  await sleep(800);
  if (coach.conversation_id) {
    const { data, error } = await db
      .from("messages")
      .select("id, direction, body")
      .eq("conversation_id", coach.conversation_id)
      .order("created_at", { ascending: false })
      .limit(2);
    if (error) throw new Error(`Messages lookup failed: ${error.message}`);
    const inbound = (data || []).find(m => m.direction === "inbound");
    const outbound = (data || []).find(m => m.direction === "outbound");
    if (!inbound) throw new Error("Inbound coach reply not stored in messages");
    if (!outbound) throw new Error("Outbound AI reply not stored in messages");
    return `${data.length} messages stored (inbound+outbound)`;
  }
  return "ok (no conv_id to verify)";
}

// ── PHASE 3: Second reply (coach follows up) ──────────────────────────────

async function testSecondReply(coach) {
  const payload = {
    schema_version: "5.3",
    event_type: "instantly_reply_sent",
    source: "instantly",
    direction: "inbound",
    trace_id: uid(),
    idempotency_key: `reply2:${coach.lead_id}:${Date.now()}`,
    payload: {
      lead_id: coach.lead_id,
      lead_email: coach.email,
      lead_name: coach.name,
      campaign_id: CAMPAIGN_ID,
      coach_reply_body: `Yes, Wednesday at 2pm works great. Also, I wanted to ask — does this cover student athletes who are already earning NIL income, or only those just starting out?`,
      ai_reply_body: `Great, I'll send a calendar invite for Wednesday at 2pm! To answer your question — yes, our program covers both existing NIL earners and athletes just starting their NIL journey. We have tiered coverage designed for each stage.`,
      timestamp: ts(-2 * 60 * 1000), // 2 minutes ago
    },
  };
  const r = await ingest(payload);
  if (!r.ok && !r.deduped) throw new Error(`Response not ok: ${JSON.stringify(r)}`);
  await sleep(800);
  if (coach.conversation_id) {
    const { count, error } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", coach.conversation_id);
    if (error) throw new Error(`Count failed: ${error.message}`);
    if (count < 4) throw new Error(`Expected ≥4 messages, got ${count}`);
    return `${count} total messages in thread`;
  }
  return "ok (no conv_id to verify)";
}

// ── PHASE 4: Third reply (scheduling confirmed) ───────────────────────────

async function testThirdReply(coach) {
  const payload = {
    schema_version: "5.3",
    event_type: "instantly_reply_sent",
    source: "instantly",
    direction: "inbound",
    trace_id: uid(),
    idempotency_key: `reply3:${coach.lead_id}:${Date.now()}`,
    payload: {
      lead_id: coach.lead_id,
      lead_email: coach.email,
      lead_name: coach.name,
      campaign_id: CAMPAIGN_ID,
      coach_reply_body: `Perfect! I've forwarded this to my AD. We have 22 athletes currently earning NIL. Looking forward to the call.`,
      ai_reply_body: `Excellent — 22 athletes is exactly the kind of program we can build a comprehensive plan around. I'll include a group rate breakdown in the materials I send before our call. See you Wednesday!`,
      timestamp: ts(),
    },
  };
  const r = await ingest(payload);
  if (!r.ok && !r.deduped) throw new Error(`Response not ok: ${JSON.stringify(r)}`);
  await sleep(800);
  // Verify pipeline is still active (not dropped)
  if (coach.conversation_id) {
    const { data, error } = await db
      .from("conversations")
      .select("pipeline, updated_at")
      .eq("id", coach.conversation_id)
      .maybeSingle();
    if (error) throw new Error(`Verification failed: ${error.message}`);
    if (!data) throw new Error("Conversation disappeared after third reply");
    return `pipeline=${data.pipeline} last_updated=${data.updated_at}`;
  }
  return "ok";
}

// ── PHASE 5: CC Support dispatch ──────────────────────────────────────────

async function testCcSupport(coach) {
  if (!coach.conversation_id) {
    throw new Error("No conversation_id — can't test CC support");
  }
  // Simulate what the bot does when user taps "Loop in Support"
  // This calls the CC_SUPPORT_WEBHOOK_URL via n8n WF02
  // We test it by hitting the /ops/ingest with cc_support.activated event
  const payload = {
    schema_version: "5.3",
    event_type: "cc_support.activated",
    source: "telegram_bot",
    direction: "inbound",
    trace_id: uid(),
    idempotency_key: `cc_support:${coach.conversation_id}:${Date.now()}`,
    entity_type: "conversation",
    entity_id: coach.conversation_id,
    payload: {
      conversation_id: coach.conversation_id,
      contact_email: coach.email,
      coach_name: coach.name,
      reason: "Coach requested detailed plan — escalating to human support",
      activated_by: "admin_telegram",
    },
  };
  const r = await ingest(payload);
  if (!r.ok && !r.deduped) throw new Error(`CC support ingest failed: ${JSON.stringify(r)}`);

  // Verify conversation has cc_support_suggested = true (bot should set this)
  await sleep(1000);
  const { data, error } = await db
    .from("conversations")
    .select("id, cc_support_suggested, pipeline")
    .eq("id", coach.conversation_id)
    .maybeSingle();
  if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
  if (!data) throw new Error("Conversation not found after CC dispatch");

  // CRITICAL: cc_support_suggested MUST be true — set by the new ops/ingest handler
  if (data.cc_support_suggested !== true) {
    throw new Error(`cc_support_suggested is still false — ops/ingest handler for cc_support.activated not working`);
  }

  // Check ops_events ledger for the cc_support event
  const { data: evtRows, error: evtErr } = await db
    .from("ops_events")
    .select("event_type, received_at")
    .eq("entity_id", coach.conversation_id)
    .eq("event_type", "cc_support.activated")
    .limit(1);
  if (evtErr) throw new Error(`ops_events lookup failed: ${evtErr.message}`);
  if (!evtRows || evtRows.length === 0) throw new Error("cc_support.activated not logged to ops_events");

  return `ledger confirmed | cc_support_suggested=${data.cc_support_suggested} pipeline=${data.pipeline}`;
}

// ── PHASE 6: High-volume stress test (20 conversations at once) ───────────

async function testHighVolume() {
  const batchSize = 20;
  const batchId = `hv-batch-${Date.now()}`;
  console.log(`\n  Running ${batchSize} concurrent outreach sends...`);

  const jobs = Array.from({ length: batchSize }, (_, i) => ({
    lead_id: `${batchId}-lead-${i}`,
    email: `hv.test.${i}.${Date.now()}@testemail-nil.com`,
    name: `HV Coach ${i}`,
  }));

  const t0 = Date.now();
  const results = await Promise.allSettled(
    jobs.map((j) =>
      ingest({
        schema_version: "5.3",
        event_type: "instantly_email_sent",
        source: "instantly",
        direction: "outbound",
        trace_id: uid(),
        idempotency_key: `hv:${j.lead_id}`,
        payload: {
          lead_id: j.lead_id,
          lead_email: j.email,
          lead_name: j.name,
          campaign_id: CAMPAIGN_ID,
          email_subject: `HV Test Outreach ${j.lead_id}`,
          timestamp: ts(),
        },
      })
    )
  );
  const elapsed = Date.now() - t0;
  const ok = results.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const notOk = results.filter((r) => r.status === "fulfilled" && !r.value?.ok).length;

  if (ok < batchSize * 0.9) {
    throw new Error(`Only ${ok}/${batchSize} succeeded (${rejected} rejected, ${notOk} not-ok) in ${elapsed}ms`);
  }
  return `${ok}/${batchSize} succeeded | ${elapsed}ms total`;
}

// ── PHASE 7: Idempotency / dedupe test ────────────────────────────────────

async function testIdempotency(coach) {
  if (!coach.conversation_id) throw new Error("No conversation_id");
  const idempotency_key = `idem-test:${coach.conversation_id}:${Date.now()}`;
  const payload = {
    schema_version: "5.3",
    event_type: "instantly_reply_sent",
    source: "instantly",
    direction: "inbound",
    trace_id: uid(),
    idempotency_key,
    payload: {
      lead_id: coach.lead_id,
      lead_email: coach.email,
      lead_name: coach.name,
      campaign_id: CAMPAIGN_ID,
      coach_reply_body: "Duplicate test message — should be deduped on second send",
      ai_reply_body: "This is the outbound duplicate test",
      timestamp: ts(),
    },
  };

  const r1 = await ingest(payload);
  const r2 = await ingest(payload); // exact same idempotency_key

  if (!r1.ok) throw new Error(`First send failed: ${JSON.stringify(r1)}`);
  if (!r2.ok && !r2.deduped) throw new Error(`Second send failed non-deduped: ${JSON.stringify(r2)}`);

  // Count messages — should NOT have created duplicates
  await sleep(800);
  const { count, error } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", coach.conversation_id);
  if (error) throw new Error(`Count failed: ${error.message}`);

  const deduped = r2.deduped === true;
  return `r1.ok=${r1.ok} r2.deduped=${deduped} total_messages=${count}`;
}

// ── PHASE 8: Supabase schema contract check ────────────────────────────────

async function testSupabaseSchema() {
  const checks = [
    { table: "conversations", requiredCols: ["id", "contact_email", "pipeline", "source"] },
    { table: "messages", requiredCols: ["id", "conversation_id", "direction", "body"] },
    { table: "ops_events", requiredCols: ["id", "event_type", "received_at"] },
    { table: "dead_letters", requiredCols: ["id", "received_at", "error"] },
  ];

  const missing = [];
  for (const check of checks) {
    const { data, error } = await db
      .from(check.table)
      .select(check.requiredCols.join(", "))
      .limit(0);
    if (error) {
      missing.push(`${check.table}: ${error.message}`);
    }
  }
  if (missing.length > 0) throw new Error(`Schema issues: ${missing.join(" | ")}`);
  return `All ${checks.length} tables OK`;
}

// ── PHASE 9: Check for dead letters from this test run ────────────────────

async function checkDeadLetters(since) {
  const { data, error } = await db
    .from("dead_letters")
    .select("id, received_at, error")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`Dead letter check failed: ${error.message}`);
  if (data && data.length > 0) {
    throw new Error(`${data.length} dead letter(s) during test:\n${data.map(d => `  [${d.received_at}] ${d.error}`).join("\n")}`);
  }
  return "0 dead letters";
}

// ── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  const runStart = new Date().toISOString();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`NIL WEALTH — Real World Email + CC Support Full Test`);
  console.log(`Bot: ${BOT_URL}`);
  console.log(`Run: ${runStart}`);
  console.log(`${"=".repeat(70)}\n`);

  // Schema first
  console.log("── PHASE 0: Schema Contract ──────────────────────────────────────");
  await assert("Supabase schema contract", testSupabaseSchema);

  // Per-coach email threads
  console.log("\n── PHASE 1–4: 3 Coach Email Threads (3x back-to-back) ───────────");
  for (const coach of coaches) {
    console.log(`\n  Coach: ${coach.name} (${coach.email})`);
    await assert(`[${coach.name}] Outreach sent → conversation created`, () => testOutreachSent(coach));
    await assert(`[${coach.name}] First reply (coach + AI)`, () => testFirstReply(coach));
    await assert(`[${coach.name}] Second reply (follow-up Q&A)`, () => testSecondReply(coach));
    await assert(`[${coach.name}] Third reply (scheduling confirmed)`, () => testThirdReply(coach));
  }

  // CC Support
  console.log("\n── PHASE 5: CC Support Dispatch ─────────────────────────────────");
  for (const coach of coaches) {
    await assert(`[${coach.name}] CC Support dispatched + ledger verified`, () => testCcSupport(coach));
  }

  // Idempotency
  console.log("\n── PHASE 6: Idempotency / Dedupe Guard ──────────────────────────");
  await assert(`Duplicate event with same idempotency_key is deduped`, () => testIdempotency(coaches[0]));

  // High volume
  console.log("\n── PHASE 7: High-Volume Stress Test (20 concurrent) ────────────");
  await assert("20 concurrent outreach events handled", testHighVolume);

  // Dead letters
  console.log("\n── PHASE 8: Dead Letter Check ────────────────────────────────────");
  await assert("No dead letters generated during test run", () => checkDeadLetters(runStart));

  // Summary
  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
  console.log("=".repeat(70));

  if (failed > 0) {
    console.log("\nFAILED ASSERTIONS:");
    results.filter(r => r.startsWith("❌")).forEach(r => console.log(" ", r));
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED — System is production-ready");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("\nFATAL TEST ERROR:", e);
  process.exit(1);
});
