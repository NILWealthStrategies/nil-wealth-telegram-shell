require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);
const BASE_WEBHOOK_SECRET = process.env.BASE_WEBHOOK_SECRET || "";
const MAKE_SEND_WEBHOOK_URL = process.env.MAKE_SEND_WEBHOOK_URL || "";

// Supabase (server only)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// urgent policy
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180);
const URGENT_SNOOZE_HOURS = Number(process.env.URGENT_SNOOZE_HOURS || 2);
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72);

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

// -------------------- OPS DB WRAPPERS --------------------
async function getSetting(key, fallback = "0") {
  const { data } = await supabase
    .schema("ops")
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? fallback;
}

async function setSetting(key, value) {
  await supabase
    .schema("ops")
    .from("settings")
    .upsert({ key, value: String(value) }, { onConflict: "key" });
}

async function getQueueCounts() {
  const { data } = await supabase.schema("ops").from("v_queue_counts").select("*");
  const map = {};
  (data || []).forEach((r) => (map[r.pipeline] = Number(r.count || 0)));
  return map;
}

async function getCompanyMetrics() {
  const { data } = await supabase
    .schema("ops")
    .from("v_company_metrics")
    .select("*")
    .maybeSingle();
  return data || {};
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

  if (key === "metrics") {
    const metrics = await getCompanyMetrics();
    const body =
`📊 Metrics

Company-wide
• Program Link Opens: ${metrics.program_link_opens || 0}
• Coverage Exploration: ${metrics.coverage_explores || 0}
• Enroll Clicks: ${metrics.enroll_clicks || 0}
• eApp Visits: ${metrics.eapp_visits || 0}
• Submission Completes: ${metrics.submission_completes || 0}`;
    await ctx.reply(body);
    return;
  }

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

// REGEN shell drafts
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
  await ctx.reply("✅ Generated V1/V2/V3. (Shell drafts for now)");
});

bot.action(/^CC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await getItem(id);
  if (!it) return ctx.reply("Item not found.");
  await updateItem(id, { cc_support_suggested: !it.cc_support_suggested });
  await ctx.reply("CC Support toggled.");
});

bot.action(/^APPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await updateItem(id, { approved: true });
  await ctx.reply("✅ Approved.");
});

bot.action(/^UNAPPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await updateItem(id, { approved: false });
  await ctx.reply("🚫 Unapproved.");
});

bot.action(/^MARKURGENT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await updateItem(id, { pipeline: "urgent", urgent: true, urgent_since: new Date().toISOString(), snoozed_until: null });
  await ctx.reply("🔥 Marked URGENT.");
});

bot.action(/^SNOOZE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const until = new Date(Date.now() + URGENT_SNOOZE_HOURS * 60 * 60 * 1000).toISOString();
  await updateItem(id, { snoozed_until: until });
  await ctx.reply(`⏰ Snoozed for ${URGENT_SNOOZE_HOURS} hours.`);
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

// -------------------- WEBHOOK SERVER --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

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
      selected_ai: 1,
      approved: false,
      cc_support_suggested: !!cc_support_suggested,
      urgent: false,
    }])
    .select("id")
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, id: data.id });
});

app.post("/webhook/track", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const { type, coach_id, meta } = req.body || {};
  const allowed = new Set(["program_link_open","coverage_explore","enroll_click","eapp_visit","submission_complete"]);
  if (!allowed.has(type)) return res.status(400).json({ ok: false, error: "invalid type" });

  await logEvent(type, coach_id, meta || {});
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});

// -------------------- RUN BOT --------------------
bot.launch();
console.log("Bot running... (OPS via Supabase)");
