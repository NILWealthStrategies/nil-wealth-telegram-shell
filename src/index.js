**
 * NIL Wealth Telegram Ops Bot — Supabase Ops Version (Option A)
 *
 * - Supabase = source of truth (tasks + conversations + events)
 * - Telegram = operations dashboard (approve/edit/send/snooze/urgent/done)
 * - n8n (optional) = execution engine for sending emails/SMS, etc.
 *
 * IMPORTANT:
 * 1) Add these env vars in Render (and locally if testing):
 *    TELEGRAM_BOT_TOKEN=...
 *    ADMIN_TELEGRAM_IDS=123,456
 *    SUPABASE_URL=https://xxxxx.supabase.co
 *    SUPABASE_SERVICE_ROLE_KEY=xxxxx
 *    BASE_WEBHOOK_SECRET=someRandomString
 *    PORT=3000 (Render will override)
 *
 * OPTIONAL (for later):
 *    N8N_SEND_WEBHOOK_URL=https://... (if you want Telegram "Send" to trigger n8n)
 *
 * 2) Ensure deps installed:
 *    npm i telegraf express uuid @supabase/supabase-js dotenv
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);
const BASE_WEBHOOK_SECRET = process.env.BASE_WEBHOOK_SECRET || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Optional: when you want Telegram "Send" to trigger n8n
const N8N_SEND_WEBHOOK_URL = process.env.N8N_SEND_WEBHOOK_URL || "";

// Urgent policy (kept similar to your shell)
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180); // 3h
const URGENT_SNOOZE_HOURS = Number(process.env.URGENT_SNOOZE_HOURS || 2);
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72);

// -------------------- GUARDS --------------------
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in env");
  process.exit(1);
}
if (!BASE_WEBHOOK_SECRET) {
  console.error("Missing BASE_WEBHOOK_SECRET in env (set a random string)");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

// -------------------- SUPABASE --------------------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -------------------- HELPERS --------------------
function nowIso() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}

function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true; // allow all if not set
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function verifyWebhookSecret(req) {
  const got = req.headers["x-nil-secret"];
  return got && String(got) === String(BASE_WEBHOOK_SECRET);
}

function shorten(s, n = 160) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function fmtTs(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

function safeJsonParse(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

// -------------------- IN-MEMORY EDIT STATE --------------------
// Simple state for "Edit" flow: user_id -> { taskId, field }
const editState = new Map();

// -------------------- TELEGRAM BOT --------------------
const bot = new Telegraf(BOT_TOKEN);

// -------------------- SUPABASE QUERY HELPERS --------------------
async function getCounts() {
  // Tasks by status
  const [{ count: waiting }, { count: inProgress }, { count: done }] = await Promise.all([
    sb.from("tasks").select("*", { count: "exact", head: true }).eq("status", "NEW"),
    sb.from("tasks").select("*", { count: "exact", head: true }).eq("status", "IN_PROGRESS"),
    sb.from("tasks").select("*", { count: "exact", head: true }).eq("status", "DONE"),
  ]);

  // Conversations by status (useful as you grow)
  const [{ count: convWaiting }, { count: convActive }, { count: convFollow }] = await Promise.all([
    sb.from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "ACTIONS_WAITING"),
    sb.from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "ACTIVE"),
    sb.from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "FOLLOW_UP_NEEDED"),
  ]);

  // "Urgent": tasks with meta.urgent = true OR priority=1 OR overdue due_at
  // (Meta JSONB filter in Supabase is limited; easiest is pull a small set and count client-side)
  const urgentCandidates = await sb
    .from("tasks")
    .select("id, priority, due_at, meta, status")
    .in("status", ["NEW", "IN_PROGRESS"])
    .order("created_at", { ascending: false })
    .limit(200);

  let urgentCount = 0;
  if (!urgentCandidates.error) {
    const now = new Date();
    for (const t of urgentCandidates.data || []) {
      const meta = t.meta || {};
      const overdue = t.due_at ? new Date(t.due_at) < now : false;
      if (meta.urgent === true || t.priority === 1 || overdue) urgentCount++;
    }
  }

  return {
    waiting: waiting || 0,
    inProgress: inProgress || 0,
    done: done || 0,
    urgent: urgentCount,
    convWaiting: convWaiting || 0,
    convActive: convActive || 0,
    convFollow: convFollow || 0,
  };
}

