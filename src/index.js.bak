require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
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
const CALENDLY_SIGNING_SECRET = process.env.CALENDLY_SIGNING_SECRET || ""; // optional now

// urgent policy
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180); // 3h
const URGENT_SNOOZE_HOURS = Number(process.env.URGENT_SNOOZE_HOURS || 2);
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72); // 2–3 days

// auto-complete durations (hot/warm/cold coach)
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

// -------------------- DB --------------------
const db = new Database("nil_ops.db");

// Tables:
// - items: action cards for both pipelines (programs/support) + master
// - templates: saved reply templates
// - metrics: aggregated counters company + per coach
// - consultations: calendly events
// - settings: bot settings (silent mode)
// - undo_log: undo window
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- programs|support
  pipeline TEXT NOT NULL,          -- actions_waiting|active|followups|completed|urgent|needs_reply
  stage TEXT NOT NULL,             -- e.g. parent_education|waiting_parent|...
  coach_id TEXT,                   -- for programs pipeline attribution
  coach_name TEXT,
  contact_email TEXT,
  subject TEXT,
  preview TEXT,
  raw TEXT,                        -- JSON string (optional)
  ai_v1 TEXT,
  ai_v2 TEXT,
  ai_v3 TEXT,
  selected_ai INTEGER DEFAULT 1,   -- 1|2|3
  approved INTEGER DEFAULT 0,      -- 0/1
  cc_support_suggested INTEGER DEFAULT 0, -- 0/1
  urgent INTEGER DEFAULT 0,        -- 0/1
  urgent_since INTEGER,            -- epoch ms
  snoozed_until INTEGER,           -- epoch ms
  cooldown_until INTEGER,          -- epoch ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_notified_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_items_pipeline ON items(pipeline);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  key TEXT PRIMARY KEY,      -- e.g. company:program_link_open, coach:123:program_link_open
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consultations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,      -- scheduled|rescheduled|missed|completed|canceled
  name TEXT,
  email TEXT,
  start_time TEXT,
  end_time TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS undo_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// -------------------- HELPERS --------------------
function nowMs() {
  return Date.now();
}

function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true; // allow if not set
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, String(value));
}

function getSetting(key, fallback = "") {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
  return row?.value ?? fallback;
}

function incMetric(key, by = 1) {
  const row = db.prepare(`SELECT value FROM metrics WHERE key=?`).get(key);
  if (!row) {
    db.prepare(`INSERT INTO metrics(key,value) VALUES(?,?)`).run(key, by);
  } else {
    db.prepare(`UPDATE metrics SET value=? WHERE key=?`).run(row.value + by, key);
  }
}

function getMetric(key) {
  const row = db.prepare(`SELECT value FROM metrics WHERE key=?`).get(key);
  return row?.value ?? 0;
}

function pushUndo(action, payloadObj) {
  const id = uuidv4();
  db.prepare(`INSERT INTO undo_log(id,action,payload,created_at) VALUES(?,?,?,?)`)
    .run(id, action, JSON.stringify(payloadObj), nowMs());
  return id;
}

function popUndo(id) {
  const row = db.prepare(`SELECT * FROM undo_log WHERE id=?`).get(id);
  if (!row) return null;
  db.prepare(`DELETE FROM undo_log WHERE id=?`).run(id);
  return { action: row.action, payload: JSON.parse(row.payload) };
}

function shorten(s, n = 140) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function fmtCount(n) {
  return String(n ?? 0);
}

