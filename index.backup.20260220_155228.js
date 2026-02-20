require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);
const BASE_WEBHOOK_SECRET = process.env.BASE_WEBHOOK_SECRET || "";

const MAKE_SEND_WEBHOOK_URL = process.env.MAKE_SEND_WEBHOOK_URL || ""; // optional now

// Supabase (server only)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180);
const URGENT_SNOOZE_HOURS = Number(process.env.URGENT_SNOOZE_HOURS || 2);
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72);

const AUTO_COMPLETE_HOT_DAYS = Number(process.env.AUTO_COMPLETE_HOT_DAYS || 30);
const AUTO_COMPLETE_WARM_DAYS = Number(process.env.AUTO_COMPLETE_WARM_DAYS || 21);
const AUTO_COMPLETE_COLD_DAYS = Number(process.env.AUTO_COMPLETE_COLD_DAYS || 14);

// -------------------- GUARDS --------------------
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}
if (!BASE_WEBHOOK_SECRET) {
  console.error("Missing BASE_WEBHOOK_SECRET in .env (set a random string)");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// -------------------- SUPABASE --------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------- HELPERS --------------------
function nowMs() {
  return Date.now();
}

function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true;
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function shorten(s, n = 140) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function verifyWebhookSecret(req) {
  const got = req.headers["x-nil-secret"];
  return got && String(got) === String(BASE_WEBHOOK_SECRET);
}

// -------------------- DB wrappers (ops schema) --------------------
async function getSetting(key, fallback = "0") {
  const { data, error } = await supabase
    .schema("ops")
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) return fallback;
  return data?.value ?? fallback;
}

async function setSetting(key, value) {
  await supabase
    .schema("ops")
    .from("settings")
    .upsert({ key, value: String(value) }, { onConflict: "key" });
}

async function insertUndo(action, payloadObj) {
  const { data } = await supabase
    .schema("ops")
    .from("undo_log")
    .insert({ action, payload: payloadObj })
    .select("id")
    .single();
  return data?.id || null;
}

async function popUndo(id) {
  const { data, error } = await supabase
    .schema("ops")
    .from("undo_log")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;

  await supabase.schema("ops").from("undo_log").delete().eq("id", id);
  return { action: data.action, payload: data.payload };
}

async function getQueueCounts() {
  const { data } = await supabase.schema("ops").from("v_queue_counts").select("*");
  const map = {};
  (data || []).forEach((r) => (map[r.pipeline] = Number(r.count || 0)));
  return map;
}

async function getCompanyMetrics() {
  const { data } = await supabase.schema("ops").from("v_company_metrics").select("*").maybeSingle();
  return (
    data || {
      program_link_opens: 0,
      coverage_explores: 0,
      enroll_clicks: 0,
      eapp_visits: 0,
      submission_completes: 0,
    }
  );
}

async function getTopCoachOpens(limit = 10) {
  const { data } = await supabase
    .schema("ops")
    .from("v_coach_metrics")
    .select("coach_id, program_link_opens, coverage_explores, enroll_clicks, eapp_visits, submission_completes")
    .order("program_link_opens", { ascending: false })
    .limit(limit);

  return data || [];
}

async function listItemsByPipeline(pipeline, limit = 8) {
  const { data } = await supabase
    .schema("ops")
    .from("items")
    .select("*")
    .eq("pipeline", pipeline)
    .order("updated_at", { ascending: false })
    .limit(limit);

  return data || [];
}

async function getItem(id) {
  const { data } = await supabase
    .schema("ops")
    .from("items")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  return data || null;
}

async function updateItem(id, fields) {
  await supabase.schema("ops").from("items").update(fields).eq("id", id);
}

async function deleteItem(id) {
  await supabase.schema("ops").from("items").delete().eq("id", id);
}

async function listConsultationsOpen(limit = 10) {
  const { data } = await supabase
    .schema("ops")
    .from("consultations")
    .select("*")
    .in("status", ["scheduled", "rescheduled", "missed"])
    .order("updated_at", { ascending: false })
    .limit(limit);

  return data || [];
}

