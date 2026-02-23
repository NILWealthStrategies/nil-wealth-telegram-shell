/* =========================================================
 * NIL Wealth Telegram Ops Bot — Index.js v5.0 (Render-ready)
 * =========================================================
 *
 * Goals locked in:
 * - Dashboard keyboard:
 *   Row1: 🌐 All | 🏈 Programs | 🧑‍🧒 Support
 *   Row2: 🗂 All Queues | ⚡ Triage | 🔎 Search
 *   Row3: 📊 Metrics | 📅 Today | 👥 Clients
 *
 * - 🗂 All Queues includes 🌊 Pools as a button (coach intelligence layer)
 * - Pools uses SAME properties as coach pools: ops.coaches (clicks/forwards/etc)
 * - Render-compatible: Express server + Telegraf polling
 *
 * Required ENV:
 *   TELEGRAM_BOT_TOKEN
 *   BASE_WEBHOOK_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional ENV:
 *   ADMIN_TELEGRAM_IDS="123,456"
 *   BUILD_VERSION
 *   PORT
 *   LIVE_CARD_TTL_MINUTES
 *   URGENT_AFTER_MINUTES
 *
 * Webhooks:
 *   POST /webhook/gmail
 *   POST /webhook/submission
 *   POST /webhook/call
 *   POST /webhook/person
 *   POST /webhook/metric
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

// -------------------- VERSION --------------------
const CODE_VERSION = "Index.js v5.0";
const BUILD_VERSION =
  process.env.BUILD_VERSION ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.RENDER_SERVICE_ID ||
  "dev-unknown";

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_WEBHOOK_SECRET = process.env.BASE_WEBHOOK_SECRET || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = Number(process.env.PORT || 3000);

// Timing
const LIVE_CARD_TTL_MINUTES = Number(process.env.LIVE_CARD_TTL_MINUTES || 360);
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180);

// -------------------- GUARDS --------------------
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!BASE_WEBHOOK_SECRET) {
  console.error("Missing BASE_WEBHOOK_SECRET");
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

// -------------------- BASIC HELPERS --------------------
function isoNow() {
  return new Date().toISOString();
}
function nowMs() {
  return Date.now();
}
function shorten(s, n = 160) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
function idShort(id) {
  if (!id) return "";
  const s = String(id);
  return s.length <= 8 ? s : s.slice(0, 8);
}
function sourceSafe(src) {
  return src === "support" ? "support" : "programs";
}
function laneLabel(source) {
  return source === "support" ? "🧑‍🧒 Support" : "🏈 Programs";
}
function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true;
  return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}
function verifyWebhookSecret(req) {
  const got = req.headers["x-nil-secret"];
  return got && String(got) === String(BASE_WEBHOOK_SECRET);
}

// -------------------- NY TIME --------------------
const NY_TZ = "America/New_York";
function nyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const tFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return { year, month, day, dayKey: `${year}-${month}-${day}`, time: tFmt.format(date) };
}
function fmtISOShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

// -------------------- SLA / URGENT --------------------
function minsUntilUrgent(updatedAtIso) {
  const updated = new Date(updatedAtIso).getTime();
  const deadline = updated + URGENT_AFTER_MINUTES * 60 * 1000;
  const diffMs = deadline - nowMs();
  return Math.ceil(diffMs / (60 * 1000));
}
function slaBadge(updatedAtIso) {
  const m = minsUntilUrgent(updatedAtIso);
  if (m <= 0) return "🔴 Overdue";
  if (m <= 60) return "🟠 Due soon";
  return "🟢 On track";
}
function fmtCountdown(updatedAtIso) {
  const m = minsUntilUrgent(updatedAtIso);
  const mmAbs = Math.abs(m);
  const h = Math.floor(mmAbs / 60);
  const mm = mmAbs % 60;
  if (m <= 0) return `⏳ 0h 0m until Urgent`;
  return `⏳ ${h}h ${mm}m until Urgent`;
}

// -------------------- ADMIN FILTER STATE --------------------
const adminState = new Map(); // adminId -> { filterSource }
function getAdminFilter(ctx) {
  const id = String(ctx.from?.id || "");
  const st = adminState.get(id) || { filterSource: "all" };
  return st.filterSource || "all";
}
function setAdminFilter(ctx, val) {
  const id = String(ctx.from?.id || "");
  adminState.set(id, { filterSource: val });
}

// -------------------- SMART RENDER (edit when possible) --------------------
function canEditFromCtx(ctx) {
  return Boolean(ctx?.callbackQuery?.message?.message_id && ctx?.chat?.id);
}
async function smartRender(ctx, text, keyboard) {
  if (ctx?.callbackQuery) {
    try {
      await ctx.answerCbQuery();
    } catch (_) {}
  }
  if (canEditFromCtx(ctx)) {
    try {
      await bot.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        text,
        keyboard
      );
      return { mode: "edit", message_id: ctx.callbackQuery.message.message_id };
    } catch (_) {}
  }
  const msg = await ctx.reply(text, keyboard);
  return { mode: "reply", message_id: msg?.message_id };
}

// -------------------- LIVE CARD TRACKING --------------------
const liveCards = new Map(); // message_id -> { chat_id, type, ref_id, added_at }
function registerLiveCard(msg, type, ref_id) {
  if (!msg?.message_id) return;
  liveCards.set(msg.message_id, { chat_id: msg.chat.id, type, ref_id, added_at: nowMs() });
}
function cleanupLiveCards() {
  const ttlMs = LIVE_CARD_TTL_MINUTES * 60 * 1000;
  const now = nowMs();
  for (const [messageId, meta] of liveCards.entries()) {
    if (!meta?.added_at) {
      liveCards.delete(messageId);
      continue;
    }
    if (now - meta.added_at > ttlMs) liveCards.delete(messageId);
  }
}
// =========================================================
// SUPABASE QUERIES
// =========================================================

// -------------------- CONVERSATIONS --------------------
async function sbCountConversations({ pipeline, source }) {
  let q = supabase.schema("ops").from("conversations").select("id", { count: "exact", head: true });
  if (pipeline) q = q.eq("pipeline", pipeline);
  if (source && source !== "all") q = q.eq("source", sourceSafe(source));
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function sbListConversations({ pipeline, source = "all", limit = 8 }) {
  let q = supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .eq("pipeline", pipeline)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (source !== "all") q = q.eq("source", sourceSafe(source));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function sbGetConversation(id) {
  const { data, error } = await supabase.schema("ops").from("conversations").select("*").eq("id", id).single();
  if (error) return null;
  return data;
}

async function sbUpsertConversationByThreadKey(thread_key, fields) {
  const payload = { thread_key, ...fields, updated_at: isoNow() };
  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .upsert(payload, { onConflict: "thread_key" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function sbInsertMessage(row) {
  const payload = {
    id: row.id || uuidv4(),
    conversation_id: row.conversation_id,
    direction: row.direction, // inbound|outbound
    from_email: row.from_email || null,
    to_email: row.to_email || null,
    body: row.body || "",
    preview: row.preview || shorten(row.body || "", 220),
    created_at: row.created_at || isoNow(),
    provider_message_id: row.provider_message_id || null,
  };
  const { error } = await supabase.schema("ops").from("messages").insert(payload);
  if (error) throw new Error(error.message);
}

async function sbCountMessages(conversation_id) {
  const { count, error } = await supabase
    .schema("ops")
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation_id);
  if (error) return 0;
  return count || 0;
}

async function sbListMessages(conversation_id, { limit = 10, offset = 0 } = {}) {
  const { data, error } = await supabase
    .schema("ops")
    .from("messages")
    .select("*")
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return data || [];
}

// -------------------- SUBMISSIONS --------------------
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return str;
  }
}
function normalizeSubmissionRow(s) {
  const submission_id = s.submission_id || s.id || s.submissionId || s.submissionID;
  const payload = s.submission_payload || s.payload || s.form_payload || s.data || null;

  const email_sent =
    typeof s.email_sent === "boolean"
      ? s.email_sent
      : typeof s.emailSent === "boolean"
      ? s.emailSent
      : typeof s.email_status === "boolean"
      ? s.email_status
      : undefined;

  const text_sent =
    typeof s.text_sent === "boolean"
      ? s.text_sent
      : typeof s.sms_sent === "boolean"
      ? s.sms_sent
      : typeof s.textSent === "boolean"
      ? s.textSent
      : typeof s.smsSent === "boolean"
      ? s.smsSent
      : undefined;

  return {
    id: String(submission_id || ""),
    submission_id: String(submission_id || ""),
    submission_payload: payload && typeof payload === "string" ? safeJsonParse(payload) : payload,
    email_sent,
    text_sent,
    email_error: s.email_error || s.email_send_error || s.emailError || null,
    text_error: s.text_error || s.text_send_error || s.sms_send_error || s.textError || s.smsError || null,
    created_at: s.created_at || s.submitted_at || s.inserted_at || null,
  };
}

async function sbCountSubmissions() {
  const { count, error } = await supabase
    .schema("ops")
    .from("submissions")
    .select("submission_id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count || 0;
}
async function sbListSubmissions({ limit = 8 } = {}) {
  const { data, error } = await supabase
    .schema("ops")
    .from("submissions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(normalizeSubmissionRow);
}
async function sbGetSubmission(submission_id) {
  const { data, error } = await supabase
    .schema("ops")
    .from("submissions")
    .select("*")
    .eq("submission_id", submission_id)
    .single();
  if (error) return null;
  return normalizeSubmissionRow(data);
}
async function sbDeleteSubmission(submission_id) {
  const { error } = await supabase.schema("ops").from("submissions").delete().eq("submission_id", submission_id);
  if (error) throw new Error(error.message);
}

// -------------------- CALLS --------------------
async function sbInsertCall(row) {
  const payload = {
    id: row.id || uuidv4(),
    created_at: row.created_at || isoNow(),
    scheduled_at: row.scheduled_at || null,
    coach_id: row.coach_id || null,
    coach_name: row.coach_name || null,
    parent_name: row.parent_name || null,
    parent_phone: row.parent_phone || null,
    parent_email: row.parent_email || null,
    source: row.source || "calendly",
    status: row.status || "booked",
    notes: row.notes || null,
    meta: row.meta || null,
  };
  const { error } = await supabase.schema("ops").from("calls").insert(payload);
  if (error) throw new Error(error.message);
  return payload.id;
}
async function sbListCalls({ limit = 10, status = null } = {}) {
  let q = supabase.schema("ops").from("calls").select("*").order("created_at", { ascending: false }).limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return [];
  return data || [];
}
async function sbGetCall(call_id) {
  const { data, error } = await supabase.schema("ops").from("calls").select("*").eq("id", call_id).single();
  if (error) return null;
  return data;
}
async function sbUpdateCall(call_id, fields) {
  const { error } = await supabase.schema("ops").from("calls").update({ ...fields }).eq("id", call_id);
  if (error) throw new Error(error.message);
}
async function sbCountCalls() {
  const { count, error } = await supabase.schema("ops").from("calls").select("id", { count: "exact", head: true });
  if (error) return 0;
  return count || 0;
}

// -------------------- COACH POOLS (ops.coaches) --------------------
async function sbUpsertCoach({ coach_id, coach_name, program_name }) {
  const payload = {
    coach_id,
    coach_name: coach_name || null,
    program_name: program_name || null,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
  const { error } = await supabase.schema("ops").from("coaches").upsert(payload, { onConflict: "coach_id" });
  if (error) return false;
  return true;
}
async function sbGetCoach(coach_id) {
  const { data, error } = await supabase.schema("ops").from("coaches").select("*").eq("coach_id", coach_id).single();
  if (error) return null;
  return data;
}
async function sbListCoaches({ limit = 12 } = {}) {
  const { data, error } = await supabase
    .schema("ops")
    .from("coaches")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}
async function sbCoachInc(coach_id, fields) {
  const { data, error } = await supabase.schema("ops").from("coaches").select("*").eq("coach_id", coach_id).single();
  if (error) return false;

  const next = { ...data };
  for (const k of Object.keys(fields || {})) {
    next[k] = Number(next[k] || 0) + Number(fields[k] || 0);
  }
  next.updated_at = isoNow();

  const { error: e2 } = await supabase.schema("ops").from("coaches").update(next).eq("coach_id", coach_id);
  if (e2) return false;
  return true;
}
async function sbCoachSet(coach_id, fields) {
  const { error } = await supabase.schema("ops").from("coaches").update({ ...fields, updated_at: isoNow() }).eq("coach_id", coach_id);
  if (error) return false;
  return true;
}

// -------------------- PEOPLE (ops.people) --------------------
async function sbUpsertPerson(row) {
  const id = row.id || uuidv4();
  const payload = {
    id,
    coach_id: row.coach_id,
    name: row.name || null,
    email: row.email || null,
    phone: row.phone || null,
    status: row.status || "new",
    summary: row.summary || null,
    meta: row.meta || null,
    last_activity_at: row.last_activity_at || null,
    updated_at: isoNow(),
    created_at: isoNow(),
  };
  const { error } = await supabase.schema("ops").from("people").upsert(payload, { onConflict: "id" });
  if (error) return null;
  return id;
}
async function sbListPeopleByCoach(coach_id, { limit = 10 } = {}) {
  const { data, error } = await supabase
    .schema("ops")
    .from("people")
    .select("*")
    .eq("coach_id", coach_id)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}
// =========================================================
// BOT UI BUILDERS
// =========================================================

function viewTitle(key) {
  const map = {
    urgent: "‼️ Urgent",
    needs_reply: "📝 Needs Reply",
    actions_waiting: "⏳ Waiting",
    active: "💬 Active",
    followups: "📚 Follow-Ups",
    forwarded: "📨 Forwarded",
    website_submissions: "🧾 Submissions",
    completed: "✅ Completed",
    all_queues: "🗂 All Queues",
    triage: "⚡ Triage",
    search: "🔎 Search",
    clients: "👥 Clients",
    pools: "🌊 Pools",
    calls: "📱 Calls",
    today: "📅 Today",
    metrics: "📊 Metrics",
    thread: "🧵 Thread",
  };
  return map[key] || key;
}
function headerLine(key, filterLabel = "all") {
  return `${viewTitle(key)} · ${filterLabel}`;
}

// -------------------- DASHBOARD --------------------
async function dashboardCounts(filterSource = "all") {
  const urgentCount = await sbCountConversations({ pipeline: "urgent", source: filterSource });
  const needsReplyCount = await sbCountConversations({ pipeline: "needs_reply", source: filterSource });
  const waitingCount = await sbCountConversations({ pipeline: "actions_waiting", source: filterSource });
  const activeCount = await sbCountConversations({ pipeline: "active", source: filterSource });
  const followCount = await sbCountConversations({ pipeline: "followups", source: filterSource });
  const forwardedCount = await sbCountConversations({ pipeline: "forwarded", source: filterSource });

  const submissionsCount = filterSource === "programs" ? 0 : await sbCountSubmissions();
  const completedCount = filterSource === "programs" ? 0 : await sbCountConversations({ pipeline: "completed", source: "support" });

  const callsCount = await sbCountCalls();
  return {
    urgentCount,
    needsReplyCount,
    waitingCount,
    activeCount,
    followCount,
    forwardedCount,
    submissionsCount,
    completedCount,
    callsCount,
  };
}

async function dashboardText(filterSource = "all") {
  const ny = nyParts(new Date());
  const counts = await dashboardCounts(filterSource);

  const filterLabel =
    filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" : "🌐 All";

  return `🪧 NIL Wealth Ops Dashboard
${CODE_VERSION} · Build: ${String(BUILD_VERSION).slice(0, 8)}

📅 Today: ${new Date().toLocaleDateString("en-US")}
⏰ NY Time: ${ny.dayKey} ${ny.time}
Filter: ${filterLabel}

📥 Queues
‼️ Urgent: ${counts.urgentCount}
📝 Needs Reply: ${counts.needsReplyCount}
⏳ Waiting: ${counts.waitingCount}
💬 Active: ${counts.activeCount}
📨 Forwarded: ${counts.forwardedCount}
🧾 Submissions: ${counts.submissionsCount}
📚 Follow-Ups: ${counts.followCount}
✅ Completed: ${counts.completedCount}

📱 Calls: ${counts.callsCount}

Use buttons below.`;
}

// EXACT rows requested
function dashboardKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🌐 All", "FILTER:all"),
      Markup.button.callback("🏈 Programs", "FILTER:programs"),
      Markup.button.callback("🧑‍🧒 Support", "FILTER:support"),
    ],
    [
      Markup.button.callback("🗂 All Queues", "ALLQ:open"),
      Markup.button.callback("⚡ Triage", "TRIAGE:open"),
      Markup.button.callback("🔎 Search", "SEARCH:help"),
    ],
    [
      Markup.button.callback("📊 Metrics", "METRICS:open"),
      Markup.button.callback("📅 Today", "TODAY:open"),
      Markup.button.callback("👥 Clients", "CLIENTS:open"),
    ],
  ]);
}

// -------------------- ALL QUEUES --------------------
async function allQueuesText(filterSource = "all") {
  const header = headerLine("all_queues", filterSource);
  return `${header}

Tap a queue below to open it.`;
}

function allQueuesKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("‼️ Urgent", "VIEW:urgent"), Markup.button.callback("📝 Needs Reply", "VIEW:needs_reply")],
    [Markup.button.callback("⏳ Waiting", "VIEW:actions_waiting"), Markup.button.callback("💬 Active", "VIEW:active")],
    [Markup.button.callback("📨 Forwarded", "VIEW:forwarded"), Markup.button.callback("📚 Follow-Ups", "VIEW:followups")],
    [Markup.button.callback("🧾 Submissions", "VIEW:website_submissions"), Markup.button.callback("✅ Completed", "VIEW:completed")],
    // ✅ Pools button lives here
    [Markup.button.callback("🌊 Pools", "POOLS:open"), Markup.button.callback("📱 Calls", "CALLS:hub"), Markup.button.callback("🔄 Refresh", "DASH:refresh")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- POOLS (Coach intelligence) --------------------
async function poolsHubText() {
  const rows = await sbListCoaches({ limit: 12 });
  if (!rows.length) {
    return `🌊 Pools (Coach Intelligence)

(No coach pools found yet.)`;
  }

  const lines = rows.map((c, i) => {
    const coach = c.coach_name || c.coach_id || "Coach";
    const program = c.program_name ? ` · ${shorten(c.program_name, 34)}` : "";
    const updated = c.updated_at ? fmtISOShort(c.updated_at) : "—";

    // keep same properties as coach pools
    const clicks = Number(c.clicks || 0);
    const forwards = Number(c.forwards || 0);
    const replies = Number(c.replies || 0);
    const sent = Number(c.sent || 0);

    return `${i + 1}. ${shorten(coach, 42)}${program}
🔗 ${clicks} · 📨 ${forwards} · 💬 ${replies} · ✉️ ${sent} · ⏱ ${updated}`;
  });

  return `🌊 Pools (Coaches)

${lines.join("\n\n")}`;
}

function poolsHubKeyboard(rows) {
  const btns = (rows || []).slice(0, 12).map((c, i) => [
    Markup.button.callback(`Open ${i + 1}`, `POOLCOACH:${c.coach_id}`),
  ]);

  return Markup.inlineKeyboard([
    ...(btns.length ? btns : []),
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

async function poolCoachCardText(coach_id) {
  const c = await sbGetCoach(coach_id);
  if (!c) return "Coach pool not found.";

  const people = await sbListPeopleByCoach(coach_id, { limit: 10 });

  const coach = c.coach_name || c.coach_id || "Coach";
  const program = c.program_name ? ` · ${c.program_name}` : "";

  const clicks = Number(c.clicks || 0);
  const forwards = Number(c.forwards || 0);
  const replies = Number(c.replies || 0);
  const sent = Number(c.sent || 0);

  const lastClick = c.last_click_at ? fmtISOShort(c.last_click_at) : "—";
  const updated = c.updated_at ? fmtISOShort(c.updated_at) : "—";

  const peopleLines = people.length
    ? people
        .map((p, i) => {
          const nm = p.name || p.email || p.phone || idShort(p.id);
          const st = p.status || "new";
          return `${i + 1}. ${shorten(nm, 34)} · ${st}`;
        })
        .join("\n")
    : "(No linked people yet.)";

  return `🌊 Pool (Coach)

${shorten(coach, 44)}${program}

🔗 Clicks: ${clicks}
📨 Forwards: ${forwards}
💬 Replies: ${replies}
✉️ Sent: ${sent}

🕒 Last Click: ${lastClick}
⏱ Updated: ${updated}

👥 People
${peopleLines}`;
}

function poolCoachCardKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Pools", "POOLS:open")],
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- TRIAGE --------------------
async function triageText(filterSource = "all") {
  const header = headerLine("triage", filterSource);

  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .in("pipeline", ["urgent", "needs_reply", "actions_waiting", "active"])
    .order("updated_at", { ascending: true })
    .limit(80);

  const rows = error ? [] : data || [];

  const filtered = rows.filter((c) => {
    if (filterSource !== "all" && sourceSafe(c.source) !== sourceSafe(filterSource)) return false;
    if (c.pipeline === "urgent") return true;
    const mins = minsUntilUrgent(c.updated_at || c.created_at);
    return mins <= 0;
  });

  const top = filtered.slice(0, 10);
  const lines = top.length
    ? top
        .map((c, i) => {
          const subj = shorten(c.subject || "Thread", 48);
          const lane = laneLabel(sourceSafe(c.source));
          const sla = slaBadge(c.updated_at || c.created_at);
          return `${i + 1}. ${subj} · ${lane} · ${sla}`;
        })
        .join("\n")
    : "(None due right now)";

  return `${header}\n\n${lines}`;
}

async function triageKeyboard(filterSource = "all") {
  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .in("pipeline", ["urgent", "needs_reply", "actions_waiting", "active"])
    .order("updated_at", { ascending: true })
    .limit(80);

  const rows = error ? [] : data || [];
  const filtered = rows.filter((c) => {
    if (filterSource !== "all" && sourceSafe(c.source) !== sourceSafe(filterSource)) return false;
    if (c.pipeline === "urgent") return true;
    return minsUntilUrgent(c.updated_at || c.created_at) <= 0;
  });

  const top = filtered.slice(0, 10);
  const openRows = top.map((c, i) => [
    Markup.button.callback(`Open ${i + 1}`, `OPENCARD:${c.id}`),
    Markup.button.callback("Thread", `THREAD:${c.id}:0`),
  ]);

  return Markup.inlineKeyboard([
    ...(openRows.length ? openRows : []),
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}
// =========================================================
// CARDS + LIST VIEWS + SEARCH + WEBHOOKS + LAUNCH
// =========================================================

// -------------------- QUEUE LIST VIEW --------------------
async function showQueueSummaryList(ctx, key, rows, filterSource) {
  const header = headerLine(key, filterSource);

  if (!rows || !rows.length) {
    await smartRender(
      ctx,
      `${header}\n\n(None right now)`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
        [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
      ])
    );
    return;
  }

  const items = rows.slice(0, 8);

  const lines = items.map((c, i) => {
    const subj = shorten(c.subject || `Submission ${c.submission_id || ""}` || "Item", 60);
    const lane = c.source ? laneLabel(sourceSafe(c.source)) : "🧾 Submission";
    const sla = c.updated_at || c.created_at ? slaBadge(c.updated_at || c.created_at) : "";
    return `${i + 1}. ${subj}\n${lane}${sla ? ` · ${sla}` : ""}`;
  });

  const kb = Markup.inlineKeyboard([
    ...items.map((c, i) => {
      const openId = c.id || c.submission_id;
      return [Markup.button.callback(`Open ${i + 1}`, `OPENCARD:${openId}`)];
    }),
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);

  await smartRender(ctx, `${header}\n\n${lines.join("\n\n")}`, kb);
}

// -------------------- THREAD VIEW (PAGINATED) --------------------
function formatMessageLineFull(m) {
  const who = m.direction === "inbound" ? "⬅️ Inbound" : "➡️ Outbound";
  const t = m.created_at ? fmtISOShort(m.created_at) : "";
  const body = String(m.body || m.preview || "").trim();
  return `${who} · ${t}\n${body.length ? body : "(empty)"}`;
}

async function showThread(ctx, convId, offset = 0) {
  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Thread not found.");

  const total = await sbCountMessages(convId);
  const limit = 5;
  const msgs = await sbListMessages(convId, { limit, offset });

  const header =
    `${headerLine("thread", "full")}\n` +
    `${conv.subject || "Thread"}\n${laneLabel(sourceSafe(conv.source))}\n💬 Messages: ${total}\nShowing: ${
      offset + 1
    }-${Math.min(offset + limit, total)}`;

  const body = msgs.length
    ? msgs.map(formatMessageLineFull).join("\n\n--------------------\n\n")
    : "(No messages yet)";

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  const kb = Markup.inlineKeyboard([
    [
      ...(hasPrev ? [Markup.button.callback("◀️ Older", `THREAD:${convId}:${prevOffset}`)] : []),
      ...(hasNext ? [Markup.button.callback("▶️ Newer", `THREAD:${convId}:${nextOffset}`)] : []),
    ],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);

  await ctx.reply(`${header}\n\n${body}`, kb);
}

// -------------------- CONVERSATION CARD --------------------
async function buildConversationText(conv) {
  const updatedIso = conv.updated_at || conv.created_at;
  const title = `${conv.subject || "Thread"}${conv.coach_name ? ` — ${conv.coach_name}` : ""}`;

  const msgCount = await sbCountMessages(conv.id);

  const createdLine = conv.created_at ? `⏱ Created: ${fmtISOShort(conv.created_at)}` : "";
  const updatedLine = conv.updated_at ? `⏱ Updated: ${fmtISOShort(conv.updated_at)}` : "";

  return `${headerLine(conv.pipeline, conv.source || "all")}
${conv.urgent ? "‼️ URGENT\n" : ""}${title}

${laneLabel(sourceSafe(conv.source))}
${slaBadge(updatedIso)}
${fmtCountdown(updatedIso)}

💬 Messages: ${msgCount}

${[createdLine, updatedLine].filter(Boolean).join("\n")}`.trim();
}

function buildConversationKeyboard(conv) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧵 Open Thread", `THREAD:${conv.id}:0`)],
    [Markup.button.callback("🧹 Dismiss", `DELETECONFIRM:conv:${conv.id}`)],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- SUBMISSION CARD --------------------
function sentBadge(v) {
  if (v === true) return "✅";
  if (v === false) return "❌";
  return "—";
}

function formatSubmissionPayloadBlock(payloadObj) {
  const sp = payloadObj || null;
  if (!sp || typeof sp !== "object") return "";

  const interests =
    Array.isArray(sp.interests) && sp.interests.length ? sp.interests.map((i) => `- ${i}`).join("\n") : "- —";

  return `📄 Submission Details
Name: ${sp.name || "—"}
Role: ${sp.role || "—"}
Athlete Name: ${sp.athleteName || sp.athlete_name || "—"}
Sport: ${sp.sport || "—"}
School: ${sp.school || "—"}
Email: ${sp.email || "—"}
Phone: ${sp.phone || "—"}

Interested In:
${interests}

Notes:
${String(sp.message || sp.notes || "—")}`;
}

function buildSubmissionText(sub) {
  const createdLine = sub.created_at ? `⏱ Created: ${fmtISOShort(sub.created_at)}` : "";
  const payloadBlock = formatSubmissionPayloadBlock(sub.submission_payload);

  const deliveryLines = [];
  deliveryLines.push(`Email Sent ${sentBadge(sub.email_sent)}`);
  deliveryLines.push(`Text Sent ${sentBadge(sub.text_sent)}`);
  if (sub.email_error) deliveryLines.push(`Email Error: ${shorten(sub.email_error, 140)}`);
  if (sub.text_error) deliveryLines.push(`Text Error: ${shorten(sub.text_error, 140)}`);

  return `${headerLine("website_submissions", "all")}

🧾 Submission ID: ${sub.submission_id || "—"}

${payloadBlock ? payloadBlock + "\n\n" : ""}${createdLine}

${deliveryLines.join("\n")}`.trim();
}

function buildSubmissionKeyboard(submission_id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧹 Dismiss", `DELETECONFIRM:sub:${submission_id}`)],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- CLIENTS --------------------
async function clientsText() {
  const { data, error } = await supabase.schema("ops").from("people").select("*").order("updated_at", { ascending: false }).limit(12);
  const rows = error ? [] : data || [];

  if (!rows.length) {
    return `👥 Clients

(No clients in ops.people yet)

Clients appear when /webhook/person is used.`;
  }

  const lines = rows.map((p, i) => {
    const nm = p.name || p.email || p.phone || idShort(p.id);
    const st = p.status || "new";
    const coach = p.coach_id ? ` · Coach: ${p.coach_id}` : "";
    return `${i + 1}. ${shorten(nm, 40)} · ${st}${coach}`;
  });

  return `👥 Clients\n\n${lines.join("\n")}`;
}

function clientsKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "DASH:back")]]);
}

// -------------------- CALLS --------------------
function oneLineCall(c, idx) {
  const when = c.scheduled_at ? fmtISOShort(c.scheduled_at) : c.created_at ? fmtISOShort(c.created_at) : "";
  const parent = c.parent_name || "Parent";
  const phone = c.parent_phone ? ` · ${c.parent_phone}` : "";
  const coach = c.coach_name ? ` · ${c.coach_name}` : c.coach_id ? ` · ${c.coach_id}` : "";
  const status = c.status ? ` · ${c.status}` : "";
  return `${idx}. ${parent}${phone}${coach}\n🗓 ${when}${status}`;
}

async function callsHubText() {
  const rows = await sbListCalls({ limit: 10 });
  if (!rows.length) {
    return `📱 Calls

(No calls yet)

Calls appear from /webhook/call.`;
  }
  const lines = rows.map((c, i) => oneLineCall(c, i + 1)).join("\n\n");
  return `📱 Calls\n\n${lines}`;
}

function callsHubKeyboard(rows) {
  const kbRows = (rows || []).slice(0, 10).map((c, i) => [Markup.button.callback(`Open ${i + 1}`, `CALL:${c.id}`)]);
  return Markup.inlineKeyboard([
    ...kbRows,
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

async function callCardText(call) {
  const when = call.scheduled_at ? new Date(call.scheduled_at).toLocaleString("en-US") : "—";
  return `${headerLine("calls", "all")}

📘 Status: ${call.status || "—"}
🗓 Scheduled: ${when}

Parent: ${call.parent_name || "—"}
Phone: ${call.parent_phone || "—"}
Email: ${call.parent_email || "—"}

Coach: ${call.coach_name || "—"}
Coach ID: ${call.coach_id || "—"}

Notes: ${call.notes || "—"}`.trim();
}

function callCardKeyboard(call_id) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Completed", `CALLSTATUS:${call_id}:completed`), Markup.button.callback("🪃 Rescheduled", `CALLSTATUS:${call_id}:rescheduled`)],
    [Markup.button.callback("🚫 Canceled", `CALLSTATUS:${call_id}:canceled`), Markup.button.callback("❌ Unresolved", `CALLSTATUS:${call_id}:unresolved`)],
    [Markup.button.callback("⬅️ Calls", "CALLS:hub")],
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- TODAY --------------------
async function todayText(filterSource = "all") {
  const ny = nyParts(new Date());
  const filterLabel =
    filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" : "🌐 All";

  const urgent = await sbCountConversations({ pipeline: "urgent", source: filterSource });
  const needs = await sbCountConversations({ pipeline: "needs_reply", source: filterSource });
  const waiting = await sbCountConversations({ pipeline: "actions_waiting", source: filterSource });
  const active = await sbCountConversations({ pipeline: "active", source: filterSource });
  const followups = await sbCountConversations({ pipeline: "followups", source: filterSource });
  const submissions = filterSource === "programs" ? 0 : await sbCountSubmissions();
  const calls = await sbCountCalls();

  return `📅 Today Ops
NY ${ny.dayKey} ${ny.time}
Filter: ${filterLabel}

‼️ Urgent: ${urgent}
📝 Needs Reply: ${needs}
⏳ Waiting: ${waiting}
💬 Active: ${active}
📚 Follow-Ups: ${followups}
🧾 Submissions: ${submissions}
📱 Calls: ${calls}`;
}

function todayKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Open ‼️ Urgent", "VIEW:urgent"), Markup.button.callback("Open 📝 Reply", "VIEW:needs_reply")],
    [Markup.button.callback("Open ⏳ Waiting", "VIEW:actions_waiting"), Markup.button.callback("Open 💬 Active", "VIEW:active")],
    [Markup.button.callback("Open 📚 Follow-Ups", "VIEW:followups"), Markup.button.callback("Open 📨 Forwarded", "VIEW:forwarded")],
    [Markup.button.callback("Open 🧾 Submissions", "VIEW:website_submissions"), Markup.button.callback("📱 Calls", "CALLS:hub")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- SEARCH --------------------
function parseSearch(q) {
  const out = { text: "", coach: null, email: null, source: null, pipeline: null, overdue: false };
  const parts = String(q || "").trim().split(/\s+/).filter(Boolean);
  const free = [];
  for (const p of parts) {
    const [k, ...rest] = p.split(":");
    const v = rest.join(":");
    if (k === "coach" && v) out.coach = v;
    else if (k === "email" && v) out.email = v;
    else if (k === "source" && v) out.source = v;
    else if (k === "pipeline" && v) out.pipeline = v;
    else if (k === "overdue" && v === "true") out.overdue = true;
    else free.push(p);
  }
  out.text = free.join(" ");
  return out;
}

async function sbSearchConversations(filterSource, query) {
  const f = parseSearch(query);

  let q = supabase.schema("ops").from("conversations").select("*").order("updated_at", { ascending: false }).limit(10);

  const src = f.source ? sourceSafe(f.source) : null;
  const effectiveSource = src || (filterSource !== "all" ? sourceSafe(filterSource) : null);
  if (effectiveSource) q = q.eq("source", effectiveSource);

  if (f.pipeline) q = q.eq("pipeline", f.pipeline);
  if (f.coach) q = q.ilike("coach_id", `%${f.coach}%`);
  if (f.email) q = q.ilike("contact_email", `%${f.email}%`);
  if (f.text) q = q.ilike("subject", `%${f.text}%`);

  const { data, error } = await q;
  const rows = error ? [] : data || [];

  const filtered = f.overdue
    ? rows.filter((r) => minsUntilUrgent(r.updated_at || r.created_at) <= 0)
    : rows;

  return filtered;
}

function searchHelpText() {
  return `🔎 Search

Format:
- free text searches subject first
- filters:
  coach:<id-part>
  email:<email-part>
  source:programs|support
  pipeline:urgent|needs_reply|actions_waiting|active|followups|forwarded|completed
  overdue:true

Example:
coach:john pipeline:needs_reply
email:gmail.com overdue:true`;
}
function searchHelpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Run Search", "SEARCH:prompt")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}
const pendingSearch = new Map(); // adminId -> awaiting boolean

// -------------------- FOLLOWUPS GROUPED (coach-based) --------------------
async function showFollowupsGroupedByCoach(ctx, filterSource) {
  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("coach_id,coach_name,source,pipeline,updated_at")
    .eq("pipeline", "followups")
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = error ? [] : data || [];
  const filtered = rows.filter((r) => {
    if (!r.coach_id) return false;
    if (filterSource !== "all" && sourceSafe(r.source) !== sourceSafe(filterSource)) return false;
    return true;
  });

  if (!filtered.length) {
    await smartRender(
      ctx,
      `📚 Follow-Ups (Grouped)\n\n(None right now)`,
      Markup.inlineKeyboard([[Markup.button.callback("🗂 All Queues", "ALLQ:open")]])
    );
    return;
  }

  const byCoach = new Map();
  for (const r of filtered) {
    const k = String(r.coach_id);
    byCoach.set(k, (byCoach.get(k) || 0) + 1);
  }

  const coachIds = Array.from(byCoach.keys()).slice(0, 12);
  const coaches = [];
  for (const id of coachIds) {
    const c = await sbGetCoach(id);
    coaches.push(c || { coach_id: id, coach_name: id });
  }

  const lines = coaches.map((c, i) => {
    const count = byCoach.get(c.coach_id) || 0;
    const name = c.coach_name || c.coach_id || "Coach";
    const program = c.program_name ? ` · ${shorten(c.program_name, 34)}` : "";
    return `${i + 1}) ${shorten(name, 42)}${program}\n📚 Follow-Ups: ${count}`;
  });

  const kb = Markup.inlineKeyboard([
    ...coaches.map((c, i) => [Markup.button.callback(`${i + 1}) Open 🌊 Pool`, `POOLCOACH:${c.coach_id}`)]),
    [Markup.button.callback("🗂 All Queues", "ALLQ:open")],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);

  await smartRender(ctx, `📚 Follow-Ups (Grouped by Coach)\n\n${lines.join("\n\n")}`, kb);
}

// -------------------- METRICS (simple view) --------------------
async function metricsText(filterSource = "all") {
  // Minimal metrics view (safe if your metric_events schema changes)
  const scope = filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" : "🌐 Company";
  const { count, error } = await supabase
    .schema("ops")
    .from("metric_events")
    .select("id", { count: "exact", head: true });

  const total = error ? 0 : count || 0;

  return `📊 Metrics
Scope: ${scope}

Total metric events logged: ${total}

(If you want full breakdown by kind, we can add it without breaking schema.)`;
}
function metricsKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "DASH:back")]]);
}

// =========================================================
// BOT + ADMIN NOTIFY
// =========================================================
const bot = new Telegraf(BOT_TOKEN);

async function notifyAdmins(text) {
  for (const id of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(id, text, Markup.inlineKeyboard([[Markup.button.callback("📅 Today", "TODAY:open")]]));
    } catch (_) {}
  }
}

// Refresh live cards
async function refreshLiveCards() {
  cleanupLiveCards();
  for (const [messageId, meta] of liveCards.entries()) {
    try {
      if (meta.type === "conversation") {
        const conv = await sbGetConversation(meta.ref_id);
        if (!conv) {
          liveCards.delete(messageId);
          continue;
        }
        await bot.telegram.editMessageText(meta.chat_id, messageId, undefined, await buildConversationText(conv), buildConversationKeyboard(conv));
      } else if (meta.type === "submission") {
        const sub = await sbGetSubmission(meta.ref_id);
        if (!sub) {
          liveCards.delete(messageId);
          continue;
        }
        await bot.telegram.editMessageText(meta.chat_id, messageId, undefined, buildSubmissionText(sub), buildSubmissionKeyboard(sub.submission_id));
      }
    } catch (_) {
      liveCards.delete(messageId);
    }
  }
}

// =========================================================
// BOT HANDLERS
// =========================================================
bot.start(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await dashboardText(filterSource), dashboardKeyboard());
});

bot.action("DASH:back", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboard());
});

bot.action("DASH:refresh", async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    await ctx.answerCbQuery("Refreshing…");
  } catch (_) {}
  await refreshLiveCards();
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboard());
});

bot.action(/^FILTER:(all|programs|support)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const val = ctx.match[1];
  setAdminFilter(ctx, val);
  await smartRender(ctx, await dashboardText(val), dashboardKeyboard());
});

// All Queues
bot.action("ALLQ:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await allQueuesText(filterSource), allQueuesKeyboard());
});

// Pools
bot.action("POOLS:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await sbListCoaches({ limit: 12 });
  await smartRender(ctx, await poolsHubText(), poolsHubKeyboard(rows));
});

bot.action(/^POOLCOACH:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const coach_id = ctx.match[1];
  await smartRender(ctx, await poolCoachCardText(coach_id), poolCoachCardKeyboard());
});

// Triage
bot.action("TRIAGE:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await triageText(filterSource), await triageKeyboard(filterSource));
});

// Today
bot.action("TODAY:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await todayText(filterSource), todayKeyboard());
});

// Metrics
bot.action("METRICS:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await smartRender(ctx, await metricsText(filterSource), metricsKeyboard());
});

// Search
bot.action("SEARCH:help", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await smartRender(ctx, searchHelpText(), searchHelpKeyboard());
});

bot.action("SEARCH:prompt", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = String(ctx.from?.id || "");
  pendingSearch.set(id, true);
  await ctx.reply("Send your search query as a message.\n\nExample: coach:john pipeline:needs_reply");
});

// Clients
bot.action("CLIENTS:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await smartRender(ctx, await clientsText(), clientsKeyboard());
});

// Calls
bot.action("CALLS:hub", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await sbListCalls({ limit: 10 });
  await smartRender(ctx, await callsHubText(), callsHubKeyboard(rows));
});

bot.action(/^CALL:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const callId = ctx.match[1];
  const call = await sbGetCall(callId);
  if (!call) return ctx.reply("Call not found.");
  await smartRender(ctx, await callCardText(call), callCardKeyboard(callId));
});

bot.action(/^CALLSTATUS:(.+):(completed|rescheduled|canceled|unresolved)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const callId = ctx.match[1];
  const status = ctx.match[2];
  await sbUpdateCall(callId, { status });
  const call = await sbGetCall(callId);
  await smartRender(ctx, await callCardText(call || { id: callId, status }), callCardKeyboard(callId));
});

// Views (queues)
bot.action(
  /^VIEW:(urgent|needs_reply|actions_waiting|active|followups|forwarded|website_submissions|completed)$/,
  async (ctx) => {
    if (!isAdmin(ctx)) return;

    const key = ctx.match[1];
    const filterSource = getAdminFilter(ctx);

    if (key === "followups") {
      await showFollowupsGroupedByCoach(ctx, filterSource);
      return;
    }

    if (key === "website_submissions") {
      const rows = filterSource === "programs" ? [] : await sbListSubmissions({ limit: 8 });
      await showQueueSummaryList(ctx, "website_submissions", rows, filterSource);
      return;
    }

    const rows = await sbListConversations({ pipeline: key, source: filterSource, limit: 8 });
    await showQueueSummaryList(ctx, key, rows, filterSource);
  }
);

// Thread view
bot.action(/^THREAD:(.+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const convId = ctx.match[1];
  const offset = Number(ctx.match[2] || 0);
  await showThread(ctx, convId, offset);
});

// Open card: conversation OR submission
bot.action(/^OPENCARD:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = ctx.match[1];

  const conv = await sbGetConversation(id);
  if (conv) {
    const msg = await ctx.reply(await buildConversationText(conv), buildConversationKeyboard(conv));
    registerLiveCard(msg, "conversation", conv.id);
    return;
  }

  const sub = await sbGetSubmission(id);
  if (!sub) return ctx.reply("Card not found.");

  const msg = await ctx.reply(buildSubmissionText(sub), buildSubmissionKeyboard(sub.submission_id));
  registerLiveCard(msg, "submission", sub.submission_id);
});

// Delete confirmation
bot.action(/^DELETECONFIRM:(conv|sub):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const kind = ctx.match[1];
  const id = ctx.match[2];

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🗑 Yes, delete", `DELETE:${kind}:${id}`), Markup.button.callback("Cancel", "DASH:back")],
  ]);

  await smartRender(ctx, `Confirm delete?\n${kind}:${idShort(id)}`, kb);
});

bot.action(/^DELETE:(conv|sub):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  const kind = ctx.match[1];
  const id = ctx.match[2];

  try {
    if (kind === "conv") {
      await supabase.schema("ops").from("conversations").delete().eq("id", id);
      await supabase.schema("ops").from("messages").delete().eq("conversation_id", id);
    } else {
      await sbDeleteSubmission(id);
    }
  } catch (_) {}

  await smartRender(ctx, "Deleted.", Markup.inlineKeyboard([[Markup.button.callback("🗂 All Queues", "ALLQ:open")]]));
});

// Text handler (search input)
bot.on("text", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const id = String(ctx.from?.id || "");
  if (!pendingSearch.get(id)) return;

  pendingSearch.delete(id);

  const filterSource = getAdminFilter(ctx);
  const query = ctx.message?.text || "";
  const rows = await sbSearchConversations(filterSource, query);

  if (!rows.length) {
    await ctx.reply("No results.", Markup.inlineKeyboard([[Markup.button.callback("⬅️ Dashboard", "DASH:back")]]));
    return;
  }

  const header = `🔎 Search Results · ${filterSource}\nQuery: ${shorten(query, 80)}\n\n`;
  const lines = rows.slice(0, 10).map((c, i) => {
    const subj = shorten(c.subject || "Thread", 56);
    const lane = laneLabel(sourceSafe(c.source));
    const sla = slaBadge(c.updated_at || c.created_at);
    return `${i + 1}. ${subj}\n${lane} · ${sla}`;
  });

  const kb = Markup.inlineKeyboard([
    ...rows.slice(0, 10).map((c, i) => [Markup.button.callback(`Open ${i + 1}`, `OPENCARD:${c.id}`)]),
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);

  await ctx.reply(header + lines.join("\n\n"), kb);
});

// =========================================================
// EXPRESS WEBHOOKS
// =========================================================
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("ok"));

// Gmail webhook
app.post("/webhook/gmail", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const p = req.body || {};
  const thread_key = String(p.thread_key || "");
  if (!thread_key) return res.status(400).json({ ok: false, error: "missing thread_key" });

  const source = sourceSafe(p.source || "programs");
  const pipeline = String(p.pipeline || "active");

  const coach_id = p.coach_id || null;
  const coach_name = p.coach_name || null;

  const convId = await sbUpsertConversationByThreadKey(thread_key, {
    source,
    pipeline,
    coach_id,
    coach_name,
    subject: p.subject || null,
    preview: p.preview || null,
    contact_email: p.contact_email || null,
    gmail_url: p.gmail_url || null,
    mirror_conversation_id: p.mirror_conversation_id || null,
    owned_by: p.owned_by || null,
    cc_support_suggested: !!p.cc_support_suggested,
    urgent: !!p.urgent,
    completed_at: p.completed_at || null,
    created_at: p.created_at || isoNow(),
  });

  if (p.message) {
    await sbInsertMessage({
      conversation_id: convId,
      direction: p.message.direction || "inbound",
      from_email: p.message.from_email || null,
      to_email: p.message.to_email || null,
      body: p.message.body || "",
      preview: p.message.preview || null,
      created_at: p.message.created_at || isoNow(),
      provider_message_id: p.message.provider_message_id || null,
    }).catch(() => {});
  }

  if (coach_id) {
    await sbUpsertCoach({ coach_id, coach_name, program_name: p.program_name || null }).catch(() => {});
    // if your pipeline generator includes metric counters, keep it safe:
    if (p.metric_kind && typeof p.metric_kind === "string") {
      await sbCoachInc(coach_id, { [p.metric_kind]: 1 }).catch(() => {});
    }
  }

  if (pipeline === "urgent" || p.urgent) {
    await notifyAdmins("📌 Complete Daily Operations");
  }

  return res.json({ ok: true, id: convId });
});

// Submission webhook
app.post("/webhook/submission", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const p = req.body || {};
  const submission_id = String(p.submission_id || p.id || "");
  if (!submission_id) return res.status(400).json({ ok: false, error: "missing submission_id" });

  const payload = {
    submission_id,
    submission_payload: p.submission_payload || p.payload || p.data || null,
    email_sent: typeof p.email_sent === "boolean" ? p.email_sent : undefined,
    text_sent: typeof p.text_sent === "boolean" ? p.text_sent : undefined,
    email_error: p.email_error || null,
    text_error: p.text_error || null,
    created_at: p.created_at || isoNow(),
  };

  await supabase.schema("ops").from("submissions").upsert(payload, { onConflict: "submission_id" }).catch(() => {});
  await notifyAdmins("📌 Complete Daily Operations");
  return res.json({ ok: true });
});

// Call webhook
app.post("/webhook/call", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const p = req.body || {};
  const id = await sbInsertCall({
    scheduled_at: p.scheduled_at || null,
    coach_id: p.coach_id || null,
    coach_name: p.coach_name || null,
    parent_name: p.parent_name || null,
    parent_phone: p.parent_phone || null,
    parent_email: p.parent_email || null,
    source: p.source || "calendly",
    status: p.status || "booked",
    notes: p.notes || null,
    meta: p.meta || null,
  }).catch(() => null);

  await notifyAdmins("📌 Complete Daily Operations");
  return res.json({ ok: true, id });
});

// Person webhook
app.post("/webhook/person", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const p = req.body || {};
  const id = await sbUpsertPerson({
    coach_id: p.coach_id || null,
    name: p.name || null,
    email: p.email || null,
    phone: p.phone || null,
    status: p.status || "new",
    summary: p.summary || null,
    meta: p.meta || null,
    last_activity_at: p.last_activity_at || isoNow(),
  }).catch(() => null);

  return res.json({ ok: true, id });
});

// Metric webhook
app.post("/webhook/metric", async (req, res) => {
  if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

  const p = req.body || {};
  const kind = String(p.kind || "");
  if (!kind) return res.status(400).json({ ok: false, error: "missing kind" });

  const payload = {
    id: uuidv4(),
    kind,
    coach_id: p.coach_id || null,
    link: p.link || null,
    meta: p.meta || null,
    created_at: p.created_at || isoNow(),
  };

  await supabase.schema("ops").from("metric_events").insert(payload).catch(() => {});
  if (p.coach_id) {
    // keep coach pool properties consistent
    await sbCoachInc(p.coach_id, { clicks: 1 }).catch(() => {});
    await sbCoachSet(p.coach_id, { last_click_at: isoNow() }).catch(() => {});
  }

  return res.json({ ok: true });
});

// =========================================================
// LAUNCH
// =========================================================
(async () => {
  try {
    await bot.launch();
    console.log("Bot launched:", CODE_VERSION);
  } catch (e) {
    console.error("Bot launch error", e);
  }

  app.listen(PORT, () => {
    console.log(`HTTP listening on ${PORT}`);
  });
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));