function buildItemCard(item) {
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

  const body =
`${urgentBadge}${approvedBadge}${line1}

${line2}

${[stage, coach, email].filter(Boolean).join("\n")}

Draft (selected V${item.selected_ai || 1}):
${ai ? shorten(ai, 800) : "(No AI draft yet)"}`
  ;

  const ccLabel = item.cc_support_suggested ? "🟢 CC Support" : "⚪ CC Support";

  // Button spacing: 2 per row max, big tap targets
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

function dashboardText() {
  const silent = getSetting("silent_mode", "0") === "1" ? "ON" : "OFF";

  const urgentCount = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='urgent'`).get().c;
  const needsReplyCount = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='needs_reply'`).get().c;
  const waitingCount = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='actions_waiting'`).get().c;
  const activeCount = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='active'`).get().c;
  const followCount = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='followups'`).get().c;
  const consultCount = db.prepare(`SELECT COUNT(*) c FROM consultations WHERE status IN ('scheduled','rescheduled','missed')`).get().c;

  const companyOpens = getMetric("company:program_link_open");
  const companyExplore = getMetric("company:coverage_explore");

  return `NIL Wealth Strategies — Operations

Today: ${new Date().toLocaleString()}
Silent Mode: ${silent}

Queues
🔥 Urgent: ${urgentCount}
✅ Needs Reply: ${needsReplyCount}
📥 Waiting: ${waitingCount}
💬 Active: ${activeCount}
⏳ Follow-Ups: ${followCount}
📅 Consultations: ${consultCount}

Metrics (Company)
• Program Link Opens: ${companyOpens}
• Coverage Exploration: ${companyExplore}

Tap a button below.`;
}

// Short labels so Telegram never truncates
function dashboardKeyboard() {
  const silent = getSetting("silent_mode", "0") === "1";
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
      Markup.button.callback("📣 Impact", "VIEW:impact"),
      Markup.button.callback("🔁 Renew", "VIEW:renewals"),
    ],
    [
      Markup.button.callback("📊 Metrics", "VIEW:metrics"),
      Markup.button.callback("🧩 Templates", "VIEW:templates"),
    ],
    [
      Markup.button.callback("📅 Today", "VIEW:today"),
      Markup.button.callback("📈 Weekly", "VIEW:weekly"),
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
    impact: "📣 Impact Updates Ready",
    renewals: "🔁 Renewals Upcoming",
    metrics: "📊 Metrics",
    templates: "🧩 Templates Library",
    today: "📅 Today View",
    weekly: "📈 Weekly KPI View",
  };
  return map[key] || key;
}

function verifyWebhookSecret(req) {
  const got = req.headers["x-nil-secret"];
  return got && String(got) === String(BASE_WEBHOOK_SECRET);
}

// -------------------- BOT --------------------
const bot = new Telegraf(BOT_TOKEN);

// show user id helper
bot.command("whoami", async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id}`);
});

bot.start(async (ctx) => {
  await ctx.reply("✅ Connected. Type /dashboard to open your Ops Dashboard.");
});

bot.command("dashboard", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(dashboardText(), dashboardKeyboard());
});

// -------- Views --------
async function sendBackButton(ctx) {
  await ctx.reply("⬅️ Back to Dashboard", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
}

bot.action("DASH:back", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(dashboardText(), dashboardKeyboard());
});

bot.action("DASH:refresh", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(dashboardText(), dashboardKeyboard());
});

bot.action("TOGGLE:SILENT", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const cur = getSetting("silent_mode", "0") === "1";
  setSetting("silent_mode", cur ? "0" : "1");
  await ctx.reply(dashboardText(), dashboardKeyboard());
});