async function upsertConsultation(payload) {
  // payload: { id, status, name, email, start_time, end_time, raw }
  const row = {
    id: String(payload.id),
    status: payload.status || "scheduled",
    name: payload.name || "",
    email: payload.email || "",
    start_time: payload.start_time ? new Date(payload.start_time).toISOString() : null,
    end_time: payload.end_time ? new Date(payload.end_time).toISOString() : null,
    raw: payload.raw || payload,
  };

  await supabase.schema("ops").from("consultations").upsert(row, { onConflict: "id" });
}

async function logEvent(event_type, coach_id, meta = {}) {
  await supabase
    .schema("ops")
    .from("events")
    .insert([{ event_type, coach_id: coach_id || null, meta }]);
}

// -------------------- TELEGRAM UI --------------------
function buildItemText(item) {
  const ai =
    item.selected_ai === 2 ? item.ai_v2 :
    item.selected_ai === 3 ? item.ai_v3 :
    item.ai_v1;

  const line1 = `${item.subject ? item.subject : "Message"}${item.coach_name ? ` — ${item.coach_name}` : ""}`;
  const line2 = item.preview ? shorten(item.preview, 180) : "(No preview)";
  const stage = item.stage ? `Stage: ${item.stage}` : "";
  const coach = item.coach_id ? `CoachID: ${item.coach_id}` : "";
  const email = item.contact_email ? `Email: ${item.contact_email}` : "";

  const urgentBadge = item.urgent ? "🔥 URGENT\n" : "";
  const approvedBadge = item.approved ? "✅ Approved\n" : "";

  return `${urgentBadge}${approvedBadge}${line1}

${line2}

${[stage, coach, email].filter(Boolean).join("\n")}

Draft (selected V${item.selected_ai || 1}):
${ai ? shorten(ai, 800) : "(No AI draft yet)"}`;
}

function buildItemKeyboard(item) {
  const ccLabel = item.cc_support_suggested ? "🟢 CC Support" : "⚪ CC Support";
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧠 Regenerate (V1/V2/V3)", `REGEN:${item.id}`)],
    [
      Markup.button.callback("✏️ Edit", `EDIT:${item.id}`),
      Markup.button.callback(ccLabel, `CC:${item.id}`),
    ],
    [
      Markup.button.callback("✅ Approve", `APPROVE:${item.id}`),
      Markup.button.callback("🚫 Unapprove", `UNAPPROVE:${item.id}`),
    ],
    [
      Markup.button.callback("📤 Send", `SEND:${item.id}`),
      Markup.button.callback("📤 Send + CC Support", `SENDCC:${item.id}`),
    ],
    [
      Markup.button.callback("⏰ Snooze 2h", `SNOOZE:${item.id}`),
      Markup.button.callback("🔥 Mark Urgent", `MARKURGENT:${item.id}`),
    ],
    [
      Markup.button.callback("✅ Mark Done", `DONE:${item.id}`),
      Markup.button.callback("🧹 Dismiss", `DISMISS:${item.id}`),
    ],
  ]);
}

async function dashboardText() {
  const silent = (await getSetting("silent_mode", "0")) === "1" ? "ON" : "OFF";
  const counts = await getQueueCounts();
  const metrics = await getCompanyMetrics();
  const consults = await listConsultationsOpen(1); // just to know it works
  const consultCount = consults ? (await listConsultationsOpen(9999)).length : 0;

  return `NIL Wealth Strategies — Operations

Today: ${new Date().toLocaleString()}
Silent Mode: ${silent}

Queues
🔥 Urgent: ${counts.urgent || 0}
✅ Needs Reply: ${counts.needs_reply || 0}
📥 Waiting: ${counts.actions_waiting || 0}
💬 Active: ${counts.active || 0}
⏳ Follow-Ups: ${counts.followups || 0}
✅ Done: ${counts.completed || 0}
📅 Consultations: ${consultCount}

Metrics (Company)
• Program Link Opens: ${metrics.program_link_opens || 0}
• Coverage Exploration: ${metrics.coverage_explores || 0}
• Enroll Clicks: ${metrics.enroll_clicks || 0}
• eApp Visits: ${metrics.eapp_visits || 0}
• Submission Completes: ${metrics.submission_completes || 0}

Tap a button below.`;
}