async function fetchTasksByFilter(filterKey) {
  // Returns tasks (with joined lead + conversation) for display
  // Keep it simple: always limit to 8 latest.

  if (filterKey === "urgent") {
    const res = await sb
      .from("tasks")
      .select("*, lead_pool:lead_id(id,email,first_name,last_name,coach_code), conversations:conversation_id(id,thread_key,status,subject)")
      .in("status", ["NEW", "IN_PROGRESS"])
      .order("created_at", { ascending: false })
      .limit(50);

    if (res.error) return [];

    const now = new Date();
    const urgentOnly = (res.data || []).filter((t) => {
      const meta = t.meta || {};
      const overdue = t.due_at ? new Date(t.due_at) < now : false;
      return meta.urgent === true || t.priority === 1 || overdue;
    });

    return urgentOnly.slice(0, 8);
  }

  if (filterKey === "waiting") {
    const res = await sb
      .from("tasks")
      .select("*, lead_pool:lead_id(id,email,first_name,last_name,coach_code), conversations:conversation_id(id,thread_key,status,subject)")
      .eq("status", "NEW")
      .order("created_at", { ascending: false })
      .limit(8);

    return res.error ? [] : res.data || [];
  }

  if (filterKey === "in_progress") {
    const res = await sb
      .from("tasks")
      .select("*, lead_pool:lead_id(id,email,first_name,last_name,coach_code), conversations:conversation_id(id,thread_key,status,subject)")
      .eq("status", "IN_PROGRESS")
      .order("updated_at", { ascending: false })
      .limit(8);

    return res.error ? [] : res.data || [];
  }

  if (filterKey === "done") {
    const res = await sb
      .from("tasks")
      .select("*, lead_pool:lead_id(id,email,first_name,last_name,coach_code), conversations:conversation_id(id,thread_key,status,subject)")
      .eq("status", "DONE")
      .order("updated_at", { ascending: false })
      .limit(8);

    return res.error ? [] : res.data || [];
  }

  // default fallback
  const res = await sb
    .from("tasks")
    .select("*, lead_pool:lead_id(id,email,first_name,last_name,coach_code), conversations:conversation_id(id,thread_key,status,subject)")
    .order("created_at", { ascending: false })
    .limit(8);

  return res.error ? [] : res.data || [];
}

async function updateTask(taskId, patch) {
  return sb.from("tasks").update(patch).eq("id", taskId).select("*").single();
}

async function setTaskMeta(taskId, metaPatch) {
  const current = await sb.from("tasks").select("meta").eq("id", taskId).single();
  if (current.error) return current;

  const meta = current.data?.meta || {};
  const nextMeta = { ...meta, ...metaPatch };

  return updateTask(taskId, { meta: nextMeta });
}

async function createOrUpsertConversation({ thread_key, lead_id, subject }) {
  // upsert by thread_key
  const payload = {
    thread_key,
    status: "ACTIONS_WAITING",
    lead_id: lead_id || null,
    subject: subject || "Reply",
    last_message_at: nowIso(),
    meta: { source: "webhook" },
  };

  const existing = await sb.from("conversations").select("id").eq("thread_key", thread_key).maybeSingle();
  if (existing.error) return { error: existing.error };

  if (!existing.data) {
    const created = await sb.from("conversations").insert(payload).select("*").single();
    return created;
  }

  // update existing
  const updated = await sb
    .from("conversations")
    .update({
      status: "ACTIONS_WAITING",
      lead_id: lead_id || null,
      subject: subject || "Reply",
      last_message_at: nowIso(),
      meta: { ...(existing.data.meta || {}), source: "webhook" },
    })
    .eq("thread_key", thread_key)
    .select("*")
    .single();

  return updated;
}

