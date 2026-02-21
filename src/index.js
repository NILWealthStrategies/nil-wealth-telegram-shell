/**
 * NIL Wealth Telegram Ops Shell — SUPABASE OPS (Index.js v2.7)
 *
 * Updates from v2.6 (per Andrew’s requirements):
 * - ✅ EMOJIS RESTORED across UI (dashboard, buttons, labels, views).
 * - ✅ "Completed Reply’s" renamed to "👍Completed" AND removed as a dashboard button.
 *   (Still appears on dashboard under Queues.)
 * - ✅ Metrics section on MAIN dashboard now lists:
 *   Engagement
 *   Exploration
 *   (stacked like the queue list)
 * - ✅ Main button label changed to "📅Today" (not "📅TODAY" / not "TODAY 📅")
 * - ✅ Metrics screen: remove BOTH Today options entirely.
 *   Only Week / Month / Year windows. No Today button. No Today window.
 *
 * Node 18+ recommended (for fetch)
 */

require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

// -------------------- VERSION MARKERS --------------------
const CODE_VERSION = "Index.js v2.7";
const BUILD_VERSION =
  process.env.BUILD_VERSION ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.RENDER_SERVICE_ID ||
  "dev-unknown";

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

// Optional send webhook (Make/n8n). If empty, sends are stubbed.
const MAKE_SEND_WEBHOOK_URL = process.env.MAKE_SEND_WEBHOOK_URL || "";

// Urgent policy
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES || 180); // 3h
const URGENT_COOLDOWN_HOURS = Number(process.env.URGENT_COOLDOWN_HOURS || 72);

// Completion policy (support only)
const COMPLETE_AFTER_HOURS = Number(process.env.COMPLETE_AFTER_HOURS || 48); // 48h default

// Support identity
const SUPPORT_FROM_EMAIL =
  process.env.SUPPORT_FROM_EMAIL || "support@mynilwealthstrategies.com";

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