async function dashboardKeyboard() {
  const silent = (await getSetting("silent_mode", "0")) === "1";
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔥 Urgent", "VIEW:urgent"),
      Markup.button.callback("✅ Reply", "VIEW:needs_reply"),
      Markup.button.callback("📅 Calls", "VIEW:consults"),
    ],
    [
      Markup.button.callback("📥 Waiting", "VIEW:actions_waiting"),
      Markup.button.callback("💬 Active", "VIEW:active"),
    ],
    [
      Markup.button.callback("⏳ Follow", "VIEW:followups"),
      Markup.button.callback("✅ Done", "VIEW:completed"),
    ],
    [
      Markup.button.callback("🏈 Programs", "PIPE:programs"),
      Markup.button.callback("👨‍👩‍👧 Support", "PIPE:support"),
    ],
    [Markup.button.callback("🌐 All", "PIPE:all")],
    [
      Markup.button.callback("📊 Metrics", "VIEW:metrics"),
      Markup.button.callback("🧩 Templates", "VIEW:templates"),
    ],
    [
      Markup.button.callback(silent ? "🔕 Silent ON" : "🔔 Silent OFF", "TOGGLE:SILENT"),
      Markup.button.callback("🔄 Refresh", "DASH:refresh"),
    ],
  ]);
}

function listViewTitle(key) {
  const map = {
    urgent: "🔥 Urgent",
    needs_reply: "✅ Needs Reply",
    actions_waiting: "📥 Actions Waiting",
    active: "💬 Active Conversations",
    followups: "⏳ Follow-Ups Needed",
    completed: "✅ Completed Conversations",
    consults: "📅 Consultations",
    metrics: "📊 Metrics",
    templates: "🧩 Templates Library",
  };
  return map[key] || key;
}

// -------------------- BOT --------------------
const bot = new Telegraf(BOT_TOKEN);

bot.command("whoami", async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id}`);
});

bot.start(async (ctx) => {
  await ctx.reply("✅ Connected. Type /dashboard to open your Ops Dashboard.");
});

bot.command("dashboard", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(await dashboardText(), await dashboardKeyboard());
});

bot.action("DASH:refresh", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(await dashboardText(), await dashboardKeyboard());
});

bot.action("TOGGLE:SILENT", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const cur = (await getSetting("silent_mode", "0")) === "1";
  await setSetting("silent_mode", cur ? "0" : "1");
  await ctx.reply(await dashboardText(), await dashboardKeyboard());
});

bot.action(/^VIEW:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const key = ctx.match[1];

  if (key === "consults") {
    const rows = await listConsultationsOpen(10);
    const body =
      `${listViewTitle(key)}\n\n` +
      (rows.length
        ? rows.map((c) => `• ${String(c.status || "").toUpperCase()} — ${c.name || ""} ${c.email || ""}\n  ${c.start_time || ""}`).join("\n\n")
        : "(None)");
    await ctx.reply(body);
    return;
  }

  if (key === "metrics") {
    const metrics = await getCompanyMetrics();
    const top = await getTopCoachOpens(10);

    const body =
`📊 Metrics

Company-wide
• Program Link Opens: ${metrics.program_link_opens || 0}
• Coverage Exploration: ${metrics.coverage_explores || 0}
• Enroll Clicks: ${metrics.enroll_clicks || 0}
• eApp Visits: ${metrics.eapp_visits || 0}
• Submission Completes: ${metrics.submission_completes || 0}