async function upsertLeadByEmail(email) {
  const norm = (email || "").trim().toLowerCase();
  if (!norm || !norm.includes("@")) return { data: null, error: null };

  // If lead exists, return it
  const found = await sb.from("lead_pool").select("*").eq("email_normalized", norm).maybeSingle();
  if (found.error) return { data: null, error: found.error };
  if (found.data) return { data: found.data, error: null };

  // Create new lead
  const inserted = await sb
    .from("lead_pool")
    .insert({
      email: norm,
      status: "NEW",
      source: "webhook",
      meta: {},
      last_touch_at: nowIso(),
    })
    .select("*")
    .single();

  return inserted;
}

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (_) {
      // ignore
    }
  }
}

// -------------------- UI BUILDERS --------------------
function dashboardKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔥 Urgent", "VIEW:urgent"),
      Markup.button.callback("📥 Waiting", "VIEW:waiting"),
    ],
    [
      Markup.button.callback("💬 In Progress", "VIEW:in_progress"),
      Markup.button.callback("✅ Done", "VIEW:done"),
    ],
    [
      Markup.button.callback("📅 Today", "VIEW:today"),
      Markup.button.callback("🔄 Refresh", "DASH:refresh"),
    ],
  ]);
}

async function dashboardText() {
  const c = await getCounts();

  return `NIL Wealth Strategies — Ops Dashboard

Today: ${new Date().toLocaleString()}

Queues
🔥 Urgent: ${c.urgent}
📥 Waiting (NEW): ${c.waiting}
💬 In Progress: ${c.inProgress}
✅ Done: ${c.done}

Conversations (FYI)
• Actions Waiting: ${c.convWaiting}
• Active: ${c.convActive}
• Follow-Up Needed: ${c.convFollow}

Tap a button below.`;
}

function buildTaskCard(t) {
  const meta = t.meta || {};
  const drafts = meta.drafts || {};
  const selected = meta.selected_ai || 1;

  const ai =
    selected === 2 ? drafts.v2 :
    selected === 3 ? drafts.v3 :
    drafts.v1;

  const lead = t.lead_pool || null;
  const conv = t.conversations || null;

  const who =
    lead?.first_name || lead?.last_name
      ? `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim()
      : (lead?.email || "");

  const coach = t.coach_code || lead?.coach_code || "";
  const urgentBadge = meta.urgent ? "🔥 URGENT\n" : "";
  const approvedBadge = meta.approved ? "✅ Approved\n" : "";

  const dueLine = t.due_at ? `Due: ${fmtTs(t.due_at)}` : "";
  const createdLine = t.created_at ? `Created: ${fmtTs(t.created_at)}` : "";
  const lastLine = conv?.last_message_at ? `Last Msg: ${fmtTs(conv.last_message_at)}` : "";

  const title = t.title || t.type || "Task";
  const details = t.details || "";

  const header = `${title}${coach ? ` — ${coach}` : ""}${who ? ` — ${who}` : ""}`;

  const body =
`${urgentBadge}${approvedBadge}${header}

${details ? shorten(details, 220) : "(No details)"}

${[dueLine, createdLine, lastLine].filter(Boolean).join("\n")}

Draft (selected V${selected}):
${ai ? shorten(ai, 900) : "(No AI draft yet)"}`
  ;

  const approveLabel = meta.approved ? "✅ Approved" : "✅ Approve";
  const urgentLabel = meta.urgent ? "🔥 Urgent ON" : "🔥 Mark Urgent";
  const snoozeLabel = "⏰ Snooze 2h";

  return {
    text: body,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback("🧠 Regenerate (V1/V2/V3)", `REGEN:${t.id}`)],
      [
        Markup.button.callback("✏️ Edit Draft", `EDIT:${t.id}`),
        Markup.button.callback(approveLabel, `APPROVE:${t.id}`),
      ],
      [
        Markup.button.callback("Use V1", `USEAI:${t.id}:1`),
        Markup.button.callback("Use V2", `USEAI:${t.id}:2`),
        Markup.button.callback("Use V3", `USEAI:${t.id}:3`),
      ],
      [
        Markup.button.callback("📤 Send", `SEND:${t.id}`),
        Markup.button.callback("✅ Mark Done", `DONE:${t.id}`),
      ],
      [
        Markup.button.callback(snoozeLabel, `SNOOZE:${t.id}`),
        Markup.button.callback(urgentLabel, `URGENT:${t.id}`),
      ],
      [Markup.button.callback("⬅️ Back", "DASH:back")],
    ]),
  };
}

// -------------------- COMMANDS --------------------
bot.command("whoami", async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id}`);
});