// -------------------- HELPERS --------------------
function nowMs() {
  return Date.now();
}
function isoNow() {
  return new Date().toISOString();
}
function isAdmin(ctx) {
  if (!ADMIN_IDS.length) return true;
  return ADMIN_IDS.includes(String(ctx.from?.id || ""));
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
function replyLabel(mode) {
  // identity-first labels (used in confirmations)
  return mode === "support" ? "🧑‍🧒 Support" : "📣 Outreach";
}

// Urgent countdown + SLA
function minsUntilUrgent(updatedAtIso) {
  const updated = new Date(updatedAtIso).getTime();
  const deadline = updated + URGENT_AFTER_MINUTES * 60 * 1000;
  const diffMs = deadline - nowMs();
  const diffMins = Math.ceil(diffMs / (60 * 1000));
  return diffMins; // can be negative
}
function fmtCountdown(updatedAtIso) {
  const m = minsUntilUrgent(updatedAtIso);
  const mmAbs = Math.abs(m);
  const h = Math.floor(mmAbs / 60);
  const mm = mmAbs % 60;
  if (m <= 0) return `⏳ 0h 0m until Urgent`;
  return `⏳ ${h}h ${mm}m until Urgent`;
}
function slaBadge(updatedAtIso) {
  const m = minsUntilUrgent(updatedAtIso);
  if (m <= 0) return "🔴 Overdue";
  if (m <= 60) return "🟡 Due soon";
  return "🟢 On track";
}

// Timezone-safe NY parts
function nyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

// DST-perfect boundaries require Luxon; this is best-effort ops boundaries.
function startOfNYDayISO(date = new Date()) {
  const p = nyParts(date);
  const nyMidnightStr = `${p.month}/${p.day}/${p.year} 00:00:00`;
  const nyMidnight = new Date(nyMidnightStr + " GMT-0500");
  return nyMidnight.toISOString();
}
function startOfNYWeekISO(date = new Date()) {
  const d = new Date(date);
  const ny = nyParts(d);
  const approxNY = new Date(
    `${ny.month}/${ny.day}/${ny.year} 12:00:00 GMT-0500`
  );
  const day = approxNY.getDay(); // 0=Sun
  const diffToMon = (day + 6) % 7; // Mon=0
  approxNY.setDate(approxNY.getDate() - diffToMon);
  const p2 = nyParts(approxNY);
  const weekStart = new Date(
    `${p2.month}/${p2.day}/${p2.year} 00:00:00 GMT-0500`
  );
  return weekStart.toISOString();
}
function startOfNYMonthISO(date = new Date()) {
  const p = nyParts(date);
  const nyStartStr = `${p.month}/01/${p.year} 00:00:00`;
  const nyStart = new Date(nyStartStr + " GMT-0500");
  return nyStart.toISOString();
}
function startOfNYYearISO(date = new Date()) {
  const p = nyParts(date);
  const nyStartStr = `01/01/${p.year} 00:00:00`;
  const nyStart = new Date(nyStartStr + " GMT-0500");
  return nyStart.toISOString();
}
function fmtISOShort(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

// -------------------- SUPABASE QUERIES (CONVERSATIONS) --------------------
async function sbCountConversations({ pipeline, source }) {
  let q = supabase
    .schema("ops")
    .from("conversations")
    .select("id", { count: "exact", head: true });
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

async function sbListConversationsByCoach({
  coach_id,
  pipeline,
  source = "all",
  limit = 8,
}) {
  let q = supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .eq("coach_id", coach_id)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (pipeline) q = q.eq("pipeline", pipeline);
  if (source !== "all") q = q.eq("source", sourceSafe(source));
  const { data, error } = await q;
  if (error) return [];
  return data || [];
}

async function sbCountConversationsByCoach({ coach_id, pipeline, source = "all" }) {
  let q = supabase
    .schema("ops")
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("coach_id", coach_id);

  if (pipeline) q = q.eq("pipeline", pipeline);
  if (source !== "all") q = q.eq("source", sourceSafe(source));
  const { count, error } = await q;
  if (error) return 0;
  return count || 0;
}

async function sbGetConversation(id) {
  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

async function sbUpsertConversationByThreadKey(thread_key, fields) {
  const payload = {
    thread_key,
    ...fields,
    updated_at: isoNow(),
  };

  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .upsert(payload, { onConflict: "thread_key" })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

async function sbUpdateConversation(id, fields) {
  const payload = { ...fields, updated_at: isoNow() };
  const { error } = await supabase
    .schema("ops")
    .from("conversations")
    .update(payload)
    .eq("id", id);
  if (error) throw new Error(error.message);
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

async function sbCountMessages(conversation_id) {
  const { count, error } = await supabase
    .schema("ops")
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation_id);

  if (error) return 0;
  return count || 0;
}

// -------------------- COACH KPI + POOLS --------------------
async function sbUpsertCoach({ coach_id, coach_name, program_name }) {
  const payload = {
    coach_id,
    coach_name: coach_name || null,
    program_name: program_name || null,
    updated_at: isoNow(),
    created_at: isoNow(),
  };

  const { error } = await supabase
    .schema("ops")
    .from("coaches")
    .upsert(payload, { onConflict: "coach_id" });

  // ignore if table not created yet
  if (error) return false;
  return true;
}

async function sbCoachInc(coach_id, fields) {
  const { data, error } = await supabase
    .schema("ops")
    .from("coaches")
    .select("*")
    .eq("coach_id", coach_id)
    .single();

  if (error) return false;

  const next = { ...data };
  for (const k of Object.keys(fields || {})) {
    next[k] = Number(next[k] || 0) + Number(fields[k] || 0);
  }
  next.updated_at = isoNow();

  const { error: e2 } = await supabase
    .schema("ops")
    .from("coaches")
    .update(next)
    .eq("coach_id", coach_id);

  if (e2) return false;
  return true;
}

async function sbCoachSet(coach_id, fields) {
  const payload = { ...fields, updated_at: isoNow() };
  const { error } = await supabase
    .schema("ops")
    .from("coaches")
    .update(payload)
    .eq("coach_id", coach_id);
  if (error) return false;
  return true;
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

async function sbGetCoach(coach_id) {
  const { data, error } = await supabase
    .schema("ops")
    .from("coaches")
    .select("*")
    .eq("coach_id", coach_id)
    .single();
  if (error) return null;
  return data;
}

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

  const { error } = await supabase
    .schema("ops")
    .from("people")
    .upsert(payload, { onConflict: "id" });

  if (error) return null;
  return id;
}

async function sbListPeopleByCoach(coach_id, { limit = 12 } = {}) {
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

async function sbGetPerson(person_id) {
  const { data, error } = await supabase
    .schema("ops")
    .from("people")
    .select("*")
    .eq("id", person_id)
    .single();
  if (error) return null;
  return data;
}

async function sbInsertCoachEvent({ coach_id, kind, link, person_id, meta }) {
  const payload = {
    id: uuidv4(),
    coach_id,
    kind,
    link: link || null,
    person_id: person_id || null,
    meta: meta || null,
    created_at: isoNow(),
  };
  await supabase.schema("ops").from("coach_events").insert(payload).catch(() => {});
}

// -------------------- METRICS (ops.metric_events) --------------------
function timeWindowSinceISO(which) {
  // NOTE: "today" intentionally removed from Metrics UI, but kept for internal flexibility.
  if (which === "today") return startOfNYDayISO(new Date());
  if (which === "week") return startOfNYWeekISO(new Date());
  if (which === "month") return startOfNYMonthISO(new Date());
  return startOfNYYearISO(new Date());
}

async function sbCountMetric(kind, { scope = "company", sinceIso } = {}) {
  let q = supabase
    .schema("ops")
    .from("metric_events")
    .select("id", { count: "exact", head: true })
    .eq("kind", kind)
    .gte("created_at", sinceIso);

  if (scope === "programs") q = q.not("coach_id", "is", null);
  if (scope === "support") q = q.is("coach_id", null);

  const { count, error } = await q;
  if (error) return 0;
  return count || 0;
}

async function sbMetricsSummary({ scope = "company", sinceIso } = {}) {
  // anchors
  const programLinkOpens = await sbCountMetric("program_link_open", { scope, sinceIso });
  const coverageExploration = await sbCountMetric("coverage_exploration", { scope, sinceIso });

  // programs extras
  const parentGuideClicks = await sbCountMetric("parent_guide_click", { scope, sinceIso });
  const guideClicks = await sbCountMetric("guide_click", { scope, sinceIso });
  const websiteClicks = await sbCountMetric("website_click", { scope, sinceIso });

  // support extras
  const taxEducationClicks = await sbCountMetric("tax_education_click", { scope, sinceIso });
  const riskAwarenessClicks = await sbCountMetric("risk_awareness_click", { scope, sinceIso });
  const shClicks = await sbCountMetric("sh_click", { scope, sinceIso });

  const websiteSubmissions = await sbCountMetric("website_submission", { scope, sinceIso });
  const eappClicks = await sbCountMetric("eapp_click", { scope, sinceIso });
  const enrollClicks = await sbCountMetric("enroll_click", { scope, sinceIso });

  return {
    programLinkOpens,
    coverageExploration,
    parentGuideClicks,
    guideClicks,
    websiteClicks,
    taxEducationClicks,
    riskAwarenessClicks,
    shClicks,
    websiteSubmissions,
    eappClicks,
    enrollClicks,
  };
}

function scopeFromFilter(filterSource) {
  if (filterSource === "programs") return "programs";
  if (filterSource === "support") return "support";
  return "company";
}

// -------------------- SEARCH --------------------
function parseSearch(q) {
  const out = {
    text: "",
    coach: null,
    email: null,
    source: null,
    pipeline: null,
    overdue: false,
    dueToday: false,
  };

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
    else if (k === "due" && v === "today") out.dueToday = true;
    else free.push(p);
  }

  out.text = free.join(" ");
  return out;
}

async function sbSearchConversations(filterSource, query) {
  const f = parseSearch(query);

  let q = supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(10);

  const src = f.source ? sourceSafe(f.source) : null;
  const effectiveSource =
    src || (filterSource !== "all" ? sourceSafe(filterSource) : null);
  if (effectiveSource) q = q.eq("source", effectiveSource);

  if (f.pipeline) q = q.eq("pipeline", f.pipeline);
  if (f.coach) q = q.ilike("coach_id", `%${f.coach}%`);
  if (f.email) q = q.ilike("contact_email", `%${f.email}%`);

  if (f.text) q = q.ilike("subject", `%${f.text}%`);

  const { data, error } = await q;
  if (error) return [];

  if (f.text && (!data || !data.length)) {
    let q2 = supabase
      .schema("ops")
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(10);

    if (effectiveSource) q2 = q2.eq("source", effectiveSource);
    if (f.pipeline) q2 = q2.eq("pipeline", f.pipeline);
    if (f.coach) q2 = q2.ilike("coach_id", `%${f.coach}%`);
    if (f.email) q2 = q2.ilike("contact_email", `%${f.email}%`);
    q2 = q2.ilike("preview", `%${f.text}%`);

    const { data: d2 } = await q2;
    return applyLocalDueFilters(d2 || [], f);
  }

  return applyLocalDueFilters(data || [], f);
}

function applyLocalDueFilters(rows, f) {
  if (f.overdue)
    return rows.filter((r) => minsUntilUrgent(r.updated_at || r.created_at) <= 0);
  if (f.dueToday)
    return rows.filter((r) => minsUntilUrgent(r.updated_at || r.created_at) <= 24 * 60);
  return rows;
}

// -------------------- BOT + NOTIFY --------------------
const bot = new Telegraf(BOT_TOKEN);

async function notifyAdmins(text, extra = {}) {
  for (const id of ADMIN_IDS) {
    try {
      if (extra?.keyboard) {
        await bot.telegram.sendMessage(id, text, extra.keyboard);
      } else {
        await bot.telegram.sendMessage(id, text);
      }
    } catch (_) {}
  }
}

// -------------------- UI BUILDERS (SUMMARY CARDS) --------------------
async function buildConversationSummary(conv) {
  const msgCount = await sbCountMessages(conv.id);

  const { data: lastTwo, error } = await supabase
    .schema("ops")
    .from("messages")
    .select("*")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(2);

  const rows = error ? [] : lastTwo || [];
  const lastInbound = rows.find((m) => m.direction === "inbound");
  const lastOutbound = rows.find((m) => m.direction === "outbound");

  return {
    msgCount,
    lastInboundPreview: lastInbound
      ? shorten(lastInbound.preview || lastInbound.body, 180)
      : "",
    lastOutboundPreview: lastOutbound
      ? shorten(lastOutbound.preview || lastOutbound.body, 180)
      : "",
  };
}

async function buildConversationText(conv) {
  const title = `${conv.subject ? conv.subject : "Thread"}${
    conv.coach_name ? ` — ${conv.coach_name}` : ""
  }`;

  const updatedIso = conv.updated_at || conv.created_at;
  const sla = slaBadge(updatedIso);
  const countdown = fmtCountdown(updatedIso);

  const linkedLine = conv.mirror_conversation_id
    ? `🔗 Linked · 🪞 ${idShort(conv.mirror_conversation_id)}`
    : "";

  const gmailLine = conv.gmail_url ? `📬 Gmail ready` : "";

  const createdLine = conv.created_at ? `🕒 Created: ${fmtISOShort(conv.created_at)}` : "";
  const updatedLine = conv.updated_at ? `🕒 Updated: ${fmtISOShort(conv.updated_at)}` : "";
  const doneLine = conv.completed_at ? `✅ Done: ${fmtISOShort(conv.completed_at)}` : "";
  const tsBlock = [createdLine, updatedLine, doneLine].filter(Boolean).join("\n");

  const urgentBadge = conv.urgent ? "‼️ URGENT" : "";
  const laneLine = `${laneLabel(sourceSafe(conv.source))}`;

  const lockLine = conv.owned_by
    ? `🔒 Owned by ${conv.owned_by === "support" ? "🧑‍🧒 Support" : "📣 Outreach"}`
    : "";

  const summary = await buildConversationSummary(conv);
  const summaryBlock = [
    `💬 Messages: ${summary.msgCount}`,
    summary.lastInboundPreview ? `⬅️ Inbound: ${summary.lastInboundPreview}` : null,
    summary.lastOutboundPreview ? `➡️ Outbound: ${summary.lastOutboundPreview}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${urgentBadge ? urgentBadge + "\n" : ""}${title}

${laneLine}
${lockLine ? lockLine + "\n" : ""}${sla}
${countdown}

${summaryBlock}

${[linkedLine, gmailLine].filter(Boolean).join("\n")}

${tsBlock}`.trim();
}

function buildConversationKeyboard(conv) {
  const ccSuggested = !!conv.cc_support_suggested;

  const sendLabel = ccSuggested ? "🟢Reply + CC" : "⚪️Reply";
  const sendCb = ccSuggested ? `SEND:${conv.id}:1` : `SEND:${conv.id}:0`;

  const mirrorBtn = conv.mirror_conversation_id
    ? Markup.button.callback("🪞 Open Mirror", `OPENMIRROR:${conv.id}`)
    : null;

  const gmailBtn = conv.gmail_url ? Markup.button.url("📬 Open in Gmail", conv.gmail_url) : null;
  const rowMirrorGmail = [mirrorBtn, gmailBtn].filter(Boolean);

  return Markup.inlineKeyboard([
    [Markup.button.callback("🧾 Open Thread", `THREAD:${conv.id}:0`)],
    ...(rowMirrorGmail.length ? [rowMirrorGmail] : []),
    [
      Markup.button.callback(
        ccSuggested ? "🟢 CC Suggested" : "⚪ CC Suggested",
        `CC:${conv.id}`
      ),
      Markup.button.callback(sendLabel, sendCb),
    ],
    [Markup.button.callback("🧹 Dismiss", `DISMISS:${conv.id}`)],
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);
}

// -------------------- SUMMARY LIST VIEWS (NO BULKY CARDS) --------------------
function oneLineSummary(conv, idx) {
  const who = conv.coach_name ? ` — ${conv.coach_name}` : "";
  const subj = shorten(conv.subject || "Thread", 52);
  const sla = slaBadge(conv.updated_at || conv.created_at);
  const lane = sourceSafe(conv.source) === "support" ? "🧑‍🧒 Support" : "🏈 Programs";
  return `${idx}. ${subj}${who} · ${lane} · ${sla}`;
}

function viewTitle(key) {
  const map = {
    urgent: "‼️ Urgent",
    needs_reply: "⚪️ Needs Reply",
    actions_waiting: "⏳ Actions Waiting",
    active: "🟦 Active Conversations",
    followups: "🔁 Follow-Ups Needed",
    forwarded: "📨 Forwarded Messages",
    completed: "👍Completed",
    search: "🔎 Search Results",
  };
  return map[key] || key;
}

async function showQueueSummaryList(ctx, key, rows, filterSource) {
  const header = `${viewTitle(key)} (${filterSource})\n${CODE_VERSION} · ${String(
    BUILD_VERSION
  ).slice(0, 8)}\n`;

  if (!rows.length) {
    await ctx.reply(
      `${header}\n(None right now)`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  const lines = rows
    .slice(0, 8)
    .map((c, i) => oneLineSummary(c, i + 1))
    .join("\n");

  const kbRows = rows.slice(0, 8).map((c, i) => [
    Markup.button.callback(`Open ${i + 1}`, `OPENCARD:${c.id}`),
    Markup.button.callback(`Thread`, `THREAD:${c.id}:0`),
  ]);

  const kb = Markup.inlineKeyboard([
    ...kbRows,
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);

  await ctx.reply(`${header}\n${lines}`, kb);
}

// -------------------- THREAD VIEW (FULL TEXT, PAGINATED) --------------------
function formatMessageLineFull(m) {
  const who = m.direction === "inbound" ? "⬅️ Inbound" : "➡️ Outbound";
  const t = m.created_at ? new Date(m.created_at).toLocaleString() : "";
  const body = String(m.body || m.preview || "").trim(); // FULL TEXT (no shorten)
  const safeBody = body.length ? body : "(empty)";
  return `${who} · ${t}\n${safeBody}`;
}

async function showThread(ctx, convId, offset = 0) {
  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Thread not found.");

  const total = await sbCountMessages(convId);
  const limit = 5;
  const msgs = await sbListMessages(convId, { limit, offset });

  const header = `🧾 Thread (Full)\n${conv.subject || "Thread"}\n${laneLabel(
    sourceSafe(conv.source)
  )}\n💬 Messages: ${total}\nShowing: ${offset + 1}-${Math.min(offset + limit, total)}`;

  const body = msgs.length
    ? msgs.map(formatMessageLineFull).join("\n\n--------------------\n\n")
    : "(No messages yet)";

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;

  const kb = Markup.inlineKeyboard([
    [
      ...(hasPrev
        ? [Markup.button.callback("◀️ Older", `THREAD:${convId}:${prevOffset}`)]
        : []),
      ...(hasNext
        ? [Markup.button.callback("▶️ Newer", `THREAD:${convId}:${nextOffset}`)]
        : []),
    ],
    [Markup.button.callback("⬅️ Back to Card", `OPENCARD:${convId}`)],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);

  await ctx.reply(`${header}\n\n${body}`, kb);
}

// -------------------- DASHBOARD --------------------
async function dashboardCounts(filterSource = "all") {
  const urgentCount = await sbCountConversations({
    pipeline: "urgent",
    source: filterSource,
  });
  const needsReplyCount = await sbCountConversations({
    pipeline: "needs_reply",
    source: filterSource,
  });
  const waitingCount = await sbCountConversations({
    pipeline: "actions_waiting",
    source: filterSource,
  });
  const activeCount = await sbCountConversations({
    pipeline: "active",
    source: filterSource,
  });
  const followCount = await sbCountConversations({
    pipeline: "followups",
    source: filterSource,
  });
  const forwardedCount = await sbCountConversations({
    pipeline: "forwarded",
    source: filterSource,
  });

  // 👍Completed is support-only completed queue (count only)
  const completedCount =
    filterSource === "programs"
      ? 0
      : await sbCountConversations({ pipeline: "completed", source: "support" });

  const scope = scopeFromFilter(filterSource);
  const metricsTop = await sbMetricsSummary({
    scope,
    sinceIso: startOfNYYearISO(new Date()),
  });

  return {
    urgentCount,
    needsReplyCount,
    waitingCount,
    activeCount,
    followCount,
    forwardedCount,
    completedCount,
    metricsTop,
  };
}

async function dashboardText(filterSource = "all") {
  const ny = nyParts(new Date());
  const counts = await dashboardCounts(filterSource);

  const filterLabel =
    filterSource === "support"
      ? "🧑‍🧒 Support"
      : filterSource === "programs"
      ? "🏈 Programs"
      : "🌐 All";

  const scopeTitle =
    filterSource === "support"
      ? "📊 Metrics (Support)"
      : filterSource === "programs"
      ? "📊 Metrics (Programs)"
      : "📊 Metrics (Company)";

  const m = counts.metricsTop;

  return `🏈 NIL Wealth Ops Dashboard
${CODE_VERSION} · Build: ${String(BUILD_VERSION).slice(0, 8)}

🗓️ Today: ${new Date().toLocaleString()}
🕒 NY Time: ${ny.dayKey} ${ny.time}
🎛️ Filter: ${filterLabel}

📥 Queues
‼️ Urgent: ${counts.urgentCount}
⚪️ Needs Reply: ${counts.needsReplyCount}
⏳ Waiting: ${counts.waitingCount}
🟦 Active: ${counts.activeCount}
🔁 Follow-Ups: ${counts.followCount}
📨 Forwarded: ${counts.forwardedCount}
👍Completed: ${counts.completedCount}

${scopeTitle}
Engagement: ${m.programLinkOpens} opens
Exploration: ${m.coverageExploration}

(Tap 📊 Metrics for full breakdown)

Use buttons below.`;
}

function dashboardKeyboard(_filterSource = "all") {
  const srcBtn = Markup.button.callback("🌐 All", "FILTER:all");
  const progBtn = Markup.button.callback("🏈 Programs", "FILTER:programs");
  const supBtn = Markup.button.callback("🧑‍🧒 Support", "FILTER:support");

  return Markup.inlineKeyboard([
    [srcBtn, progBtn, supBtn],
    [
      Markup.button.callback("📅Today", "TODAY:open"),
      Markup.button.callback("📊 Metrics", "METRICS:open"),
      Markup.button.callback("🔎 Search", "SEARCH:help"),
    ],
    [
      Markup.button.callback("‼️ Urgent", "VIEW:urgent"),
      Markup.button.callback("⚪️ Reply", "VIEW:needs_reply"),
      Markup.button.callback("⏳ Waiting", "VIEW:actions_waiting"),
    ],
    [
      Markup.button.callback("🟦 Active", "VIEW:active"),
      Markup.button.callback("🔁 Follow-Ups", "VIEW:followups"),
      Markup.button.callback("📨 Forwarded", "VIEW:forwarded"),
    ],
    [
      Markup.button.callback("📞 Calls", "CALLS:hub"),
      Markup.button.callback("🔄 Refresh", "DASH:refresh"),
    ],
  ]);
}

// -------------------- TODAY 📅 VIEW (NO "DONE" PIECE) --------------------
async function todayCounts(filterSource = "all") {
  const urgent = await sbCountConversations({ pipeline: "urgent", source: filterSource });
  const needs = await sbCountConversations({ pipeline: "needs_reply", source: filterSource });
  const waiting = await sbCountConversations({
    pipeline: "actions_waiting",
    source: filterSource,
  });
  const active = await sbCountConversations({ pipeline: "active", source: filterSource });
  const followups = await sbCountConversations({ pipeline: "followups", source: filterSource });
  return { urgent, needs, waiting, active, followups };
}

async function todayText(filterSource = "all") {
  const ny = nyParts(new Date());
  const filterLabel =
    filterSource === "support"
      ? "🧑‍🧒 Support"
      : filterSource === "programs"
      ? "🏈 Programs"
      : "🌐 All";

  const c = await todayCounts(filterSource);

  return (
    `📌 Today Ops (NY ${ny.dayKey})\n` +
    `${CODE_VERSION} · ${String(BUILD_VERSION).slice(0, 8)}\n` +
    `🎛️ Filter: ${filterLabel}\n\n` +
    `‼️ Urgent: ${c.urgent}\n` +
    `⚪️ Needs Reply: ${c.needs}\n` +
    `⏳ Waiting: ${c.waiting}\n` +
    `🟦 Active: ${c.active}\n` +
    `🔁 Follow-Ups: ${c.followups}\n\n` +
    `Use buttons below.`
  );
}

function todayKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Open ‼️ Urgent", "VIEW:urgent"),
      Markup.button.callback("Open ⚪️ Reply", "VIEW:needs_reply"),
    ],
    [
      Markup.button.callback("Open ⏳ Waiting", "VIEW:actions_waiting"),
      Markup.button.callback("Open 🟦 Active", "VIEW:active"),
    ],
    [
      Markup.button.callback("Open 🔁 Follow-Ups", "VIEW:followups"),
      Markup.button.callback("Open 📨 Forwarded", "VIEW:forwarded"),
    ],
    [
      Markup.button.callback("📊 Metrics", "METRICS:open"),
      Markup.button.callback("📞 Calls", "CALLS:hub"),
    ],
    [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
  ]);
}

// -------------------- METRICS UI (NO TODAY OPTIONS) --------------------
async function metricsText(filterSource = "all", which = "week") {
  const scope = scopeFromFilter(filterSource);
  const sinceIso = timeWindowSinceISO(which);

  const title =
    scope === "programs"
      ? "📊 Metrics (🏈 Programs)"
      : scope === "support"
      ? "📊 Metrics (🧑‍🧒 Support)"
      : "📊 Metrics (🌐 Company)";

  const m = await sbMetricsSummary({ scope, sinceIso });

  const lines = [];
  lines.push(title);
  lines.push(`🗓️ Window: ${which.toUpperCase()}`);
  lines.push("");

  // anchors
  lines.push(`Engagement (Program Link Opens): ${m.programLinkOpens}`);
  lines.push(`Exploration (Coverage Exploration): ${m.coverageExploration}`);
  lines.push("");

  // full named metrics ONLY inside Metrics view
  if (scope === "programs") {
    lines.push(`Parent Guide Clicks: ${m.parentGuideClicks}`);
    lines.push(`Guide Clicks: ${m.guideClicks}`);
    lines.push(`Website Clicks: ${m.websiteClicks}`);
  } else if (scope === "support") {
    lines.push(`Tax Education Clicks: ${m.taxEducationClicks}`);
    lines.push(`Risk Awareness Clicks: ${m.riskAwarenessClicks}`);
    lines.push(`Parent Guide Clicks: ${m.parentGuideClicks}`);
    lines.push(`Supplemental Health Clicks: ${m.shClicks}`);
    lines.push(`Website Submissions: ${m.websiteSubmissions}`);
    lines.push(`eApp Clicks: ${m.eappClicks}`);
    lines.push(`Enroll Clicks: ${m.enrollClicks}`);
  } else {
    lines.push(`Parent Guide Clicks: ${m.parentGuideClicks}`);
    lines.push(`Guide Clicks: ${m.guideClicks}`);
    lines.push(`Website Clicks: ${m.websiteClicks}`);
    lines.push("");
    lines.push(`Tax Education Clicks: ${m.taxEducationClicks}`);
    lines.push(`Risk Awareness Clicks: ${m.riskAwarenessClicks}`);
    lines.push(`Supplemental Health Clicks: ${m.shClicks}`);
    lines.push("");
    lines.push(`Website Submissions: ${m.websiteSubmissions}`);
    lines.push(`eApp Clicks: ${m.eappClicks}`);
    lines.push(`Enroll Clicks: ${m.enrollClicks}`);
  }

  return lines.join("\n");
}

function metricsKeyboard() {
  // IMPORTANT: only Week / Month / Year. NO TODAY anywhere.
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Week", "METRICS:week"),
      Markup.button.callback("Month", "METRICS:month"),
      Markup.button.callback("Year", "METRICS:year"),
    ],
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);
}

// -------------------- STATE --------------------
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

// -------------------- COMMANDS --------------------
bot.start(async (ctx) => {
  await ctx.reply(
    `✅ Connected.\n${CODE_VERSION} · Build: ${String(BUILD_VERSION).slice(0, 8)}\nType /dashboard`
  );
});

bot.command("dashboard", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await dashboardText(filterSource), dashboardKeyboard(filterSource));
});

bot.command("search", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const filterSource = getAdminFilter(ctx);
  const q = String(ctx.message?.text || "")
    .replace(/^\/search\s*/i, "")
    .trim();
  if (!q) {
    await ctx.reply(
      `🔎 Search usage:\n/search your text\n/search coach:ABC source:support pipeline:needs_reply\n/search overdue:true\n/search due:today`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  const rows = await sbSearchConversations(filterSource, q);
  if (!rows.length) {
    await ctx.reply(
      `🔎 No matches for: ${q}`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  await ctx.reply(
    `🔎 Results (${rows.length}) for: ${q}\n(Showing summary list — tap Open)`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );

  await showQueueSummaryList(ctx, "search", rows.slice(0, 8), filterSource);
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

// Filter
bot.action(/^FILTER:(all|programs|support)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const v = ctx.match[1];
  setAdminFilter(ctx, v);
  await ctx.reply(await dashboardText(v), dashboardKeyboard(v));
});

// Search help
bot.action("SEARCH:help", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await ctx.reply(
    `🔎 Search usage:\n/search your text\n/search coach:ABC source:support pipeline:needs_reply\n/search overdue:true\n/search due:today`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// TODAY 📅
bot.action("TODAY:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await todayText(filterSource), todayKeyboard());
});

// Metrics open + window switches (default -> WEEK)
bot.action("METRICS:open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await metricsText(filterSource, "week"), metricsKeyboard());
});
bot.action(/^METRICS:(week|month|year)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const which = ctx.match[1];
  const filterSource = getAdminFilter(ctx);
  await ctx.reply(await metricsText(filterSource, which), metricsKeyboard());
});

// -------------------- VIEWS --------------------
bot.action(
  /^VIEW:(urgent|needs_reply|actions_waiting|active|followups|forwarded)$/,
  async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();

    const key = ctx.match[1];
    const filterSource = getAdminFilter(ctx);

    // Special: Follow-Ups should be COACH-GROUPED
    if (key === "followups") {
      await showFollowupsGroupedByCoach(ctx, filterSource);
      return;
    }

    const rows = await sbListConversations({ pipeline: key, source: filterSource, limit: 8 });
    await showQueueSummaryList(ctx, key, rows, filterSource);
  }
);

// Thread view actions
bot.action(/^THREAD:(.+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const convId = ctx.match[1];
  const offset = Number(ctx.match[2] || 0);
  await showThread(ctx, convId, offset);
});

bot.action(/^OPENCARD:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const convId = ctx.match[1];
  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Card not found.");
  await ctx.reply(await buildConversationText(conv), buildConversationKeyboard(conv));
});

// -------------------- MIRROR OPEN --------------------
bot.action(/^OPENMIRROR:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const convId = ctx.match[1];
  const conv = await sbGetConversation(convId);
  if (!conv || !conv.mirror_conversation_id) return ctx.reply("No mirror linked.");
  const mirror = await sbGetConversation(conv.mirror_conversation_id);
  if (!mirror) return ctx.reply("Mirror not found.");
  await ctx.reply(`🔗 Opening mirror 🪞 ${idShort(mirror.id)}`);
  await ctx.reply(await buildConversationText(mirror), buildConversationKeyboard(mirror));
});

// -------------------- CC SUGGESTED TOGGLE + MIRROR CREATION --------------------
async function createSupportMirrorConversation(programConv) {
  const mirrorThreadKey = `mirror:${programConv.thread_key}`;

  const mirrorId = await sbUpsertConversationByThreadKey(mirrorThreadKey, {
    source: "support",
    pipeline: programConv.pipeline || "actions_waiting",
    coach_id: programConv.coach_id || null,
    coach_name: programConv.coach_name || null,
    contact_email: programConv.contact_email || null,
    subject: programConv.subject ? `🪞 ${programConv.subject}` : "🪞 Support Mirror",
    preview: programConv.preview || null,
    gmail_url: programConv.gmail_url || null,
    inbound_from_email: SUPPORT_FROM_EMAIL,
    cc_support_suggested: true,
    escalated_to_support: true,
    mirror_conversation_id: programConv.id,
    owned_by: "support",
    urgent: !!programConv.urgent,
    urgent_since: programConv.urgent_since || null,
    cooldown_until: programConv.cooldown_until || null,
    created_at: isoNow(),
  });

  await sbUpdateConversation(programConv.id, {
    mirror_conversation_id: mirrorId,
    escalated_to_support: true,
  });

  return mirrorId;
}

bot.action(/^CC:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const convId = ctx.match[1];
  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Card not found.");

  const turningOn = !conv.cc_support_suggested;
  await sbUpdateConversation(convId, { cc_support_suggested: turningOn });

  const src = sourceSafe(conv.source);
  if (src === "programs" && turningOn && !conv.mirror_conversation_id) {
    const mirrorId = await createSupportMirrorConversation(conv);
    await ctx.reply(`🟢 CC Suggested ON\n🔗 Linked mirror created 🪞 ${idShort(mirrorId)}`);
    return;
  }

  await ctx.reply(`CC Suggested: ${turningOn ? "🟢 ON" : "⚪ OFF"}`);
});

// -------------------- DISMISS --------------------
bot.action(/^DISMISS:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const convId = ctx.match[1];
  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Card not found.");

  try {
    await supabase.schema("ops").from("messages").delete().eq("conversation_id", convId);
  } catch (_) {}

  const { error } = await supabase.schema("ops").from("conversations").delete().eq("id", convId);
  if (error) return ctx.reply(`Dismiss error: ${error.message}`);

  await ctx.reply(
    "🧹 Dismissed.",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// -------------------- SEND FLOW (ASK WHO -> CONFIRM -> SEND) --------------------
async function resolveFromEmail(conv, sendAs) {
  const src = sourceSafe(conv.source);
  if (src === "support") return SUPPORT_FROM_EMAIL;
  if (sendAs === "support") return SUPPORT_FROM_EMAIL;
  return conv.inbound_from_email || null;
}

async function sendOut(conv, { ccSupport, sendAs }) {
  const payload = {
    code_version: CODE_VERSION,
    build: String(BUILD_VERSION),

    conversation_id: conv.id,
    thread_key: conv.thread_key,
    source: sourceSafe(conv.source),

    coach_id: conv.coach_id,
    coach_name: conv.coach_name,
    contact_email: conv.contact_email,
    subject: conv.subject,

    body: "",

    cc_support: !!ccSupport,
    cc_support_suggested: !!conv.cc_support_suggested,

    send_as: sendAs, // 'support'|'outreach'
    from_email: await resolveFromEmail(conv, sendAs),

    mirror_conversation_id: conv.mirror_conversation_id || null,
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

// Send button pressed: programs asks identity; support goes straight to confirm
bot.action(/^SEND:(.+):([01])$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const convId = ctx.match[1];
  const cc = ctx.match[2] === "1";

  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Card not found.");

  const src = sourceSafe(conv.source);

  if (src === "support") {
    await ctx.reply(
      `Send as: ${replyLabel("support")}\n\nAre you sure you want to send?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes, Send", `DOSEND:${convId}:${cc ? 1 : 0}:support`)],
        [Markup.button.callback("⬅️ Cancel", "DASH:back")],
      ])
    );
    return;
  }

  // Programs lane: enforce lock if set
  const owned = conv.owned_by; // 'support'|'outreach'|null
  if (owned === "support" || owned === "outreach") {
    const fixed = owned;
    await ctx.reply(
      `🔒 Owned by ${fixed === "support" ? "🧑‍🧒 Support" : "📣 Outreach"}\nSend as: ${replyLabel(
        fixed
      )}\n\nAre you sure you want to send?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes, Send", `DOSEND:${convId}:${cc ? 1 : 0}:${fixed}`)],
        [Markup.button.callback("⬅️ Cancel", "DASH:back")],
      ])
    );
    return;
  }

  // No lock: ask identity FIRST
  await ctx.reply(
    `Send this as who?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📣 Outreach", `CONFIRMSEND:${convId}:${cc ? 1 : 0}:outreach`),
        Markup.button.callback("🧑‍🧒 Support", `CONFIRMSEND:${convId}:${cc ? 1 : 0}:support`),
      ],
      [Markup.button.callback("⬅️ Cancel", "DASH:back")],
    ])
  );
});

// Identity selected -> confirm sure
bot.action(/^CONFIRMSEND:(.+):([01]):(support|outreach)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const convId = ctx.match[1];
  const cc = ctx.match[2] === "1";
  const sendAs = ctx.match[3];

  await ctx.reply(
    `Send as: ${replyLabel(sendAs)}\n\nAre you sure you want to send?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Yes, Send", `DOSEND:${convId}:${cc ? 1 : 0}:${sendAs}`)],
      [Markup.button.callback("⬅️ Cancel", "DASH:back")],
    ])
  );
});

// Do send -> append outbound message + lock rules + NO instant completion
bot.action(/^DOSEND:(.+):([01]):(support|outreach)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();

  const convId = ctx.match[1];
  const cc = ctx.match[2] === "1";
  const sendAs = ctx.match[3];

  const conv = await sbGetConversation(convId);
  if (!conv) return ctx.reply("Card not found.");

  const src = sourceSafe(conv.source);
  const effectiveSendAs = src === "support" ? "support" : sendAs;

  // If Programs + CC => ensure mirror exists and lock ownership to Support
  let mirrorId = conv.mirror_conversation_id || null;
  if (src === "programs" && cc) {
    if (!mirrorId) {
      mirrorId = await createSupportMirrorConversation(conv);
      const refreshed = await sbGetConversation(convId);
      if (refreshed) {
        await sbUpdateConversation(convId, { owned_by: "support" });
        if (refreshed.mirror_conversation_id) {
          await sbUpdateConversation(refreshed.mirror_conversation_id, { owned_by: "support" });
        }
      }
      await ctx.reply(`🔗 Support linked ✅ · 🪞 ${idShort(mirrorId)}`);
    } else {
      await sbUpdateConversation(convId, { owned_by: "support" });
      try {
        await sbUpdateConversation(mirrorId, { owned_by: "support" });
      } catch (_) {}
    }
  }

  const out = await sendOut(conv, { ccSupport: cc, sendAs: effectiveSendAs });

  // Outbound message on the original conversation
  await sbInsertMessage({
    conversation_id: convId,
    direction: "outbound",
    from_email: await resolveFromEmail(conv, effectiveSendAs),
    to_email: conv.contact_email || null,
    body: `(Sent via Telegram as ${effectiveSendAs})`,
    created_at: isoNow(),
  });

  // If Programs + CC: also write an outbound message to the SUPPORT mirror thread
  if (src === "programs" && cc && mirrorId) {
    try {
      const mirror = await sbGetConversation(mirrorId);
      if (mirror) {
        await sbInsertMessage({
          conversation_id: mirrorId,
          direction: "outbound",
          from_email: SUPPORT_FROM_EMAIL,
          to_email: mirror.contact_email || conv.contact_email || null,
          body: `(CC Support sent via Telegram)`,
          created_at: isoNow(),
        });

        await sbUpdateConversation(mirrorId, {
          pipeline: "active",
          last_outbound_at: isoNow(),
          urgent: false,
          urgent_since: null,
        });
      }
    } catch (_) {}
  }

  const cooldown = new Date(nowMs() + URGENT_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  // NO instant completion: move to active and let auto-complete handle support later
  await sbUpdateConversation(convId, {
    pipeline: "active",
    urgent: false,
    urgent_since: null,
    cooldown_until: cooldown,
    last_outbound_at: isoNow(),
  });

  // KPI: consider this as an "email sent" if coach_id exists
  if (conv.coach_id) {
    await sbUpsertCoach({ coach_id: conv.coach_id, coach_name: conv.coach_name || null });
    await sbCoachInc(conv.coach_id, { emails_total: 1 });
  }

  await ctx.reply(
    out.stub ? "✅ Reply sent (stub)." : `✅ Reply sent. Status: ${out.status}.`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
  );
});

// -------------------- URGENT LOOP (AUTO) --------------------
async function urgentLoop() {
  const { data: rows, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("*")
    .in("pipeline", ["actions_waiting", "needs_reply", "active"])
    .order("updated_at", { ascending: true })
    .limit(250);

  if (error) return;

  const ms = nowMs();
  const tooOldMs = ms - URGENT_AFTER_MINUTES * 60 * 1000;
  const notifyCooldownMs = URGENT_COOLDOWN_HOURS * 60 * 60 * 1000;

  for (const c of rows || []) {
    const updated = new Date(c.updated_at || c.created_at).getTime();
    if (updated > tooOldMs) continue;

    if (c.cooldown_until && ms < new Date(c.cooldown_until).getTime()) continue;

    const lastNotified = c.last_notified_at ? new Date(c.last_notified_at).getTime() : 0;

    try {
      await sbUpdateConversation(c.id, {
        pipeline: "urgent",
        urgent: true,
        urgent_since: c.urgent_since || isoNow(),
        last_notified_at: isoNow(),
      });

      if (ms - lastNotified > notifyCooldownMs) {
        await notifyAdmins(
          `‼️ URGENT\n${c.subject || "Thread"}${c.coach_name ? ` — ${c.coach_name}` : ""}\n${CODE_VERSION} · ${String(
            BUILD_VERSION
          ).slice(0, 8)}`
        );
      }
    } catch (_) {}
  }
}

// -------------------- AUTO COMPLETE (SUPPORT ONLY) --------------------
async function autoCompleteSupportLoop() {
  const cutoffMs = nowMs() - COMPLETE_AFTER_HOURS * 60 * 60 * 1000;

  const { data: rows, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("id,source,pipeline,last_outbound_at,last_inbound_at,updated_at,created_at")
    .eq("source", "support")
    .in("pipeline", ["active", "needs_reply", "actions_waiting", "followups", "urgent"])
    .order("updated_at", { ascending: true })
    .limit(250);

  if (error) return;

  for (const c of rows || []) {
    if (!c.last_outbound_at) continue;

    const lastOut = new Date(c.last_outbound_at).getTime();
    if (lastOut > cutoffMs) continue;

    if (c.last_inbound_at) {
      const lastIn = new Date(c.last_inbound_at).getTime();
      if (lastIn > lastOut) continue;
    }

    try {
      await sbUpdateConversation(c.id, {
        pipeline: "completed",
        completed_at: isoNow(),
        urgent: false,
        urgent_since: null,
      });
    } catch (_) {}
  }
}

// -------------------- DAILY DIGEST (NY 8:30AM) HARD-LOCKED TO ALL --------------------
let lastDigestDayKeyNY = "";

function dailyDigestKeyboard() {
  // Buttons are NOT locked (they behave normally).
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Open ‼️ Urgent", "VIEW:urgent"),
      Markup.button.callback("Open ⚪️ Reply", "VIEW:needs_reply"),
    ],
    [
      Markup.button.callback("Open ⏳ Waiting", "VIEW:actions_waiting"),
      Markup.button.callback("Open 🟦 Active", "VIEW:active"),
    ],
    [
      Markup.button.callback("Open 🔁 Follow-Ups", "VIEW:followups"),
      Markup.button.callback("Open 📨 Forwarded", "VIEW:forwarded"),
    ],
    [
      Markup.button.callback("📅Today", "TODAY:open"),
      Markup.button.callback("📞 Calls", "CALLS:hub"),
    ],
  ]);
}

async function dailyDigestLoopNY() {
  const ny = nyParts(new Date());

  if (ny.dayKey === lastDigestDayKeyNY) return;
  if (Number(ny.hour) === 8 && Number(ny.minute) === 30) {
    lastDigestDayKeyNY = ny.dayKey;

    try {
      // HARD-LOCK counts to ALL (source: "all") regardless of admin filter state.
      const urgent = await sbCountConversations({ pipeline: "urgent", source: "all" });
      const needs = await sbCountConversations({ pipeline: "needs_reply", source: "all" });
      const waiting = await sbCountConversations({ pipeline: "actions_waiting", source: "all" });
      const active = await sbCountConversations({ pipeline: "active", source: "all" });
      const followups = await sbCountConversations({ pipeline: "followups", source: "all" });

      const text =
        `📌 Daily Ops Digest (NY ${ny.dayKey} 08:30)\n` +
        `${CODE_VERSION} · ${String(BUILD_VERSION).slice(0, 8)}\n` +
        `🎛️ Filter: 🌐 ALL (hard-locked)\n\n` +
        `‼️ Urgent: ${urgent}\n` +
        `⚪️ Needs Reply: ${needs}\n` +
        `⏳ Waiting: ${waiting}\n` +
        `🟦 Active: ${active}\n` +
        `🔁 Follow-Ups: ${followups}`;

      await notifyAdmins(text, { keyboard: dailyDigestKeyboard() });
    } catch (_) {}
  }
}

// -------------------- COACH POOLS UI (Calls hub) --------------------
function fmtCoachLine(c, followupCount = null) {
  const name = c.coach_name ? `${c.coach_name}` : c.coach_id;
  const prog = c.program_name ? ` · ${c.program_name}` : "";
  const clicks = Number(c.clicks_total || 0);
  const fwd = Number(c.forwards_total || 0);
  const reps = Number(c.replies_total || 0);
  const sent = Number(c.emails_total || 0);

  const fu = followupCount !== null ? ` · FollowUps: ${followupCount}` : "";
  return `${name}${prog}\n📤 Sent: ${sent} · 💬 Replies: ${reps} · 🔗 Clicks: ${clicks} · 📨 Forwards: ${fwd}${fu}`;
}

async function showCallsHub(ctx) {
  const coaches = await sbListCoaches({ limit: 10 });
  if (!coaches.length) {
    await ctx.reply(
      `📞 Calls (Coach Pools)\n\n(No coaches in ops.coaches yet)\n\nWhen clicks/forwards/people come in, they will appear here.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  const lines = coaches.map((c, i) => `${i + 1}) ${fmtCoachLine(c)}`).join("\n\n");

  const kb = Markup.inlineKeyboard([
    ...coaches.slice(0, 10).map((c, i) => [
      Markup.button.callback(`${i + 1}) Open Coach`, `COACH:${c.coach_id}`),
    ]),
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);

  await ctx.reply(`📞 Calls (Coach Pools)\n${lines}`, kb);
}

async function showCoachOverview(ctx, coach_id) {
  const coach = await sbGetCoach(coach_id);
  if (!coach) {
    await ctx.reply(
      "Coach not found.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "CALLS:hub")]])
    );
    return;
  }

  const followupsCount = await sbCountConversationsByCoach({
    coach_id,
    pipeline: "followups",
    source: "all",
  });
  const forwardedCount = await sbCountConversationsByCoach({
    coach_id,
    pipeline: "forwarded",
    source: "all",
  });
  const needsReplyCount = await sbCountConversationsByCoach({
    coach_id,
    pipeline: "needs_reply",
    source: "all",
  });

  const text =
    `🏈 Coach Pool\n\n` +
    `${fmtCoachLine(coach, followupsCount)}\n\n` +
    `⚪️ Needs Reply: ${needsReplyCount}\n` +
    `📨 Forwarded: ${forwardedCount}\n` +
    `🔁 Follow-Ups: ${followupsCount}\n\n` +
    `🔗 Last Click: ${coach.last_click_at ? fmtISOShort(coach.last_click_at) : "—"}\n` +
    `📨 Last Forward: ${coach.last_forward_at ? fmtISOShort(coach.last_forward_at) : "—"}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("👥 People Pool", `PEOPLE:${coach_id}`),
      Markup.button.callback("📨 Forwarded", `COACHVIEW:${coach_id}:forwarded`),
    ],
    [
      Markup.button.callback("🔁 Follow-Ups", `COACHVIEW:${coach_id}:followups`),
      Markup.button.callback("⚪️ Needs Reply", `COACHVIEW:${coach_id}:needs_reply`),
    ],
    [Markup.button.callback("⬅️ Back", "CALLS:hub")],
  ]);

  await ctx.reply(text, kb);
}