Per-Coach (top 10 by opens)`;

    const lines = top.length
      ? top.map((r) => `• ${r.coach_id} — Opens: ${r.program_link_opens || 0}, Explore: ${r.coverage_explores || 0}, Enroll: ${r.enroll_clicks || 0}, eApp: ${r.eapp_visits || 0}`).join("\n")
      : "(No coach metrics yet)";

    await ctx.reply(`${body}\n\n${lines}`);
    return;
  }

  // default list view for items
  const rows = await listItemsByPipeline(key, 8);
  if (!rows.length) {
    await ctx.reply(`${listViewTitle(key)}\n\n(None right now)`);
    return;
  }

  await ctx.reply(`${listViewTitle(key)}\n\nShowing latest ${rows.length} items:`);
  for (const it of rows) {
    await ctx.reply(buildItemText(it), buildItemKeyboard(it));
  }
});

bot.action(/^PIPE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const key = ctx.match[1];

  let sourceFilter = null;
  if (key === "programs") sourceFilter = "programs";
  if (key === "support") sourceFilter = "support";

  // get counts by pipeline filtered by source (simple approach)
  let query = supabase.schema("ops").from("items").select("pipeline", { count: "exact", head: false });
  if (sourceFilter) query = query.eq("source", sourceFilter);

  // We'll compute counts via grouped select (Supabase doesn't group count cleanly),
  // so just fetch pipelines and count in JS for now.
  const { data } = await (sourceFilter
    ? supabase.schema("ops").from("items").select("pipeline").eq("source", sourceFilter)
    : supabase.schema("ops").from("items").select("pipeline")
  );

  const map = {};
  (data || []).forEach((r) => (map[r.pipeline] = (map[r.pipeline] || 0) + 1));

  const title =
    key === "programs" ? "🏈 Programs Pipeline" :
    key === "support" ? "👨‍👩‍👧 Support Pipeline" :
    "🌐 All Pipeline";

  const body =
`${title}

Queues
🔥 Urgent: ${map.urgent || 0}
✅ Needs Reply: ${map.needs_reply || 0}
📥 Waiting: ${map.actions_waiting || 0}
💬 Active: ${map.active || 0}
⏳ Follow-Ups: ${map.followups || 0}
✅ Done: ${map.completed || 0}