bot.start(async (ctx) => {
  await ctx.reply("✅ Connected. Type /dashboard to open your Ops Dashboard.");
});

bot.command("dashboard", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(await dashboardText(), dashboardKeyboard());
});

// -------------------- DASH ACTIONS --------------------
bot.action("DASH:back", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(await dashboardText(), dashboardKeyboard());
});

bot.action("DASH:refresh", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(await dashboardText(), dashboardKeyboard());
});

bot.action(/^VIEW:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const key = ctx.match[1];

  if (key === "today") {
    const c = await getCounts();
    await ctx.reply(
      `📅 Today View\n\n🔥 Urgent: ${c.urgent}\n📥 Waiting: ${c.waiting}\n💬 In Progress: ${c.inProgress}\n\nDaily order: Urgent → Waiting → In Progress.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  const tasks = await fetchTasksByFilter(key);

  if (!tasks.length) {
    await ctx.reply(`${key.toUpperCase()}\n\n(None right now)`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  const title =
    key === "urgent" ? "🔥 Urgent" :
    key === "waiting" ? "📥 Actions Waiting" :
    key === "in_progress" ? "💬 In Progress" :
    key === "done" ? "✅ Done" :
    key;

  await ctx.reply(`${title}\n\nShowing latest ${tasks.length} items:`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));

  for (const t of tasks) {
    const card = buildTaskCard(t);
    await ctx.reply(card.text, card.keyboard);
  }
});

// -------------------- TASK ACTIONS --------------------
bot.action(/^REGEN:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];

  // Pull task for context
  const task = await sb
    .from("tasks")
    .select("id,title,details,coach_code,meta,lead_pool:lead_id(email,first_name,last_name)")
    .eq("id", taskId)
    .single();

  if (task.error || !task.data) return ctx.reply("Task not found.");

  const base = task.data.details || task.data.title || "Message";
  const v1 = `V1: Thanks — quick answer on ${shorten(base, 80)}.`;
  const v2 = `V2: Got it. Here’s the next step and what to expect. (${shorten(base, 80)})`;
  const v3 = `V3: Understood. Here’s the cleanest answer + next step. (${shorten(base, 80)})`;

  await setTaskMeta(taskId, {
    drafts: { v1, v2, v3 },
    selected_ai: 1,
  });

  await ctx.reply("✅ Generated V1/V2/V3 drafts (shell mode).", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^USEAI:(.+):([123])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];
  const v = Number(ctx.match[2]);

  await setTaskMeta(taskId, { selected_ai: v });
  await ctx.reply(`✅ Selected V${v}.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^EDIT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];
  editState.set(String(ctx.from.id), { taskId });

  await ctx.reply(
    "✏️ Send the new draft text as your next message.\n\n(When you send it, I’ll save it as Draft V1 and keep V2/V3 unchanged.)",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Cancel", "DASH:back")]])
  );
});