async function showPeoplePool(ctx, coach_id) {
  const coach = await sbGetCoach(coach_id);
  const people = await sbListPeopleByCoach(coach_id, { limit: 12 });

  const title = `👥 People Pool\nCoach: ${coach?.coach_name || coach_id}\nShowing ${people.length}`;

  if (!people.length) {
    await ctx.reply(
      `${title}\n\n(No people yet for this coach)\n\nPeople appear here from /webhook/person or when you choose to attach them in automation.`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", `COACH:${coach_id}`)]])
    );
    return;
  }

  const lines = people
    .map((p, i) => {
      const nm = p.name || p.email || p.phone || idShort(p.id);
      const st = p.status || "new";
      const sm = p.summary ? shorten(p.summary, 80) : "";
      return `${i + 1}. ${nm} · ${st}\n${sm}`;
    })
    .join("\n\n");

  const kb = Markup.inlineKeyboard([
    ...people.slice(0, 12).map((p, i) => [
      Markup.button.callback(`Open ${i + 1}`, `PERSON:${p.id}`),
    ]),
    [Markup.button.callback("⬅️ Back", `COACH:${coach_id}`)],
  ]);

  await ctx.reply(`${title}\n\n${lines}`, kb);
}

async function showPersonOverview(ctx, person_id) {
  const p = await sbGetPerson(person_id);
  if (!p) {
    await ctx.reply(
      "Person not found.",
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "CALLS:hub")]])
    );
    return;
  }

  const text =
    `👤 Person Overview\n\n` +
    `Name: ${p.name || "—"}\n` +
    `Email: ${p.email || "—"}\n` +
    `Phone: ${p.phone || "—"}\n` +
    `Status: ${p.status || "—"}\n` +
    `Coach ID: ${p.coach_id || "—"}\n\n` +
    `Summary:\n${p.summary || "—"}\n\n` +
    `🕒 Created: ${p.created_at ? fmtISOShort(p.created_at) : "—"}\n` +
    `🕒 Updated: ${p.updated_at ? fmtISOShort(p.updated_at) : "—"}\n` +
    `🕒 Last Activity: ${p.last_activity_at ? fmtISOShort(p.last_activity_at) : "—"}`;

  await ctx.reply(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Back to People", `PEOPLE:${p.coach_id}`)],
      [Markup.button.callback("⬅️ Coach", `COACH:${p.coach_id}`)],
      [Markup.button.callback("⬅️ Dashboard", "DASH:back")],
    ])
  );
}