bot.action(/^VIEW:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const key = ctx.match[1];

  if (key === "consults") {
    const rows = db.prepare(
      `SELECT * FROM consultations
       WHERE status IN ('scheduled','rescheduled','missed')
       ORDER BY updated_at DESC LIMIT 10`
    ).all();

    const body =
      `${listViewTitle(key)}\n\n` +
      (rows.length
        ? rows.map((c) => `• ${c.status.toUpperCase()} — ${c.name || ""} ${c.email || ""}\n  ${c.start_time || ""}`).join("\n\n")
        : "(None)");

    await ctx.reply(body, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  if (key === "metrics") {
    // only the metrics you approved
    const companyOpens = getMetric("company:program_link_open");
    const companyExplore = getMetric("company:coverage_explore");

    const body =
`📊 Metrics

Company-wide
• Program Link Opens: ${companyOpens}
• Coverage Exploration: ${companyExplore}

Per-Coach (top 10 by opens)`;

    const top = db.prepare(`SELECT key, value FROM metrics WHERE key LIKE 'coach:%:program_link_open' ORDER BY value DESC LIMIT 10`).all();
    const lines = top.length
      ? top.map((r) => {
          const parts = r.key.split(":");
          const coachId = parts[1];
          const opens = r.value;
          const explore = getMetric(`coach:${coachId}:coverage_explore`);
          return `• ${coachId} — Opens: ${opens}, Explore: ${explore}`;
        }).join("\n")
      : "(No coach metrics yet)";

    await ctx.reply(`${body}\n\n${lines}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  if (key === "templates") {
    const rows = db.prepare(`SELECT * FROM templates ORDER BY created_at DESC LIMIT 12`).all();
    const body =
      `🧩 Templates Library\n\n` +
      (rows.length ? rows.map((t) => `• ${t.name}`).join("\n") : "(No templates yet)") +
      `\n\nUse:\n/template_add Name | body\n/template_search keyword\n/template_insert <name> (from inside an item)`;

    await ctx.reply(body, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  if (key === "today") {
    const waiting = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='actions_waiting'`).get().c;
    const urgent = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='urgent'`).get().c;
    const needs = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='needs_reply'`).get().c;

    await ctx.reply(
      `📅 Today View\n\n🔥 Urgent: ${urgent}\n✅ Needs Reply: ${needs}\n📥 Waiting: ${waiting}\n\nTip: Keep Urgent → Needs Reply → Consultations as your daily order.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  if (key === "weekly") {
    // basic weekly KPI: counts created last 7 days
    const since = nowMs() - 7 * 24 * 60 * 60 * 1000;
    const created = db.prepare(`SELECT COUNT(*) c FROM items WHERE created_at >= ?`).get(since).c;
    const done = db.prepare(`SELECT COUNT(*) c FROM items WHERE pipeline='completed' AND updated_at >= ?`).get(since).c;

    const opens = getMetric("company:program_link_open");
    const explore = getMetric("company:coverage_explore");

    await ctx.reply(
      `📈 Weekly KPI\n\nNew Items: ${created}\nCompleted: ${done}\n\nCompany Metrics\n• Program Link Opens: ${opens}\n• Coverage Exploration: ${explore}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  // default list view for items
  const rows = db.prepare(`SELECT * FROM items WHERE pipeline=? ORDER BY updated_at DESC LIMIT 8`).all(key);

  if (!rows.length) {
    await ctx.reply(`${listViewTitle(key)}\n\n(None right now)`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  await ctx.reply(`${listViewTitle(key)}\n\nShowing latest ${rows.length} items:`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
  for (const it of rows) {
    await ctx.reply(buildItemCard(it), buildItemCard(it));
  }
});

bot.action(/^PIPE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const key = ctx.match[1]; // programs|support|all

  let where = "";
  if (key === "programs") where = `WHERE source='programs'`;
  if (key === "support") where = `WHERE source='support'`;

  const rows = db.prepare(`SELECT pipeline, COUNT(*) c FROM items ${where} GROUP BY pipeline`).all();
  const map = {};
  rows.forEach((r) => (map[r.pipeline] = r.c));

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

  await ctx.reply(body, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// -------------------- ITEM ACTIONS --------------------
function getItem(id) {
  return db.prepare(`SELECT * FROM items WHERE id=?`).get(id);
}

function updateItem(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k}=@${k}`).join(", ");
  db.prepare(`UPDATE items SET ${sets}, updated_at=@updated_at WHERE id=@id`).run({
    ...fields,
    updated_at: nowMs(),
    id,
  });
}

// Regenerate V1/V2/V3
bot.action(/^REGEN:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  // Shell: generate simple drafts (later Make/OpenAI can replace this)
  const base = it.preview || it.subject || "Message";
  const v1 = `V1 Draft: Thanks for reaching out — quick response on: ${shorten(base, 90)}.`;
  const v2 = `V2 Draft: Appreciate the message. Here’s the next step and what to expect. (${shorten(base, 90)})`;
  const v3 = `V3 Draft: Understood. Here’s the cleanest answer + next step. (${shorten(base, 90)})`;

  updateItem(id, { ai_v1: v1, ai_v2: v2, ai_v3: v3, selected_ai: 1 });

  await ctx.reply("✅ Generated V1/V2/V3. (Shell drafts for now)", Markup.inlineKeyboard([
    [Markup.button.callback("Use V1", `USEAI:${id}:1`), Markup.button.callback("Use V2", `USEAI:${id}:2`), Markup.button.callback("Use V3", `USEAI:${id}:3`)],
    [Markup.button.callback("⬅️ Back", "DASH:back")]
  ]));
});

bot.action(/^USEAI:(.+):([123])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const v = Number(ctx.match[2]);
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");
  updateItem(id, { selected_ai: v });
  await ctx.reply(`✅ Selected V${v}.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// CC Support suggested toggle (green when suggested)
bot.action(/^CC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");
  updateItem(id, { cc_support_suggested: it.cc_support_suggested ? 0 : 1 });
  await ctx.reply(`CC Support suggestion toggled: ${it.cc_support_suggested ? "OFF" : "ON"}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^APPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");
  updateItem(id, { approved: 1 });
  await ctx.reply("✅ Approved.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^UNAPPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");
  updateItem(id, { approved: 0 });
  await ctx.reply("🚫 Unapproved.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// Send / Send+CC are stubs until Make webhook is connected
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
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  // confirm
  await ctx.reply(
    "Are you sure you want to SEND this draft?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Yes, Send", `CONFIRMSEND:${id}:0`)],
      [Markup.button.callback("⬅️ Cancel", "DASH:back")],
    ])
  );
});

bot.action(/^SENDCC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];

  await ctx.reply(
    "Are you sure you want to SEND + CC Support?",
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Yes, Send + CC", `CONFIRMSEND:${id}:1`)],
      [Markup.button.callback("⬅️ Cancel", "DASH:back")],
    ])
  );
});

bot.action(/^CONFIRMSEND:(.+):([01])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const cc = ctx.match[2] === "1";
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  const out = await sendOut(it, cc);

  // auto remove urgent flag once sent (your request)
  updateItem(id, {
    pipeline: "active",
    urgent: 0,
    urgent_since: null,
    snoozed_until: null,
    cooldown_until: nowMs() + URGENT_COOLDOWN_HOURS * 60 * 60 * 1000,
    last_notified_at: nowMs(),
  });

  // undo window
  const undoId = pushUndo("send", { item_id: id, prev_pipeline: it.pipeline });

  await ctx.reply(
    out.stub
      ? `📤 Sent (stub mode). Connected automation will send for real later.\n\nUndo available for a moment.`
      : `📤 Sent. Status: ${out.status}\n\nUndo available for a moment.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("↩️ Undo Send", `UNDO:${undoId}`)],
      [Markup.button.callback("⬅️ Back", "DASH:back")],
    ])
  );
});

bot.action(/^UNDO:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const entry = popUndo(id);
  if (!entry) return ctx.reply("Undo not available.");

  if (entry.action === "send") {
    const it = getItem(entry.payload.item_id);
    if (it) updateItem(it.id, { pipeline: entry.payload.prev_pipeline || "actions_waiting" });
    await ctx.reply("↩️ Undone. Item returned to previous queue.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  await ctx.reply("Undo applied.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^SNOOZE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  const until = nowMs() + URGENT_SNOOZE_HOURS * 60 * 60 * 1000;
  updateItem(id, { snoozed_until: until });

  await ctx.reply(`⏰ Snoozed for ${URGENT_SNOOZE_HOURS} hours.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^MARKURGENT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  updateItem(id, { pipeline: "urgent", urgent: 1, urgent_since: nowMs(), snoozed_until: null });

  await ctx.reply("🔥 Marked URGENT. You will get notified if it sits too long.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^DONE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  updateItem(id, { pipeline: "completed", urgent: 0, urgent_since: null });

  await ctx.reply("✅ Marked done. It will live in Completed until auto-archive rules move it later.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^DISMISS:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = getItem(id);
  if (!it) return ctx.reply("Item not found.");

  db.prepare(`DELETE FROM items WHERE id=?`).run(id);
  await ctx.reply("🧹 Dismissed.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// -------------------- TEMPLATES COMMANDS --------------------
bot.command("template_add", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = ctx.message?.text || "";
  const arg = text.replace("/template_add", "").trim();
  const parts = arg.split("|");
  if (parts.length < 2) {
    return ctx.reply("Usage: /template_add Name | template body");
  }
  const name = parts[0].trim();
  const body = parts.slice(1).join("|").trim();
  const id = uuidv4();
  db.prepare(`INSERT INTO templates(id,name,body,tags,created_at) VALUES(?,?,?,?,?)`)
    .run(id, name, body, "", nowMs());
  await ctx.reply(`✅ Template saved: ${name}`);
});

bot.command("template_search", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const q = (ctx.message?.text || "").replace("/template_search", "").trim();
  if (!q) return ctx.reply("Usage: /template_search keyword");
  const rows = db.prepare(`SELECT * FROM templates WHERE name LIKE ? OR body LIKE ? ORDER BY created_at DESC LIMIT 10`)
    .all(`%${q}%`, `%${q}%`);
  if (!rows.length) return ctx.reply("No templates found.");
  await ctx.reply("Found:\n\n" + rows.map((t) => `• ${t.name}`).join("\n"));
});

// -------------------- AUTOMATIONS (background loop) --------------------
async function notifyAdmins(text) {
  if (getSetting("silent_mode", "0") === "1") return;
  for (const id of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (e) {
      // ignore
    }
  }
}

// Urgent timer: if an item sits beyond URGENT_AFTER_MINUTES and not snoozed/cooldown, notify and keep in urgent.
async function urgentLoop() {
  const ms = nowMs();
  const tooOld = ms - URGENT_AFTER_MINUTES * 60 * 1000;

  const rows = db.prepare(`
    SELECT * FROM items
    WHERE pipeline IN ('actions_waiting','needs_reply','active','urgent')
  `).all();

  for (const it of rows) {
    // skip snoozed
    if (it.snoozed_until && ms < it.snoozed_until) continue;
    // skip cooldown
    if (it.cooldown_until && ms < it.cooldown_until) continue;

    const age = it.updated_at || it.created_at;
    if (age <= tooOld) {
      // mark urgent and notify if not recently notified
      const last = it.last_notified_at || 0;
      const notifyCooldownMs = URGENT_COOLDOWN_HOURS * 60 * 60 * 1000;

      if (ms - last > notifyCooldownMs) {
        updateItem(it.id, { pipeline: "urgent", urgent: 1, urgent_since: it.urgent_since || ms, last_notified_at: ms });
        await notifyAdmins(`🔥 URGENT: You need to respond today.\n\n${it.subject || "Message"}${it.coach_name ? ` — ${it.coach_name}` : ""}`);
      } else {
        // already notified within cooldown window
        updateItem(it.id, { pipeline: "urgent", urgent: 1, urgent_since: it.urgent_since || ms });
      }
    }
  }
}

// Auto-complete (3-tier hot/warm/cold) -> move items to completed after time
function tierDays(it) {
  // you can later set a "coach_tier" flag based on engagement
  // shell heuristic: if coach has metrics > thresholds, treat as hot/warm
  if (!it.coach_id) return AUTO_COMPLETE_COLD_DAYS;

  const opens = getMetric(`coach:${it.coach_id}:program_link_open`);
  if (opens >= 25) return AUTO_COMPLETE_HOT_DAYS;
  if (opens >= 10) return AUTO_COMPLETE_WARM_DAYS;
  return AUTO_COMPLETE_COLD_DAYS;
}

function autoCompleteLoop() {
  const ms = nowMs();
  const rows = db.prepare(`SELECT * FROM items WHERE pipeline='completed'`).all();
  for (const it of rows) {
    const days = tierDays(it);
    const expire = it.updated_at + days * 24 * 60 * 60 * 1000;
    if (ms > expire) {
      // archive by deletion for now (could be separate archived table later)
      db.prepare(`DELETE FROM items WHERE id=?`).run(it.id);
    }
  }
}

// Run loops every 60 seconds
setInterval(() => {
  urgentLoop().catch(() => {});
  autoCompleteLoop();
}, 60 * 1000);

// -------------------- WEBHOOK SERVER --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// Make/Gmail -> create item
// POST /webhook/item  (header x-nil-secret must match BASE_WEBHOOK_SECRET)
app.post("/webhook/item", (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const {
    source, // "programs" or "support"
    coach_id,
    coach_name,
    contact_email,
    subject,
    preview,
    stage,
    cc_support_suggested,
  } = req.body || {};

  // duplicate detection: same email+subject+preview within last 24h
  const since = nowMs() - 24 * 60 * 60 * 1000;
  const dup = db.prepare(`
    SELECT id FROM items
    WHERE contact_email=? AND subject=? AND preview=? AND created_at >= ?
    LIMIT 1
  `).get(contact_email || "", subject || "", preview || "", since);

  if (dup) {
    return res.json({ ok: true, duplicate: true, id: dup.id });
  }

  const id = uuidv4();
  const ms = nowMs();

  db.prepare(`
    INSERT INTO items(
      id, source, pipeline, stage, coach_id, coach_name,
      contact_email, subject, preview, raw,
      ai_v1, ai_v2, ai_v3, selected_ai,
      approved, cc_support_suggested,
      urgent, urgent_since, snoozed_until, cooldown_until,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    source === "support" ? "support" : "programs",
    "actions_waiting",
    stage || "intake",
    coach_id || null,
    coach_name || null,
    contact_email || null,
    subject || null,
    preview || null,
    JSON.stringify(req.body || {}),
    "",
    "",
    "",
    1,
    0,
    cc_support_suggested ? 1 : 0,
    0,
    null,
    null,
    null,
    ms,
    ms
  );

  // notify admins: new action waiting
  notifyAdmins(`📥 New Action Waiting\n\n${subject || "Message"}${coach_name ? ` — ${coach_name}` : ""}`).catch(() => {});

  res.json({ ok: true, id });
});

// Tracking events
// POST /webhook/track  { type: "program_link_open" | "coverage_explore", coach_id?: "X" }
app.post("/webhook/track", (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const { type, coach_id } = req.body || {};
  if (type !== "program_link_open" && type !== "coverage_explore") {
    return res.status(400).json({ ok: false, error: "invalid type" });
  }

  // Company metrics
  incMetric(`company:${type}`, 1);

  // Per coach (if provided)
  if (coach_id) incMetric(`coach:${coach_id}:${type}`, 1);

  res.json({ ok: true });
});

// Calendly events -> consultations table
// POST /webhook/calendly
app.post("/webhook/calendly", (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const { id, status, name, email, start_time, end_time, raw } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });

  const ms = nowMs();
  const existing = db.prepare(`SELECT id FROM consultations WHERE id=?`).get(id);

  if (!existing) {
    db.prepare(`INSERT INTO consultations(id,status,name,email,start_time,end_time,raw,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, status || "scheduled", name || "", email || "", start_time || "", end_time || "", JSON.stringify(raw || req.body || {}), ms, ms);
  } else {
    db.prepare(`UPDATE consultations SET status=?, name=?, email=?, start_time=?, end_time=?, raw=?, updated_at=? WHERE id=?`)
      .run(status || "scheduled", name || "", email || "", start_time || "", end_time || "", JSON.stringify(raw || req.body || {}), ms, id);
  }

  // notify
  notifyAdmins(`📅 Consultation Update: ${String(status || "scheduled").toUpperCase()}\n${name || ""} ${email || ""}\n${start_time || ""}`).catch(() => {});

  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});

// -------------------- RUN BOT --------------------
bot.launch();
console.log("Bot running... (FULL OPS SHELL)");