Tap a queue on dashboard to open items.`;

  await ctx.reply(body);
});

// -------------------- ITEM ACTIONS --------------------

// Regenerate V1/V2/V3 (shell drafts — n8n/Make can overwrite later)
bot.action(/^REGEN:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");

  const base = it.preview || it.subject || "Message";
  const v1 = `V1 Draft: Thanks for reaching out — quick response on: ${shorten(base, 90)}.`;
  const v2 = `V2 Draft: Appreciate the message. Here’s the next step and what to expect. (${shorten(base, 90)})`;
  const v3 = `V3 Draft: Understood. Here’s the cleanest answer + next step. (${shorten(base, 90)})`;

  await updateItem(id, { ai_v1: v1, ai_v2: v2, ai_v3: v3, selected_ai: 1 });

  await ctx.reply("✅ Generated V1/V2/V3. (Shell drafts for now)", Markup.inlineKeyboard([
    [Markup.button.callback("Use V1", `USEAI:${id}:1`), Markup.button.callback("Use V2", `USEAI:${id}:2`), Markup.button.callback("Use V3", `USEAI:${id}:3`)],
  ]));
});

bot.action(/^USEAI:(.+):([123])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const v = Number(ctx.match[2]);
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");
  await updateItem(id, { selected_ai: v });
  await ctx.reply(`✅ Selected V${v}.`);
});

bot.action(/^CC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");
  await updateItem(id, { cc_support_suggested: !it.cc_support_suggested });
  await ctx.reply(`CC Support suggestion toggled.`);
});

bot.action(/^APPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");
  await updateItem(id, { approved: true });
  await ctx.reply("✅ Approved.");
});

bot.action(/^UNAPPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");
  await updateItem(id, { approved: false });
  await ctx.reply("🚫 Unapproved.");
});

async function sendOut(it, ccSupport) {
  const ai =
    it.selected_ai === 2 ? it.ai_v2 :
    it.selected_ai === 3 ? it.ai_v3 :
    it.ai_v1;

  const payload = {
    item_id: it.id,
    source: it.source,
    coach_id: it.coach_id,
    coach_name: it.coach_name,
    contact_email: it.contact_email,
    subject: it.subject,
    body: ai || "",
    cc_support: !!ccSupport,
    cc_support_suggested: !!it.cc_support_suggested,
  };

  if (!MAKE_SEND_WEBHOOK_URL) {
    console.log("SEND STUB (no MAKE_SEND_WEBHOOK_URL set):", payload);
    return { ok: true, stub: true };
  }

  const res = await fetch(MAKE_SEND_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return { ok: res.ok, status: res.status };
}

bot.action(/^SEND:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await ctx.reply("Are you sure you want to SEND this draft?",
    Markup.inlineKeyboard([[Markup.button.callback("✅ Yes, Send", `CONFIRMSEND:${id}:0`)]])
  );
});

bot.action(/^SENDCC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await ctx.reply("Are you sure you want to SEND + CC Support?",
    Markup.inlineKeyboard([[Markup.button.callback("✅ Yes, Send + CC", `CONFIRMSEND:${id}:1`)]])
  );
});

bot.action(/^CONFIRMSEND:(.+):([01])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const cc = ctx.match[2] === "1";
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");

  const out = await sendOut(it, cc);

  await updateItem(id, {
    pipeline: "active",
    urgent: false,
    urgent_since: null,
    snoozed_until: null,
    cooldown_until: new Date(Date.now() + URGENT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString(),
    last_notified_at: new Date().toISOString(),
  });

  const undoId = await insertUndo("send", { item_id: id, prev_pipeline: it.pipeline });

  await ctx.reply(
    out.stub ? `📤 Sent (stub mode). Undo available briefly.` : `📤 Sent. Status: ${out.status}\nUndo available briefly.`,
    Markup.inlineKeyboard([[Markup.button.callback("↩️ Undo Send", `UNDO:${undoId}`)]])
  );
});

bot.action(/^UNDO:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const entry = await popUndo(id);
  if (!entry) return ctx.reply("Undo not available.");

  if (entry.action === "send") {
    const it = await getItem(entry.payload.item_id);
    if (it) await updateItem(it.id, { pipeline: entry.payload.prev_pipeline || "actions_waiting" });
    await ctx.reply("↩️ Undone. Item returned to previous queue.");
    return;
  }

  await ctx.reply("Undo applied.");
});

bot.action(/^SNOOZE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const until = new Date(Date.now() + URGENT_SNOOZE_HOURS * 60 * 60 * 1000).toISOString();
  await updateItem(id, { snoozed_until: until });
  await ctx.reply(`⏰ Snoozed for ${URGENT_SNOOZE_HOURS} hours.`);
});

bot.action(/^MARKURGENT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await updateItem(id, { pipeline: "urgent", urgent: true, urgent_since: new Date().toISOString(), snoozed_until: null });
  await ctx.reply("🔥 Marked URGENT.");
});

bot.action(/^DONE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await updateItem(id, { pipeline: "completed", urgent: false, urgent_since: null });
  await ctx.reply("✅ Marked done.");
});

bot.action(/^DISMISS:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await deleteItem(id);
  await ctx.reply("🧹 Dismissed.");
});

// -------------------- Background loops --------------------
async function notifyAdmins(text) {
  const silent = (await getSetting("silent_mode", "0")) === "1";
  if (silent) return;
  for (const id of ADMIN_IDS) {
    try { await bot.telegram.sendMessage(id, text); } catch {}
  }
}

async function urgentLoop() {
  const ms = Date.now();
  const tooOldMs = ms - URGENT_AFTER_MINUTES * 60 * 1000;

  // pull candidate items
  const { data } = await supabase
    .schema("ops")
    .from("items")
    .select("*")
    .in("pipeline", ["actions_waiting", "needs_reply", "active", "urgent"])
    .limit(200);

  const rows = data || [];
  for (const it of rows) {
    const snoozedUntil = it.snoozed_until ? new Date(it.snoozed_until).getTime() : null;
    if (snoozedUntil && ms < snoozedUntil) continue;

    const cooldownUntil = it.cooldown_until ? new Date(it.cooldown_until).getTime() : null;
    if (cooldownUntil && ms < cooldownUntil) continue;

    const age = it.updated_at ? new Date(it.updated_at).getTime() : new Date(it.created_at).getTime();
    if (age <= tooOldMs) {
      const last = it.last_notified_at ? new Date(it.last_notified_at).getTime() : 0;
      const notifyCooldownMs = URGENT_COOLDOWN_HOURS * 60 * 60 * 1000;

      if (ms - last > notifyCooldownMs) {
        await updateItem(it.id, {
          pipeline: "urgent",
          urgent: true,
          urgent_since: it.urgent_since || new Date().toISOString(),
          last_notified_at: new Date().toISOString(),
        });
        await notifyAdmins(`🔥 URGENT: You need to respond today.\n\n${it.subject || "Message"}${it.coach_name ? ` — ${it.coach_name}` : ""}`);
      } else {
        await updateItem(it.id, { pipeline: "urgent", urgent: true, urgent_since: it.urgent_since || new Date().toISOString() });
      }
    }
  }
}

async function autoCompleteLoop() {
  // optional: keep as-is later; safe to no-op for now
  // You can implement archival policies later based on ops.events engagement.
}

// run loops
setInterval(() => {
  urgentLoop().catch(() => {});
  autoCompleteLoop();
}, 60 * 1000);

// -------------------- WEBHOOK SERVER --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// POST /webhook/item  header x-nil-secret required
app.post("/webhook/item", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const {
    source,
    coach_id,
    coach_name,
    contact_email,
    subject,
    preview,
    stage,
    cc_support_suggested,
  } = req.body || {};

  // duplicate detection: same email+subject+preview within last 24h
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: dup } = await supabase
    .schema("ops")
    .from("items")
    .select("id")
    .eq("contact_email", contact_email || null)
    .eq("subject", subject || null)
    .eq("preview", preview || null)
    .gte("created_at", sinceIso)
    .limit(1);

  if (dup && dup.length) return res.json({ ok: true, duplicate: true, id: dup[0].id });

  const { data, error } = await supabase
    .schema("ops")
    .from("items")
    .insert([{
      source: source === "support" ? "support" : "programs",
      pipeline: "actions_waiting",
      stage: stage || "intake",
      coach_id: coach_id || null,
      coach_name: coach_name || null,
      contact_email: contact_email || null,
      subject: subject || null,
      preview: preview || null,
      raw: req.body || {},
      ai_v1: "",
      ai_v2: "",
      ai_v3: "",
      selected_ai: 1,
      approved: false,
      cc_support_suggested: !!cc_support_suggested,
      urgent: false,
    }])
    .select("id")
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  notifyAdmins(`📥 New Action Waiting\n\n${subject || "Message"}${coach_name ? ` — ${coach_name}` : ""}`).catch(() => {});
  res.json({ ok: true, id: data.id });
});

// POST /webhook/track  { type, coach_id?, meta? }
app.post("/webhook/track", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const { type, coach_id, meta } = req.body || {};
  const allowed = new Set(["program_link_open","coverage_explore","enroll_click","eapp_visit","submission_complete"]);
  if (!allowed.has(type)) return res.status(400).json({ ok: false, error: "invalid type" });

  await logEvent(type, coach_id, meta || {});
  res.json({ ok: true });
});

// POST /webhook/calendly
app.post("/webhook/calendly", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });

  await upsertConsultation({
    id,
    status: req.body.status,
    name: req.body.name,
    email: req.body.email,
    start_time: req.body.start_time,
    end_time: req.body.end_time,
    raw: req.body.raw || req.body,
  });

  notifyAdmins(`📅 Consultation Update: ${(req.body.status || "scheduled").toUpperCase()}\n${req.body.name || ""} ${req.body.email || ""}\n${req.body.start_time || ""}`).catch(() => {});
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});

// -------------------- RUN BOT --------------------
bot.launch();
console.log("Bot running... (FIRM OPS via Supabase)");