bot.action("CALLS:hub", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  await showCallsHub(ctx);
});

bot.action(/^COACH:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const coachId = ctx.match[1];
  await showCoachOverview(ctx, coachId);
});

bot.action(/^PEOPLE:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const coachId = ctx.match[1];
  await showPeoplePool(ctx, coachId);
});

bot.action(/^PERSON:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const personId = ctx.match[1];
  await showPersonOverview(ctx, personId);
});

bot.action(/^COACHVIEW:(.+):(followups|forwarded|needs_reply)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.answerCbQuery();
  const coachId = ctx.match[1];
  const pipe = ctx.match[2];

  const rows = await sbListConversationsByCoach({
    coach_id: coachId,
    pipeline: pipe,
    source: "all",
    limit: 8,
  });
  await showQueueSummaryList(ctx, pipe, rows, `coach:${coachId}`);
});

// -------------------- FOLLOWUPS (GROUPED BY COACH) --------------------
async function showFollowupsGroupedByCoach(ctx, filterSource) {
  const { data, error } = await supabase
    .schema("ops")
    .from("conversations")
    .select("id,coach_id,coach_name,source,pipeline,updated_at,created_at")
    .eq("pipeline", "followups")
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = error ? [] : data || [];
  if (!rows.length) {
    await ctx.reply(
      `🔁 Follow-Ups (Grouped)\n\n(None right now)`,
      Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "DASH:back")]])
    );
    return;
  }

  const byCoach = new Map();
  for (const r of rows) {
    if (filterSource !== "all" && sourceSafe(r.source) !== sourceSafe(filterSource)) continue;
    const key = r.coach_id || "unknown";
    byCoach.set(key, (byCoach.get(key) || 0) + 1);
  }

  const coachIds = Array.from(byCoach.keys()).slice(0, 10);

  const coaches = [];
  for (const id of coachIds) {
    const c = await sbGetCoach(id);
    coaches.push(
      c || {
        coach_id: id,
        coach_name: rows.find((x) => (x.coach_id || "unknown") === id)?.coach_name || id,
      }
    );
  }

  const lines = coaches
    .map((c, i) => {
      const count = byCoach.get(c.coach_id) || 0;
      return `${i + 1}) ${fmtCoachLine(c, count)}`;
    })
    .join("\n\n");

  const kb = Markup.inlineKeyboard([
    ...coaches.map((c, i) => [
      Markup.button.callback(`${i + 1}) Open Coach`, `COACH:${c.coach_id}`),
      Markup.button.callback("🔁 FollowUps", `COACHVIEW:${c.coach_id}:followups`),
    ]),
    [Markup.button.callback("⬅️ Back", "DASH:back")],
  ]);

  await ctx.reply(`🔁 Follow-Ups (Grouped by Coach)\n\n${lines}`, kb);
}

