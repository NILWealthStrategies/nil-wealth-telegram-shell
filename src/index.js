/// TEST CHANGE - Andrew 
**
 * NIL Wealth Telegram Ops Shell — SUPABASE OPS (Master) + F/G Additions
 * F) Support escalation + mirror cards 🪞 + link indicator 🔗 + reply identity toggle
 * G) Programs/Support sections fixed (source filtering consistent, default All)
 *
 * Node 18+ recommended (for fetch)
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

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

const MAKE_SEND_WEBHOOK_URL = process.env.MAKE_SEND_WEBHOOK_URL || ""; // optional
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180); // 3h
const URGENT_SNOOZE_HOURS = Number(process.env.URGENT_SNOOZE_HOURS || 2);
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72);

// Daily digest (8:30am local server time; Render is often UTC. You can tune.)
const DAILY_DIGEST_HOUR = Number(process.env.DAILY_DIGEST_HOUR || 8);
const DAILY_DIGEST_MINUTE = Number(process.env.DAILY_DIGEST_MINUTE || 30);

// -------------------- GUARDS --------------------
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}
if (!BASE_WEBHOOK_SECRET) {
  console.error("Missing BASE_WEBHOOK_SECRET in .env");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
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
function isoNow() {
  return new Date().toISOString();
}
function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true; // allow if not set
  const id = String(ctx.from?.id || "");
  return ADMIN_IDS.includes(id);
}
function verifyWebhookSecret(req) {
  const got = req.headers["x-nil-secret"];
  return got && String(got) === String(BASE_WEBHOOK_SECRET);
}
function shorten(s, n = 140) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
function fmtCount(n) {
  return String(n ?? 0);
}
function idShort(id) {
  if (!id) return "";
  const s = String(id);
  return s.length <= 8 ? s : s.slice(0, 8);
}
function sourceSafe(src) {
  return src === "support" ? "support" : "programs";
}
function replyIdentityDefault(item) {
  // F: reply identity
  if (item?.reply_identity === "support" || item?.reply_identity === "outreach") return item.reply_identity;
  return item?.source === "support" ? "support" : "outreach";
}
function laneLabel(source) {
  return source === "support" ? "👨‍👩‍👧 Support" : "🏈 Programs";
}
function replyLabel(mode) {
  return mode === "support" ? "🟣 Support" : "🔵 Outreach";
}
function minsUntilUrgent(updatedAtIso) {
  const updated = new Date(updatedAtIso).getTime();
  const deadline = updated + URGENT_AFTER_MINUTES * 60 * 1000;
  const diffMs = deadline - nowMs();
  const diffMins = Math.max(0, Math.ceil(diffMs / (60 * 1000)));
  return diffMins;
}
function fmtCountdown(updatedAtIso) {
  const m = minsUntilUrgent(updatedAtIso);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `⏳ ${h}h ${mm}m until Urgent`;
}