bot.on("text", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const state = editState.get(String(ctx.from.id));
  if (!state) return;

  const newText = (ctx.message?.text || "").trim();
  if (!newText) return;

  const taskId = state.taskId;
  editState.delete(String(ctx.from.id));

  // Update drafts.v1 with the user's edit
  const current = await sb.from("tasks").select("meta").eq("id", taskId).single();
  if (current.error) {
    await ctx.reply("Could not load task meta.");
    return;
  }

  const meta = current.data?.meta || {};
  const drafts = meta.drafts || {};
  drafts.v1 = newText;

  await setTaskMeta(taskId, { drafts, selected_ai: 1 });

  await ctx.reply("✅ Draft updated (saved as V1).", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^APPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];

  const cur = await sb.from("tasks").select("meta").eq("id", taskId).single();
  if (cur.error) return ctx.reply("Task not found.");

  const meta = cur.data?.meta || {};
  const approved = meta.approved === true;

  await setTaskMeta(taskId, { approved: !approved });

  await ctx.reply(!approved ? "✅ Approved." : "🚫 Unapproved.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^URGENT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];

  const cur = await sb.from("tasks").select("meta").eq("id", taskId).single();
  if (cur.error) return ctx.reply("Task not found.");

  const meta = cur.data?.meta || {};
  const urgent = meta.urgent === true;

  await setTaskMeta(taskId, {
    urgent: !urgent,
    urgent_since: !urgent ? nowIso() : null,
  });

  await ctx.reply(!urgent ? "🔥 Marked URGENT." : "✅ Urgent cleared.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^SNOOZE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];
  const untilMs = nowMs() + URGENT_SNOOZE_HOURS * 60 * 60 * 1000;

  await setTaskMeta(taskId, { snoozed_until_ms: untilMs });

  await ctx.reply(`⏰ Snoozed for ${URGENT_SNOOZE_HOURS} hours.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^DONE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];
  await updateTask(taskId, { status: "DONE", resolution_code: "DONE_IN_TELEGRAM" });

  // clear urgent flag
  await setTaskMeta(taskId, { urgent: false, urgent_since: null });

  await ctx.reply("✅ Marked Done.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

async function sendToN8n(payload) {
  if (!N8N_SEND_WEBHOOK_URL) {
    console.log("SEND STUB (no N8N_SEND_WEBHOOK_URL set):", payload);
    return { ok: true, stub: true };
  }

  const res = await fetch(N8N_SEND_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return { ok: res.ok, status: res.status };
}

bot.action(/^SEND:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];

  // confirm
  await ctx.reply(
    "Are you sure you want to SEND this draft?\n\n(If n8n webhook is not set, this is stub mode.)",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Yes, Send", `CONFIRMSEND:${taskId}`)],
      [Markup.button.callback("⬅️ Cancel", "DASH:back")],
    ])
  );
});

bot.action(/^CONFIRMSEND:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const taskId = ctx.match[1];

  const taskRes = await sb
    .from("tasks")
    .select("*, lead_pool:lead_id(id,email,first_name,last_name), conversations:conversation_id(id,thread_key,status,subject)")
    .eq("id", taskId)
    .single();

  if (taskRes.error || !taskRes.data) return ctx.reply("Task not found.");

  const t = taskRes.data;
  const meta = t.meta || {};
  const drafts = meta.drafts || {};
  const selected = meta.selected_ai || 1;

  const body =
    selected === 2 ? drafts.v2 :
    selected === 3 ? drafts.v3 :
    drafts.v1;

  const payload = {
    task_id: t.id,
    task_type: t.type,
    coach_code: t.coach_code || null,
    title: t.title || null,
    details: t.details || null,
    lead: t.lead_pool || null,
    conversation: t.conversations || null,
    draft_version: `V${selected}`,
    body: body || "",
    approved: meta.approved === true,
    sent_at: nowIso(),
    source: "telegram_ops",
  };

  const out = await sendToN8n(payload);

  // Mark done in Supabase + record resolution
  await updateTask(taskId, {
    status: "DONE",
    resolution_code: out.stub ? "SENT_STUB" : `SENT_${out.status}`,
  });

  // Add sent timestamp into meta so Telegram shows date in the card later
  await setTaskMeta(taskId, {
    urgent: false,
    urgent_since: null,
    last_sent_at: nowIso(),
    last_sent_result: out.stub ? "stub" : String(out.status),
    send_cooldown_until_ms: nowMs() + URGENT_COOLDOWN_HOURS * 60 * 60 * 1000,
  });

  await ctx.reply(
    out.stub
      ? "📤 Sent (stub mode). Once you connect n8n webhook, it will send for real."
      : `📤 Sent. Status: ${out.status}`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// -------------------- URGENT LOOP (kept similar) --------------------
async function urgentLoop() {
  // Pull latest NEW/IN_PROGRESS tasks and flag urgent if sitting too long
  const res = await sb
    .from("tasks")
    .select("id, created_at, updated_at, due_at, priority, meta, title, coach_code")
    .in("status", ["NEW", "IN_PROGRESS"])
    .order("created_at", { ascending: false })
    .limit(200);

  if (res.error) return;

  const msNow = nowMs();
  const tooOldMs = msNow - URGENT_AFTER_MINUTES * 60 * 1000;

  for (const t of res.data || []) {
    const meta = t.meta || {};

    // Snooze
    if (meta.snoozed_until_ms && msNow < meta.snoozed_until_ms) continue;

    // Send cooldown
    if (meta.send_cooldown_until_ms && msNow < meta.send_cooldown_until_ms) continue;

    // "Age" based on updated_at/created_at
    const updatedAt = t.updated_at ? new Date(t.updated_at).getTime() : null;
    const createdAt = t.created_at ? new Date(t.created_at).getTime() : null;
    const ageMs = updatedAt || createdAt || msNow;

    const overdue = t.due_at ? new Date(t.due_at).getTime() < msNow : false;

    const shouldBeUrgent =
      meta.urgent === true ||
      t.priority === 1 ||
      overdue ||
      ageMs <= tooOldMs;

    if (!shouldBeUrgent) continue;

    // Notify only if not notified recently
    const lastNotifiedMs = meta.last_notified_ms || 0;
    const notifyCooldownMs = URGENT_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (msNow - lastNotifiedMs > notifyCooldownMs) {
      await setTaskMeta(t.id, {
        urgent: true,
        urgent_since: meta.urgent_since || nowIso(),
        last_notified_ms: msNow,
      });

      await notifyAdmins(
        `🔥 URGENT: Needs attention today.\n\n${t.title || "Task"}${t.coach_code ? ` — ${t.coach_code}` : ""}\n${fmtTs(t.updated_at || t.created_at)}`
      );
    } else {
      // Ensure urgent stays true even if we're not notifying
      if (meta.urgent !== true) {
        await setTaskMeta(t.id, { urgent: true, urgent_since: meta.urgent_since || nowIso() });
      }
    }
  }
}

setInterval(() => {
  urgentLoop().catch(() => {});
}, 60 * 1000);

// -------------------- WEB SERVER (INBOUND WEBHOOKS) --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /webhook/reply
 * Creates a conversation + a NEW task to approve a reply draft.
 *
 * Header: x-nil-secret must match BASE_WEBHOOK_SECRET
 *
 * Body example:
 * {
 *   "thread_key": "parent@test.com",     // or provider thread id
 *   "email": "parent@test.com",
 *   "subject": "Re: Coach Program",
 *   "preview": "Their latest message snippet...",
 *   "coach_code": "COACH_123",
 *   "details": "Full inbound text or summary..."
 * }
 */
app.post("/webhook/reply", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const {
    thread_key,
    email,
    subject,
    preview,
    coach_code,
    details,
  } = req.body || {};

  const th = thread_key || (email ? String(email).trim().toLowerCase() : uuidv4());
  const leadUpsert = await upsertLeadByEmail(email || "");
  if (leadUpsert.error) return res.status(500).json({ ok: false, error: "lead_upsert_failed" });

  const conv = await createOrUpsertConversation({
    thread_key: th,
    lead_id: leadUpsert.data?.id || null,
    subject: subject || "Reply",
  });
  if (conv.error) return res.status(500).json({ ok: false, error: "conversation_upsert_failed" });

  // Create NEW task that Telegram will show in Waiting
  const taskInsert = await sb
    .from("tasks")
    .insert({
      status: "NEW",
      type: "GENERAL",
      coach_code: coach_code || null,
      lead_id: leadUpsert.data?.id || null,
      conversation_id: conv.data?.id || null,
      title: subject ? `Reply approval — ${subject}` : "Reply approval",
      details: details || preview || "(No preview)",
      priority: 2,
      due_at: null,
      meta: {
        source: "webhook_reply",
        preview: preview || "",
        drafts: { v1: "", v2: "", v3: "" },
        selected_ai: 1,
        approved: false,
        urgent: false,
      },
    })
    .select("*")
    .single();

  if (taskInsert.error) return res.status(500).json({ ok: false, error: "task_insert_failed" });

  // Notify admins in Telegram
  await notifyAdmins(`📥 New Reply Waiting\n\n${subject || "Reply"}${coach_code ? ` — ${coach_code}` : ""}\n${email || ""}`);

  res.json({ ok: true, conversation_id: conv.data?.id, task_id: taskInsert.data?.id });
});

// Start server
app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});

// Run bot
bot.launch();
console.log("Bot running... (SUPABASE OPS VERSION)");