// -------------------- WEBHOOK SERVER --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, code: CODE_VERSION, build: BUILD_VERSION });
});

/**
 * Unified inbound webhook:
 * POST /webhook/item
 */
app.post("/webhook/item", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const {
      thread_key,
      source,
      direction,
      coach_id,
      coach_name,
      contact_email,
      subject,
      body,
      preview,
      cc_support_suggested,
      gmail_url,
      inbound_from_email,
      provider_message_id,
      pipeline,
    } = req.body || {};

    const src = sourceSafe(source);
    const dir = direction === "outbound" ? "outbound" : "inbound";
    const tk = thread_key || `fallback:${uuidv4()}`;

    if (coach_id) {
      await sbUpsertCoach({ coach_id, coach_name: coach_name || null });
    }

    const convId = await sbUpsertConversationByThreadKey(tk, {
      source: src,
      pipeline: pipeline || (dir === "inbound" ? "needs_reply" : "active"),
      coach_id: coach_id || null,
      coach_name: coach_name || null,
      contact_email: contact_email || null,
      subject: subject || null,
      preview: preview || shorten(body || "", 220),
      gmail_url: gmail_url || null,
      inbound_from_email: inbound_from_email || null,
      cc_support_suggested: !!cc_support_suggested,
      created_at: isoNow(),
      last_inbound_at: dir === "inbound" ? isoNow() : undefined,
      last_outbound_at: dir === "outbound" ? isoNow() : undefined,
    });

    await sbInsertMessage({
      conversation_id: convId,
      direction: dir,
      from_email: dir === "inbound" ? contact_email || null : null,
      to_email: dir === "outbound" ? contact_email || null : null,
      body: body || "",
      preview: preview || shorten(body || "", 220),
      provider_message_id: provider_message_id || null,
      created_at: isoNow(),
    });

    // KPI: inbound reply
    if (dir === "inbound" && coach_id) {
      await sbCoachInc(coach_id, { replies_total: 1 });
      await sbCoachSet(coach_id, { last_reply_at: isoNow() });
      await sbInsertCoachEvent({
        coach_id,
        kind: "reply",
        link: null,
        person_id: null,
        meta: { convId, tk },
      });
    }

    if (dir === "inbound") {
      notifyAdmins(
        `⚪️ Needs Reply\n${subject || "Thread"}${coach_name ? ` — ${coach_name}` : ""}\n${CODE_VERSION} · ${String(
          BUILD_VERSION
        ).slice(0, 8)}`,
        {
          keyboard: Markup.inlineKeyboard([
            [Markup.button.callback("Open ⚪️ Needs Reply", "VIEW:needs_reply")],
            [Markup.button.callback("📅Today", "TODAY:open")],
          ]),
        }
      ).catch(() => {});
    }

    return res.json({ ok: true, conversation_id: convId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Coach click webhook:
 * POST /webhook/click
 */
app.post("/webhook/click", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { coach_id, coach_name, kind, link, person_id, meta } = req.body || {};
    if (!coach_id) return res.status(400).json({ ok: false, error: "coach_id required" });

    await sbUpsertCoach({ coach_id, coach_name: coach_name || null });
    await sbCoachInc(coach_id, { clicks_total: 1 });
    await sbCoachSet(coach_id, { last_click_at: isoNow() });
    await sbInsertCoachEvent({
      coach_id,
      kind: kind || "click",
      link: link || null,
      person_id: person_id || null,
      meta: meta || null,
    });

    // Metrics log (Programs attribution)
    try {
      await supabase.schema("ops").from("metric_events").insert({
        coach_id,
        kind: kind || "program_link_open",
        link: link || null,
        meta: meta || null,
        created_at: isoNow(),
      });
    } catch (_) {}

    // Surface it as "forwarded/click activity" rolling card
    const tk = `coach-signal:${coach_id}`;
    const subject = `Coach Activity Signal — ${coach_name || coach_id}`;
    const bodyText = `🔗 Click reported\nCoach: ${coach_name || coach_id}\nLink: ${link || "—"}\nTime: ${fmtISOShort(
      isoNow()
    )}`;

    const convId = await sbUpsertConversationByThreadKey(tk, {
      source: "programs",
      pipeline: "forwarded",
      coach_id,
      coach_name: coach_name || null,
      subject,
      preview: shorten(bodyText, 220),
      created_at: isoNow(),
    });

    await sbInsertMessage({
      conversation_id: convId,
      direction: "inbound",
      from_email: null,
      to_email: null,
      body: bodyText,
      preview: shorten(bodyText, 220),
      created_at: isoNow(),
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Support / Company metric webhook:
 * POST /webhook/metric
 */
app.post("/webhook/metric", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { coach_id, kind, link, meta } = req.body || {};
    if (!kind) return res.status(400).json({ ok: false, error: "kind required" });

    await supabase.schema("ops").from("metric_events").insert({
      coach_id: coach_id || null,
      kind,
      link: link || null,
      meta: meta || null,
      created_at: isoNow(),
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Coach forward webhook:
 * POST /webhook/forward
 */
app.post("/webhook/forward", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { coach_id, coach_name, thread_key, meta } = req.body || {};
    if (!coach_id) return res.status(400).json({ ok: false, error: "coach_id required" });

    await sbUpsertCoach({ coach_id, coach_name: coach_name || null });
    await sbCoachInc(coach_id, { forwards_total: 1 });
    await sbCoachSet(coach_id, { last_forward_at: isoNow() });
    await sbInsertCoachEvent({ coach_id, kind: "forward", link: null, person_id: null, meta: meta || null });

    const tk = thread_key || `coach-forward:${coach_id}`;
    const subject = `Coach Forwarded — ${coach_name || coach_id}`;
    const bodyText = `📨 Forward signal\nCoach: ${coach_name || coach_id}\nTime: ${fmtISOShort(isoNow())}`;

    const convId = await sbUpsertConversationByThreadKey(tk, {
      source: "programs",
      pipeline: "forwarded",
      coach_id,
      coach_name: coach_name || null,
      subject,
      preview: shorten(bodyText, 220),
      created_at: isoNow(),
    });

    await sbInsertMessage({
      conversation_id: convId,
      direction: "inbound",
      body: bodyText,
      preview: shorten(bodyText, 220),
      created_at: isoNow(),
    });

    return res.json({ ok: true, conversation_id: convId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Person webhook:
 * POST /webhook/person
 */
app.post("/webhook/person", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { coach_id, name, email, phone, status, summary, meta, last_activity_at, coach_name } = req.body || {};
    if (!coach_id) return res.status(400).json({ ok: false, error: "coach_id required" });

    await sbUpsertCoach({ coach_id, coach_name: coach_name || null });

    const id = await sbUpsertPerson({
      coach_id,
      name,
      email,
      phone,
      status,
      summary,
      meta,
      last_activity_at: last_activity_at || isoNow(),
    });

    if (!id) return res.status(500).json({ ok: false, error: "people upsert failed (table missing?)" });
    return res.json({ ok: true, person_id: id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Failure inbox hook
app.post("/webhook/failure", async (req, res) => {
  try {
    if (!verifyWebhookSecret(req)) return res.status(401).json({ ok: false });

    const { kind, message, source, payload } = req.body || {};
    const row = {
      id: uuidv4(),
      kind: kind || "unknown",
      message: message || "unknown failure",
      source: source || "unknown",
      payload: payload || req.body || {},
      created_at: isoNow(),
    };

    const { error } = await supabase.schema("ops").from("failures").insert(row);
    if (error) {
      await notifyAdmins(
        `⚠️ FAILURE (db insert failed)\n${row.kind}\n${row.message}\n${CODE_VERSION} · ${String(BUILD_VERSION).slice(0, 8)}`
      );
      return res.json({ ok: false, error: error.message });
    }

    await notifyAdmins(
      `⚠️ FAILURE INBOX\n${row.kind}\n${row.message}\n${CODE_VERSION} · ${String(BUILD_VERSION).slice(0, 8)}`
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}`);
  console.log(`${CODE_VERSION} · Build: ${BUILD_VERSION}`);
});

// -------------------- LOOPS --------------------
setInterval(() => {
  urgentLoop().catch(() => {});
  dailyDigestLoopNY().catch(() => {});
  autoCompleteSupportLoop().catch(() => {});
}, 60 * 1000);

// -------------------- RUN BOT --------------------
bot.launch();
console.log(`Bot running... ${CODE_VERSION} · Build: ${BUILD_VERSION}`);