// -------------------- SUPABASE QUERIES --------------------
async function sbCountItems({ pipeline, source }) {
  let q = supabase.schema("ops").from("items").select("id", { count: "exact", head: true });

  if (pipeline) q = q.eq("pipeline", pipeline);
  if (source && source !== "all") q = q.eq("source", sourceSafe(source));

  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function sbListItems({ pipeline, source = "all", limit = 8 }) {
  let q = supabase
    .schema("ops")
    .from("items")
    .select("*")
    .eq("pipeline", pipeline)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (source !== "all") q = q.eq("source", sourceSafe(source));

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function sbGetItem(id) {
  const { data, error } = await supabase.schema("ops").from("items").select("*").eq("id", id).single();
  if (error) return null;
  return data;
}

async function sbUpdateItem(id, fields) {
  const payload = { ...fields, updated_at: isoNow() };
  const { error } = await supabase.schema("ops").from("items").update(payload).eq("id", id);
  if (error) throw new Error(error.message);
}

async function sbInsertItem(row) {
  const payload = {
    id: row.id || uuidv4(),
    source: sourceSafe(row.source),
    pipeline: row.pipeline || "actions_waiting",
    stage: row.stage || "intake",
    coach_id: row.coach_id || null,
    coach_name: row.coach_name || null,
    contact_email: row.contact_email || null,
    subject: row.subject || null,
    preview: row.preview || null,
    raw: row.raw || row.raw === "" ? row.raw : null,

    ai_v1: row.ai_v1 || "",
    ai_v2: row.ai_v2 || "",
    ai_v3: row.ai_v3 || "",
    selected_ai: row.selected_ai || 1,

    approved: row.approved ?? false,
    cc_support_suggested: row.cc_support_suggested ?? false,

    urgent: row.urgent ?? false,
    urgent_since: row.urgent_since ?? null,
    snoozed_until: row.snoozed_until ?? null,
    cooldown_until: row.cooldown_until ?? null,

    // F columns (you will add in DB)
    reply_identity: replyIdentityDefault(row),
    escalated_to_support: row.escalated_to_support ?? false,
    mirror_item_id: row.mirror_item_id ?? null,

    // optional gmail link (if upstream provides)
    gmail_url: row.gmail_url ?? null,

    created_at: row.created_at || isoNow(),
    updated_at: row.updated_at || isoNow(),
    last_notified_at: row.last_notified_at ?? null,
  };

  const { data, error } = await supabase.schema("ops").from("items").insert(payload).select("id").single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function sbDeleteItem(id) {
  const { error } = await supabase.schema("ops").from("items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

async function sbCountConsults() {
  const { count, error } = await supabase
    .schema("ops")
    .from("consultations")
    .select("id", { count: "exact", head: true })
    .in("status", ["scheduled", "rescheduled", "missed"]);
  if (error) throw new Error(error.message);
  return count || 0;
}

async function sbIncMetric(key, by = 1) {
  // upsert metrics table: key TEXT PK, value INT
  const { data: existing, error: e1 } = await supabase.schema("ops").from("metrics").select("*").eq("key", key).single();
  if (e1 && e1.code !== "PGRST116") {
    // PGRST116 = row not found
    // ignore if not found
  }
  if (!existing) {
    const { error } = await supabase.schema("ops").from("metrics").insert({ key, value: by });
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.schema("ops").from("metrics").update({ value: (existing.value || 0) + by }).eq("key", key);
  if (error) throw new Error(error.message);
}

async function sbGetMetric(key) {
  const { data, error } = await supabase.schema("ops").from("metrics").select("*").eq("key", key).single();
  if (error) return 0;
  return data?.value || 0;
}

// -------------------- NOTIFY HELPERS --------------------
const bot = new Telegraf(BOT_TOKEN);

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (_) {}
  }
}

// -------------------- UI BUILDERS --------------------
function buildItemText(item) {
  const ai =
    item.selected_ai === 2 ? item.ai_v2 :
    item.selected_ai === 3 ? item.ai_v3 :
    item.ai_v1;

  const title = `${item.subject ? item.subject : "Message"}${item.coach_name ? ` — ${item.coach_name}` : ""}`;
  const preview = item.preview ? shorten(item.preview, 220) : "(No preview)";

  const urgentBadge = item.urgent ? "🔥 URGENT\n" : "";
  const approvedBadge = item.approved ? "✅ Approved\n" : "";

  const src = sourceSafe(item.source);
  const mode = replyIdentityDefault(item);

  // 🔗 / 🪞 linking display (F)
  const linkLine = (() => {
    if (item.mirror_item_id) {
      // If this is a mirror card (source=support created from programs), it will also have mirror_item_id.
      // We’ll show both icons always when linked.
      return `🔗 Linked · 🪞 ${idShort(item.mirror_item_id)}`;
    }
    return "";
  })();

  const countdownLine = item.urgent ? "" : fmtCountdown(item.updated_at || item.created_at);

  const laneLine = `${laneLabel(src)} · Reply as ${replyLabel(mode)}`;
  const metaLines = [
    item.stage ? `Stage: ${item.stage}` : null,
    item.coach_id ? `CoachID: ${item.coach_id}` : null,
    item.contact_email ? `Email: ${item.contact_email}` : null,
    linkLine || null,
    countdownLine || null,
  ].filter(Boolean).join("\n");

  return `${urgentBadge}${approvedBadge}${title}

${laneLine}

${preview}

${metaLines}

Draft (selected V${item.selected_ai || 1}):
${ai ? shorten(ai, 900) : "(No AI draft yet)"}`;
}

function buildItemKeyboard(item) {
  const ccSuggested = !!item.cc_support_suggested;
  const ccLabel = ccSuggested ? "🟢 CC Support" : "⚪ CC Support";

  const mode = replyIdentityDefault(item);
  const replyBtn = mode === "support" ? "🟣 Reply as Support" : "🔵 Reply as Outreach";

  const mirrorBtn = item.mirror_item_id
    ? Markup.button.callback(`🪞 Open Mirror`, `OPENMIRROR:${item.id}`)
    : null;

  const gmailBtn = item.gmail_url
    ? Markup.button.url("📬 Open in Gmail", item.gmail_url)
    : null;

  const rowMirrorGmail = [mirrorBtn, gmailBtn].filter(Boolean);

  return Markup.inlineKeyboard([
    [Markup.button.callback("🧠 Regenerate (V1/V2/V3)", `REGEN:${item.id}`)],
    [Markup.button.callback(replyBtn, `REPLYMODE:${item.id}`)],
    ...(rowMirrorGmail.length ? [rowMirrorGmail] : []),
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
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);
}

async function dashboardText(filterSource = "all") {
  const urgentCount = await sbCountItems({ pipeline: "urgent", source: filterSource });
  const needsReplyCount = await sbCountItems({ pipeline: "needs_reply", source: filterSource });
  const waitingCount = await sbCountItems({ pipeline: "actions_waiting", source: filterSource });
  const activeCount = await sbCountItems({ pipeline: "active", source: filterSource });
  const followCount = await sbCountItems({ pipeline: "followups", source: filterSource });
  const consultCount = await sbCountConsults();

  const companyOpens = await sbGetMetric("company:program_link_open");
  const companyExplore = await sbGetMetric("company:coverage_explore");

  const filterLabel =
    filterSource === "support" ? "👨‍👩‍👧 Support" :
    filterSource === "programs" ? "🏈 Programs" :
    "🌐 All";

  return `NIL Wealth Strategies — Operations

Today: ${new Date().toLocaleString()}
Filter: ${filterLabel}

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

Use buttons below.`;
}

function dashboardKeyboard(filterSource = "all") {
  const src = filterSource;

  const srcBtn =
    src === "all"
      ? Markup.button.callback("🌐 All (selected)", "FILTER:all")
      : Markup.button.callback("🌐 All", "FILTER:all");

  const progBtn =
    src === "programs"
      ? Markup.button.callback("🏈 Programs (selected)", "FILTER:programs")
      : Markup.button.callback("🏈 Programs", "FILTER:programs");

  const supBtn =
    src === "support"
      ? Markup.button.callback("👨‍👩‍👧 Support (selected)", "FILTER:support")
      : Markup.button.callback("👨‍👩‍👧 Support", "FILTER:support");

  return Markup.inlineKeyboard([
    [srcBtn, progBtn, supBtn],
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
      Markup.button.callback("📊 Metrics", "VIEW:metrics"),
      Markup.button.callback("📅 Today", "VIEW:today"),
    ],
    [Markup.button.callback("🔄 Refresh", "DASH:refresh")],
  ]);
}

// -------------------- STATE (per-admin UI filter) --------------------
const adminState = new Map(); // adminId -> { filterSource: "all"|"programs"|"support" }

function getAdminFilter(ctx) {
  const id = String(ctx.from?.id || "");
  const st = adminState.get(id) || { filterSource: "all" };
  return st.filterSource || "all";
}

function setAdminFilter(ctx, val) {
  const id = String(ctx.from?.id || "");
  adminState.set(id, { filterSource: val });
}

// -------------------- BOT COMMANDS --------------------
bot.command("whoami", async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id}`);
});

bot.start(async (ctx) => {
  await ctx.reply("✅ Connected. Type /dashboard to open your Ops Dashboard.");
});

bot.command("dashboard", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await dashboardText(filterSource), dashboardKeyboard(filterSource));
});

// Back/refresh
bot.action("DASH:back", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await dashboardText(filterSource), dashboardKeyboard(filterSource));
});

bot.action("DASH:refresh", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await dashboardText(filterSource), dashboardKeyboard(filterSource));
});

// Filter toggle (G: Programs/Support sections work)
bot.action(/^FILTER:(all|programs|support)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const v = ctx.match[1];
  setAdminFilter(ctx, v);
  await ctx.reply(await dashboardText(v), dashboardKeyboard(v));
});

// -------------------- VIEW HANDLER --------------------
function viewTitle(key) {
  const map = {
    urgent: "🔥 Urgent",
    needs_reply: "✅ Needs Reply",
    actions_waiting: "📥 Actions Waiting",
    active: "💬 Active Conversations",
    followups: "⏳ Follow-Ups Needed",
    completed: "✅ Completed Conversations",
    consults: "📅 Consultations",
    metrics: "📊 Metrics",
    today: "📅 Today View",
  };
  return map[key] || key;
}

bot.action(/^VIEW:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const key = ctx.match[1];
  const filterSource = getAdminFilter(ctx);

  // Consultations
  if (key === "consults") {
    const { data, error } = await supabase
      .schema("ops")
      .from("consultations")
      .select("*")
      .in("status", ["scheduled", "rescheduled", "missed"])
      .order("updated_at", { ascending: false })
      .limit(10);

    if (error) return ctx.reply(`Error: ${error.message}`);

    const rows = data || [];
    const body =
      `${viewTitle(key)}\n\n` +
      (rows.length
        ? rows
            .map((c) => `• ${String(c.status || "").toUpperCase()} — ${c.name || ""} ${c.email || ""}\n  ${c.start_time || ""}`)
            .join("\n\n")
        : "(None)");

    await ctx.reply(body, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
    return;
  }

  // Metrics
  if (key === "metrics") {
    const companyOpens = await sbGetMetric("company:program_link_open");
    const companyExplore = await sbGetMetric("company:coverage_explore");

    const { data: top, error } = await supabase
      .schema("ops")
      .from("metrics")
      .select("key,value")
      .like("key", "coach:%:program_link_open")
      .order("value", { ascending: false })
      .limit(10);

    if (error) return ctx.reply(`Error: ${error.message}`);

    const lines = (top || []).length
      ? await Promise.all(
          (top || []).map(async (r) => {
            const parts = String(r.key).split(":");
            const coachId = parts[1];
            const opens = r.value || 0;
            const explore = await sbGetMetric(`coach:${coachId}:coverage_explore`);
            return `• ${coachId} — Opens: ${opens}, Explore: ${explore}`;
          })
        )
      : ["(No coach metrics yet)"];

    await ctx.reply(
      `📊 Metrics\n\nCompany-wide\n• Program Link Opens: ${companyOpens}\n• Coverage Exploration: ${companyExplore}\n\nPer-Coach (top 10)\n${lines.join("\n")}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  // Today view (simple summary; your full “cards” view can be added later)
  if (key === "today") {
    const urgent = await sbCountItems({ pipeline: "urgent", source: filterSource });
    const needs = await sbCountItems({ pipeline: "needs_reply", source: filterSource });
    const waiting = await sbCountItems({ pipeline: "actions_waiting", source: filterSource });

    await ctx.reply(
      `📅 Today View (${filterSource === "all" ? "All" : filterSource})\n\n🔥 Urgent: ${urgent}\n✅ Needs Reply: ${needs}\n📥 Waiting: ${waiting}\n\nTip: Urgent → Needs Reply → Waiting.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Open 🔥 Urgent", "VIEW:urgent")],
        [Markup.button.callback("Open ✅ Needs Reply", "VIEW:needs_reply")],
        [Markup.button.callback("Open 📥 Waiting", "VIEW:actions_waiting")],
        [Markup.button.callback("⬅️ Back", "DASH:back")],
      ])
    );
    return;
  }

  // Default list view for items
  const rows = await sbListItems({ pipeline: key, source: filterSource, limit: 8 });

  if (!rows.length) {
    await ctx.reply(
      `${viewTitle(key)} (${filterSource === "all" ? "All" : filterSource})\n\n(None right now)`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  await ctx.reply(
    `${viewTitle(key)} (${filterSource === "all" ? "All" : filterSource})\n\nShowing latest ${rows.length} items:`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );

  for (const it of rows) {
    await ctx.reply(buildItemText(it), buildItemKeyboard(it));
  }
});

// -------------------- ITEM ACTIONS --------------------

// Shell regenerate drafts
bot.action(/^REGEN:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  const base = it.preview || it.subject || "Message";
  const v1 = `V1 Draft: Thanks for reaching out — quick response on: ${shorten(base, 90)}.`;
  const v2 = `V2 Draft: Appreciate the message. Here’s the next step and what to expect. (${shorten(base, 90)})`;
  const v3 = `V3 Draft: Understood. Here’s the cleanest answer + next step. (${shorten(base, 90)})`;

  await sbUpdateItem(id, { ai_v1: v1, ai_v2: v2, ai_v3: v3, selected_ai: 1 });

  await ctx.reply(
    "✅ Generated V1/V2/V3. (Shell drafts for now)",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Use V1", `USEAI:${id}:1`),
        Markup.button.callback("Use V2", `USEAI:${id}:2`),
        Markup.button.callback("Use V3", `USEAI:${id}:3`),
      ],
      [Markup.button.callback("⬅️ Back", "DASH:back")],
    ])
  );
});

bot.action(/^USEAI:(.+):([123])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const v = Number(ctx.match[2]);
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");
  await sbUpdateItem(id, { selected_ai: v });
  await ctx.reply(`✅ Selected V${v}.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// F: Reply identity toggle
bot.action(/^REPLYMODE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  const cur = replyIdentityDefault(it);
  const next = cur === "support" ? "outreach" : "support";

  await sbUpdateItem(id, { reply_identity: next });

  await ctx.reply(`✅ Reply identity set to: ${next.toUpperCase()}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// F: Open mirror (jump to mirror card)
bot.action(/^OPENMIRROR:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it || !it.mirror_item_id) return ctx.reply("No mirror linked.");

  const mirror = await sbGetItem(it.mirror_item_id);
  if (!mirror) return ctx.reply("Mirror item not found (deleted).");

  await ctx.reply(`🔗 Opening mirror 🪞 ${idShort(mirror.id)}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
  await ctx.reply(buildItemText(mirror), buildItemKeyboard(mirror));
});

// Approve toggle
bot.action(/^APPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");
  await sbUpdateItem(id, { approved: true });
  await ctx.reply("✅ Approved.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

bot.action(/^UNAPPROVE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");
  await sbUpdateItem(id, { approved: false });
  await ctx.reply("🚫 Unapproved.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// F: CC Support toggle + escalation (creates/removes mirror)
async function createSupportMirror(programItem) {
  // Create a support mirror card. It links back via mirror_item_id.
  const mirrorId = await sbInsertItem({
    source: "support",
    pipeline: programItem.pipeline || "actions_waiting",
    stage: programItem.stage || "intake",

    coach_id: programItem.coach_id,
    coach_name: programItem.coach_name,
    contact_email: programItem.contact_email,

    subject: programItem.subject ? `🪞 ${programItem.subject}` : "🪞 Support Mirror",
    preview: programItem.preview,
    raw: programItem.raw,

    ai_v1: programItem.ai_v1 || "",
    ai_v2: programItem.ai_v2 || "",
    ai_v3: programItem.ai_v3 || "",
    selected_ai: programItem.selected_ai || 1,

    approved: false,
    cc_support_suggested: true,

    urgent: !!programItem.urgent,
    urgent_since: programItem.urgent_since || null,

    // F
    reply_identity: "support",
    escalated_to_support: true,
    mirror_item_id: programItem.id, // mirror points back to original
    gmail_url: programItem.gmail_url || null,
  });

  return mirrorId;
}

bot.action(/^CC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];

  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  const turningOn = !it.cc_support_suggested;

  // toggle the flag
  await sbUpdateItem(id, { cc_support_suggested: turningOn });

  // Only escalate mirrors when the original is Programs lane
  const src = sourceSafe(it.source);

  if (src === "programs") {
    if (turningOn) {
      // create mirror if missing
      if (!it.mirror_item_id) {
        const mirrorId = await createSupportMirror(it);

        // link original to mirror
        await sbUpdateItem(id, {
          escalated_to_support: true,
          mirror_item_id: mirrorId,
        });

        await ctx.reply(
          `🟢 CC Support ON\n🔗 Linked mirror created 🪞 ${idShort(mirrorId)}`,
          Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
        );
        return;
      }

      await ctx.reply(
        "🟢 CC Support ON\n🔗 Mirror already linked.",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
      );
      return;
    } else {
      // turning off: remove mirror if exists
      if (it.mirror_item_id) {
        await sbDeleteItem(it.mirror_item_id);
      }

      await sbUpdateItem(id, {
        escalated_to_support: false,
        mirror_item_id: null,
      });

      await ctx.reply(
        "⚪ CC Support OFF\n🪞 Mirror removed (if it existed).",
        Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
      );
      return;
    }
  }

  // If it's already a Support item, just toggle the indicator (no extra mirroring)
  await ctx.reply(
    `CC Support toggled: ${turningOn ? "ON" : "OFF"}`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// Snooze
bot.action(/^SNOOZE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  const until = new Date(nowMs() + URGENT_SNOOZE_HOURS * 60 * 60 * 1000).toISOString();
  await sbUpdateItem(id, { snoozed_until: until });

  await ctx.reply(`⏰ Snoozed for ${URGENT_SNOOZE_HOURS} hours.`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// Mark urgent
bot.action(/^MARKURGENT:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  await sbUpdateItem(id, {
    pipeline: "urgent",
    urgent: true,
    urgent_since: isoNow(),
    snoozed_until: null,
  });

  await ctx.reply("🔥 Marked URGENT.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// Done
bot.action(/^DONE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  await sbUpdateItem(id, { pipeline: "completed", urgent: false, urgent_since: null });

  await ctx.reply("✅ Marked done.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// Dismiss
bot.action(/^DISMISS:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  // If dismissing an original with a mirror, clean up mirror too
  if (it.mirror_item_id) {
    try { await sbDeleteItem(it.mirror_item_id); } catch (_) {}
  }

  await sbDeleteItem(id);
  await ctx.reply("🧹 Dismissed.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]]));
});

// -------------------- SEND (stub or webhook) --------------------
async function sendOut(it, ccSupport) {
  const ai =
    it.selected_ai === 2 ? it.ai_v2 :
    it.selected_ai === 3 ? it.ai_v3 :
    it.ai_v1;

  // F: reply identity included
  const payload = {
    item_id: it.id,
    source: sourceSafe(it.source),
    coach_id: it.coach_id,
    coach_name: it.coach_name,
    contact_email: it.contact_email,
    subject: it.subject,
    body: ai || "",
    cc_support: !!ccSupport,
    cc_support_suggested: !!it.cc_support_suggested,
    reply_identity: replyIdentityDefault(it), // 'outreach' | 'support'
    mirror_item_id: it.mirror_item_id || null, // 🔗
  };

  if (!MAKE_SEND_WEBHOOK_URL) {
    console.log("SEND STUB (no MAKE_SEND_WEBHOOK_URL):", payload);
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

  const it = await sbGetItem(id);
  if (!it) return ctx.reply("Item not found.");

  const out = await sendOut(it, cc);

  // move to active, clear urgent, set cooldown
  const cooldown = new Date(nowMs() + URGENT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  await sbUpdateItem(id, {
    pipeline: "active",
    urgent: false,
    urgent_since: null,
    snoozed_until: null,
    cooldown_until: cooldown,
    last_notified_at: isoNow(),
  });

  await ctx.reply(
    out.stub ? "📤 Sent (stub mode)." : `📤 Sent. Status: ${out.status}`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// -------------------- BACKGROUND LOOPS --------------------
async function urgentLoop() {
  const filterSrc = "all";

  // Pull candidates (small batch)
  const { data: rows, error } = await supabase
    .schema("ops")
    .from("items")
    .select("*")
    .in("pipeline", ["actions_waiting", "needs_reply", "active", "urgent"])
    .order("updated_at", { ascending: true })
    .limit(200);

  if (error) return;

  const ms = nowMs();
  const tooOldMs = ms - URGENT_AFTER_MINUTES * 60 * 1000;
  const notifyCooldownMs = URGENT_COOLDOWN_HOURS * 60 * 60 * 1000;

  for (const it of rows || []) {
    const updated = new Date(it.updated_at || it.created_at).getTime();

    // snoozed?
    if (it.snoozed_until && ms < new Date(it.snoozed_until).getTime()) continue;

    // cooldown?
    if (it.cooldown_until && ms < new Date(it.cooldown_until).getTime()) continue;

    if (updated <= tooOldMs) {
      // mark urgent and notify if not recently notified
      const lastNotified = it.last_notified_at ? new Date(it.last_notified_at).getTime() : 0;

      if (ms - lastNotified > notifyCooldownMs) {
        try {
          await sbUpdateItem(it.id, {
            pipeline: "urgent",
            urgent: true,
            urgent_since: it.urgent_since || isoNow(),
            last_notified_at: isoNow(),
          });

          await notifyAdmins(
            `🔥 URGENT: You need to respond today.\n\n${it.subject || "Message"}${it.coach_name ? ` — ${it.coach_name}` : ""}`
          );
        } catch (_) {}
      } else {
        try {
          await sbUpdateItem(it.id, {
            pipeline: "urgent",
            urgent: true,
            urgent_since: it.urgent_since || isoNow(),
          });
        } catch (_) {}
      }
    }
  }
}

let lastDigestDayKey = "";

async function dailyDigestLoop() {
  // Sends once per day at DAILY_DIGEST_HOUR:DAILY_DIGEST_MINUTE (server local time)
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

  if (dayKey === lastDigestDayKey) return;

  if (now.getHours() === DAILY_DIGEST_HOUR && now.getMinutes() === DAILY_DIGEST_MINUTE) {
    lastDigestDayKey = dayKey;
    try {
      const urgent = await sbCountItems({ pipeline: "urgent", source: "all" });
      const needs = await sbCountItems({ pipeline: "needs_reply", source: "all" });
      const waiting = await sbCountItems({ pipeline: "actions_waiting", source: "all" });

      await notifyAdmins(
        `📌 Daily Ops Digest (${now.toLocaleDateString()})\n\n🔥 Urgent: ${urgent}\n✅ Needs Reply: ${needs}\n📥 Waiting: ${waiting}\n\nOpen /dashboard to drill in.`
      );
    } catch (_) {}
  }
}

// Run loops every 60 seconds
setInterval(() => {
  urgentLoop().catch(() => {});
  dailyDigestLoop().catch(() => {});
}, 60 * 1000);

// -------------------- WEBHOOK SERVER --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// Create item from upstream (n8n/Make/Gmail/Instantly)
// POST /webhook/item (header x-nil-secret required)
app.post("/webhook/item", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const {
      source, // "programs" | "support"
      coach_id,
      coach_name,
      contact_email,
      subject,
      preview,
      stage,
      cc_support_suggested,
      gmail_url, // optional
      thread_key, // optional
      raw,
    } = req.body || {};

    const src = sourceSafe(source);

    const id = await sbInsertItem({
      source: src,
      pipeline: "actions_waiting",
      stage: stage || "intake",
      coach_id: coach_id || null,
      coach_name: coach_name || null,
      contact_email: contact_email || null,
      subject: subject || null,
      preview: preview || null,
      raw: JSON.stringify(raw || req.body || {}),
      cc_support_suggested: !!cc_support_suggested,
      gmail_url: gmail_url || null,

      // F: default reply identity per lane
      reply_identity: src === "support" ? "support" : "outreach",
    });

    // Notify admins: new action waiting
    notifyAdmins(`📥 New Action Waiting\n\n${subject || "Message"}${coach_name ? ` — ${coach_name}` : ""}`).catch(() => {});
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Tracking events
// POST /webhook/track { type: "program_link_open" | "coverage_explore", coach_id?: "X" }
app.post("/webhook/track", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { type, coach_id } = req.body || {};
    if (type !== "program_link_open" && type !== "coverage_explore") {
      return res.status(400).json({ ok: false, error: "invalid type" });
    }

    await sbIncMetric(`company:${type}`, 1);
    if (coach_id) await sbIncMetric(`coach:${coach_id}:${type}`, 1);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
});

// -------------------- RUN BOT --------------------
bot.launch();
console.log("Bot running... (SUPABASE OPS + F/G)");
