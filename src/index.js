"use strict";
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const {
  conversationRoleForDisplay,
  idShort,
  isInstantlySource,
  isProgramLane,
  normalizeEmail,
  normalizeRole,
  roleDefaultLane,
  roleDefaultNextAction,
  roleFilterLabel,
  roleLabel,
  roleTag,
  safeStr,
  shorten,
  sourceSafe,
} = require("./lib/core-utils");
const {
  fmtWhen,
  parseIsoOrNull,
  tFmtDateShort,
  tFmtDateTimeShort,
  tFmtMin,
  tFmtTimeShort,
  tSafe,
  tShortProgram,
} = require("./lib/format-utils");
const {
  buildCallCardTextHTML,
  callNeedsAction,
  callStatusLabel,
  callSummaryLine,
} = require("./lib/call-formatters");
const {
  buildConversationCardText,
  convoSummaryLine,
  formatInstantlyTimelineLine,
  formatMessageLineFull,
} = require("./lib/conversation-formatters");
const {
  allQueuesText,
  buildDashboardText,
  buildOpsHealthText,
  buildYearSummaryText,
} = require("./lib/dashboard-formatters");
const {
  buildSubmissionCard,
  coverageLabel,
  emailStatusIcon,
  smsStatusIcon,
} = require("./lib/submission-formatters");
const {
  TRIAGE_CALL_WINDOW_HOURS,
  tCallBtnLabel,
  tCallContext,
  tCallDueAt,
  tCallLine,
  tCallName,
  tCallOpenAction,
  tCallScheduledAt,
  tCallSortKey,
  tCallTypeEmoji,
  tComputeWaitingMinutes,
  tConvoBtnLabel,
  tConvoBtnLabelTriage,
  tConvoLine,
  tDisplayName,
  tFollowupBtnLabel,
  tFollowupLine,
  tFollowupTargetAction,
  tIsCoachThread,
} = require("./lib/triage-formatters");
const {
  capQueueCount,
  headerLine,
  laneLabel,
  sanitizeDisplayText,
  slaBadge,
  smartSortByPriority,
  urgentCountdown,
  viewTitle,
} = require("./lib/view-utils");
// ---------- VERSION ----------
const CODE_VERSION =
"Index.js V6.2";
const BUILD_VERSION =
process.env.BUILD_VERSION ||
process.env.RENDER_GIT_COMMIT ||
process.env.RENDER_SERVICE_ID ||
"dev-unknown";
// ---------- ENV ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
.split(",")
.map((s) => s.trim())
.filter(Boolean);
const PORT = Number(process.env.PORT || 3000);
const BASE_WEBHOOK_SECRET = process.env.BASE_WEBHOOK_SECRET || "";
const OPS_WEBHOOK_HMAC_SECRET = process.env.OPS_WEBHOOK_HMAC_SECRET ||
""; // optional, preferred if set
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
"";
// v5.1 send integration (Make/n8n “send” hook). If empty, send actions stub.
const MAKE_SEND_WEBHOOK_URL = process.env.MAKE_SEND_WEBHOOK_URL || "";
const CC_SUPPORT_WEBHOOK_URL = process.env.CC_SUPPORT_WEBHOOK_URL || "";
const HANDOFF_WEBHOOK_URL = process.env.HANDOFF_WEBHOOK_URL || "";
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 15000);
// policy knobs (same as v5.1)
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES ||
180);
const URGENT_COOLDOWN_HOURS =
Number(process.env.URGENT_COOLDOWN_HOURS || 72);

const COMPLETE_AFTER_HOURS = Number(process.env.COMPLETE_AFTER_HOURS ||
48);
const SUPPORT_FROM_EMAIL =
process.env.SUPPORT_FROM_EMAIL || "support@mynilwealthstrategies.com";
const OUTREACH_FROM_EMAIL = process.env.OUTREACH_FROM_EMAIL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 7000);
// live cards
const LIVE_CARD_TTL_MINUTES = Number(process.env.LIVE_CARD_TTL_MINUTES || 360);
const REFRESH_MIN_INTERVAL_MS = 1200;
const MAX_QUEUE_DISPLAY = 500;
const ENABLE_TELEGRAM_BOT =
String(process.env.ENABLE_TELEGRAM_BOT || "true").toLowerCase() !== "false";
const ENABLE_TELEGRAM_LIVE_REFRESH =
String(process.env.ENABLE_TELEGRAM_LIVE_REFRESH || "true").toLowerCase() !== "false";
// NY time
const NY_TZ = "America/New_York";
// ---------- GUARDS ----------
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!BASE_WEBHOOK_SECRET && !OPS_WEBHOOK_HMAC_SECRET) {
  throw new Error("Missing BASE_WEBHOOK_SECRET or OPS_WEBHOOK_HMAC_SECRET");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
// ---------- CLIENTS ----------
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ========== GLOBAL EXPRESS MIDDLEWARE ==========
// Request size and JSON parsing
app.use(express.json({ limit: "1mb" }));

// Request timeout protection
app.use((req, res, next) => {
  res.setTimeout(30000); // 30 second timeout for all requests
  next();
});

// Comprehensive error logging middleware
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (!res.headersSent) {
      res.setHeader("X-Service-Version", CODE_VERSION);
    }
    return originalJson(body);
  };
  next();
});

// Request validation middleware
app.use((req, res, next) => {
  // Protect against missing/malformed request body
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (!req.body || typeof req.body !== "object") {
      req.body = {};
    }
  }
  next();
});

// Catch unhandled JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    console.error("[SECURITY] Invalid JSON received:", err.message);
    return res.status(400).json({ ok: false, error: "Invalid JSON in request body" });
  }
  next(err);
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
auth: { persistSession: false },
});
const ops = () => supabase.schema("nil");

const _tgSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
bot.telegram.sendMessage = async (...args) => {
  try {
    return await _tgSendMessage(...args);
  } catch (err) {
    console.error("[ERROR] telegram.sendMessage:", err?.message || String(err));
    return null;
  }
};

const _tgEditMessageText = bot.telegram.editMessageText.bind(bot.telegram);
bot.telegram.editMessageText = async (...args) => {
  try {
    return await _tgEditMessageText(...args);
  } catch (err) {
    const msg = String(err?.description || err?.message || "");
    if (!msg.includes("message is not modified")) {
      console.error("[ERROR] telegram.editMessageText:", msg || String(err));
    }
    return null;
  }
};
// ---------- IN-MEMORY FILTER STORAGE ----------
const userFilters = new Map(); // userId -> filter value ("all" | "programs" | "support")
const userRoleFilters = new Map(); // userId -> role filter ("all" | "parent" | "athlete" | "coach" | "trainer" | "other")
const draftEditState = new Map(); // userId -> { convId, version }
const EVENT_TYPES = {
  LEAD_CREATED: "lead.created",
  LEAD_UPDATED: "lead.updated",
  CALENDLY_BOOKED: "calendly.booked",
  CONVERSATION_CREATED: "conversation.created",
  CONVERSATION_UPDATED: "conversation.updated",
  MESSAGE_INGESTED: "message.ingested",
  HANDOFF_DETECTED: "outreach.handoff_detected",
  IDENTITY_LINKED: "conversation.identity_linked",
  OUTBOX_EMAIL_SENT: "outbox.email.sent",
  OUTBOX_EMAIL_FAILED: "outbox.email.failed",
  CC_SUPPORT_ACTIVATED: "cc_support.activated",
  ANALYTICS_RECORDED: "analytics.recorded",
};
// ==========================================================
// CRITICAL: TELEGRAM BOT RELIABILITY WRAPPERS
// ==========================================================

// Operation timeout wrapper - prevents hanging on long operations
function withTimeout(promise, timeoutMs = 25000, errorMsg = "Operation timed out") {
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 25000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMsg)), safeTimeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function postJsonWebhook(url, payload, { timeoutMs = WEBHOOK_TIMEOUT_MS, headers = {} } = {}) {
  if (!url) {
    return { ok: false, status: 503, error: "webhook_url_not_configured", bodyText: "" };
  }

  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : WEBHOOK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      bodyText,
      error: res.ok ? null : "webhook_non_2xx",
    };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return {
      ok: false,
      status: 504,
      error: isAbort ? "webhook_timeout" : String(err?.message || err),
      bodyText: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Retry wrapper for critical webhook operations
async function postJsonWebhookWithRetry(url, payload, { maxRetries = 3, timeoutMs = WEBHOOK_TIMEOUT_MS, headers = {} } = {}) {
  if (!url) {
    return { ok: false, status: 503, error: "webhook_url_not_configured", bodyText: "", attempts: 0 };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await postJsonWebhook(url, payload, { timeoutMs, headers });
      if (result.ok || attempt === maxRetries) {
        return { ...result, attempts: attempt };
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 1000);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const backoffMs = Math.min(100 * Math.pow(2, attempt - 1), 1000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  return {
    ok: false,
    status: 504,
    error: String(lastError?.message || "webhook failed after retries"),
    bodyText: "",
    attempts: maxRetries,
  };
}

function validateOutboundPayload(payload, options = {}) {
  const {
    requireConversationId = true,
    requireThreadKey = true,
    requireSendAs = false,
    requireSubject = false,
    requireBody = false,
    requireCcMessages = false,
  } = options;
  const errors = [];
  const allowedSendAs = new Set(["support", "outreach"]);
  const basicEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["payload_missing_or_invalid"] };
  }

  if (requireConversationId && !payload.conversation_id) {
    errors.push("conversation_id_required");
  }
  if (requireThreadKey && !payload.thread_key) {
    errors.push("thread_key_required");
  }
  if (requireSendAs && !allowedSendAs.has(String(payload.send_as || ""))) {
    errors.push("send_as_invalid");
  }
  if (requireSubject && !String(payload.subject || "").trim()) {
    errors.push("subject_required");
  }
  if (requireBody && !String(payload.body || "").trim()) {
    errors.push("body_required");
  }

  if (payload.from_email && !basicEmailRegex.test(String(payload.from_email).trim())) {
    errors.push("from_email_invalid");
  }

  if (!payload.trace_id) {
    payload.trace_id = makeTraceId();
  }
  if (!payload.idempotency_key) {
    payload.idempotency_key = deriveIdempotencyKey(payload);
  }

  if (requireCcMessages) {
    const bridgeBody = String(payload.bridge_message?.body || "").trim();
    const supportBody = String(payload.support_message?.body || "").trim();
    if (!bridgeBody) errors.push("bridge_message_body_required");
    if (!supportBody) errors.push("support_message_body_required");
  }

  return { ok: errors.length === 0, errors };
}

function logOutboundValidationError(context, payload, errors) {
  console.warn("[VALIDATION] outbound payload rejected", {
    context,
    errors,
    conversation_id: payload?.conversation_id || null,
    thread_key: payload?.thread_key || null,
    event_type: payload?.event_type || null,
    send_as: payload?.send_as || null,
    trace_id: payload?.trace_id || null,
  });
}

// Safe callback query answerer - ALWAYS answers, even on errors
async function safeAnswerCbQuery(ctx, text = undefined) {
  if (!ctx.update?.callback_query?.id) return;
  try {
    await ctx.answerCbQuery(text).catch((err) => {
      const msg = String(err?.description || err?.message || "");
      // Ignore expected errors (already answered, too old, etc.)
      if (
        !msg.includes("query is too old") &&
        !msg.includes("QUERY_ID_INVALID") &&
        !msg.includes("already answered")
      ) {
        console.log(`[WARN] answerCbQuery failed: ${msg}`);
      }
    });
  } catch (_) {}
}

// Action handler wrapper - ensures callbacks are answered and errors handled
function safeAction(handler) {
  return async (ctx) => {
    try {
      // Answer callback query FIRST to stop loading spinner
      await safeAnswerCbQuery(ctx);
      
      // Run handler with timeout
      await withTimeout(
        handler(ctx),
        30000,
        "Action took too long - please try again"
      );
    } catch (err) {
      logError("bot.action", err);
      try {
        // Attempt to show user-friendly error
        const errMsg = String(err?.message || "Unknown error");
        if (errMsg.includes("timed out") || errMsg.includes("timeout")) {
          await ctx.reply("⏱ Request timed out. Please try again.").catch(() => {});
        } else if (errMsg.includes("not found")) {
          await ctx.reply("❌ Item not found. It may have been deleted.").catch(() => {});
        } else {
          await ctx.reply("❌ An error occurred. Please try /dashboard to refresh.").catch(() => {});
        }
      } catch (_) {}
    }
  };
}

// Command handler wrapper - similar protection for commands
function safeCommand(handler) {
  return async (ctx) => {
    try {
      await withTimeout(
        handler(ctx),
        30000,
        "Command took too long - please try again"
      );
    } catch (err) {
      logError("bot.command", err);
      try {
        await ctx.reply("❌ An error occurred. Please try again.").catch(() => {});
      } catch (_) {}
    }
  };
}

// ---------- AUTH ----------
function isAdmin(ctx) {
if (!ADMIN_IDS.length) return true;
return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}
function verifyWebhookSecret(req) {
const got = req.headers["x-nil-secret"];
return got && String(got) === String(BASE_WEBHOOK_SECRET);
}
function verifyHmac(req) {
if (!OPS_WEBHOOK_HMAC_SECRET) return false;

const sig = req.headers["x-ops-signature"];
if (!sig) return false;
const expected = crypto
.createHmac("sha256", OPS_WEBHOOK_HMAC_SECRET)
.update(JSON.stringify(req.body))
.digest("hex");
return String(sig) === String(expected);
}
function verifyOpsIngestAuth(req) {
if (OPS_WEBHOOK_HMAC_SECRET) return verifyHmac(req);
return verifyWebhookSecret(req);
}
// ---------- UTIL ----------
// ---------- ADMIN FILTER HELPER (v5.4) ----------
function getAdminFilter(ctx) {
try {
const userId = String(ctx.from?.id || "");
const legacy =
ctx?.session?.admin_filter ??
ctx?.session?.adminFilter ??
ctx?.state?.admin_filter ??
ctx?.state?.adminFilter ??
ctx?.scene?.state?.admin_filter ??
ctx?.scene?.state?.adminFilter ??
null;
return userFilters.get(userId) || legacy || "all";
} catch (_) {
return "all";
}
}
function setAdminFilter(ctx, v) {
try {
const userId = String(ctx.from?.id || "");
userFilters.set(userId, v);
} catch (_) {}
}
function getAdminRoleFilter(ctx) {
try {
const userId = String(ctx.from?.id || "");
return userRoleFilters.get(userId) || "all";
} catch (_) {
return "all";
}
}
function setAdminRoleFilter(ctx, v) {
try {
const userId = String(ctx.from?.id || "");
userRoleFilters.set(userId, v);
} catch (_) {}
}
// ---------- v5.4 UTILITY FUNCTIONS ----------
function compact(v) {
// Safe string display: converts null/undefined to "—"
if (v === null || v === undefined) return "—";
const s = String(v).trim();
return s.length > 0 ? s : "—";
}
function logError(context, err) {
// Structured error logging (v5.4)
const msg = err?.message || String(err);
const stack = err?.stack || "";
console.error(`[ERROR] ${context}:`, msg);
if (stack && NODE_ENV !== "production") {
console.error(stack);
}
}
function shortErrorReason(err, fallback = "unknown") {
const msg = String(err?.message || err?.details || err?.hint || fallback || "unknown").trim();
if (!msg) return "unknown";
return msg.length > 110 ? `${msg.slice(0, 107)}...` : msg;
}
function buildLoadWarning(label, err = null) {
return `⚠️ Unable to load ${label} right now.\nReason: ${shortErrorReason(err)}\n\nThe queue is still operational; try again in a moment.`;
}
function newTraceId() {
// Generate trace ID for event tracking (v5.4)
return uuidv4();
}
function hashStable(str) {
// Deterministic hash for idempotency keys (v5.4)
if (!str) return String(Date.now());
try {
let hash = 2166136261; // FNV-1a 32-bit offset
for (let i = 0; i < str.length; i++) {
hash ^= str.charCodeAt(i);
hash = Math.imul(hash, 16777619);
}
return (hash >>> 0).toString(16);
} catch (_) {
return String(Date.now());
}
}
async function dbSelectFirst(candidates) {
// Try multiple DB query candidates
// v5.4 pattern for schema compatibility
for (const fn of candidates) {
try {
const result = await fn();
if (result && !result.error && result.data) {
return result;
}
} catch (_) {
// Continue to next candidate
}
}
return { data: null, error: new Error("All DB query candidates failed") };
}
// ---------- END v5.4 UTILITIES ----------
function makeCardKey(entityType, stableId) {
return `${entityType}:${stableId}`;
}
function parseCardKey(ck) {
const s = safeStr(ck);
const i = s.indexOf(":");
if (i === -1) return { entityType: null, stableId: null };
return { entityType: s.slice(0, i), stableId: s.slice(i + 1) };
}
// ---------- NY TIME ----------
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
const tfmt = new Intl.DateTimeFormat("en-US", {
timeZone: NY_TZ,
hour: "numeric",
minute: "2-digit",
hour12: true,
});

const toNyMidnightUtc = (y, m, d) => {
const utcApprox = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0));
const tparts = new Intl.DateTimeFormat("en-US", {
timeZone: NY_TZ,
hour12: false,
hour: "2-digit",
minute: "2-digit",
second: "2-digit",
year: "numeric",
month: "2-digit",
day: "2-digit",
}).formatToParts(utcApprox);
const tget = (type) => tparts.find((p) => p.type === type)?.value;
const nyHour = Number(tget("hour") || 0);
const nyMinute = Number(tget("minute") || 0);
const nySecond = Number(tget("second") || 0);
const nyDay = Number(tget("day") || d);
const dayShift = nyDay - Number(d);
const offsetMinutes = (dayShift * 24 * 60) + (nyHour * 60) + nyMinute + (nySecond / 60);
return new Date(utcApprox.getTime() - (offsetMinutes * 60 * 1000));
};

const dayStartUtc = toNyMidnightUtc(year, month, day);
const nextBase = new Date(dayStartUtc.getTime() + (24 * 60 * 60 * 1000));
const nextParts = fmt.formatToParts(nextBase);
const nget = (type) => nextParts.find((p) => p.type === type)?.value;
const nextYear = nget("year");
const nextMonth = nget("month");
const nextDay = nget("day");
const dayEndUtc = toNyMidnightUtc(nextYear, nextMonth, nextDay);

return {
dayKey: `${year}-${month}-${day}`,
time: tfmt.format(date),
dayStartISO: dayStartUtc.toISOString(),
dayEndISO: dayEndUtc.toISOString(),
};
}
// ---------- OPS EVENTS LEDGER (v5.2) ----------
function deriveIdempotencyKey(evt) {
const raw = JSON.stringify({

event_type: evt.event_type,
source: evt.source,
direction: evt.direction,
entity_type: evt.entity_type || null,
entity_id: evt.entity_id || null,
submission_id: evt.submission_id || null,
payload: evt.payload || null,
});
return crypto.createHash("sha256").update(raw).digest("hex");
}
function deriveInstantlyReplyIdempotencyKey({ leadId, timestamp }) {
  const raw = `instantly_reply|${safeStr(leadId) || "unknown"}|${safeStr(timestamp) || "unknown"}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}
async function sbInsertOpsEvent(evt) {
// requires nil.ops_events (append-only) with unique constraint recommended:
// unique(event_type, idempotency_key)
const row = {
id: uuidv4(),
created_at: new Date().toISOString(),
schema_version: evt.schema_version || "5.3",
event_type: evt.event_type,
source: evt.source,
direction: evt.direction || "inbound",
trace_id: evt.trace_id || uuidv4(),
idempotency_key: evt.idempotency_key || deriveIdempotencyKey(evt),
entity_type: evt.entity_type || null,
entity_id: evt.entity_id || null,
submission_id: evt.submission_id || null,
client_email: evt.client_email || null,
client_phone_e164: evt.client_phone_e164 || null,
payload: evt.payload || null,
};
const { error } = await ops().from("ops_events").insert(row);
if (error) throw new Error(error.message);
}
async function sbInsertOpsEventSafe(evt) {
// Insert with dedupe: if (event_type, idempotency_key) already exists, return { deduped: true }
const row = {
id: uuidv4(),
created_at: new Date().toISOString(),
schema_version: evt.schema_version || "5.3",
event_type: evt.event_type,
source: evt.source,
direction: evt.direction || "inbound",
trace_id: evt.trace_id || uuidv4(),
idempotency_key: evt.idempotency_key || deriveIdempotencyKey(evt),
entity_type: evt.entity_type || null,
entity_id: evt.entity_id || null,
submission_id: evt.submission_id || null,
client_email: evt.client_email || null,
client_phone_e164: evt.client_phone_e164 || null,
payload: evt.payload || null,
};
const { error } = await ops().from("ops_events").insert(row, { onConflict: "ignore" });
if (error?.code === "23505" || error?.message?.includes("duplicate")) {
return { deduped: true };
}
if (error) throw new Error(error.message);
return { deduped: false };
}
function parseDelimitedList(raw) {
if (!raw) return [];
if (Array.isArray(raw)) return raw.filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
return String(raw)
.split(",")
.map((s) => s.trim())
.filter(Boolean);
}
function buildOpsSignature(bodyObj) {
if (!OPS_WEBHOOK_HMAC_SECRET) return "";
return crypto
.createHmac("sha256", OPS_WEBHOOK_HMAC_SECRET)
.update(JSON.stringify(bodyObj))
.digest("hex");
}
async function postOpsIngestEvent(eventBody) {
const headers = { "content-type": "application/json" };
if (BASE_WEBHOOK_SECRET) headers["x-nil-secret"] = BASE_WEBHOOK_SECRET;
if (OPS_WEBHOOK_HMAC_SECRET) {
headers["x-ops-signature"] = buildOpsSignature(eventBody);
}
const resp = await fetch(`http://127.0.0.1:${PORT}/ops/ingest`, {
method: "POST",
headers,
body: JSON.stringify(eventBody),
});
if (!resp.ok) {
const txt = await resp.text().catch(() => "");
throw new Error(`/ops/ingest ${resp.status}: ${txt || "unknown"}`);
}
}
async function writeDeadLetterSafe(reason, payload) {
  try {
    await ops().from("dead_letters").insert({
      received_at: new Date().toISOString(),
      error: safeStr(reason) || "unknown_dead_letter_reason",
      payload: payload || null,
    });
  } catch (err) {
    console.error("[dead_letters insert error]", err?.message || String(err));
  }
}
let outboxWorkerRunning = false;
let lastOutboxTickAt = null;
async function runOutboxSenderTick() {
if (outboxWorkerRunning) return;
outboxWorkerRunning = true;
lastOutboxTickAt = new Date().toISOString();
try {
// Email/SMS outbox processing moved to n8n workflows
} catch (err) {
logError("runOutboxSenderTick", err);
} finally {
outboxWorkerRunning = false;
}
}
// ---------- MIRROR SYSTEM (v5.4) ----------
async function mirrorEvent(event) {
// v5.4: Mirror events for linked cards (safe if ops_events doesn't exist)
if (!event?.event_type || !event?.idempotency_key) return false;
try {
await sbInsertOpsEventSafe(event);
return true;
} catch (err) {
logError("mirrorEvent", err);
return false;
}
}
async function getMirrors(cardKey) {
// Get mirrored/linked cards from nil.card_mirrors
if (!cardKey) return [];
try {
const { data, error } = await ops()
.from("card_mirrors")
.select("*")
.eq("card_key", cardKey)
.limit(25);
if (error) throw error;
return data || [];
} catch (err) {
logError("getMirrors", err);
return [];
}
}
// ---------- COUNTS ----------
async function sbCountConversations({ pipeline, source, role }) {
try {
let q = ops().from("conversations").select("id", { count: "exact", head: true });
if (pipeline) q = q.eq("pipeline", pipeline);
if (source && source !== "all") q = q.eq("source", sourceSafe(source));
if (role && role !== "all") q = q.eq("role", role);
const { count, error } = await q;
if (error) {
  if (role && String(error.message || "").toLowerCase().includes("role")) {
    let fallback = ops().from("conversations").select("id", { count: "exact", head: true });
    if (pipeline) fallback = fallback.eq("pipeline", pipeline);
    if (source && source !== "all") fallback = fallback.eq("source", sourceSafe(source));
    const { count: fallbackCount, error: fallbackErr } = await fallback;
    if (fallbackErr) {
      console.warn(`sbCountConversations(${pipeline}) fallback error:`, fallbackErr.message);
      return 0;
    }
    return fallbackCount || 0;
  }
  console.warn(`sbCountConversations(${pipeline}) error:`, error.message);
  return 0; // Return 0 instead of throwing
}
return count || 0;
} catch (err) {
console.warn(`sbCountConversations(${pipeline}) exception:`, err.message);
return 0;
}
}
async function sbCountSubmissions() {
try {
const { count, error } = await ops()
.from("submissions")
.select("submission_id", { count: "exact", head: true });
if (error) {
  console.warn("sbCountSubmissions error:", error.message);
  return 0;
}
return count || 0;
} catch (err) {
console.warn("sbCountSubmissions exception:", err.message);
return 0;
}
}
// Auto-urgent: count needs_reply items with >24h wait time
async function sbCountUrgentAuto({ source = "all", role = "all" } = {}) {
try {
const OVERDUE_MINUTES = 24 * 60;
const rows = await sbListConversations({ pipeline: "needs_reply", source, role, limit: 100 });
let count = 0;
for (const c of rows || []) {
const waitingMin = tComputeWaitingMinutes(c);
if (waitingMin != null && waitingMin > OVERDUE_MINUTES) count++;
}
return count;
} catch (err) {
console.warn("sbCountUrgentAuto exception:", err.message);
return 0;
}
}
// Auto-urgent: list needs_reply items with >24h wait time
async function sbListUrgentAuto({ source = "all", role = "all", limit = 8 } = {}) {
try {
const OVERDUE_MINUTES = 24 * 60;
const rows = await sbListConversations({ pipeline: "needs_reply", source, role, limit: 100 });
const urgent = [];
for (const c of rows || []) {
const waitingMin = tComputeWaitingMinutes(c);
if (waitingMin != null && waitingMin > OVERDUE_MINUTES) {
urgent.push(c);
}
}
// Sort by wait time descending
const waitSort = (a, b) => (tComputeWaitingMinutes(b) || 0) - (tComputeWaitingMinutes(a) || 0);
urgent.sort(waitSort);
return urgent.slice(0, limit);
} catch (err) {
console.warn("sbListUrgentAuto exception:", err.message);
return [];
}
}
// ---------- HANDOFF PENDING (surface layer) ----------
// Ownership note: upstream detector can be n8n/provider intelligence.
// This bot layer reads and acts on persisted handoff flags for operators.
async function sbCountHandoffPending({ source = "all" } = {}) {
  try {
    let q = ops()
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("needs_support_handoff", true)
      .not("cc_support_suggested", "eq", true);
    if (source !== "all") q = q.eq("source", sourceSafe(source));
    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch (err) {
    console.warn("sbCountHandoffPending exception:", err.message);
    return 0;
  }
}
async function sbListHandoffPending({ source = "all", limit = 24 } = {}) {
  try {
    let q = ops()
      .from("conversations")
      .select("id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at, cc_support_suggested, mirror_conversation_id, role, needs_support_handoff, needs_support_handoff_at, handoff_detected_reason")
      .eq("needs_support_handoff", true)
      .not("cc_support_suggested", "eq", true)
      .order("needs_support_handoff_at", { ascending: false })
      .limit(limit);
    if (source !== "all") q = q.eq("source", sourceSafe(source));
    const { data, error } = await q;
    if (error) return [];
    return data || [];
  } catch (err) {
    console.warn("sbListHandoffPending exception:", err.message);
    return [];
  }
}
// Count needs_reply items EXCLUDING those >24h (which are auto-escalated to urgent)
async function sbCountNeedsReplyNonUrgent({ source = "all", role = "all" } = {}) {
try {
const OVERDUE_MINUTES = 24 * 60;
const rows = await sbListConversations({ pipeline: "needs_reply", source, role, limit: 100 });
let count = 0;
for (const c of rows || []) {
const waitingMin = tComputeWaitingMinutes(c);
if (waitingMin == null || waitingMin <= OVERDUE_MINUTES) {
count++;
}
}
return count;
} catch (err) {
console.warn("sbCountNeedsReplyNonUrgent exception:", err.message);
return 0;
}
}
async function sbCountDeadLetters() {
try {
const { count, error } = await ops()
.from("dead_letters")
.select("received_at", { count: "exact", head: true });
if (error) {
  console.warn("sbCountDeadLetters error:", error.message);
  return null;
}
return Number(count) || 0;
} catch (err) {
console.warn("sbCountDeadLetters exception:", err.message);
return null;
}
}
async function sbCountCalls() {
try {
const { count, error } = await ops()
.from("calls")
.select("id", { count: "exact", head: true });
if (error) {
  console.warn("sbCountCalls error:", error.message);
  return 0;
}
return count || 0;
} catch (err) {
console.warn("sbCountCalls exception:", err.message);
return 0;
}
}

async function buildOpsHealthSummary() {
  const deadLetterBacklog = await sbCountDeadLetters();
  const pendingHandoffs = await sbCountHandoffPending({ source: "all" });
  return {
    config: {
      make_send_webhook_configured: !!MAKE_SEND_WEBHOOK_URL,
      cc_support_webhook_configured: !!CC_SUPPORT_WEBHOOK_URL,
      handoff_webhook_configured: !!HANDOFF_WEBHOOK_URL,
      openai_api_key_configured: !!OPENAI_API_KEY,
      support_from_email_configured: !!SUPPORT_FROM_EMAIL,
      outreach_from_email_configured: !!OUTREACH_FROM_EMAIL,
    },
    runtime: {
      last_outbox_tick_at: lastOutboxTickAt,
      dead_letter_backlog: deadLetterBacklog,
      pending_handoff_conversations: Number.isFinite(pendingHandoffs) ? pendingHandoffs : null,
    },
  };
}

// ---------- LISTS ----------
async function sbListConversations({ pipeline, source = "all", role = "all", limit = 8 }) {
const buildQuery = (withRole, withHandoff, withCardExtras = true) => {
  const handoffCols = withHandoff ? ', needs_support_handoff, needs_support_handoff_at, handoff_detected_reason' : '';
  const cardCols = withCardExtras ? ', cc_support_suggested, gmail_url, mirror_conversation_id' : '';
  let q = ops()
    .from("conversations")
    .select(
      withRole
        ? `id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at${cardCols}, role, role_pending, role_confidence${handoffCols}`
        : `id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at${cardCols}${handoffCols}`
    )
    .order("updated_at", { ascending: false })
    .limit(limit * 2); // Fetch 2x limit for sorting
  if (pipeline) q = q.eq("pipeline", pipeline);
  // Source filtering: include specific source OR null OR empty (for unmigrated test data)
  if (source !== "all") {
    const safeSrc = sourceSafe(source);
    q = q.or(`source.eq.${safeSrc},source.is.null,source.eq.`);
  }
  if (withRole && role && role !== "all") q = q.eq("role", role);
  return q;
};
const result = await dbSelectFirst([
  () => buildQuery(true, true),
  () => buildQuery(false, true),
  () => buildQuery(true, false),  // fallback: handoff columns may not exist yet
  () => buildQuery(false, false), // fallback: no role, no handoff columns
  () => buildQuery(true, false, false),  // fallback: role columns only, no card extras
  () => buildQuery(false, false, false), // fallback: minimal queue-safe columns only
]);
if (result?.error) throw new Error(result.error.message || result.error);
const sorted = smartSortByPriority(result?.data || []);
return sorted.slice(0, limit);
}
async function sbGetConversationById(id) {
const { data, error } = await ops()
.from("conversations")
.select("*")
.eq("id", id)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
async function sbGetConversationByThreadKey(thread_key) {
const { data, error } = await ops()
.from("conversations")
.select("*")
.eq("thread_key", thread_key)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
async function sbFindConversationByEmail(email) {
const normalized = normalizeEmail(email);
if (!normalized) return null;
const buildQuery = (useNormalized, withRole) => {
const selectFields = withRole
  ? "id, role, role_pending, role_confidence, role_source, contact_email, normalized_email, source, conversation_kind, coach_name"
  : "id, contact_email, normalized_email, source, conversation_kind, coach_name";
let q = ops()
.from("conversations")
.select(selectFields)
.order("updated_at", { ascending: false })
.limit(1);
if (useNormalized) {
q = q.eq("normalized_email", normalized);
} else {
q = q.ilike("contact_email", normalized);
}
return q.maybeSingle();
};
const result = await dbSelectFirst([
() => buildQuery(true, true),
() => buildQuery(true, false),
() => buildQuery(false, true),
() => buildQuery(false, false),
]);
if (result?.error) return null;
return result.data || null;
}
// ---------- MESSAGES / THREAD ----------
async function sbCountMessages(conversation_id) {
const { count, error } = await ops()
.from("messages")
.select("id", { count: "exact", head: true })
.eq("conversation_id", conversation_id);
if (error) throw new Error(error.message);
return count || 0;
}

async function sbListMessages(conversation_id, { offset = 0, limit = 6 } = {}) {
const { data, error } = await ops()
.from("messages")
.select("id, direction, sender, from_email, to_email, subject, body, preview, created_at")
.eq("conversation_id", conversation_id)
.order("created_at", { ascending: false })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
}
async function sbListCcSupportEvents(conversation_id, { limit = 100 } = {}) {
  try {
    const { data, error } = await ops()
      .from("ops_events")
      .select("id, created_at, event_type, payload")
      .eq("entity_type", "conversation")
      .eq("entity_id", conversation_id)
      .eq("event_type", "cc_support_sent")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      logError("sbListCcSupportEvents", error);
      return [];
    }
    return data || [];
  } catch (err) {
    logError("sbListCcSupportEvents", err);
    return [];
  }
}
// ---------- SUBMISSIONS ----------
async function sbListSubmissions({ limit = 8, offset = 0 } = {}) {
const { data, error } = await ops()
.from("submissions")
.select("submission_id, created_at, submission_payload")
.order("created_at", { ascending: false })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
}
async function sbGetSubmission(submission_id) {
const { data, error } = await ops()
.from("submissions")
.select("*")
.eq("submission_id", submission_id)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
// ---------- PEOPLE ----------
async function sbListPeopleForConversation(conversation_id) {
const { data, error } = await ops()
.from("people")
.select("id, name, email, role, created_at, updated_at")
.eq("conversation_id", conversation_id)
.order("updated_at", { ascending: false });
if (error) {
console.log("sbListPeopleForConversation error:", error);
return [];
}
return data || [];
}

async function sbGetPerson(personId) {
const { data, error } = await ops()
.from("people")
.select("*")
.eq("id", personId)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
async function sbListPeopleByIdentity({ client_id = null, normalized_email = null, normalized_phone = null, limit = 12 } = {}) {
// Query people by various identifiers
let q = ops()
.from("people")
.select("id, name, email, role, created_at, updated_at")
.order("updated_at", { ascending: false })
.limit(limit);

// Build OR conditions dynamically
const conditions = [];
if (client_id) conditions.push(`id.eq.${client_id}`);
if (normalized_email) conditions.push(`email.ilike.%${normalized_email}%`);

if (conditions.length > 0) {
q = q.or(conditions.join(","));
}

const { data, error } = await q;
if (error) {
console.log("sbListPeopleByIdentity error:", error);
return [];
}
return data || [];
}
// ---------- COACHES / POOLS ----------
async function sbListCoaches({ limit = 10 } = {}) {
const { data, error } = await ops()
.from("coaches")
.select("id, coach_id, coach_name, program, school, updated_at, created_at")
.order("updated_at", { ascending: false })
.limit(limit);
if (error) throw new Error(error.message);
return data || [];
}
async function sbGetCoach(coach_id) {
const { data, error } = await ops()
.from("coaches")
.select("*")
.eq("coach_id", coach_id)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
async function sbListConversationsByCoach({ coach_id, pipeline, source = "all", limit = 8 }) {
let q = ops()
.from("conversations")
.select("id, source, pipeline, subject, preview, updated_at, coach_id, coach_name")
.eq("coach_id", coach_id)
.order("updated_at", { ascending: false })
.limit(limit * 2); // Fetch 2x for sorting
if (pipeline) q = q.eq("pipeline", pipeline);
if (source !== "all") q = q.eq("source", sourceSafe(source));
const { data, error } = await q;
if (error) throw new Error(error.message);
// Apply smart sorting and return requested limit
const sorted = smartSortByPriority(data || []);
return sorted.slice(0, limit);
}
// ---------- CALLS ----------
async function sbListCalls({ limit = 8, offset = 0 } = {}) {
const buildQuery = (withScheduledFor) => ops()
  .from("calls")
  .select(
    withScheduledFor
      ? "id, client_name, scheduled_for, outcome, updated_at, created_at"
      : "id, client_name, scheduled_at, outcome, updated_at, created_at"
  )
  .order("updated_at", { ascending: false })
  .range(offset, offset + limit - 1);
const result = await dbSelectFirst([
  () => buildQuery(true),
  () => buildQuery(false),
]);
if (result?.error) throw new Error(result.error.message || result.error);
return result?.data || [];
}
async function sbGetCall(callId) {
const { data, error } = await ops()
.from("calls")
.select("*")
.eq("id", callId)
.maybeSingle();
if (error) throw new Error(error.message);
return data || null;
}
async function sbSetCallOutcome(callId, outcome) {
const { error } = await ops()
.from("calls")
.update({ outcome, updated_at: new Date().toISOString() })
.eq("id", callId);
if (error) throw new Error(error.message);
}
async function sbDeleteMessageById(messageId) {
// Soft delete by default; hard delete only if is_test=true
const { data: msg, error: fetchErr } = await ops()
.from("messages")
.select("is_test, conversation_id")
.eq("id", messageId)
.maybeSingle();
if (fetchErr) {
console.warn("Failed to fetch message for deletion:", fetchErr.message);
throw new Error(fetchErr.message);
}
if (!msg) return; // Message doesn't exist, nothing to do
if (msg.is_test === true) {
// Hard delete
const { error: deleteErr } = await ops().from("messages").delete().eq("id", messageId);
if (deleteErr) {
console.warn("Failed to hard delete message:", deleteErr.message);
throw new Error(deleteErr.message);
}
} else {
// Soft delete
const { error: updateErr } = await ops().from("messages").update({ is_deleted: true }).eq("id", messageId);
if (updateErr) {
console.warn("Failed to soft delete message:", updateErr.message);
throw new Error(updateErr.message);
}
}
}
async function sbListConversationsByPersonId(personId, limit = 10) {
const { data, error } = await ops()
.from("conversations")
.select("id, source, pipeline, subject, preview, updated_at, coach_name, contact_email")
.or(`coach_id.eq.${personId},contact_id.eq.${personId}`)
.order("updated_at", { ascending: false })
.limit(limit);
if (error) {
console.log("sbListConversationsByPersonId error:", error);
return [];
}
return data || [];
}
async function sbListSubmissionsByPersonId(personId, limit = 10) {
const { data, error } = await ops()
.from("submissions")
.select("submission_id, athlete_name, state, created_at, submission_payload")
.eq("contact_id", personId)
.order("created_at", { ascending: false })
.limit(limit);
if (error) throw new Error(error.message);
return data || [];
}
async function sbListClientSubmissions(clientId, limit = 10, offset = 0) {
const { data, error } = await ops()
.from("submissions")
.select("submission_id, athlete_name, state, created_at, coverage_accident, coverage_hospital_indemnity, coverage_type, coach_id, coach_name, pool_label, submission_payload")
.eq("client_id", clientId)
.order("created_at", { ascending: false })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
}
async function sbListClientCalls(clientId, limit = 10) {
const buildQuery = (withScheduledFor) => ops()
.from("calls")
.select(withScheduledFor
  ? "id, client_name, client_email, best_phone, scheduled_for, reason, outcome, updated_at, created_at, conversation_id"
  : "id, client_name, client_email, best_phone, scheduled_at, reason, outcome, updated_at, created_at, conversation_id")
.eq("client_id", clientId)
.order("updated_at", { ascending: false })
.limit(limit);
const result = await dbSelectFirst([
() => buildQuery(true),
() => buildQuery(false),
]);
if (result?.error) throw new Error(result.error.message || result.error);
return result?.data || [];
}
async function sbListClientThreads(clientId, limit = 10, offset = 0) {
const { data, error } = await ops()
.from("conversations")
.select("id, source, pipeline, subject, preview, updated_at, coach_name, contact_email, thread_key")
.eq("client_id", clientId)
.order("updated_at", { ascending: false })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
}
async function sbListPeopleForClient(clientId, limit = 10) {
const { data, error } = await ops()
.from("people")
.select("id, name, email, phone_e164, role, created_at, updated_at")
.eq("client_id", clientId)
.order("updated_at", { ascending: false })
.limit(limit);
if (error) throw new Error(error.message);
return data || [];
}
function canonicalizeSubmissionPayload(p, { source = "unknown" } = {}) {
// Normalize submission fields; return object with standard keys + raw payload
const payload = p || {};
const explicitRole = normalizeRole(
payload.your_role || payload.user_role || payload.role
);
const defaultRole = "parent";
return {
first_name: payload.first_name || payload.firstName || null,
last_name: payload.last_name || payload.lastName || null,
email: payload.email || null,
phone_e164: payload.phone_e164 || payload.phone || null,
state: payload.state || null,
athlete_name: payload.athlete_name || payload.athleteName || null,
coverage_accident: payload.coverage_accident === true,
coverage_hospital_indemnity: payload.coverage_hospital_indemnity === true,
referral_source: payload.referral_source || payload.referralSource || null,
your_role: explicitRole || defaultRole,
intent_answer: payload.intent_answer || payload.intentAnswer || payload.intent || null,
how_heard_about: payload.how_heard_about || payload.howHeardAbout || payload.how_heard || null,
notes: payload.notes || null,
created_at: payload.created_at || new Date().toISOString(),
};
}
function isMissingColumnError(error) {
const msg = String(error?.message || "").toLowerCase();
return (msg.includes("column") && msg.includes("does not exist")) ||
       (msg.includes("column") && msg.includes("schema cache")) ||
       (msg.includes("column") && msg.includes("not found"));
}
async function sbUpsertSubmissionSafe(row) {
const { error } = await ops()
.from("submissions")
.upsert(row, { onConflict: "submission_id" });
if (error && isMissingColumnError(error)) {
const fallback = { ...row };
delete fallback.your_role;
delete fallback.intent_answer;
delete fallback.how_heard_about;
const { error: fallbackErr } = await ops()
.from("submissions")
.upsert(fallback, { onConflict: "submission_id" });
if (fallbackErr) throw new Error(fallbackErr.message);
return { fallback: true };
}
if (error) throw new Error(error.message);
return { fallback: false };
}
async function sbUpdateSubmissionSafe(submission_id, patch) {
const { error } = await ops()
.from("submissions")
.update(patch)
.eq("submission_id", submission_id);
if (error && isMissingColumnError(error)) {
const fallback = { ...patch };
delete fallback.your_role;
delete fallback.intent_answer;
delete fallback.how_heard_about;
const { error: fallbackErr } = await ops()
.from("submissions")
.update(fallback)
.eq("submission_id", submission_id);
if (fallbackErr) throw new Error(fallbackErr.message);
return { fallback: true };
}
if (error) throw new Error(error.message);
return { fallback: false };
}
async function sbClientSummary() {
// Returns client stats derived from people table (contacts/coaches)
// Since conversations doesn't have client_id, we use people as proxy
const { data: people, error: peopleErr } = await ops()
.from("people")
.select("id, created_at");
if (peopleErr) {
console.log("sbClientSummary error:", peopleErr);
return { total: 0, newMonth: 0, withConversations: 0, needsReply: 0, active: 0, completed: 0 };
}
const rows = people || [];
const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const withConv = 0; // No conversation_id column
const newMonth = rows.filter(p => p.created_at >= monthAgo).length;

// Get pipeline stats from conversations - get all since we can't link directly
const { data: convs, error: convErr } = await ops()
.from("conversations")
.select("id, pipeline");
if (convErr) {
console.log("sbClientSummary conversations error:", convErr);
return {
total: rows.length,
newMonth,
withConversations: withConv,
needsReply: 0,
active: 0,
completed: 0,
};
}
const needsReply = (convs || []).filter(c => c.pipeline === "needs_reply").length;
const active = (convs || []).filter(c => c.pipeline === "active").length;
const completed = (convs || []).filter(c => c.pipeline === "completed").length;

return {
total: rows.length,
newMonth,
withConversations: withConv,
needsReply,
active,
completed,
};
}
async function sbListClients({ bucket = "all", limit = 12, offset = 0 } = {}) {
// Returns list of people (clients/contacts) with metadata
// Since no dedicated clients table, use people as proxy
let q = ops()
.from("people")
.select("id, name, email, role, created_at, updated_at")
.order("updated_at", { ascending: false });

if (bucket === "new_month") {
const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
q = q.gte("created_at", monthAgo);
}

const { data, error } = await q.range(offset, offset + limit - 1);
if (error) {
console.log("sbListClients error:", error);
return [];
}
const rows = data || [];
return rows.map(p => ({
client_id: p.id, // map id to client_id for compatibility
name: p.name || "—",
email: p.email || null,
phone_e164: null, // column doesn't exist
role: p.role || null,
last_activity_at: p.updated_at,
}));
}
async function sbGetClientCard(clientId) {
// Get person/client detail - using people table
const { data, error } = await ops()
.from("people")
.select("*")
.eq("id", clientId)
.maybeSingle();
if (error) {
console.log("sbGetClientCard error:", error);
return null;
}
if (!data) return null;
// Return in client structure format
return {
client_id: data.id,
primary_name: data.name,
primary_email: data.email,
primary_phone_e164: null, // column doesn't exist
primary_role: data.role,
status: "active",
pool_label: null,
state: null,
conversation_id: null, // column doesn't exist
created_at: data.created_at,
updated_at: data.updated_at,
};
}
async function sbListCallsTriage({ source = "all", limit = 24, windowHours = 48 } = {}) {
// Get calls for triage view (due soon or needs action)
const now = new Date();
const windowMs = windowHours * 3600 * 1000;
const windowStart = new Date(now.getTime() - windowMs).toISOString();
const buildQuery = (scheduleField, withSource) => {
let q = ops()
.from("calls")
.select("*")
.order(scheduleField, { ascending: true })
.limit(limit);
if (withSource && source !== "all") {
q = q.eq("source", sourceSafe(source));
}
q = q.or(`${scheduleField}.gte.${windowStart},outcome.is.null`);
return q;
};
const result = await dbSelectFirst([
() => buildQuery("scheduled_for", true),
() => buildQuery("scheduled_at", true),
() => buildQuery("scheduled_for", false),
() => buildQuery("scheduled_at", false),
]);
if (result?.error) {
console.log("sbListCallsTriage error:", result.error);
return [];
}
return result?.data || [];
}
// ---------- METRICS (v5.3 aligned) ----------
async function sbMetricSummary({ source = "all", window = "month" }) {
const now = new Date();
const sinceDays = window === "week" ? 7 : window === "year" ? 365 : window === "all" ? null : 30;
const since = sinceDays ? new Date(now.getTime() - sinceDays * 24 * 3600 * 1000).toISOString() : null;
// metric events
let q = ops()
.from("metric_events")
.select("event_type, source, created_at");
if (since) q = q.gte("created_at", since);

if (source !== "all") q = q.eq("source", sourceSafe(source));
const { data, error } = await q;
if (error) throw new Error(error.message);
const rows = data || [];
const counts = {
programLinkOpens: 0,
coverageExploration: 0,
enrollClicks: 0,
eappVisits: 0,
threadsCreated: 0, // ✅ new
};
  for (const r of rows) {
    if (r.event_type === "program_link_open") counts.programLinkOpens++;
    if (r.event_type === "coverage_exploration") counts.coverageExploration++;
    if (r.event_type === "enroll_click") counts.enrollClicks++;
    if (r.event_type === "eapp_visit") counts.eappVisits++;
    // ✅ choose ONE canonical thread metric event name and stick to it
    if (r.event_type === "thread_created" || r.event_type ===  "conversation.created")
      counts.threadsCreated++;
  }
  
  // Fetch calls answered for all windows
  let callsAnswered = 0;
  try {
    let cq = ops()
      .from("calls")
      .select("id, outcome, updated_at, created_at");
    if (since) cq = cq.gte("created_at", since);
    const { data: calls, error: callErr } = await cq;
    if (!callErr && calls?.length) {
      callsAnswered = calls.filter((c) => c.outcome === "completed" || c.outcome === "answered").length;
    }
  } catch (_) {}
  
  counts.callsAnswered = callsAnswered;
  
  // For week/month, return counts only
  if (window !== "year") return counts;
// ---------- YEAR EXTRAS ----------
// Build monthly buckets
const order = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthIndex = (d) => new Date(d).getMonth(); // 0..11
const monthly = Array.from({ length: 12 }, (_, i) => ({
label: order[i],
opens: 0,
exploration: 0,
enrollClicks: 0,
eappVisits: 0,
threads: 0,
callsAnswered: 0,
}));

for (const r of rows) {
const mi = monthIndex(r.created_at);
if (mi < 0 || mi > 11) continue;
if (r.event_type === "program_link_open") monthly[mi].opens++;
if (r.event_type === "coverage_exploration") monthly[mi].exploration++;
if (r.event_type === "enroll_click") monthly[mi].enrollClicks++;
if (r.event_type === "eapp_visit") monthly[mi].eappVisits++;
if (r.event_type === "thread_created" || r.event_type === "conversation.created")
monthly[mi].threads++;
}

// Add calls to monthly buckets
try {
let cq2 = ops()
.from("calls")
.select("outcome, created_at")
.gte("created_at", since);
const { data: callsData, error: callErr2 } = await cq2;
if (!callErr2 && callsData?.length) {
for (const c of callsData) {
if (c.outcome === "completed" || c.outcome === "answered") {
const mi = monthIndex(c.created_at);
if (mi >= 0 && mi <= 11) monthly[mi].callsAnswered++;
}
}
}
} catch (_) {}

// best month / best month ever (same thing unless you later compare multi-years)
const bestMonth = monthly.reduce((a, b) => (b.enrollClicks > a.enrollClicks ? b : a),
monthly[0]);
const bestMonthEver = bestMonth;
// best week (approx): compute week buckets from rows
const weekKey = (iso) => {
const d = new Date(iso);
const y = d.getFullYear();
const onejan = new Date(y, 0, 1);
const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
return `${y}-W${String(week).padStart(2, "0")}`;
};
const weekAgg = new Map(); // key -> { enrollClicks, threads }
for (const r of rows) {
const k = weekKey(r.created_at);
const cur = weekAgg.get(k) || { enrollClicks: 0, threads: 0 };
if (r.event_type === "enroll_click") cur.enrollClicks++;
if (r.event_type === "thread_created" || r.event_type === "conversation.created")
cur.threads++;
weekAgg.set(k, cur);
}
let bestWeek = null;
for (const [k, v] of weekAgg.entries()) {
if (!bestWeek || v.enrollClicks > bestWeek.enrollClicks) bestWeek = { label: k, ...v };
}
// trends: compare last month vs month before (simple and matches your definition)
const lastMonthIdx = now.getMonth();
const prevMonthIdx = (lastMonthIdx + 11) % 12;

const trendOf = (key) => {
const a = monthly[prevMonthIdx][key] || 0;
const b = monthly[lastMonthIdx][key] || 0;
if (b > a) return "up";
if (b < a) return "down";
return "flat";
};

return {
...counts,
monthlyBreakdown: monthly,
bestWeek,
bestMonth: { label: bestMonth.label, enrollClicks: bestMonth.enrollClicks, threads:
bestMonth.threads },
bestMonthEver: { label: bestMonthEver.label, enrollClicks: bestMonthEver.enrollClicks,
threads: bestMonthEver.threads },
trend: {
opens: trendOf("opens"),
exploration: trendOf("exploration"),
enrollClicks: trendOf("enrollClicks"),
eappVisits: trendOf("eappVisits"),
threads: trendOf("threads"),
callsAnswered: trendOf("callsAnswered"),
},
};
}
// ---------- POOLS OVERVIEW ----------
async function sbPoolsOverview({ source = "all", limit = 40 } = {}) {
// Get pools overview - coaches with their conversations and activity metrics
let q = ops()
.from("coaches")
.select(`
id,
coach_id,
coach_name,
program,
school,
updated_at,
created_at
`)
.order("updated_at", { ascending: false })
.limit(limit);

if (source !== "all") q = q.eq("program", source === "programs" ? "programs" : "support");

const { data, error } = await q;
if (error) {
console.log("sbPoolsOverview error:", error);
return [];
}

// Map to expected format with derived flags
const rows = (data || []).map(coach => ({
coach_id: coach.coach_id,
coach_full_name: coach.coach_name,
program_name: coach.program || coach.school || "Unknown",
needs_reply: false,
followup_due: false,
is_active: true,
waiting_minutes: 0,
followup_next_action_at: null,
last_activity_at: coach.updated_at,
guide_opens_year: 0,
enroll_clicks_year: 0,
eapp_visits_year: 0,
}));

return rows;
}
// ---------- SMART RENDER (v5.3 SAFE) ----------
async function sbGetLastOpsEventTimestamp() {
try {
const { data, error } = await ops()
.from("ops_events")
.select("created_at")
.order("created_at", { ascending: false })
.limit(1)
.maybeSingle();
if (error) {
console.warn("sbGetLastOpsEventTimestamp error:", error.message);
return null;
}
return data?.created_at || null;
} catch (err) {
console.warn("sbGetLastOpsEventTimestamp exception:", err.message);
return null;
}
}

async function smartRender(ctx, text, keyboard) {
const safeText = sanitizeDisplayText(text);
// stop Telegram spinner when this was a button click
try {
if (ctx.update?.callback_query?.id) {
await ctx.answerCbQuery().catch((err) => {
// Only log if it's not "query is too old" or "already answered"
const msg = String(err?.description || err?.message || "");
if (!msg.includes("query is too old") && !msg.includes("QUERY_ID_INVALID") && !msg.includes("already answered")) {
console.log(`[WARN] answerCbQuery failed: ${msg}`);
}
});
}
} catch (_) {}
// try edit-in-place first (clean UI)
if (ctx.update?.callback_query?.message) {
const m = ctx.update.callback_query.message;
try {
await withTimeout(
bot.telegram.editMessageText(
m.chat.id,
m.message_id,
undefined,
safeText,
keyboard
),
8000,
"Edit message timed out"
);
// ✅ CRITICAL: Unregister this card from live refresh to prevent auto-revert
// When navigating to a new view (thread, drafts, etc), the card should NOT be auto-refreshed
liveCards.delete(m.message_id);
return { mode: "edit", message_id: m.message_id, chat_id: m.chat.id };
} catch (err) {
const msg = String(err?.description || err?.message || "");
// harmless: already same content
if (msg.includes("message is not modified")) {
return { mode: "noop", message_id: m.message_id, chat_id: m.chat.id };
}
// If edit fails for any other reason, fall through to reply
console.log(`[INFO] Edit failed, sending new message: ${msg.substring(0, 60)}`);
}
}
// fallback: new message
try {
const msg = await withTimeout(
ctx.reply(safeText, keyboard),
8000,
"Send message timed out"
);
return { mode: "reply", message_id: msg?.message_id, chat_id: msg?.chat?.id };
} catch (err) {
console.log(`[ERROR] Failed to send message: ${err.message}`);
throw err;
}
}

// ---------- LEADS DISPLAY ----------
async function leadsText() {
  try {
    const { data: analytics, error: analyticsErr } = await ops()
      .from("v_analytics_summary")
      .select("*")
      .single();
    
    if (analyticsErr) throw new Error(analyticsErr.message);
    
    const { data: topLeads, error: leadsErr } = await ops()
      .from("v_top_leads")
      .select("*")
      .limit(10);
    
    if (leadsErr) throw new Error(leadsErr.message);
    
    const { data: statusCounts, error: statusErr } = await ops()
      .from("leads")
      .select("status");
    
    const statuses = { ready: 0, outreach_started: 0, replied: 0, no_email: 0, bounced: 0 };
    
    if (!statusErr && statusCounts) {
      for (const row of statusCounts) {
        if (statuses.hasOwnProperty(row.status)) statuses[row.status]++;
      }
    }
    
    let text = `🎯 NIL LEADS DASHBOARD
📊 Overview

• Total Leads: ${analytics?.total_leads || 0}
• New Today: ${analytics?.leads_today || 0}
• With Email: ${statuses.ready + statuses.outreach_started + statuses.replied}

📈 Status
Ready: ${statuses.ready}
Started: ${statuses.outreach_started}
Replied: ${statuses.replied}

🔥 Top 10 Leads

`;
    if (topLeads && topLeads.length > 0) {
      for (let i = 0; i < Math.min(10, topLeads.length); i++) {
        const lead = topLeads[i];
        const score = lead.engagement_score || 0;
        const emoji = score >= 20 ? "🔥" : score >= 10 ? "⭐" : "📌";
        text += `${emoji} ${lead.full_name} (${lead.organization}) - Score: ${score}\n`;
      }
    } else {
      text += `No leads yet.\n`;
    }
    return text;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

function leadsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🆕 Ready", "LEADS:filter:ready"), Markup.button.callback("📧 Started", "LEADS:filter:outreach_started")],
    [Markup.button.callback("🔄 Refresh", "LEADS:refresh"), Markup.button.callback("⬅ Dashboard", "DASH:back")]
  ]);
}

// ---------- ANALYTICS DISPLAY ----------
async function analyticsText() {
  try {
    const { data: analytics, error } = await ops()
      .from("v_analytics_summary")
      .select("*")
      .single();
    
    if (error) throw new Error(error.message);
    
    let text = `📊 EMAIL ANALYTICS
📅 Today

Sent: ${analytics?.emails_sent_today || 0}
Opens: ${analytics?.opens_today || 0}
Clicks: ${analytics?.clicks_today || 0}
Replies: ${analytics?.replies_today || 0}

📈 All-Time

Sent: ${analytics?.total_emails_sent || 0}
Opens: ${analytics?.total_opens || 0}
Clicks: ${analytics?.total_clicks || 0}
Replies: ${analytics?.total_replies || 0}

💯 Rates

Open: ${analytics?.open_rate_pct || 0}%
Click: ${analytics?.click_rate_pct || 0}%
Reply: ${analytics?.reply_rate_pct || 0}%`;
    return text;
  } catch (err) {
    return `❌ Error: ${err.message}`;
  }
}

function analyticsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "ANALYTICS:refresh"), Markup.button.callback("⬅ Dashboard", "DASH:back")]
  ]);
}

// ---------- DASHBOARD TEXT ----------
async function dashboardText(filterSource = "all") {
const { dayKey, time } = nyParts(new Date());
const filterLabel =
filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" :
"🌐 All";
const counts = {
handoffCount: await sbCountHandoffPending({ source: filterSource }),
urgentCount: await sbCountUrgentAuto({ source: filterSource }),
needsReplyCount: await sbCountNeedsReplyNonUrgent({ source: filterSource }),
waitingCount: await sbCountConversations({ pipeline: "actions_waiting", source: filterSource
}),
activeCount: await sbCountConversations({ pipeline: "active", source: filterSource }),
forwardedCount: await sbCountConversations({ pipeline: "forwarded", source: filterSource }),
followCount: await sbCountConversations({ pipeline: "followups", source: filterSource }),
completedCount: await sbCountConversations({ pipeline: "completed", source: filterSource }),
submissionsCount: await sbCountSubmissions(),
callsCount: await sbCountCalls(),
};
const lastIngestAt = await sbGetLastOpsEventTimestamp();
const staleWarning = (() => {
if (!lastIngestAt) return "⚠️ Data may be stale · Last ingest: none yet";
const ts = new Date(lastIngestAt).getTime();
if (!Number.isFinite(ts)) return "⚠️ Data may be stale · Last ingest timestamp invalid";
const ageMinutes = Math.floor((Date.now() - ts) / 60000);
if (ageMinutes > 30) {
return `⚠️ Data may be stale · Last ingest: ${tFmtDateTimeShort(lastIngestAt)}`;
}
return "";
})();
const capped = {
handoffCount: capQueueCount(counts.handoffCount, MAX_QUEUE_DISPLAY),
urgentCount: capQueueCount(counts.urgentCount, MAX_QUEUE_DISPLAY),
needsReplyCount: capQueueCount(counts.needsReplyCount, MAX_QUEUE_DISPLAY),
waitingCount: capQueueCount(counts.waitingCount, MAX_QUEUE_DISPLAY),
activeCount: capQueueCount(counts.activeCount, MAX_QUEUE_DISPLAY),
forwardedCount: capQueueCount(counts.forwardedCount, MAX_QUEUE_DISPLAY),
submissionsCount: capQueueCount(counts.submissionsCount, MAX_QUEUE_DISPLAY),
followCount: capQueueCount(counts.followCount, MAX_QUEUE_DISPLAY),
callsCount: capQueueCount(counts.callsCount, MAX_QUEUE_DISPLAY),
completedCount: capQueueCount(counts.completedCount, MAX_QUEUE_DISPLAY),
};
const m = await sbMetricSummary({ source: filterSource, window: "all" }).catch(() => ({}));
return buildDashboardText({
codeVersion: CODE_VERSION,
buildVersion: BUILD_VERSION,
today: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" }).format(new Date()),
time,
filterLabel,
staleWarning,
capped,
metrics: m,
});
}
// ✅ EXACT v5.1 dashboard keyboard: filters row + nav row + metrics row (ONLY 3 rows)
function dashboardKeyboardV50() {
return Markup.inlineKeyboard([
// Row 1 (filters)
[
Markup.button.callback("🌐 All", "FILTER:all"),
Markup.button.callback("🏈 Programs", "FILTER:programs"),
Markup.button.callback("🧑‍🧒 Support", "FILTER:support"),
],
// Row 2 (nav)
[
Markup.button.callback("🗂 All Queues", "ALLQ:open"),
Markup.button.callback("⚡️ Triage", "TRIAGE:open"),
Markup.button.callback("🔎 Search", "SEARCH:help"),

],
// Row 3
[
Markup.button.callback("📊 Metrics", "METRICS:open"),
Markup.button.callback("📅 Today", "TODAY:open"),
Markup.button.callback("👥 Clients", "CLIENTS:open"),
],
]);
}
// ======================================================
// ALL QUEUES (v5.5 OPS CLEAN + LIVE REFRESH)
// ======================================================
// ---------- ALL QUEUES KEYBOARD ----------
function allQueuesKeyboard(filterSource = "all") {
if (filterSource === "programs") {
return Markup.inlineKeyboard([
[
Markup.button.callback("Role: All", "ROLEFILTER:all"),
Markup.button.callback("Parent", "ROLEFILTER:parent"),
Markup.button.callback("Athlete", "ROLEFILTER:athlete"),
],
[
Markup.button.callback("Coach", "ROLEFILTER:coach"),
Markup.button.callback("Trainer", "ROLEFILTER:trainer"),
Markup.button.callback("Other", "ROLEFILTER:other"),
],
[
Markup.button.callback("🤖 Instantly Threads", "VIEW:active"),
Markup.button.callback("📌 Loop in Support", "HANDOFF:open"),
],
[
Markup.button.callback("‼️ Urgent", "VIEW:urgent"),
Markup.button.callback("📝 Needs Reply", "VIEW:needs_reply"),
],
[
Markup.button.callback("📚 Follow-Ups", "VIEW:followups"),
Markup.button.callback("🌊 Pools", "POOLS:open"),
],
[
Markup.button.callback("👥 Clients", "CLIENTS:open"),
Markup.button.callback("📱 Calls", "CALLS:hub"),
],
[
Markup.button.callback("🧾 Submissions", "VIEW:website_submissions"),
Markup.button.callback("✅ Completed", "VIEW:completed"),
],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}

return Markup.inlineKeyboard([
[
Markup.button.callback("Role: All", "ROLEFILTER:all"),
Markup.button.callback("Parent", "ROLEFILTER:parent"),
Markup.button.callback("Athlete", "ROLEFILTER:athlete"),
],
[
Markup.button.callback("Coach", "ROLEFILTER:coach"),
Markup.button.callback("Trainer", "ROLEFILTER:trainer"),
Markup.button.callback("Other", "ROLEFILTER:other"),
],
[
Markup.button.callback("‼️ Urgent", "VIEW:urgent"),
Markup.button.callback("📝 Needs Reply", "VIEW:needs_reply"),
],
[
Markup.button.callback("⏳ Waiting", "VIEW:actions_waiting"),
Markup.button.callback("💬 Active", "VIEW:active"),
],
[
Markup.button.callback("📱 Calls", "CALLS:hub"),
Markup.button.callback("📚 Follow-Ups", "VIEW:followups"),
],
[
Markup.button.callback("📨 Forwarded", "VIEW:forwarded"),
Markup.button.callback("🧾 Submissions", "VIEW:website_submissions"),
],
[
Markup.button.callback("✅ Completed", "VIEW:completed"),
Markup.button.callback("🌊 Pools", "POOLS:open"),
],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}
// ======================================================
// CONVERSATION SUMMARY LIST
// ======================================================
// ---------- SHOW LIST ----------
async function showConversationList(ctx, viewKey, rows, filterSource, roleFilter = "all") {
const filterLabel =
filterSource === "support"
? "🧑‍🧒 Support"
: filterSource === "programs"
? "🏈 Programs"
: "🌐 All";
const header = `${headerLine(viewKey, filterLabel)} · ${roleFilterLabel(roleFilter)}`;

const safeRows = Array.isArray(rows) ? rows : [];
const cappedRows = safeRows.slice(0, MAX_QUEUE_DISPLAY);
const overflowNote = safeRows.length > MAX_QUEUE_DISPLAY
? `\n⚠️ Showing ${MAX_QUEUE_DISPLAY} of ${safeRows.length} total items.`
: "";

const body = cappedRows.length
? cappedRows.map((conv) => convoSummaryLine(conv, URGENT_AFTER_MINUTES)).join("\n") + "\n─────"
: "No items.";
// buttons - just back navigation, no individual open buttons
const kb = [[Markup.button.callback("⬅ Back", "ALLQ:open")]];
const msg = await smartRender(ctx,
`${header}${overflowNote}\n\n${body}`,
Markup.inlineKeyboard(kb)
);
// ==================================================
// ✅ LIVE CARD REGISTRATION (AUTO REFRESH SUPPORT)
// ==================================================
if (msg?.message_id) {
registerLiveCard(msg, {
type: "dashboard",
card_key: `queue:${filterSource}:${roleFilter}:${viewKey}`,
ref_id: `queue:${filterSource}:${roleFilter}:${viewKey}`,
filterSource,
});
}
return msg;
}
// ---------- CONVERSATION CARD (v5.3 CLEAN + OPS SAFE) ----------
async function buildConversationCard(conv) {
const msgCount = await sbCountMessages(conv.id).catch(() => 0);
const latest = await sbListMessages(conv.id, { offset: 0, limit: 1 }).catch(() => []);
const latestMessage = Array.isArray(latest) && latest.length ? latest[0] : null;
const lastDirection = latestMessage?.direction === "outbound" ? "outbound" : latestMessage?.direction === "inbound" ? "inbound" : "—";
const lastAgeMinutes = (() => {
const t = latestMessage?.created_at ? new Date(latestMessage.created_at).getTime() : null;
if (!t || !Number.isFinite(t)) return null;
return Math.max(0, Math.floor((Date.now() - t) / 60000));
})();
const lastAgeText = lastAgeMinutes == null ? "—" : tFmtMin(lastAgeMinutes) || `${lastAgeMinutes}m`;
const instantlyThreadSummary = isInstantlySource(conv)
? `Thread Summary: ${msgCount} msgs • Last: ${lastDirection} • ${lastAgeText} ago`
: null;
const { text, isInstantlyInbound } = buildConversationCardText(conv, {
msgCount,
latestMessage,
instantlyThreadSummary,
urgentAfterMinutes: URGENT_AFTER_MINUTES,
});
return { text, msgCount, isInstantlyInbound };
}
function conversationCardKeyboard(conv, msgCount = null, options = {}) {
const isInstantlyInbound = options?.isInstantlyInbound === true;
const id = conv.id;
// Mirror button only if present
const mirrorRow = conv.mirror_conversation_id
? [Markup.button.callback("Open Mirror", `OPENMIRROR:${id}`)]
: [];
// CC label
const ccOn = conv.cc_support_suggested === true;
const ccBtnLabel = ccOn ? "📇 CC ON" : "CC OFF";
// Role conflict confirmation row (if pending role exists)
const roleConflictRow = conv?.role_pending && conv?.role_confidence === "low"
? [Markup.button.callback(`✅ Confirm [${roleLabel(conv.role_pending)}]`, `CONFIRMROLE:${id}:${conv.role_pending}`)]
: [];
// Thread button label
const threadLabel = (() => {
if (msgCount === null) return "🧵 Thread";
if (msgCount === 0) return "🧵 Thread (none)";
if (msgCount === 1) return "🧵 Thread (1 msg)";
return `🧵 Thread (${msgCount} msgs)`;
})();
if (isInstantlyInbound) {
const rows = [
[Markup.button.callback("🧵 View Thread", `THREAD:${id}:0`)],
[Markup.button.callback("📌 CC Support", `CC:${id}`)],
];
rows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
return Markup.inlineKeyboard(rows);
}
// Instantly AI manages outreach replies — Telegram is read-only viewer + support handoff point
const isInstantlyManaged = isInstantlySource(conv);
const loopBtnLabel = conv.needs_support_handoff ? "🚨 Loop in Support NOW" : "📌 Loop in Support";

if (isInstantlyManaged) {
    // Instantly-owned thread: Telegram provides visibility + CC Support only.
  return Markup.inlineKeyboard([
    [Markup.button.callback(threadLabel, `THREAD:${id}:0`)],
    [
      Markup.button.callback(loopBtnLabel, `CC:${id}`),
      Markup.button.callback("👥 People", `PEOPLE:${id}`),
    ],
    [
      ...roleConflictRow,
      ...mirrorRow,
    ],
    [Markup.button.callback("🔧 Set Role", `SETROLE:${id}`)],
    [Markup.button.callback("⬅ Dashboard", "DASH:back")],
  ]);
}

// Support lane or CC-locked — full send/draft flow via Gmail
return Markup.inlineKeyboard([
  [Markup.button.callback(threadLabel, `THREAD:${id}:0`)],
  [
    Markup.button.callback(ccBtnLabel, `CC:${id}`),
    Markup.button.callback("👥 People", `PEOPLE:${id}`),
  ],
  [
    ...roleConflictRow,
    ...mirrorRow,
  ],
  [Markup.button.callback("🔧 Set Role", `SETROLE:${id}`)],
  [Markup.button.callback("✍️ Drafts V1/V2/V3", `DRAFTS:open:${id}`)],
  [Markup.button.callback("📤 Send (Support) 🔒", `SEND:${id}:1`)],
  [Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}
// ---------- SUBMISSION CARD ----------

function submissionKeyboard(sub) {
return Markup.inlineKeyboard([
[Markup.button.callback("🗑 Delete",
`DELETECONFIRM:submission:${sub.submission_id}`)],
[Markup.button.callback("⬅ Back", "VIEW:website_submissions")],
]);
}
// ---------- START / DASH ----------
bot.start(safeCommand(async (ctx) => {
if (!isAdmin(ctx)) return;
await ctx.reply("✅ NIL Wealth Ops Bot running.\nType /dashboard");
}));

bot.command("dashboard", safeCommand(async (ctx) => {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await ctx.reply(await dashboardText(filterSource), dashboardKeyboardV50());
}));

bot.command("leads", safeCommand(async (ctx) => {
if (!isAdmin(ctx)) return;
await ctx.reply(await leadsText(), leadsKeyboard());
}));

bot.command("analytics", safeCommand(async (ctx) => {
if (!isAdmin(ctx)) return;
await ctx.reply(await analyticsText(), analyticsKeyboard());
}));

bot.command("health", safeCommand(async (ctx) => {
if (!isAdmin(ctx)) return;
const summary = await buildOpsHealthSummary();
await ctx.reply(buildOpsHealthText(summary));
}));

bot.action("DASH:back", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
}));

bot.action("DASH:refresh", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
}));

// ---------- FILTER ----------
bot.action(/^FILTER:(all|programs|support)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const v = ctx.match[1];
setAdminFilter(ctx, v);
await smartRender(ctx, await dashboardText(v), dashboardKeyboardV50());
}));

// ---------- ROLE FILTER ----------
bot.action(/^ROLEFILTER:(all|parent|athlete|coach|trainer|other)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const v = ctx.match[1];
setAdminRoleFilter(ctx, v);
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await allQueuesText(filterSource, v), allQueuesKeyboard(filterSource));
}));

// ---------- ALL QUEUES ----------
bot.action("ALLQ:open", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const filterSource = getAdminFilter(ctx);
const roleFilter = getAdminRoleFilter(ctx);
const msg = await smartRender(
ctx,
await allQueuesText(filterSource, roleFilter),
allQueuesKeyboard(filterSource)
);
// Optional: track as live card (queue list)
if (msg?.message_id) {
registerLiveCard(msg, {
type: "dashboard",
card_key: `dashboard:${filterSource}:${roleFilter}:allq`,
ref_id: `allq:${filterSource}:${roleFilter}`,
filterSource,
});
}
}));
// ---------- QUEUE VIEW ----------
bot.action(
  /^VIEW:(urgent|needs_reply|actions_waiting|active|followups|forwarded|website_submissions|completed):?(\d*)$/,
safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const viewKey = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const filterSource = getAdminFilter(ctx);
const roleFilter = getAdminRoleFilter(ctx);
try {
if (viewKey === "website_submissions") {
const pageSize = 5;
const offset = (page - 1) * pageSize;
// Get total count + page of data
const { data: allSubs, error: countErr } = await ops()
.from("submissions")
.select("submission_id", { count: "exact", head: false });
if (countErr) {
logError("VIEW:website_submissions count", countErr);
return smartRender(
ctx,
buildLoadWarning("submission queue count", countErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "ALLQ:open")]])
);
}
const totalCount = allSubs?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);
  
const subs = await sbListSubmissions({ limit: pageSize, offset });
const lineForSub = (s, idx) => {
const p = s.submission_payload || {};
const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "—";
const email = p.email || "—";
const state = p.state || "—";
const athlete = p.athlete_name || "—";
const acc = p.coverage_accident === true ? "✅ Accident" : "";
const hosp = p.coverage_hospital_indemnity === true ? "✅ Hospital" : "";
const cov = [acc, hosp].filter(Boolean).join(" + ") || (p.coverage_type || "—");
const shortId = idShort(s.submission_id);
return `${offset + idx + 1}. ${name} • ${state}\n   ${athlete} • ${cov}\n   ID: ${shortId}`;
};

const pageInfo = `Page ${currentPage}/${totalPages} (${totalCount} total)`;
const lines = subs.length ? subs.map(lineForSub).join("\n\n") : "No submissions.";
// Just navigation buttons, no individual open buttons
const kb = [];
// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀️ Prev", `VIEW:website_submissions:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶️", `VIEW:website_submissions:${currentPage + 1}`));
}
if (navRow.length > 0) kb.push(navRow);
kb.push([Markup.button.callback("⬅ Back", "ALLQ:open")]);
const msg = await smartRender(ctx,
`${headerLine("🧾 Submissions", filterSource)}\n${pageInfo}\n\n${lines}`,
Markup.inlineKeyboard(kb)
);
// Optional: live list refresh
if (msg?.message_id) {
registerLiveCard(msg, {
type: "dashboard",
card_key: `queue:${filterSource}:website_submissions`,
ref_id: `queue:${filterSource}:website_submissions`,
filterSource,
});
}
return;
}
// Handle urgent with auto-escalation logic
const rows = viewKey === "urgent" 
? await sbListUrgentAuto({ source: filterSource, role: roleFilter, limit: 8 })
: await sbListConversations({ pipeline: viewKey, source: filterSource, role: roleFilter, limit: 8 });
await showConversationList(ctx, viewKey, rows, filterSource, roleFilter);
// If you want queue lists to live-refresh too, update showConversationList
// to return the sent message and register it there.
} catch (err) {
logError(`VIEW:${viewKey}`, err);
await smartRender(
ctx,
buildLoadWarning(viewTitle(viewKey), err),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "ALLQ:open")]])
);
}
})
);

// ---------- OPENCARD (conversation + submission) ----------
bot.action(/^OPENCARD:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const raw = ctx.match[1];
// allow "sub:<id>" for submissions
if (raw.startsWith("sub:")) {
const sid = raw.slice(4);
const sub = await sbGetSubmission(sid);
if (!sub) {
await ctx.reply("❌ Submission not found.");
return;
}
const text = buildSubmissionCard(sub);
const kb = submissionKeyboard(sub);
// Edit dashboard in place (single card flow)
await smartRender(ctx, text, kb);
return;
}
const conv = await sbGetConversationById(raw);
if (!conv) {
await ctx.reply("❌ Conversation not found.");
return;
}
const { text, msgCount, isInstantlyInbound } = await buildConversationCard(conv);
const kb = conversationCardKeyboard(conv, msgCount, { isInstantlyInbound });
// Edit dashboard in place (single card flow)
const msg = await smartRender(ctx, text, kb);
if (msg?.message_id) {
registerLiveCard(msg, {
type: "conversation",
card_key: `conversation:${conv.id}`,
ref_id: conv.id,
});
}
}));

// ---------- CONFIRM ROLE (CONFLICT RESOLUTION) ----------
bot.action(/^CONFIRMROLE:([^:]+):(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
try {
const convId = ctx.match[1];
const confirmedRole = normalizeRole(ctx.match[2]);
if (!confirmedRole) return ctx.reply("❌ Invalid role.");

const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");

const nowIso = new Date().toISOString();
const { error } = await ops()
.from("conversations")
.update({
role: confirmedRole,
role_pending: null,
role_confidence: "high",
role_source: "manual",
role_last_updated_at: nowIso,
updated_at: nowIso,
})
.eq("id", convId);

if (error) {
if (isMissingColumnError(error)) {
return ctx.reply("⚠️ Role columns not yet created. Run migration first.");
}
throw new Error(error.message);
}

await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "conversation.role.confirmed",
source: "telegram",
direction: "inbound",
entity_type: "conversation",
entity_id: convId,
payload: {
confirmed_role: confirmedRole,
resolution: "manual_confirm",
},
});

refreshQueue.add(makeCardKey("conversation", convId));
refreshQueue.add("triage:all");
refreshQueue.add("dashboard:all");

const updated = await sbGetConversationById(convId);
const { text, msgCount, isInstantlyInbound } = await buildConversationCard(updated);
const kb = conversationCardKeyboard(updated, msgCount, { isInstantlyInbound });
await smartRender(ctx, `✅ Role confirmed.\n\n${text}`, kb);
} catch (err) {
logError("CONFIRMROLE", err);
await ctx.reply(`❌ Error confirming role: ${err.message}`).catch(() => {});
}
}));

// ---------- SET ROLE (ADMIN) ----------
bot.action(/^SETROLE:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
try {
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");

const currentRole = conversationRoleForDisplay(conv);
const kb = Markup.inlineKeyboard([
[Markup.button.callback("👨‍👩‍👧 Parent", `ROLESELECT:${convId}:parent`)],
[Markup.button.callback("🏃 Athlete", `ROLESELECT:${convId}:athlete`)],
[Markup.button.callback("🏆 Coach", `ROLESELECT:${convId}:coach`)],
[Markup.button.callback("💪 Trainer", `ROLESELECT:${convId}:trainer`)],
[Markup.button.callback("❓ Other", `ROLESELECT:${convId}:other`)],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
]);
await smartRender(ctx, `🔧 Select new role (currently: ${currentRole}):`, kb);
} catch (err) {
logError("SETROLE", err);
await ctx.reply(`❌ Error: ${err.message}`).catch(() => {});
}
}));

// ---------- ROLE SELECT (APPLY) ----------
bot.action(/^ROLESELECT:([^:]+):(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
try {
const convId = ctx.match[1];
const selectedRole = normalizeRole(ctx.match[2]);
if (!selectedRole) return ctx.reply("❌ Invalid role.");

const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");

const nowIso = new Date().toISOString();
const traceId = newTraceId();

// Update conversation with the new role
const { error } = await ops()
.from("conversations")
.update({
role: selectedRole,
role_pending: null,
role_confidence: "high",
role_source: "manual",
role_last_updated_at: nowIso,
updated_at: nowIso,
})
.eq("id", convId);

if (error) {
if (isMissingColumnError(error)) {
return ctx.reply("⚠️ Role columns not yet created. Run migration first.");
}
throw new Error(error.message);
}

// Log the role change event
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "conversation.role.set_manual",
source: "telegram",
direction: "inbound",
entity_type: "conversation",
entity_id: convId,
trace_id: traceId,
payload: {
new_role: selectedRole,
previous_role: conv.role || "parent",
set_by_admin: true,
},
});

// Refresh the card
refreshQueue.add(makeCardKey("conversation", convId));
refreshQueue.add("triage:all");
refreshQueue.add("dashboard:all");

const updated = await sbGetConversationById(convId);
const { text, msgCount, isInstantlyInbound } = await buildConversationCard(updated);
const kb = conversationCardKeyboard(updated, msgCount, { isInstantlyInbound });
await smartRender(ctx, `✅ Role set to ${roleLabel(selectedRole)}.\n\n${text}`, kb);
} catch (err) {
logError("ROLESELECT", err);
await ctx.reply(`❌ Error setting role: ${err.message}`).catch(() => {});
}
}));
// ---------- OPEN MIRROR ----------
bot.action(/^OPENMIRROR:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
try {
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv?.mirror_conversation_id) {
await ctx.answerCbQuery("No mirror conversation found.");
return;
}
const mirror = await sbGetConversationById(conv.mirror_conversation_id);
if (!mirror) {
await ctx.answerCbQuery("Mirror conversation not found.");
return;
}
const { text, msgCount, isInstantlyInbound } = await buildConversationCard(mirror);
const kb = conversationCardKeyboard(mirror, msgCount, { isInstantlyInbound });
// Edit dashboard in place (single card flow)
await smartRender(ctx, text, kb);
} catch (err) {
logError("OPENMIRROR", err);
await ctx.reply("❌ Error opening mirror. Try /dashboard to refresh.").catch(() => {});
}
}));
// ---------- MIRRORS LIST (v5.4) ----------
bot.action(/^MIRRORS:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const raw = String(ctx.match[1] || "");
const mirrors = await getMirrors(cardKey);
if (raw.startsWith("sub:") || raw.startsWith("submission:")) {
const sid = raw.startsWith("sub:") ? raw.slice(4) : raw.slice("submission:".length);
const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", `OPENCARD:${cardKey}`)],
]);
return smartRender(ctx, `🪞 Mirrors\n\nNo linked cards found for:\n${cardKey}`, kb);
}

let text = `🪞 Mirrors\n\nLinked cards for: ${cardKey}\n\n`;
const buttons = [];

for (const m of mirrors.slice(0, 10)) {
const mk = m.mirror_card_key || m.card_key || "";

const convId = raw.startsWith("conversation:") ? raw.slice("conversation:".length) : raw;
const conv = await sbGetConversationById(convId);
text += `• ${shorten(label, 50)}\n  ${mk}\n\n`;
if (mk) {
buttons.push([Markup.button.callback(shorten(label, 28), `OPENCARD:${mk}`)]);
}
}

buttons.push([Markup.button.callback("🔄 Refresh", `MIRRORS:${cardKey}`)]);
buttons.push([Markup.button.callback("⬅ Back", `OPENCARD:${cardKey}`)]);

return smartRender(ctx, text, Markup.inlineKeyboard(buttons));
}));
// ==========================================================
// 🧵 THREAD VIEW (paged) — v5.3 OPS CLEAN + LIVE REFRESH + LATEST JUMP +
// DEBUG + DELETE (TEST) + 🪞 MIRROR
// ==========================================================
//
// FINAL version w/ tweaks applied:
// ✅ Tweak #1: Latest offset supports newest_first OR oldest_first via THREAD_ORDER
// ✅ Tweak #2: Stable card_key = `thread:${convId}` (refresh targets the open thread reliably)
// ✅ Tweak #3: Adds 🪞 Open Mirror button inside thread view when mirror exists
//
// Requires existing helpers:
// - shorten(str, n)
// - isAdmin(ctx)
// - headerLine(...)
// - laneLabel(...), sourceSafe(...)
// - sbGetConversationById(convId)
const THREAD_ORDER = "newest_first"; // "newest_first" | "oldest_first"
// ---------- THREAD VIEW HELPERS ----------

function computeLatestOffset(total, limit) {
if (THREAD_ORDER === "newest_first") return 0;
return Math.max(0, total - limit);
}
// For delete-newest logic: pick which message is “newest” on the current page.
function pickNewestMessageIdOnPage(msgs) {
if (!msgs?.length) return null;
// If list is newest_first, first item is newest. If oldest_first, last item is newest.
return THREAD_ORDER === "newest_first" ? (msgs[0]?.id || null) : (msgs[msgs.length - 1]?.id
|| null);
}
async function buildThreadPage(convId, offset, limit) {
const conv = await sbGetConversationById(convId);
if (!conv) return { ok: false, error: "Conversation not found." };
const total = await sbCountMessages(convId);
const msgs = await sbListMessages(convId, { offset, limit });
const shownFrom = total === 0 ? 0 : Math.min(offset + 1, total);

const shownTo = total === 0 ? 0 : Math.min(offset + limit, total);
const header =
`${headerLine("thread", "full")}\n` +
`${conv.subject || "Thread"}\n` +
`${laneLabel(sourceSafe(conv.source))}\n` +
`💬 Messages: ${total}\n` +
(total > 0 ? `Showing: ${shownFrom}-${shownTo}` : `Showing: 0-0`);
const isInstantlyThread = isInstantlySource(conv);
let body;
if (isInstantlyThread) {
const timelineMsgs = await sbListMessages(convId, { offset: 0, limit: MAX_QUEUE_DISPLAY }).catch(() => []);
const ccEvents = await sbListCcSupportEvents(convId, { limit: MAX_QUEUE_DISPLAY }).catch(() => []);
const timeline = [
...(timelineMsgs || []).map((m) => ({ ...m, timeline_type: "message" })),
...(ccEvents || []).map((e) => ({ ...e, timeline_type: "event" })),
]
.sort((a, b) => {
const at = a?.created_at ? new Date(a.created_at).getTime() : 0;
const bt = b?.created_at ? new Date(b.created_at).getTime() : 0;
return at - bt;
});
body = timeline.length
? timeline.map((entry) => formatInstantlyTimelineLine(entry, conv)).join("\n\n--------------------\n\n")
: "(No messages yet)";
} else {
body = msgs?.length
? msgs.map(formatMessageLineFull).join("\n\n--------------------\n\n")
: "(No messages yet)";
}
// Pagination controls
const prevOffset = Math.max(0, offset - limit);
const nextOffset = offset + limit;
const hasPrev = offset > 0;
const hasNext = nextOffset < total;
// Latest jump
const latestOffset = computeLatestOffset(total, limit);
const kbRows = [];
if (isInstantlyThread) {
if (conv?.mirror_conversation_id) {
kbRows.push([Markup.button.callback("🪞 Open Mirror", `OPENMIRROR:${conv.id}`)]);
}
kbRows.push([Markup.button.callback("⬅ Back to Card", `OPENCARD:${convId}`)]);
kbRows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
return {
ok: true,
conv,
total,
msgs,
text: `${header}\n\n${body}`,
keyboard: Markup.inlineKeyboard(kbRows),
latestOffset,
};
}
// paging row
const paging = [];
if (hasPrev) paging.push(Markup.button.callback("◀ Older",
`THREAD:${convId}:${prevOffset}`));
if (hasNext) paging.push(Markup.button.callback("▶ Newer",
`THREAD:${convId}:${nextOffset}`));
if (paging.length) kbRows.push(paging);
// latest row (only show if not already on latest)
if (offset !== latestOffset && total > 0) {
kbRows.push([Markup.button.callback("⏩ Latest", `THREAD:${convId}:${latestOffset}`)]);
}
// 🪞 mirror row (recommended)
if (conv?.mirror_conversation_id) {
kbRows.push([Markup.button.callback("🪞 Open Mirror", `OPENMIRROR:${conv.id}`)]);

}
// nav rows
kbRows.push([Markup.button.callback("⬅ Back to Card", `OPENCARD:${convId}`)]);
kbRows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
return {
ok: true,
conv,
total,
msgs,
text: `${header}\n\n${body}`,
keyboard: Markup.inlineKeyboard(kbRows),
latestOffset,
};
}
// ---------- THREAD VIEW (paged) ----------
bot.action(/^THREAD:(.+):(\d+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const offset = Number(ctx.match[2] || 0);
const limit = 6;
try {
const page = await buildThreadPage(convId, offset, limit);
if (!page.ok) {
await ctx.reply(page.error || "Thread not found.").catch(() => {});
return;
}
await smartRender(ctx, page.text, page.keyboard);
} catch (err) {
logError("THREAD", err);
await ctx.reply("❌ Thread error. Try /dashboard.").catch(() => {});
}
}));
// ---------- CC SUPPORT ----------
function makeTraceId() {
return uuidv4();
}
function makeCcIdempotencyKey(convId) {
// idempotent per conversation (prevents double-CC spam)
return crypto.createHash("sha256").update(`cc_support|${convId}`).digest("hex");
}
function isProgramLaneConversation(conv) {
const lane = String(conv?.lane || "").trim().toLowerCase();
if (lane) return lane === "program";
// Fallback for older rows where lane may be missing
const s = sourceSafe(conv?.source);
return s === "programs";
}
async function sbGetRecentCcSupportSent(conversationId, withinHours = 24) {
  try {
    const sinceIso = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    const { data, error } = await ops()
      .from("ops_events")
      .select("id, created_at, event_type, entity_id, payload")
      .eq("event_type", "cc_support_sent")
      .eq("entity_id", conversationId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logError("sbGetRecentCcSupportSent", error);
      return null;
    }
    return data || null;
  } catch (err) {
    logError("sbGetRecentCcSupportSent", err);
    return null;
  }
}
function buildCcSupportDispatchPayload(
  conv,
  { bridge_draft = 2, support_draft = 2, bridge_message = null, support_message = null } = {}
) {
  const trace_id = makeTraceId();
  const idempotency_key = makeCcIdempotencyKey(conv.id);
  const payload = {
    schema_version: "5.3",
    event_type: "cc_support.requested",
    source: "telegram",
    direction: "outbound",
    trace_id,
    idempotency_key,
    entity_type: "conversation",
    entity_id: conv.id,
    conversation_id: conv.id,
    thread_key: conv.thread_key,
    coach_id: conv.coach_id || null,
    coach_name: conv.coach_name || null,
    contact_email: conv.contact_email || null,
    bridge_draft: Number(bridge_draft),
    support_draft: Number(support_draft),
    bridge_message: bridge_message
      ? {
          subject: bridge_message.subject || "",
          body: bridge_message.body || "",
        }
      : null,
    support_message: support_message
      ? {
          subject: support_message.subject || "",
          body: support_message.body || "",
        }
      : null,
    gmail_thread_id: conv.gmail_thread_id || null,
    message_id_header: conv.message_id_header || null,
    in_reply_to: conv.in_reply_to || null,
    references: conv.references || null,
    mirror_conversation_id: conv.mirror_conversation_id || null,
    payload: {
      lane_source: sourceSafe(conv.source),
      lane: conv.lane || null,
      subject: conv.subject || "",
      cc_support_suggested: true,
    },
  };
  return { payload, trace_id, idempotency_key };
}
async function requestCcSupportWorkflow(
conv,
{ bridge_draft = 2, support_draft = 2, bridge_message = null, support_message = null } = {}
) {
const { payload, trace_id, idempotency_key } = buildCcSupportDispatchPayload(conv, {
bridge_draft,
support_draft,
bridge_message,
support_message,
});
const validation = validateOutboundPayload(payload, {
  requireConversationId: true,
  requireThreadKey: true,
  requireSendAs: false,
  requireSubject: false,
  requireBody: false,
  requireCcMessages: true,
});
if (!validation.ok) {
logOutboundValidationError("requestCcSupportWorkflow", payload, validation.errors);
return {
ok: false,
status: 422,
error: "invalid_outbound_payload",
bodyText: validation.errors.join(","),
trace_id: payload.trace_id,
idempotency_key: payload.idempotency_key,
payload,
};
}
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "cc_support.dispatch_requested",
source: "telegram",
direction: "outbound",
trace_id,
idempotency_key,
entity_type: "conversation",
entity_id: conv.id,
payload,
});
const result = await postJsonWebhook(CC_SUPPORT_WEBHOOK_URL, payload);
return {
...result,
trace_id,
idempotency_key,
payload,
};

}
// -------------------------------
// 📇 CC Helper Functions
// -------------------------------
function ccKeyboard(convId, bridgeDraft = 2, supportDraft = 2) {
const tagB = (v) => bridgeDraft === v ? " ✅" : "";
const tagS = (v) => supportDraft === v ? " ✅" : "";
return Markup.inlineKeyboard([
[
Markup.button.callback(`View Bridge V1${tagB(1)}`, `CCVIEW:${convId}:bridge:1:${bridgeDraft}:${supportDraft}`),
Markup.button.callback(`View Bridge V2${tagB(2)}`, `CCVIEW:${convId}:bridge:2:${bridgeDraft}:${supportDraft}`),
Markup.button.callback(`View Bridge V3${tagB(3)}`, `CCVIEW:${convId}:bridge:3:${bridgeDraft}:${supportDraft}`),
],
[
Markup.button.callback(`View Support V1${tagS(1)}`, `CCVIEW:${convId}:support:1:${bridgeDraft}:${supportDraft}`),
Markup.button.callback(`View Support V2${tagS(2)}`, `CCVIEW:${convId}:support:2:${bridgeDraft}:${supportDraft}`),
Markup.button.callback(`View Support V3${tagS(3)}`, `CCVIEW:${convId}:support:3:${bridgeDraft}:${supportDraft}`),
],
[Markup.button.callback("♻️ Regenerate Drafts", `CCREGEN:${convId}`)],
[Markup.button.callback("✅ Confirm CC Support", `CCCONFIRM:${convId}:${bridgeDraft}:${supportDraft}`)],
[Markup.button.callback("⬅ Back to Conversation", `OPENCARD:${convId}`)]
]);
}

async function renderCCCard(ctx, convId, bridgeDraft = 2, supportDraft = 2) {
const drafts = ccDraftsCache.get(convId);
if (!drafts) {
return smartRender(ctx, "❌ CC drafts not found. Click Regenerate.", ccKeyboard(convId, bridgeDraft, supportDraft));
}
let text = `📇 CC Support\nConversation: ${idShort(convId)}\n\n`;
text += `This will:\n• Send bridge message from outreach to contact\n• Send forwardable support message from ${SUPPORT_FROM_EMAIL}\n• Create + link the Support mirror thread\n\n`;
text += `Selected:\n• Bridge Draft: V${bridgeDraft}\n• Support Draft: V${supportDraft}\n\n`;
text += `Click "View" buttons to see full message text before confirming.`;
return smartRender(ctx, text, ccKeyboard(convId, bridgeDraft, supportDraft));
}

// -------------------------------
// 📇 CC button pressed (opens confirm screen)
// -------------------------------
bot.action(/^CC:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
// CC only allowed from program/outreach side (your rule)
if (!isProgramLaneConversation(conv)) {
  return smartRender(
    ctx,
    "📇 CC Support is only available for program lane conversations.",
    Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
  );
}
// If already linked, treat as "open mirror" instead of re-CC
if (conv.mirror_conversation_id) {
return smartRender(
ctx,
"🪞 Already linked to Support.\nOpening the mirror thread now…",
Markup.inlineKeyboard([[Markup.button.callback("🪞 Open Mirror", `OPENMIRROR:${conv.id}`), Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
}

// Generate CC drafts with ChatGPT if not cached
if (!ccDraftsCache.has(convId)) {
await smartRender(
ctx,
`📇 CC Support\nConversation: ${idShort(convId)}\n\n⏳ Generating bridge & support drafts with ChatGPT...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
try {
const generated = await withTimeout(
generateCCDrafts(conv),
15000,
"CC draft generation timed out"
);
ccDraftsCache.set(convId, generated);
} catch (err) {
if (String(err?.message || "").toLowerCase().includes("timed out")) {
return smartRender(
ctx,
"⏱ Draft generation timed out.",
Markup.inlineKeyboard([
[Markup.button.callback("🔁 Retry", `CCREGEN:${convId}`)],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
])
);
}
return smartRender(ctx, `❌ Failed to generate CC drafts: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
}

// Show CC selection screen
await renderCCCard(ctx, convId, 2, 2);
}));

// -------------------------------
// View full CC draft text
// -------------------------------
bot.action(/^CCVIEW:(.+):(bridge|support):([123]):(\d):(\d)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const type = ctx.match[2]; // "bridge" or "support"
const version = parseInt(ctx.match[3], 10);
const currentBridge = parseInt(ctx.match[4], 10);
const currentSupport = parseInt(ctx.match[5], 10);
const drafts = ccDraftsCache.get(convId);
if (!drafts) {
return smartRender(ctx, "❌ CC drafts not found. Go back and regenerate.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const draft = drafts[type]?.[`v${version}`];
if (!draft) {
return smartRender(ctx, `❌ ${type} V${version} not found.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const isSelected = (type === "bridge" && currentBridge === version) || (type === "support" && currentSupport === version);
const typeLabel = type === "bridge" ? "Bridge" : "Support";
let text = `📇 ${typeLabel} Message V${version} ${isSelected ? "✅ SELECTED" : ""}\nConversation: ${idShort(convId)}\n\n`;
text += `📧 Subject: ${draft.subject || "—"}\n\n`;
text += `📝 Body:\n${draft.body || "(empty)"}`;
const newBridge = type === "bridge" ? version : currentBridge;
const newSupport = type === "support" ? version : currentSupport;
const buttons = [
[Markup.button.callback(isSelected ? "✅ Selected" : `✅ Select ${typeLabel} V${version}`, `CCSELECT:${convId}:${type}:${version}:${currentBridge}:${currentSupport}`)],
[Markup.button.callback("⬅ Back to CC Options", `CC:${convId}`)]
];
await smartRender(ctx, text, Markup.inlineKeyboard(buttons));
}));

// -------------------------------
// Select CC draft version
// -------------------------------
bot.action(/^CCSELECT:(.+):(bridge|support):([123]):(\d):(\d)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const type = ctx.match[2];
const version = parseInt(ctx.match[3], 10);
const currentBridge = parseInt(ctx.match[4], 10);
const currentSupport = parseInt(ctx.match[5], 10);
// Update selections
const newBridge = type === "bridge" ? version : currentBridge;
const newSupport = type === "support" ? version : currentSupport;
await renderCCCard(ctx, convId, newBridge, newSupport);
}));

// -------------------------------
// Regenerate CC drafts
// -------------------------------
bot.action(/^CCREGEN:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
ccDraftsCache.delete(convId);
await smartRender(
ctx,
`📇 CC Support\nConversation: ${idShort(convId)}\n\n⏳ Regenerating bridge & support drafts with ChatGPT...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
try {
const generated = await withTimeout(
generateCCDrafts(conv),
15000,
"CC draft generation timed out"
);
ccDraftsCache.set(convId, generated);
await renderCCCard(ctx, convId, 2, 2);
} catch (err) {
if (String(err?.message || "").toLowerCase().includes("timed out")) {
return smartRender(
ctx,
"⏱ Draft generation timed out.",
Markup.inlineKeyboard([
[Markup.button.callback("🔁 Retry", `CCREGEN:${convId}`)],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
])
);
}
return smartRender(ctx, `❌ Failed to generate CC drafts: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
}));

bot.action(/^CCCONFIRM:(.+):(\d):(\d)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const bridgeDraft = Number(ctx.match[2] || 2);
const supportDraft = Number(ctx.match[3] || 2);
const conv = await sbGetConversationById(convId);
const drafts = ccDraftsCache.get(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
if (!isProgramLaneConversation(conv)) {
return smartRender(ctx, "📇 CC Support is only available for program lane conversations.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (!drafts) {
return smartRender(ctx, "❌ CC drafts expired. Re-open CC Support and regenerate if needed.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const bridgeMessage = drafts.bridge?.[`v${bridgeDraft}`] || null;
const supportMessage = drafts.support?.[`v${supportDraft}`] || null;
if (!bridgeMessage || !supportMessage) {
return smartRender(ctx, "❌ Selected CC draft content is missing. Re-open CC Support and try again.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const recentCcSent = await sbGetRecentCcSupportSent(convId, 24);
if (recentCcSent) {
const sentAt = tFmtDateTimeShort(recentCcSent.created_at);
return smartRender(
ctx,
`⚠ CC support was already sent for this conversation today.\nLast send: ${sentAt}\n\nSend again only if you intend to override duplicate protection.`,
Markup.inlineKeyboard([
[Markup.button.callback("✅ Override and Send", `CCFORCE:${convId}:${bridgeDraft}:${supportDraft}`)],
[Markup.button.callback("⬅ Back", `CC:${convId}`)],
])
);
}
// Set suggested flag immediately + clear handoff (so UI reflects intent)
const { error: ccError } = await ops()
.from("conversations")
.update({
cc_support_suggested: true,
needs_support_handoff: false,
needs_support_handoff_at: null,
updated_at: new Date().toISOString(),
})
.eq("id", convId);
if (ccError) {
console.warn("Failed to set cc_support_suggested:", ccError.message);
// Don't fail hard - just log and proceed with OPS ledger
}
// OPS ledger: intent
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "cc_support.confirmed",
source: "telegram",
direction: "inbound",

entity_type: "conversation",
entity_id: convId,
payload: { bridgeDraft, supportDraft },
});
// Fire webhook to n8n to do the actual email sends + mirror creation/linking
const result = await requestCcSupportWorkflow(conv, {
bridge_draft: bridgeDraft,
support_draft: supportDraft,
bridge_message: bridgeMessage,
support_message: supportMessage,
});
if (result.ok) {
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "cc_support_sent",
source: "telegram",
direction: "outbound",
entity_type: "conversation",
entity_id: convId,
trace_id: result.trace_id,
idempotency_key: `${result.idempotency_key}:sent`,
payload: {
bridgeDraft,
supportDraft,
sent_at: new Date().toISOString(),
status: result.status,
},
});
}

// Clear cache
ccDraftsCache.delete(convId);

// Refresh to get updated cc_support_suggested flag
const updatedConv = await sbGetConversationById(convId);
const { text: cardText, msgCount, isInstantlyInbound } = await buildConversationCard(updatedConv);
const errorHint = !result.ok
? `\n\nReason: ${shorten(result.error || result.bodyText || "unknown_error", 220)}`
: "";
const successText = result.ok ? 
`📇 CC Support queued.\n🔒 Sending lane locked to Support (was Outreach).\nMirror thread will appear when ingested.\n\n${cardText}` : 
`❌ CC failed (${result.status || "?"})${errorHint}`;
await smartRender(
ctx,
successText,
result.ok ? conversationCardKeyboard(updatedConv, msgCount, { isInstantlyInbound }) : Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);

// Refresh the conversation card instantly
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});
}));

bot.action(/^CCFORCE:(.+):(\d):(\d)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const bridgeDraft = Number(ctx.match[2] || 2);
const supportDraft = Number(ctx.match[3] || 2);
const conv = await sbGetConversationById(convId);
const drafts = ccDraftsCache.get(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
if (!isProgramLaneConversation(conv)) {
return smartRender(ctx, "📇 CC Support is only available for program lane conversations.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (!drafts) {
return smartRender(ctx, "❌ CC drafts expired. Re-open CC Support and regenerate if needed.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const bridgeMessage = drafts.bridge?.[`v${bridgeDraft}`] || null;
const supportMessage = drafts.support?.[`v${supportDraft}`] || null;
if (!bridgeMessage || !supportMessage) {
return smartRender(ctx, "❌ Selected CC draft content is missing. Re-open CC Support and try again.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const { error: ccError } = await ops()
.from("conversations")
.update({
cc_support_suggested: true,
needs_support_handoff: false,
needs_support_handoff_at: null,
updated_at: new Date().toISOString(),
})
.eq("id", convId);
if (ccError) {
console.warn("Failed to set cc_support_suggested:", ccError.message);
}
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "cc_support.confirmed",
source: "telegram",
direction: "inbound",
entity_type: "conversation",
entity_id: convId,
payload: { bridgeDraft, supportDraft, override: true },
});
const result = await requestCcSupportWorkflow(conv, {
bridge_draft: bridgeDraft,
support_draft: supportDraft,
bridge_message: bridgeMessage,
support_message: supportMessage,
});
if (result.ok) {
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "cc_support_sent",
source: "telegram",
direction: "outbound",
entity_type: "conversation",
entity_id: convId,
trace_id: result.trace_id,
idempotency_key: `${result.idempotency_key}:sent:override`,
payload: {
bridgeDraft,
supportDraft,
override: true,
sent_at: new Date().toISOString(),
status: result.status,
},
});
}
ccDraftsCache.delete(convId);
const updatedConv = await sbGetConversationById(convId);
const { text: cardText, msgCount, isInstantlyInbound } = await buildConversationCard(updatedConv);
const errorHint = !result.ok
? `\n\nReason: ${shorten(result.error || result.bodyText || "unknown_error", 220)}`
: "";
const successText = result.ok
? `📇 CC Support override queued.\n\n${cardText}`
: `❌ CC override failed (${result.status || "?"})${errorHint}`;
await smartRender(
ctx,
successText,
result.ok ? conversationCardKeyboard(updatedConv, msgCount, { isInstantlyInbound }) : Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});
}));
// ==========================================================
// ---------- PEOPLE ----------
// ------------------------------
// PEOPLE LIST (from a conversation)
// ------------------------------
bot.action(/^PEOPLE:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
// Identity first (OPS): client_id > normalized signals > raw contact signals
const people = await sbListPeopleByIdentity({
client_id: conv.client_id || null,
normalized_email: conv.normalized_email || conv.contact_email || null,
normalized_phone: conv.normalized_phone || null,
limit: 12,
});
const header = `👥 PEOPLE
--
Conversation: ${idShort(convId)}\n${people.length} record(s)`;
const body = people.length
? people
.slice(0, 12)
.map((p) => {
const name = p.name || "—";
const email = p.email || "—";
const phone = p.phone_e164 || "—";
const role = p.role || "—";
const conf =
p.identity_confidence_score != null
? ` • Conf ${Number(p.identity_confidence_score).toFixed(2)}`
: "";
return `──────────────────────\n• ${name}\n  ${email} • ${phone}\n  Role: ${role}${conf}`;
})
.join("\n") + "\n──────────────────────"
: "No people records.";
// Just back button, no individual open buttons
const kb = [[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]];
// Edit dashboard in place (single card flow)
await smartRender(ctx, `${header}\n\n${body}`, Markup.inlineKeyboard(kb));
}));
// ------------------------------
// PERSON DETAIL
// ------------------------------
bot.action(/^PERSON:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const personId = ctx.match[1];
const p = await sbGetPerson(personId);
if (!p) return ctx.reply("Person not found.");
const conf =
p.identity_confidence_score != null
? Number(p.identity_confidence_score).toFixed(2)
: "—";
const text =
`👤 Person · ${idShort(p.id)}\n` +
`Name: ${p.name || "—"}\n` +
`Email: ${p.email || "—"}\n` +
`Phone: ${p.phone_e164 || "—"}\n` +
`Role: ${p.role || "—"}\n` +
`ClientID: ${p.client_id || "—"}\n` +
`Conf: ${conf}\n` +
`Created: ${p.created_at || "—"}\n` +
`Updated: ${p.updated_at || "—"}`;
const kb = Markup.inlineKeyboard([
[Markup.button.callback("💬 Conversations", `PERSONCONV:${p.id}`)],
[Markup.button.callback("🧾 Submissions", `PERSONSUB:${p.id}`)],
[Markup.button.callback("🗑 Delete", `DELETECONFIRM:person:${p.id}`)],

[Markup.button.callback("⬅ Back", "DASH:back")],
]);
// Edit dashboard in place (single card flow)
await smartRender(ctx, text, kb);
}));
// ------------------------------
// PERSON → CONVERSATIONS
// ------------------------------
bot.action(/^PERSONCONV:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const personId = ctx.match[1];
const p = await sbGetPerson(personId);
if (!p) return ctx.reply("Person not found.");
const convs = await sbListConversationsByPersonId(personId, 10);
const header = `💬 Conversations · ${p.name || idShort(personId)}\n${convs.length} thread(s)`;
const body = convs.length
? convs
.map((c) => {
const pipe = c.pipeline || "active";
const label =
pipe === "urgent"
? "‼️ Urgent"
: pipe === "needs_reply"
? "📝 Needs Reply"
: pipe === "followups"
? "📚 Follow Up"
: pipe === "completed"
? "✅ Completed"
: "💬 Active";
return `• ${label}\n ${c.subject || "—"}\n ${c.preview || "—"}`;
})
.join("\n\n")
: "No conversations found.";

const kb = convs.slice(0, 10).map((c) => [Markup.button.callback("Open",
`OPENCARD:${c.id}`)]);
kb.push([Markup.button.callback("⬅ Back", `PERSON:${personId}`)]);
// Edit dashboard in place (single card flow)
await smartRender(ctx, `${header}\n\n${body}`, Markup.inlineKeyboard(kb));
}));
// ------------------------------
// PERSON → SUBMISSIONS
// ------------------------------
bot.action(/^PERSONSUB:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const personId = ctx.match[1];
const p = await sbGetPerson(personId);
if (!p) return ctx.reply("Person not found.");
const subs = await sbListSubmissionsByPersonId(personId, 10);
const header = `🧾 Submissions · ${p.name || idShort(personId)}\n${subs.length} record(s)`;
const body = subs.length
? subs
.map((s) => {
const sid = s.submission_id || "—";
const athlete = s.athlete_name || "—";
const st = s.state || "—";
const cov =
s.coverage_accident && s.coverage_hospital_indemnity
? "Accident + Hospital Indemnity"
: s.coverage_accident
? "Accident"
: s.coverage_hospital_indemnity
? "Hospital Indemnity"
: (s.coverage_type || "—");
return `• ${sid}\n Coverage: ${cov}\n Athlete: ${athlete}\n State: ${st}`;
})
.join("\n\n")

: "No submissions found.";
const kb = subs.slice(0, 10).map((s) => [
Markup.button.callback("Open", `SUB:${s.submission_id}`),
]);
kb.push([Markup.button.callback("⬅ Back", `PERSON:${personId}`)]);
// Edit dashboard in place (single card flow)
await smartRender(ctx, `${header}\n\n${body}`, Markup.inlineKeyboard(kb));
}));
// ---------- SUBMISSION DETAIL CARD ----------
bot.action(/^SUB:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const submissionId = ctx.match[1];
const sub = await sbGetSubmission(submissionId);
if (!sub) return ctx.reply("Submission not found.");

const p = sub.submission_payload || {};
const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "—";
const email = p.email || "—";
const state = sub.state || "—";
const athlete = sub.athlete_name || p.athlete_name || "—";
const cov = sub.coverage_accident && sub.coverage_hospital_indemnity ? "Accident + Hospital Indemnity"
: sub.coverage_accident ? "Accident"
: sub.coverage_hospital_indemnity ? "Hospital Indemnity"
: (sub.coverage_type || "—");
const coach = sub.coach_name ? `Coach: ${sub.coach_name}` : "—";
const pool = sub.pool_label ? `Pool: ${sub.pool_label}` : "—";
const emailSent = sub.email_sent === true || sub.enrollment_email_sent === true;
const smsSent = sub.sms_sent === true || sub.enrollment_sms_sent === true;

const text = `🧾 SUBMISSION
--
ID: ${idShort(submissionId)}

Submitter
${name}
${email}

Athlete
${athlete}

Details
State: ${state}
Coverage: ${cov}
${coach}
${pool}

--
Status
Sent Email: ${emailStatusIcon(emailSent)}
Sent SMS: ${smsStatusIcon(smsSent)}

Created: ${sub.created_at || "—"}
--`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", "ALLQ:open")],
]);

const msg = await smartRender(ctx, text, kb);
registerLiveCard(msg, {
type: "submission",
card_key: `submission:${submissionId}`,
ref_id: submissionId,
});
}));
// ---------- COACH DETAIL CARD ----------
bot.action(/^COACH:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const coachId = ctx.match[1];
const coach = await sbGetCoach(coachId);
if (!coach) return ctx.reply("Coach not found.");

const name = coach.coach_name || "—";
const program = coach.program || coach.school || "—";
const filterSource = getAdminFilter(ctx);
const convs = await sbListConversationsByCoach({ coach_id: coachId, source: filterSource, limit: 10 });

const text = `🧑‍🏫 COACH
--
Name: ${name}

Program: ${program}

Active Conversations: ${convs.length}

--
Created: ${coach.created_at || "—"}
--`;

const kb = [
[Markup.button.callback("📬 Conversations", `COACH:convs:${coachId}`)],
[Markup.button.callback("⬅ Back", "POOLS:open")],
];

const msg = await smartRender(ctx, text, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "coach",
card_key: `coach:${coachId}`,
ref_id: coachId,
});
}));
// ---------- COACH CONVERSATIONS ----------
bot.action(/^COACH:convs:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const coachId = ctx.match[1];
const coach = await sbGetCoach(coachId);
if (!coach) return ctx.reply("Coach not found.");

const filterSource = getAdminFilter(ctx);
const convs = await sbListConversationsByCoach({ coach_id: coachId, source: filterSource, limit: 12 });

const title = `🧵 ${coach.coach_name || "Coach"}'s Conversations`;
const body = convs.length ? convs.map((c, i) => `${i+1}. ${c.subject || "(no subject)"}\n${c.preview || ""}`).join("\n\n") : "No conversations.";

// Just navigation, no individual open buttons
const kb = [[Markup.button.callback("⬅ Back", `COACH:${coachId}`)]];

const msg = await smartRender(ctx, `${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "coach_convs",
card_key: `coach_convs:${coachId}`,
ref_id: coachId,
});
}));
// ---------- CLIENTS SEARCH ----------
bot.action("CLIENTS:search", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const text = `🔎 Search Clients\n\nSend a message with client name or email to search.\n\nExample:\njordan smith\njsmith@example.com`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", "CLIENTS:open")],
]);

await smartRender(ctx, text, kb);
}));
// ===============================
// TRIAGE HANDLER
// ===============================
async function triageOpen(ctx, activeSection = "all", activePage = 1) {
const filterSource = getAdminFilter(ctx) || "all";
const roleFilter = getAdminRoleFilter(ctx) || "all";
const pageSize = 10;
const OVERDUE_THRESHOLD_HOURS = 24; // Items waiting > 24h are urgent

// Fetch all items for all sections
const [handoffRaw, needsRaw, callsRaw, followupsRaw] = await Promise.all([
  sbListHandoffPending({ source: filterSource, limit: 24 }).catch((err) => {
    logError("triageOpen:handoff", err);
    return [];
  }),
  sbListConversations({ pipeline: "needs_reply", source: filterSource, role: roleFilter, limit: 48 }).catch((err) => {
    logError("triageOpen:needs_reply", err);
    return [];
  }),
  sbListCallsTriage({ source: filterSource, limit: 24, windowHours: TRIAGE_CALL_WINDOW_HOURS }).catch((err) => {
    logError("triageOpen:calls", err);
    return [];
  }),
  sbListCoachFollowupsDueNow({ source: filterSource, limit: 24 }).catch((err) => {
    logError("triageOpen:followups", err);
    return [];
  }),
]);

// Separate overdue needs_reply from regular needs_reply
const seen = new Set();
const urgent = [];
const needs = [];
const OVERDUE_MINUTES = OVERDUE_THRESHOLD_HOURS * 60;
for (const c of needsRaw || []) {
  if (!c?.id || seen.has(c.id)) continue;
  seen.add(c.id);
  
  // Check if overdue (waiting > 24 hours)
  const waitingMin = tComputeWaitingMinutes(c);
  if (waitingMin != null && waitingMin > OVERDUE_MINUTES) {
    urgent.push(c); // Elevate overdue to urgent
  } else {
    needs.push(c); // Keep non-overdue in needs
  }
}

// Sort
const waitSort = (a, b) => (tComputeWaitingMinutes(b) || 0) - (tComputeWaitingMinutes(a) || 0);
urgent.sort(waitSort);
needs.sort(waitSort);

const calls = (callsRaw || []).slice().sort((a, b) => {
  const ak = tCallSortKey(a);
  const bk = tCallSortKey(b);
  if (ak.dueNow !== bk.dueNow) return ak.dueNow - bk.dueNow;
  if (ak.dueMs !== bk.dueMs) return ak.dueMs - bk.dueMs;
  return ak.schedMs - bk.schedMs;
});

const followups = (followupsRaw || []).slice().sort((a, b) => {
  const ad = a.due_at || a.followup_next_action_at || a.next_action_at;
  const bd = b.due_at || b.followup_next_action_at || b.next_action_at;
  return (ad ? new Date(ad).getTime() : Infinity) - (bd ? new Date(bd).getTime() : Infinity);
});

// Build unified item list with tier info
const allItems = [];
handoffRaw.forEach(c => allItems.push({ type: "convo", tier: "handoff", item: c }));
urgent.forEach(c => allItems.push({ type: "convo", tier: "urgent", item: c }));
needs.forEach(c => allItems.push({ type: "convo", tier: "needs", item: c }));
calls.forEach(c => allItems.push({ type: "call", tier: "calls", item: c }));
followups.forEach(f => allItems.push({ type: "followup", tier: "followups", item: f }));

// Pagination
const totalPages = Math.max(1, Math.ceil(allItems.length / pageSize));
const safePage = Math.min(totalPages, Math.max(1, Number(activePage) || 1));
const start = (safePage - 1) * pageSize;
const pageItems = allItems.slice(start, start + pageSize);

// Build text with tier headers
const lines = [];
const title = (typeof viewTitle === "function") ? viewTitle("triage") : "⚡ Triage";
lines.push(`${title} · ${roleFilterLabel(roleFilter)}`);
lines.push(`${handoffRaw.length > 0 ? `📌 ${handoffRaw.length} · ` : ""}‼ ${urgent.length} · ⏳ ${needs.length} · 📱 ${calls.length} · 📚 ${followups.length}`);
lines.push("");

if (pageItems.length === 0) {
  lines.push("No items.");
} else {
  let currentTier = null;
  let itemNum = start + 1;
  
  pageItems.forEach((entry) => {
    // Add tier header if switching tiers
    if (entry.tier !== currentTier) {
      if (currentTier !== null) lines.push(""); // Blank line between tiers
      const tierHeaders = {
        handoff: "📌 LOOP IN SUPPORT — Flagged by Instantly",
        urgent: "‼ URGENT (Overdue > 24h)",
        needs: "⏳ NEEDS REPLY",
        calls: "📱 CALLS (DUE)",
        followups: "📚 COACH FOLLOW-UPS (DUE)"
      };
      lines.push(tierHeaders[entry.tier]);
      currentTier = entry.tier;
    }
    
    // Add item line
    if (entry.type === "call") {
      lines.push(tCallLine(entry.item, itemNum));
    } else if (entry.type === "followup") {
      lines.push(tFollowupLine(entry.item, itemNum));
    } else {
      lines.push(tConvoLine(entry.item, itemNum));
    }
    itemNum++;
  });
}
lines.push("");

// Build buttons
const kb = [];

// Pagination
if (totalPages > 1) {
  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback("◀️ Prev", `TRIAGE:all:${safePage - 1}`));
  }
  navRow.push(Markup.button.callback(`· ${safePage}/${totalPages} ·`, `TRIAGE:all:${safePage}`));
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback("Next ▶️", `TRIAGE:all:${safePage + 1}`));
  }
  kb.push(navRow);
}

// Open buttons for displayed items
pageItems.forEach((entry) => {
  if (entry.type === "call") {
    const action = tCallOpenAction(entry.item);
    if (action) kb.push([Markup.button.callback(tCallBtnLabel(entry.item), action)]);
  } else if (entry.type === "followup") {
    const action = tFollowupTargetAction(entry.item);
    if (action) kb.push([Markup.button.callback(tFollowupBtnLabel(entry.item), action)]);
  } else {
    kb.push([Markup.button.callback(tConvoBtnLabelTriage(entry.item), `OPENCARD:${entry.item.id}`)]);
  }
});

kb.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);

const msg = await smartRender(ctx, lines.join("\n\n"), Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
  type: "triage",
  card_key: `triage:${filterSource}:${safePage}`,
  ref_id: filterSource,
  filterSource,
});
}

async function handoffOpen(ctx, activePage = 1) {
const filterSource = getAdminFilter(ctx) || "all";
const roleFilter = getAdminRoleFilter(ctx) || "all";
const pageSize = 10;
const raw = await sbListHandoffPending({ source: filterSource, limit: 80 }).catch((err) => {
logError("handoffOpen", err);
return [];
});
const items = roleFilter === "all"
  ? raw
  : (raw || []).filter((c) => conversationRoleForDisplay(c) === roleFilter);
const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
const safePage = Math.min(totalPages, Math.max(1, Number(activePage) || 1));
const start = (safePage - 1) * pageSize;
const pageItems = items.slice(start, start + pageSize);
const filterLabel =
filterSource === "support"
? "🧑‍🧒 Support"
: filterSource === "programs"
? "🏈 Programs"
: "🌐 All";

const lines = [];
lines.push(`${headerLine("handoff", filterLabel)} · ${roleFilterLabel(roleFilter)}`);
lines.push(`Flagged by Instantly for immediate human handoff.`);
lines.push(`Open: ${items.length}`);
lines.push("");

if (pageItems.length === 0) {
  lines.push("No handoff items.");
} else {
  pageItems.forEach((conv, idx) => {
    const reason = conv.handoff_detected_reason ? `\n Reason: ${conv.handoff_detected_reason}` : "";
    lines.push(`${tConvoLine(conv, start + idx + 1)}${reason}`);
  });
}

const kb = [];
if (totalPages > 1) {
  const navRow = [];
  if (safePage > 1) {
    navRow.push(Markup.button.callback("◀️ Prev", `HANDOFF:${safePage - 1}`));
  }
  navRow.push(Markup.button.callback(`· ${safePage}/${totalPages} ·`, `HANDOFF:${safePage}`));
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback("Next ▶️", `HANDOFF:${safePage + 1}`));
  }
  kb.push(navRow);
}

pageItems.forEach((conv) => {
  kb.push([Markup.button.callback(tConvoBtnLabelTriage(conv), `OPENCARD:${conv.id}`)]);
});

kb.push([Markup.button.callback("⬅ All Queues", "ALLQ:open")]);
kb.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);

const msg = await smartRender(ctx, lines.join("\n\n"), Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
  type: "handoff",
  card_key: `handoff:${filterSource}:${roleFilter}:${safePage}`,
  ref_id: `handoff:${filterSource}:${roleFilter}`,
  filterSource,
});
}

bot.action("TRIAGE:open", safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;
await triageOpen(ctx, "all", 1);
} catch (err) {
logError("TRIAGE:open", err);
await ctx.reply(`❌ Error loading triage: ${err.message}`).catch(() => {});
}
}));

bot.action("HANDOFF:open", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
await handoffOpen(ctx, 1);
}));

bot.action(/^HANDOFF:(\d+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const page = parseInt(ctx.match[1], 10) || 1;
await handoffOpen(ctx, page);
}));

bot.action(/^TRIAGE:all:(\d+)$/, safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const page = parseInt(ctx.match[1]) || 1;
await triageOpen(ctx, "all", page);
} catch (err) {
logError("TRIAGE:all", err);
await ctx.reply(`❌ Error loading triage: ${err.message}`).catch(() => {});
}
}));
// ---------- v5.4 SEARCH STATE & ENHANCED SEARCH ----------
const SEARCH_STATE = new Map(); // chatId -> { awaiting: true, startedAt: timestamp }

function setSearchMode(chatId, active = true) {
if (!active) {
SEARCH_STATE.delete(chatId);
} else {
SEARCH_STATE.set(chatId, { awaiting: true, startedAt: Date.now() });
}
}

function getSearchMode(chatId) {
const state = SEARCH_STATE.get(chatId);
if (!state) return null;
// Auto-expire search mode after 5 minutes
if (Date.now() - state.startedAt > 5 * 60 * 1000) {
SEARCH_STATE.delete(chatId);
return null;
}
return state;
}

async function runSearch(chatId, query) {
// v5.4 enhanced search (tries unified view first, then individual nil tables)
const q = String(query || "").trim();
if (!q) return [];

let results = [];

// Try unified search view first (v5.4 pattern)
try {
const { data, error } = await ops()
.from("v_search")
.select("*")
.ilike("search_text", `%${q}%`)
.limit(40);
if (!error && Array.isArray(data) && data.length > 0) {
return smartSortByPriority(data).slice(0, 25);
}
} catch (_) {}

// If view doesn't exist, search individual nil tables
const fallbackQueries = [
// Conversations
async () => {
const { data, error } = await ops()
.from("conversations")
.select("id, subject, preview, updated_at, next_action_at, priority_tier, source, pipeline")
.or(`subject.ilike.%${q}%,preview.ilike.%${q}%,contact_email.ilike.%${q}%`)
.limit(15);
if (error) {
logError("runSearch.conversations", error);
return [];
}
return (data || []).map(r => ({ ...r, entity_type: "conversation", card_key: `conversation:${r.id}` }));
},
// Submissions
async () => {
const { data, error } = await ops()
.from("submissions")
.select("submission_id, submission_payload, created_at")
.limit(15);
if (error) {
logError("runSearch.submissions", error);
return [];
}
const filtered = (data || []).filter(s => {
const p = s.submission_payload || {};
const searchable = [p.first_name, p.last_name, p.email, p.phone, p.state].join(" ").toLowerCase();
return searchable.includes(q.toLowerCase());
});
return filtered.map(r => ({ ...r, entity_type: "submission", card_key: `submission:${r.submission_id}` }));
},
// People
async () => {
const { data, error } = await ops()
.from("people")
.select("id, name, email, role, created_at")
.or(`name.ilike.%${q}%,email.ilike.%${q}%`)
.limit(15);
if (error) {
logError("runSearch.people", error);
return [];
}
return (data || []).map(r => ({ ...r, entity_type: "person", card_key: `person:${r.id}` }));
},
];

for (const fn of fallbackQueries) {
try {
const items = await fn();
results = results.concat(items);
} catch (err) {
logError("runSearch (individual table)", err);
}
}

return smartSortByPriority(results).slice(0, 25);
}

async function renderSearchResults(ctx, query, rows) {
const title = `🔎 Search Results: ${query}`;
if (!rows || rows.length === 0) {
const kb = Markup.inlineKeyboard([
[Markup.button.callback("🔎 New Search", "SEARCH:help")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
return smartRender(ctx, `${title}\n\nNo results found.`, kb);
}

let text = `${title}\n\n`;
const buttons = [];

for (const r of rows.slice(0, 12)) {
const cardKey = r.card_key || `${r.entity_type}:${r.id || r.submission_id}`;
const label = r.subject || r.name || r.title || r.display_title || "Item";
const sub = r.preview || r.email || r.role || r.entity_type || "";
text += `• ${shorten(label, 50)}\n  ${shorten(sub, 60)}\n  ${cardKey}\n\n`;
buttons.push([Markup.button.callback(shorten(label, 28), `OPENCARD:${cardKey}`)]);
}

buttons.push([Markup.button.callback("🔎 New Search", "SEARCH:help"), Markup.button.callback("🕘 Recent", "SEARCH:recent")]);
buttons.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);

return smartRender(ctx, text, Markup.inlineKeyboard(buttons));
}

// Message handler for search input (v5.4)
bot.on("message", async (ctx, next) => {
try {
const chatId = ctx.chat?.id;
if (!chatId) return next();

const userId = String(ctx.from?.id || "");
const editState = draftEditState.get(userId);
if (editState) {
const raw = String(ctx.message?.text || "").trim();
if (!raw) return next();
const editConv = await sbGetConversationById(editState.convId);
if (!editConv) {
draftEditState.delete(userId);
await ctx.reply("❌ Conversation not found. Open card again.");
return;
}
if (isInstantlySource(editConv)) {
draftEditState.delete(userId);
await ctx.reply("⚠ Draft editing is disabled for Instantly-managed conversations. Use CC Support from the conversation card.");
return;
}
const selected = await sbGetSelectedDraftBody(editState.convId, "conversation");
if (!selected) {
draftEditState.delete(userId);
await ctx.reply("❌ No selected draft found. Open Drafts and pick V1/V2/V3 again.");
return;
}
let subject = selected.subject || "Re:";
let body = raw;
const split = raw.split(/\n\s*\n/);
if (split.length > 1) {
subject = split[0].trim() || subject;
body = split.slice(1).join("\n\n").trim();
}
await sbSaveConversationDraftVersion(editState.convId, Number(editState.version || selected.version || 1), subject, body, true);
draftEditState.delete(userId);
await renderDraftsCard(ctx, editState.convId, "Saved edited draft");
return;
}

const searchState = getSearchMode(chatId);
if (!searchState?.awaiting) return next();

// User is in search mode - process the query
const query = ctx.message?.text;
if (!query) return next();

setSearchMode(chatId, false); // Exit search mode

const results = await runSearch(chatId, query);
await renderSearchResults(ctx, query, results);
return; // Don't call next() - we handled it
} catch (err) {
logError("search message handler", err);
return next();
}
});

// ---------- SEARCH HELP (keep) ----------
bot.action("SEARCH:help", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

// v5.4: Activate search mode
const chatId = ctx.chat?.id;
if (chatId) setSearchMode(chatId, true);

const text =
`🔎 SEARCH
--
Type your search query now:

• Coach name
• Client name or email
• Submission ID
• Phone number
• Any keyword

--
💡 Tip: Keep it simple - fewer words work better.

Or use /search <text> anytime.
--`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("🕘 Recent", "SEARCH:recent")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
await smartRender(ctx, text, kb);
}));
// ---------- SEARCH RECENT ----------
bot.action("SEARCH:recent", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const text = `🕘 RECENT ITEMS
--
Recent feature shows your last accessed conversations.

💡 To access: Open any conversation from a queue view.
--`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("📱 Calls", "CALLS:hub")],
[Markup.button.callback("⚡️ Triage", "TRIAGE:open")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);

await smartRender(ctx, text, kb);
}));
// ---------- SEARCH HELP (v5.3 + History) ----------
// ===============================
// TODAY (v5.3) — FINAL (WITH COUNTS + LIVE REFRESH)
// Shows:
// - ⚡️ Triage Due (all due-now items incl calls/no-answer followups if your triage view counts
// them)
// - 📱 Calls Today (scheduled calls that fall within NY day boundary)
// - 📝 Needs Reply (conversations in needs_reply pipeline)
// - 📚 Follow-Ups Due (coach follow-ups due now)
//
// Requires you to map these 4 count functions to your OPS views/tables:
// - sbCountTriageDueNow({ source })
// - sbCountCallsToday({ source, dayStartISO, dayEndISO })
// - sbCountNeedsReply({ source })
// - sbCountCoachFollowupsDueNow({ source })
//
// Live refresh: registers type="today" so your refresh engine can re-render it later.

// ===============================
async function sbCountTriageDueNow({ source = "all" } = {}) {
// Recommended: implement as SELECT count(*) from nil.v_triage_due_now where
// source=...
// Placeholder stub (replace with your Supabase query)
let q = ops()
.from("v_triage_due_now")
.select("card_key", { count: "exact", head: true });
if (source !== "all") {
q = q.eq("source", source);
}
const { count, error } = await q; // adjust if your view stores source differently
if (error) {
console.log("sbCountTriageDueNow error:", error);
return 0;
}
return Number(count) || 0;
}
async function sbCountNeedsReply({ source = "all" } = {}) {
// Recommended: view like nil.v_conversations_card with pipeline field
const q = ops()
.from("v_conversations_card")
.select("id", { count: "exact", head: true })
.eq("pipeline", "needs_reply");
if (source !== "all") q.eq("source", source);
const { error, count } = await q;
if (error) {
console.log("sbCountNeedsReply error:", error);
return 0;
}
return Number(count) || 0;
}
async function sbCountCoachFollowupsDueNow({ source = "all" } = {}) {
// Recommended: view like nil.v_coach_followups_due_now
let q = ops()
.from("v_coach_followups_due_now")
.select("coach_id", { count: "exact", head: true });
if (source !== "all") q = q.eq("source", source);

const { error, count } = await q;
if (error) {
console.log("sbCountCoachFollowupsDueNow error:", error);
return 0;
}
return Number(count) || 0;
}
async function sbListCoachFollowupsDueNow({ source = "all", limit = 24 } = {}) {
// List coach followups that are due now from nil.conversations
const now = new Date().toISOString();
const buildQuery = (withMetrics = true) => {
  const metricCols = withMetrics
    ? ", guide_opens_year, enroll_clicks_year, eapp_visits_year"
    : "";
  let q = ops()
    .from("conversations")
    .select(
      `id, coach_id, coach_name, contact_email, source, pipeline, subject, preview, updated_at, created_at, next_action_at${metricCols}`
    )
    .eq("pipeline", "followups")
    .lte("next_action_at", now)
    .order("next_action_at", { ascending: true })
    .limit(limit);
  if (source !== "all") q = q.eq("source", sourceSafe(source));
  return q;
};

const result = await dbSelectFirst([
  () => buildQuery(true),
  () => buildQuery(false),
]);
if (result?.error) {
  console.log("sbListCoachFollowupsDueNow error:", result.error);
  return [];
}
return result?.data || [];
}
async function sbCountCallsToday({ source = "all", dayStartISO, dayEndISO } = {}) {
// Recommended: view like nil.v_calls_card with scheduled_at
// Calls Today = scheduled_at within [dayStart, dayEnd)
let q = ops()
.from("v_calls_card")
.select("call_id", { count: "exact", head: true })
.gte("scheduled_at", dayStartISO)
.lt("scheduled_at", dayEndISO);
if (source !== "all") q = q.eq("source", source);
const { error, count } = await q;
if (error) {
console.log("sbCountCallsToday error:", error);
return 0;
}
return Number(count) || 0;
}
// ---------- TODAY ----------
bot.action("TODAY:open", safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx) || "all";
const now = new Date();
const { dayKey, time, dayStartISO, dayEndISO } = nyParts(now);
// nyParts MUST return:
// - dayKey: e.g. "Tuesday"
// - time: e.g. "3:42 PM"
// - dayStartISO: ISO string at NY 00:00
// - dayEndISO: ISO string at next day NY 00:00
// Pull counts (parallel)
const [triageDue, callsToday] = await Promise.all([
  sbCountTriageDueNow({ source: filterSource }).catch(() => 0),
  sbCountCallsToday({ source: filterSource, dayStartISO, dayEndISO }).catch(() => 0),
]);

const text =
`📅 TODAY
--
${dayKey} • ${time}

⚡️ Triage Due: ${triageDue}
📱 Calls Scheduled: ${callsToday}
--`;
const kb = Markup.inlineKeyboard([
[Markup.button.callback("⚡️ Triage", "TRIAGE:open")],
[Markup.button.callback("📱 Calls", "CALLS:hub"), Markup.button.callback("🗂 All Queues", "ALLQ:open")],
[Markup.button.callback("🔎 Search", "SEARCH:help"), Markup.button.callback("🕘 Recent", "SEARCH:recent")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
const msg = await smartRender(ctx, text, kb);
// ✅ live refresh registration
registerLiveCard(msg, {
type: "today",
card_key: `today:${filterSource}`,
ref_id: filterSource,
});
} catch (err) {
logError("TODAY:open", err);
await ctx.reply(`❌ Error loading today: ${err.message}`).catch(() => {});
}
}));
// ---------- POOLS ----------
// ===============================
// POOLS (v5.3 FINAL — Refresh Enabled)
// ===============================
bot.action("POOLS:open", safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;

const filterSource = getAdminFilter(ctx) || "all";
const rows = await sbPoolsOverview({
source: filterSource,
limit: 40,
});
// ---------- CLASSIFY ----------
const needsReply = rows.filter(r => r.needs_reply);
const followUps = rows.filter(r => !r.needs_reply && r.followup_due);
const activeChat = rows.filter(r => !r.needs_reply && !r.followup_due && r.is_active);
const activePrograms = rows.filter(
r => !r.needs_reply && !r.followup_due && !r.is_active
);
// ---------- SMART SORTING ----------
// 📝 longest waiting first
needsReply.sort(
(a,b) => (b.waiting_minutes || 0) - (a.waiting_minutes || 0)
);
// 📚 soonest follow-up first
followUps.sort(
(a,b) =>
new Date(a.followup_next_action_at || 0)
- new Date(b.followup_next_action_at || 0)
);
// 💬 most recent activity
activeChat.sort(
(a,b) =>
new Date(b.last_activity_at || 0)
- new Date(a.last_activity_at || 0)
);
// 🌊 performance score
const perfScore = r =>
(r.guide_opens_year||0)*1 +
(r.enroll_clicks_year||0)*4 +
(r.eapp_visits_year||0)*6;
activePrograms.sort((a,b)=>{

const diff = perfScore(b) - perfScore(a);
if (diff !== 0) return diff;
return new Date(b.last_activity_at||0)
- new Date(a.last_activity_at||0);
});
// ---------- BUILD TEXT ----------
const lines = [];
lines.push(`🌊 POOLS • ${filterSource}`);
lines.push("--");
const section = (title, list, builder) => {
if (!list.length) return;
lines.push(`\n${title}`);
list.slice(0,6).forEach((r,i)=>{
lines.push(builder(r,i));
});
lines.push("──────────────────────");
};
section("📝 Needs Reply", needsReply,
(r,i)=>`${i+1}) Coach ${r.coach_full_name}
${r.program_name}
Waiting: ${r.waiting_minutes || 0}m`
);
section("📚 Follow-Ups", followUps,
(r,i)=>`${i+1}) Coach ${r.coach_full_name}
${r.program_name}
Due: ${new Date(r.followup_next_action_at).toLocaleDateString()}`
);
section("💬 Active", activeChat,
(r,i)=>`${i+1}) Coach ${r.coach_full_name}
${r.program_name}`
);
lines.push("\nActive Programs");
activePrograms.slice(0,8).forEach((r,i)=>{
lines.push(
`${i+1}) Coach ${r.coach_full_name}
${r.program_name}
Guide ${r.guide_opens_year||0} | Enroll ${r.enroll_clicks_year||0} | eApp
${r.eapp_visits_year||0}`

);
});
// ---------- BUTTONS ----------
const orderedButtons = [
...needsReply,
...followUps,
...activeChat,
...activePrograms
].slice(0,12);
const kb = orderedButtons.map(r => [
Markup.button.callback(
`${r.coach_full_name}`,
`COACH:${r.coach_id}`
)
]);
kb.push([
Markup.button.callback("⬅ Dashboard","DASH:back")
]);
// ---------- SEND MESSAGE ----------
const msg = await smartRender(ctx, lines.join("\n\n"), Markup.inlineKeyboard(kb));
// ✅ REGISTER LIVE CARD (THIS IS THE IMPORTANT PART)
registerLiveCard(msg, {
type: "pools",
card_key: `pools:${filterSource}`,
ref_id: filterSource,
});
} catch (err) {
logError("POOLS:open", err);
await ctx.reply(`❌ Error loading pools: ${err.message}`).catch(() => {});
}
}));
// ==========================================================
// METRICS CARD
// ==========================================================
async function showMetricsCard(ctx, window = "month") {
if (!isAdmin(ctx)) return;
try {
const filterSource = getAdminFilter(ctx) || "all";
const metrics = await sbMetricSummary({ source: filterSource, window }).catch(() => ({}));

const titleMap = {
week: "📊 METRICS · LAST 7 DAYS",
month: "📊 METRICS · LAST 30 DAYS",
year: "📊 METRICS · THIS YEAR"
};
const title = titleMap[window] || titleMap.month;

// Calculate averages
const divisor = window === "week" ? 7 : window === "year" ? 365 : 30;
const perLabel = window === "year" ? "/mo" : "/day";
const avgDivisor = window === "year" ? 12 : divisor; // year shows per month average

const avg = (val) => Math.round((val || 0) / avgDivisor);

let body = `--
Parent Guide Link Opens: ${metrics.programLinkOpens || 0}
  (Avg ${avg(metrics.programLinkOpens)}${perLabel})

Coverage Exploration: ${metrics.coverageExploration || 0}
  (Avg ${avg(metrics.coverageExploration)}${perLabel})

Enroll Portal Visits: ${metrics.enrollClicks || 0}
  (Avg ${avg(metrics.enrollClicks)}${perLabel})

eApp Visits: ${metrics.eappVisits || 0}
  (Avg ${avg(metrics.eappVisits)}${perLabel})

Threads Created (replies): ${metrics.threadsCreated || 0}
  (Avg ${avg(metrics.threadsCreated)}${perLabel})

Calls Answered: ${metrics.callsAnswered || 0}
  (Avg ${avg(metrics.callsAnswered)}${perLabel})
--`.trim();

// Add best week/month for year view
if (window === "year" && metrics.bestWeek && metrics.bestMonth) {
const bestWeek = `🏆 Best Week: ${metrics.bestWeek.label || "—"} (Enroll ${metrics.bestWeek.enrollClicks || 0}, Threads ${metrics.bestWeek.threads || 0})`;
const bestMonth = `⭐ Best Month: ${metrics.bestMonth.label || "—"} (Enroll ${metrics.bestMonth.enrollClicks || 0}, Threads ${metrics.bestMonth.threads || 0})`;
body += `\n\n${bestWeek}\n${bestMonth}`;
}

const kb = [
[
Markup.button.callback(window === "week" ? "• Week" : "Week", "METRICS:week"),
Markup.button.callback(window === "month" ? "• Month" : "Month", "METRICS:month"),
Markup.button.callback(window === "year" ? "• Year" : "Year", "METRICS:year"),
],
[Markup.button.callback("🎉 Year Summary", "METRICS:yearsummary")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
];

const msg = await smartRender(ctx, `${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "metrics",
card_key: `metrics:${filterSource}:${window}`,
ref_id: `${filterSource}:${window}`,
});
return msg;
} catch (err) {
logError("showMetricsCard", err);
await ctx.reply("❌ Error loading metrics. Try /dashboard to refresh.").catch(() => {});
}
}

bot.action("METRICS:open", safeAction(async (ctx) => {
return showMetricsCard(ctx, "month");
}));

bot.action("METRICS:week", safeAction(async (ctx) => {
return showMetricsCard(ctx, "week");
}));

bot.action("METRICS:month", safeAction(async (ctx) => {
return showMetricsCard(ctx, "month");
}));

bot.action("METRICS:year", safeAction(async (ctx) => {
return showMetricsCard(ctx, "year");
}));

// ==========================================================
// LEADS & ANALYTICS
// ==========================================================
bot.action("LEADS:refresh", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
await smartRender(ctx, await leadsText(), leadsKeyboard());
}));

bot.action(/^LEADS:filter:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const status = ctx.match[1];
const { data: leads, error } = await ops()
.from("leads")
.select("*")
.eq("status", status)
.order("engagement_score", { ascending: false })
.limit(20);
if (error) throw new Error(error.message);
let text = `🎯 Leads (${status})\n\n`;
if (leads && leads.length > 0) {
for (const lead of leads) {
text += `• ${lead.full_name} (${lead.organization})\n  ${lead.email} | Score: ${lead.engagement_score || 0}\n\n`;
}
} else {
text += `No leads with status "${status}".\n`;
}
await smartRender(ctx, text, leadsKeyboard());
}));

bot.action("ANALYTICS:refresh", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
await smartRender(ctx, await analyticsText(), analyticsKeyboard());
}));
// ==========================================================
// CLIENTS + CLIENT CARD (v5.3 OPS CLEAN + POOLS)
// ==========================================================
//
// Drop-in replacement for your Clients module.
//
// Requires helpers (you can stub these now, backfill with views later):

// - sbClientSummary() -> { total, newMonth, withConversations, needsReply, active, completed
// }
// - sbListClients({ bucket, limit }) -> [{ client_id, name, email, phone_e164, state, last_activity_at,
// convo_count, needs_reply_count, pool_label?, coach_id?, coach_name? }]
// - sbGetClientCard(clientId) -> {
// client_id, status, last_activity_at, last_inbound_at,
// primary_role, primary_name, primary_email, primary_phone_e164, state,
// threads_total, threads_needs_reply, submissions_total, calls_open,
// coverage_accident, coverage_hospital_indemnity, coverage_type,
// people_count,
// pools: [{ pool_id, pool_label, coach_id, coach_name }] // can be []
// }
// - sbListClientThreads(clientId, limit) -> [{ id, subject, preview, pipeline, lane, last_inbound_at,
// updated_at }]
// - sbListClientSubmissions(clientId, limit) -> [{ submission_id, athlete_name, state, created_at,
// coverage_accident, coverage_hospital_indemnity, coverage_type, coach_id, coach_name,
// pool_label }]
// - sbListClientCalls(clientId, limit) -> [{ id, client_name, client_email, best_phone,
// scheduled_for, reason, outcome, updated_at, created_at, conversation_id }]
// - sbListPeopleForClient(clientId, limit) -> [{ id, name, email, phone_e164, role }]
//
// Also expects these bot/global helpers exist:
// - isAdmin(ctx)
// - idShort(str)
// - registerLiveCard(msg, meta)
// - safeEditMessageText(chat_id, message_id, text, extra) (your refresh section already has
// this)
// - queueCardRefresh(card_key) (optional; or use refreshQueue.add)
// - makeCardKey(entityType, stableId) (optional; otherwise use `client:${id}` style
// directly)
// - Markup from telegraf
//
// ==========================================================
// ------------------------------
// CLIENTS HUB
// ------------------------------
bot.action("CLIENTS:open", safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const stats = await sbClientSummary();

const text =
`👥 Clients\n\n` +
`Total Clients: ${stats?.total || 0}\n` +
`New This Month: ${stats?.newMonth || 0}\n` +
`With Conversations: ${stats?.withConversations || 0}\n` +
` 📝 Awaiting Reply: ${stats?.needsReply || 0}\n\n` +
`Quick Views\n` +
`• 💬 Active: ${stats?.active || 0}\n` +
`• ✅ Completed: ${stats?.completed || 0}`;
const kb = Markup.inlineKeyboard([
[Markup.button.callback("📝 Awaiting Reply", "CLIENTS:list:needs_reply")],
[
Markup.button.callback("💬 Active", "CLIENTS:list:active"),
Markup.button.callback("✅ Completed", "CLIENTS:list:completed"),
],
[Markup.button.callback("🆕 New This Month", "CLIENTS:list:new_month")],
[
Markup.button.callback("🕘 Recent", "CLIENTS:list:recent"),
Markup.button.callback("📜 History", "CLIENTS:list:history"),
],
[Markup.button.callback("🔎 Search", "CLIENTS:search")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
const msg = await smartRender(ctx, text, kb);
registerLiveCard(msg, {
type: "clients",
card_key: "clients:all",
ref_id: "all",
});
} catch (err) {
logError("CLIENTS:open", err);
await ctx.reply(`❌ Error loading clients: ${err.message}`).catch(() => {});
}
}));
// ------------------------------
// CLIENTS LISTS
// buckets: needs_reply | active | completed | new_month | recent | history
// ------------------------------
bot.action(/^CLIENTS:list:(needs_reply|active|completed|new_month|recent|history):?(\d*)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const bucket = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count for this bucket
const { data: allClients, error: allClientsErr } = await ops()
.from("people")
.select("client_id", { count: "exact", head: false });
if (allClientsErr) {
logError("CLIENTS:list count", allClientsErr);
return smartRender(
ctx,
buildLoadWarning("client counts", allClientsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Clients", "CLIENTS:open")]])
);
}
const totalCount = allClients?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const rows = await sbListClients({ bucket, limit: pageSize, offset });
const title =
bucket === "needs_reply" ? "📝 Clients · Awaiting Reply"
: bucket === "active" ? "💬 Clients · Active"
: bucket === "completed" ? "✅ Clients · Completed"
: bucket === "new_month" ? "🆕 Clients · New This Month"
: bucket === "recent" ? "🕘 Clients · Recent"
: "📜 Clients · History";
const endItem = Math.min(offset + rows.length, totalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${totalCount}`;
const body = rows?.length
? rows.map((c, idx) => {
const nm = c.primary_name || c.name || "—";
const em = c.primary_email || c.email || "—";
const ph = c.primary_phone_e164 || c.phone_e164 || "—";
const st = c.state || "—";
const threads = (c.convo_count ?? c.threads_total ?? "—");
const nr = (c.needs_reply_count ?? c.threads_needs_reply ?? "—");
const pool = c.pool_label ? `\n 🌊 ${c.pool_label}` : "";
return `${offset + idx + 1}. ${nm} (${st})${pool}\n ${em} · ${ph}\n Threads: ${threads} · 📝 ${nr}`;
}).join("\n\n")
: "No clients found.";
// Just navigation, no individual open buttons
const kb = [];

// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀️ Prev", `CLIENTS:list:${bucket}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶️", `CLIENTS:list:${bucket}:${currentPage + 1}`));
}
if (navRow.length > 0) kb.push(navRow);

kb.push([Markup.button.callback("⬅ Clients", "CLIENTS:open")]);
const msg = await smartRender(ctx, `${title}\n${pageInfo}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "clients_list",
card_key: `clients_list:${bucket}:${page}`,
ref_id: bucket,
});
}));
// ------------------------------
// CLIENT CARD (includes 🌊 Pools)
// ------------------------------
bot.action(/^CLIENT:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const clientId = ctx.match[1];
const c = await sbGetClientCard(clientId);
if (!c) return ctx.reply("Client not found.");
const status =
c.status === "active" ? "💬 Active"
: c.status === "quiet" ? "🤫 Quiet"
: c.status === "closed" ? "⚫ Closed"
: "💬 Active";
const primaryRole = c.primary_role === "coach" ? "Coach" : "Parent";
const name = c.primary_name || "—";
const email = c.primary_email || "—";
const phone = c.primary_phone_e164 || "—";
const state = c.state || "—";
const poolsArr = Array.isArray(c.pools) ? c.pools : [];
const poolsBlock = poolsArr.length
? poolsArr.slice(0, 3).map((p) => {
const label = p.pool_label || "—";
const coachName = p.coach_name || "—";
const coachId = p.coach_id || "—";
return `${label}\nCoach: ${coachName}\nCoachID: ${coachId}`;
}).join("\n\n")
: "";
const covLine = (() => {
const a = !!c.coverage_accident;
const h = !!c.coverage_hospital_indemnity;
if (a && h) return "✓ Accident Coverage\n✓ Hospital Indemnity";
if (a) return "✓ Accident Coverage";
if (h) return "✓ Hospital Indemnity";
return c.coverage_type ? `• ${c.coverage_type}` : "—";
})();
const text =
`👥 CLIENT
--
Name: ${name}
ClientID: ${c.client_id}
Status: ${status}

Primary: ${primaryRole}
Last Activity: ${c.last_activity_at || "—"}
Last Inbound: ${c.last_inbound_at || "—"}

──────────────────────
📬 CONTACT
Email: ${email}
Phone: ${phone}
State: ${state}
${poolsBlock ? `\n──────────────────────\n🌊 POOLS\n${poolsBlock}` : ""}

──────────────────────
📊 ACTIVITY
Threads: ${c.threads_total || 0}  📝 Needs Reply: ${c.threads_needs_reply || 0}
Submissions: ${c.submissions_total || 0}
Calls Open: ${c.calls_open || 0}

──────────────────────
🧾 COVERAGE
${covLine}

──────────────────────
`;
const hasPools = poolsArr.length > 0;
const kbRows = [
[Markup.button.callback("🧵 Threads", `CLIENT:threads:${c.client_id}`),
Markup.button.callback("🧾 Submissions", `CLIENT:subs:${c.client_id}`)],
[Markup.button.callback("📱 Calls", `CLIENT:calls:${c.client_id}`), Markup.button.callback("👥 People", `CLIENT:people:${c.client_id}`)],
];
if (hasPools) kbRows.push([Markup.button.callback("🌊 Pools",
`CLIENT:pools:${c.client_id}`)]);
kbRows.push([Markup.button.callback("🔎 Search", "CLIENTS:search")]);
kbRows.push([Markup.button.callback("⬅ Clients", "CLIENTS:open")]);
const msg = await ctx.reply(text, Markup.inlineKeyboard(kbRows));
registerLiveCard(msg, {
type: "client",
card_key: `client:${c.client_id}`,
ref_id: c.client_id,
});
}));
// ------------------------------
// CLIENT → THREADS
// ------------------------------
bot.action(/^CLIENT:threads:(.+):?(\d*)$/, safeAction(async (ctx) => {

if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count
const { data: allThreads, error: allThreadsErr } = await ops()
.from("conversations")
.select("id", { count: "exact", head: false });
if (allThreadsErr) {
logError("CLIENT:threads count", allThreadsErr);
return smartRender(
ctx,
buildLoadWarning("thread counts", allThreadsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]])
);
}
const totalCount = allThreads?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const threads = await sbListClientThreads(clientId, pageSize, offset);
const title = `🧵 Threads · ${idShort(clientId)}`;
const endItem = Math.min(offset + threads.length, totalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${totalCount}`;
const body = threads?.length
? threads.map((t, idx) => {
const pipe = t.pipeline || "active";
const label =
pipe === "urgent" ? "‼️ Urgent"
: pipe === "needs_reply" ? "📝 Needs Reply"
: pipe === "followups" ? "📚 Follow Up"
: pipe === "completed" ? "✅ Completed"
: "💬 Active";
const lane = t.lane ? ` — ${String(t.lane).toUpperCase()}` : "";
const last = t.last_inbound_at || t.updated_at || "—";
const subj = t.subject || "—";
const prev = t.preview || "—";
return `${offset + idx + 1}. ${label}${lane}\n${subj}\n${prev}\nLast inbound: ${last}`;
}).join("\n\n")
: "No threads yet.\n(If they only submitted the website form, threads will appear when a reply comes in.)";
// Just navigation, no individual open buttons
const kb = [];

// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀️ Prev", `CLIENT:threads:${clientId}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶️", `CLIENT:threads:${clientId}:${currentPage + 1}`));
}
if (navRow.length > 0) kb.push(navRow);

kb.push([Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]);
const msg = await smartRender(ctx, `${title}\n${pageInfo}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_threads",
card_key: `client_threads:${clientId}:${page}`,
ref_id: clientId,
});
}));
// ------------------------------
// CLIENT → SUBMISSIONS
// ------------------------------
bot.action(/^CLIENT:subs:(.+):?(\d*)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const clientId = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count
const { data: allSubs, error: allSubsErr } = await ops()
.from("submissions")
.select("submission_id", { count: "exact", head: false });
if (allSubsErr) {
logError("CLIENT:subs count", allSubsErr);
return smartRender(
ctx,
buildLoadWarning("submission counts", allSubsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]])
);
}
const totalCount = allSubs?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const subs = await sbListClientSubmissions(clientId, pageSize, offset);
const title = `🧾 Submissions · ${idShort(clientId)}`;
const endItem = Math.min(offset + subs.length, totalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${totalCount}`;
const body = subs?.length
? subs.map((s, idx) => {
const sid = s.submission_id || "—";
const athlete = s.athlete_name || "—";
const st = s.state || "—";
const cov =
s.coverage_accident && s.coverage_hospital_indemnity ? "Accident + Hospital Indemnity"
: s.coverage_accident ? "Accident"
: s.coverage_hospital_indemnity ? "Hospital Indemnity"
: (s.coverage_type || "—");
const pool = s.pool_label ? `\n🌊 ${s.pool_label}` : "";
const coach = s.coach_name ? `\nCoach: ${s.coach_name}` : "";
return `${offset + idx + 1}. ${sid}\nCoverage: ${cov}\nAthlete: ${athlete}\nState: ${st}\nCreated: ${s.created_at || "—"}${pool}${coach}`;
}).join("\n\n")
: "No submissions found.";
// Just navigation, no individual open buttons
const kb = [];

// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀️ Prev", `CLIENT:subs:${clientId}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶️", `CLIENT:subs:${clientId}:${currentPage + 1}`));
}
if (navRow.length > 0) kb.push(navRow);

kb.push([Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]);
const msg = await smartRender(ctx, `${title}\n${pageInfo}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_subs",
card_key: `client_subs:${clientId}:${page}`,
ref_id: clientId,
});
}));
// ------------------------------
// CLIENT → CALLS
// ------------------------------
bot.action(/^CLIENT:calls:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;

const clientId = ctx.match[1];
const calls = await sbListClientCalls(clientId, 10);
const title = `📱 CALLS
--
Client: ${idShort(clientId)}`;
const body = calls?.length
? calls.slice(0, 10).map((c) => {
const when = c.scheduled_for || "—";
const outcome = c.outcome || "—";
const reason = c.reason || "—";
const email = c.client_email || "—";
const phone = c.best_phone || c.client_phone_e164 || "—";
return `──────────────────────\n• ${when}\n  Reason: ${reason}\n  Email: ${email}\n  Phone: ${phone}\n  Outcome: ${outcome}`;
}).join("\n") + "\n──────────────────────"
: "No calls found.";
// Just back button, no individual open buttons
const kb = [[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]];
const msg = await ctx.reply(`${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_calls",
card_key: `client_calls:${clientId}`,
ref_id: clientId,
});
}));
// ------------------------------
// CLIENT → PEOPLE
// ------------------------------
bot.action(/^CLIENT:people:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const people = await sbListPeopleForClient(clientId, 12);
const title = `👥 PEOPLE
--
Client: ${idShort(clientId)}\n${people?.length || 0} record(s)`;
const body = people?.length
? people.slice(0, 12).map((p) => {
const nm = p.name || "—";
const em = p.email || "—";

const ph = p.phone_e164 || "—";
const role = p.role || "—";
return `──────────────────────\n• ${nm}\n  ${em} • ${ph}\n  Role: ${role}`;
}).join("\n") + "\n──────────────────────"
: "No people found.";
// Just back button, no individual open buttons
const kb = [[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]];
const msg = await ctx.reply(`${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_people",
card_key: `client_people:${clientId}`,
ref_id: clientId,
});
}));
// ------------------------------
// CLIENT → POOLS (optional screen)
// ------------------------------
bot.action(/^CLIENT:pools:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const c = await sbGetClientCard(clientId);
if (!c) return ctx.reply("Client not found.");
const poolsArr = Array.isArray(c.pools) ? c.pools : [];
const title = `🌊 POOLS
--
Client: ${c.primary_name || idShort(clientId)}`;
const body = poolsArr.length
? poolsArr.slice(0, 10).map((p) => {
const label = p.pool_label || "—";
const coachName = p.coach_name || "—";
const coachId = p.coach_id || "—";
return `──────────────────────\n• ${label}\n  Coach: ${coachName}\n  CoachID: ${coachId}`;
}).join("\n") + "\n──────────────────────"
: "No pools linked.";
const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)],
]);

const msg = await ctx.reply(`${title}\n\n${body}`, kb);
registerLiveCard(msg, {
type: "client_pools",
card_key: `client_pools:${clientId}`,
ref_id: clientId,
});
}));
// ==========================================================
// REFRESH ENGINE ADDITIONS (paste into refreshLiveCards)
// ==========================================================
//
// Add these meta.type cases inside your existing refreshLiveCards loop.
// (Do NOT duplicate your refresh engine; just add these branches.)
//
// else if (meta.type === "clients") {
// const stats = await sbClientSummary();
// const text =
// `👥 Clients\n\n` +
// `Total Clients: ${stats?.total || 0}\n` +
// `New This Month: ${stats?.newMonth || 0}\n` +
// `With Conversations: ${stats?.withConversations || 0}\n` +
// ` 📝 Awaiting Reply: ${stats?.needsReply || 0}\n\n` +
// `Quick Views\n` +
// `• 💬 Active: ${stats?.active || 0}\n` +
// `• ✅ Completed: ${stats?.completed || 0}`;
// const kb = Markup.inlineKeyboard([
// [Markup.button.callback("📝 Awaiting Reply", "CLIENTS:list:needs_reply")],
// [Markup.button.callback("💬 Active", "CLIENTS:list:active"), Markup.button.callback("✅ Completed", "CLIENTS:list:completed")],
// [Markup.button.callback("🆕 New This Month", "CLIENTS:list:new_month")],
// [Markup.button.callback("🕘 Recent", "CLIENTS:list:recent"), Markup.button.callback("📜 History", "CLIENTS:list:history")],
// [Markup.button.callback("🔎 Search", "CLIENTS:search")],
// [Markup.button.callback("⬅ Dashboard", "DASH:back")],
// ]);
// await safeEditMessageText(meta.chat_id, msgId, text, kb);
// }
//
// else if (meta.type === "clients_list") {
// const bucket = meta.ref_id;

// const rows = await sbListClients({ bucket, limit: 12 });
// const title =
// bucket === "needs_reply" ? "📝 Clients · Awaiting Reply"
// : bucket === "active" ? "💬 Clients · Active"
// : bucket === "completed" ? "✅ Clients · Completed"
// : bucket === "new_month" ? "🆕 Clients · New This Month"
// : bucket === "recent" ? "🕘 Clients · Recent"
// : "📜 Clients · History";
// const body = rows?.length
// ? rows.slice(0, 12).map((c) => {
// const nm = c.primary_name || c.name || "—";
// const em = c.primary_email || c.email || "—";
// const ph = c.primary_phone_e164 || c.phone_e164 || "—";
// const st = c.state || "—";
// const threads = (c.convo_count ?? c.threads_total ?? "—");
// const nr = (c.needs_reply_count ?? c.threads_needs_reply ?? "—");
// const pool = c.pool_label ? `\n 🌊 ${c.pool_label}` : "";
// return `• ${nm} (${st})${pool}\n ${em} · ${ph}\n Threads: ${threads} · 📝 ${nr}`;
// }).join("\n\n")
// : "No clients found.";
// const kb = (rows || []).slice(0, 10).map((c) => [Markup.button.callback("Open",
// `CLIENT:${c.client_id}`)]);
// kb.push([Markup.button.callback("⬅ Clients", "CLIENTS:open")]);
// await safeEditMessageText(meta.chat_id, msgId, `${title}\n\n${body}`,
// Markup.inlineKeyboard(kb));
// }
//
// else if (meta.type === "client") {
// const c = await sbGetClientCard(meta.ref_id);
// if (!c) return;
// const status = c.status === "active" ? "💬 Active" : c.status === "quiet" ? "🤫 Quiet" : c.status === "closed" ? "⚫ Closed" : "💬 Active";
// const primaryRole = c.primary_role === "coach" ? "Coach" : "Parent";
// const name = c.primary_name || "—";
// const email = c.primary_email || "—";
// const phone = c.primary_phone_e164 || "—";
// const state = c.state || "—";
// const poolsArr = Array.isArray(c.pools) ? c.pools : [];
// const poolsBlock = poolsArr.length
// ? `\n🌊 Pools\n` + poolsArr.slice(0, 3).map((p) => `${p.pool_label || "—"}\nCoach: ${p.coach_name || "—"}\nCoachID: ${p.coach_id || "—"}`).join("\n\n")
// : "";
// const covLine = (() => {
// const a = !!c.coverage_accident;

// const h = !!c.coverage_hospital_indemnity;
// if (a && h) return "✓ Accident Coverage\n✓ Hospital Indemnity";
// if (a) return "✓ Accident Coverage";
// if (h) return "✓ Hospital Indemnity";
// return c.coverage_type ? `• ${c.coverage_type}` : "—";
// })();
// const text =
// `👥 Client · ${name}\n` +
// `ClientID: ${c.client_id}\n` +
// `Status: ${status}\n\n` +
// `Primary: ${primaryRole}\n` +
// `Last Activity: ${c.last_activity_at || "—"}\n` +
// `Last Inbound: ${c.last_inbound_at || "—"}\n\n` +
// `────────────────\n\n` +
// `📬 Contact\n` +
// ---------- CALLS ----------
function callKeyboard(c) {
return Markup.inlineKeyboard([
[
Markup.button.callback("✅ Answered", `CALLSTATUS:${c.id}:answered`),
Markup.button.callback("❌ No Answer", `CALLSTATUS:${c.id}:no_answer`),
],
[
Markup.button.callback("📘 Reschedule", `CALLSTATUS:${c.id}:reschedule`),
Markup.button.callback("🚫 Canceled", `CALLSTATUS:${c.id}:canceled`),
],
[
Markup.button.callback("✅ Completed", `CALLSTATUS:${c.id}:completed`),
Markup.button.callback("🗑 Delete", `DELETECONFIRM:call:${c.id}`),
],
[Markup.button.callback("⬅ Calls", "CALLS:hub")],
]);
}
// -------- Calls Hub --------
bot.action(/^CALLS:hub:?(\d*)$/, safeAction(async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const page = parseInt(ctx.match[1]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;
  
// Get total count
const { data: allCalls, error: countErr } = await ops()
.from("calls")
.select("id", { count: "exact", head: false });
if (countErr) {
logError("CALLS:hub count", countErr);
return smartRender(
ctx,
buildLoadWarning("call counts", countErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Dashboard", "DASH:back")]])
);
}
const totalCount = allCalls?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);
  
const calls = await sbListCalls({ limit: pageSize, offset });
const endItem = Math.min(offset + calls.length, totalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${totalCount}`;
const body = calls.length ? calls.map(callSummaryLine).join("\n") + "\n──────────────────────" : "No calls found.";
// Just navigation buttons, no individual open buttons
const kb = [];
  
// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀️ Prev", `CALLS:hub:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶️", `CALLS:hub:${currentPage + 1}`));
}
if (navRow.length > 0) kb.push(navRow);
  
kb.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
const msg = await smartRender(ctx, `${viewTitle("calls")}\n${pageInfo}\n\n${body}`, Markup.inlineKeyboard(kb));
return msg;
} catch (err) {
logError("CALLS:hub", err);
await ctx.reply(`❌ Error loading calls: ${err.message}`).catch(() => {});
}
}));
// -------- Open Call Card --------
bot.action(/^CALL:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const id = ctx.match[1];
const c = await sbGetCall(id);
if (!c) return ctx.reply("Call not found.");
const textHtml = buildCallCardTextHTML(c);
const msg = await ctx.reply(textHtml, {
parse_mode: "HTML",
...callKeyboard(c),
});
// Live refresh registration
if (typeof registerLiveCard === "function") {
registerLiveCard(msg, {
type: "call",
ref_id: c.id,
card_key: `call:${c.id}`,
});
}
return msg;
}));
// -------- Set Outcome --------
bot.action(/^CALLSTATUS:(.+):(answered|no_answer|reschedule|canceled|completed)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const callId = ctx.match[1];
const outcome = ctx.match[2];
// 1) Update call outcome in DB
await sbSetCallOutcome(callId, outcome);
// 2) Reload call for linkage
const call = await sbGetCall(callId);

// 3) Map outcome -> conversation pipeline (your current locked mapping)
const outcomeToPipeline = {
answered: "completed",
completed: "completed",
no_answer: "followups",
reschedule: "followups",
canceled: "followups",
};
const nextPipeline = outcomeToPipeline[outcome] || "active";
// 4) Update linked conversation pipeline safely (if exists)
if (call?.conversation_id) {
const nowIso = new Date().toISOString();
const conv = await sbGetConversationById(call.conversation_id);
const patch = { pipeline: nextPipeline, updated_at: nowIso };
if (nextPipeline === "followups") {
// set once (don’t reset clock)
patch.followup_started_at = conv?.followup_started_at || nowIso;
} else {
// leaving followups clears followup tracking
patch.followup_started_at = null;
patch.followup_reminder_sent_at = null;
patch.followup_reminder_count = 0;
}
const { error } = await ops()
.from("conversations")
.update(patch)
.eq("id", call.conversation_id);
if (error) {
await ctx.reply(`❌ Updated call, but failed moving conversation: ${error.message}`);
return;
}
// Targeted refresh: call + conversation + main views (if those card_keys exist)
if (typeof refreshQueue !== "undefined") {
refreshQueue.add(`call:${callId}`);
refreshQueue.add(`conversation:${call.conversation_id}`);
refreshQueue.add(`triage:all`);
refreshQueue.add(`today:all`);

}
if (typeof refreshLiveCards === "function") {
refreshLiveCards(true).catch(() => {});
}
} else {
// No conversation: still refresh call + primary views
if (typeof refreshQueue !== "undefined") {
refreshQueue.add(`call:${callId}`);
refreshQueue.add(`triage:all`);
refreshQueue.add(`today:all`);
}
if (typeof refreshLiveCards === "function") {
refreshLiveCards(true).catch(() => {});
}
}
// 5) OPS ledger event
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "call.outcome_set",
source: "telegram",
direction: "inbound",
entity_type: "call",
entity_id: callId,
payload: {
outcome,
nextPipeline,
conversation_id: call?.conversation_id || null,
},
});
await ctx.reply(
`✅ Call marked ${outcome.replace("_", " ")}.${call?.conversation_id ? ` Conversation → ${nextPipeline}.` : ""}`
).catch(() => {});
}));
// ---------- METRICS: YEAR SUMMARY ----------
function yearSummaryKeyboard() {
return Markup.inlineKeyboard([
[Markup.button.callback("📊 Metrics", "METRICS:open")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}
bot.action("METRICS:yearsummary", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
const y = await sbMetricSummary({ source: filterSource, window: "year" }).catch((err) => {
logError("METRICS:yearsummary", err);
return {};
});
const text = buildYearSummaryText(y, filterSource);
const msg = await smartRender(ctx, text, yearSummaryKeyboard());
// ✅ Live refresh registration (auto-updating card)
if (typeof registerLiveCard === "function") {
registerLiveCard(msg, {
type: "metrics_year",
ref_id: filterSource,
card_key: `metrics_year:${filterSource}`,
});
}
return msg;
}));
// ---------- OPTIONAL: REFRESH BRANCH (PASTE INTO refreshLiveCards) ----------
// You said you want every update to auto-refresh.
// Add this branch inside refreshLiveCards(), alongside "conversation"/"submission"/"dashboard"
// branches:
//
// else if (meta.type === "metrics_year") {
// const filterSource = meta.ref_id || "all";
// const y = await sbMetricSummary({ source: filterSource, window: "year" });
// const text = buildYearSummaryText(y, filterSource);
// await bot.telegram.editMessageText(

// meta.chat_id,
// msgId,
// undefined,
// text,
// { ...yearSummaryKeyboard() }
// );
// }
// ===============================
// SEND SYSTEM (v5.3 OPS SAFE + CC PACKAGE + REFRESH)
// ===============================
// resolve sender email (DMARC-safe)
async function resolveFromEmail(conv, sendAs) {
// support always uses support inbox
if (sendAs === "support") return SUPPORT_FROM_EMAIL;
// outreach must use a configured outreach sender. Never fall back to support.
return conv?.outreach_from_email || OUTREACH_FROM_EMAIL || null;
}
// helpers
function makeSendIdempotencyKey(conv, useDraft, mode) {
const draftUpdated = conv?.draft_updated_at || conv?.updated_at || "";
const to = conv?.contact_email || "";
return crypto
.createHash("sha256")
.update(`${conv.id}|${useDraft}|${mode}|${draftUpdated}|${to}`)
.digest("hex");
}
// -------------------------------
// Draft helpers (YOU MUST HAVE THESE OR EQUIVALENT)
// -------------------------------
// You already have V1/V2/V3 drafts. These helpers are the bridge.
// If your draft storage differs, just adjust these two functions.
async function sbGetSelectedDraftBody(conversationId, kind = "conversation") {
// kind: "conversation" | "bridge" | "support_forward"

// Expected table: message_drafts with fields:
// conversation_id, kind, version (1/2/3), selected (bool), subject, body
const { data, error } = await ops()
.from("message_drafts")
.select("version, subject, body")
.eq("conversation_id", conversationId)
.eq("kind", kind)
.eq("selected", true)
.order("created_at", { ascending: false })
.limit(1);
if (error) return null;
const row = Array.isArray(data) ? data[0] : null;
return row ? { version: row.version, subject: row.subject || "", body: row.body || "" } : null;
}

async function sbListConversationDrafts(conversationId) {
const { data, error } = await ops()
.from("message_drafts")
.select("version, subject, body, selected, created_at")
.eq("conversation_id", conversationId)
.eq("kind", "conversation")
.order("version", { ascending: true })
.order("created_at", { ascending: false });
if (error) throw new Error(error.message);
const byVersion = new Map();
for (const row of (data || [])) {
if (!byVersion.has(row.version)) byVersion.set(row.version, row);
}
return [1,2,3].map((v) => byVersion.get(v)).filter(Boolean);
}

async function sbSaveConversationDraftVersion(conversationId, version, subject, body, selected = false) {
if (selected) {
await ops()
.from("message_drafts")
.update({ selected: false })
.eq("conversation_id", conversationId)
.eq("kind", "conversation");
}
const { error } = await ops()
.from("message_drafts")
.insert({
conversation_id: conversationId,
kind: "conversation",
version: Number(version),
subject: subject || "",
body: body || "",
selected: !!selected,
created_at: new Date().toISOString(),
});
if (error) throw new Error(error.message);
}

async function sbSelectConversationDraft(conversationId, version) {
await ops()
.from("message_drafts")
.update({ selected: false })
.eq("conversation_id", conversationId)
.eq("kind", "conversation");
const { error } = await ops()
.from("message_drafts")
.update({ selected: true })
.eq("conversation_id", conversationId)
.eq("kind", "conversation")
.eq("version", Number(version));
if (error) throw new Error(error.message);
}

async function sbLatestInboundMessage(conversationId) {
const { data, error } = await ops()
.from("messages")
.select("body, preview, subject, created_at")
.eq("conversation_id", conversationId)
.eq("direction", "inbound")
.order("created_at", { ascending: false })
.limit(1);
if (error) return null;
return Array.isArray(data) ? data[0] : null;
}

async function generateConversationDrafts(conv) {
if (!OPENAI_API_KEY) {
throw new Error("Missing OPENAI_API_KEY");
}
const inbound = await sbLatestInboundMessage(conv.id);
const isPrograms = sourceSafe(conv.source) === "programs";
let coverageExplorationYear = null;
if (isPrograms) {
  try {
    const yearly = await sbMetricSummary({ source: "programs", window: "year" });
    coverageExplorationYear = Number(yearly?.coverageExploration || 0);
  } catch (_) {
    coverageExplorationYear = null;
  }
}
const prompt = {
contact_email: conv.contact_email || "",
subject: conv.subject || "",
preview: conv.preview || "",
latest_inbound: inbound?.body || inbound?.preview || "",
coach_name: conv.coach_name || "",
source: conv.source || "support",
followup_due_at: conv.followup_next_action_at || conv.next_action_at || null,
metrics_window: "year",
enroll_clicks_year: Number(conv.enroll_clicks_year || 0),
guide_opens_year: Number(conv.guide_opens_year || 0),
coverage_exploration_total_year: coverageExplorationYear,
};
const programsSystemPrompt = "You write concise professional outreach follow-up replies for coach conversations. Return JSON with v1,v2,v3 each containing subject and body.";
const supportSystemPrompt = "You write concise professional support replies. Return JSON with v1,v2,v3 each containing subject and body.";
const programsUserPrompt = `Create 3 follow-up reply drafts for this Programs conversation:\n${JSON.stringify(prompt)}\n\nRules:\n- This is a manual follow-up reply in the outreach lane (not autonomous AI send)\n- Use metric context naturally when helpful: Enroll Clicks, Parent Guide Opens, and Total Coverage Exploration\n- Keep under 130 words\n- Include one clear next step\n- Keep tone human, confident, and concise\n- Do not mention AI\nReturn: {\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}}`;
const supportUserPrompt = `Create 3 reply drafts for this inbound conversation:\n${JSON.stringify(prompt)}\n\nRules:\n- V1 direct/helpful\n- V2 warm/relationship-focused\n- V3 concise/executive\n- Keep under 130 words\n- Include clear next step\n- Do not mention AI\nReturn: {\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}}`;
const res = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${OPENAI_API_KEY}`,
},
body: JSON.stringify({
model: "gpt-4o-mini",
temperature: 0.7,
response_format: { type: "json_object" },
messages: [
{ role: "system", content: isPrograms ? programsSystemPrompt : supportSystemPrompt },
{ role: "user", content: isPrograms ? programsUserPrompt : supportUserPrompt }
]
})
});
if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
const json = await res.json();
const content = json?.choices?.[0]?.message?.content;
if (!content) throw new Error("No draft content from OpenAI");
const parsed = JSON.parse(content);
return parsed;
}

async function generateCCDrafts(conv) {
if (!OPENAI_API_KEY) {
throw new Error("Missing OPENAI_API_KEY");
}
const inbound = await sbLatestInboundMessage(conv.id);
const prompt = {
contact_email: conv.contact_email || "",
subject: conv.subject || "",
preview: conv.preview || "",
latest_inbound: inbound?.body || inbound?.preview || "",
coach_name: conv.coach_name || "",
source: conv.source || "outreach",
};
const res = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${OPENAI_API_KEY}`,
},
body: JSON.stringify({
model: "gpt-4o-mini",
temperature: 0.7,
response_format: { type: "json_object" },
messages: [
{ role: "system", content: "You write CC bridge and support messages. Return JSON with bridge (v1-v3) and support (v1-v3) drafts, each with subject and body." },
{ role: "user", content: `Create CC drafts for this conversation:\n${JSON.stringify(prompt)}\n\nCreate 6 drafts total:\nBridge messages (to be sent from outreach to contact):\n- V1: Short/Direct ("Looping in support...")\n- V2: Warm/Personal (build relationship)\n- V3: Ultra-brief (executive style)\n\nSupport messages (forwardable from ${SUPPORT_FROM_EMAIL}):\n- V1: Professional/Detailed\n- V2: Warm/Helpful\n- V3: Quick/Action-focused\n\nKeep all under 130 words. Return: {\"bridge\":{\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}},\"support\":{\"v1\":{...},\"v2\":{...},\"v3\":{...}}}` }
]
})
});
if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
const json = await res.json();
const content = json?.choices?.[0]?.message?.content;
if (!content) throw new Error("No CC draft content from OpenAI");
const parsed = JSON.parse(content);
return parsed;
}

// CC drafts cache (in-memory, per conversation)
const ccDraftsCache = new Map();

function draftsKeyboard(convId, selectedVersion = null) {
const tag = (v) => selectedVersion === v ? " ✅" : "";
return Markup.inlineKeyboard([
[Markup.button.callback(`View V1${tag(1)}`, `DRAFTS:view:${convId}:1`), Markup.button.callback(`View V2${tag(2)}`, `DRAFTS:view:${convId}:2`), Markup.button.callback(`View V3${tag(3)}`, `DRAFTS:view:${convId}:3`)],
[Markup.button.callback("✏️ Edit Selected", `DRAFTS:edit:${convId}`), Markup.button.callback("♻️ Regenerate", `DRAFTS:regen:${convId}`)],
[Markup.button.callback("📤 Send (Support)", `CONFIRMSEND:${convId}:1:support`), Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]
]);
}

async function renderDraftsCard(ctx, convId, note = "") {
const drafts = await sbListConversationDrafts(convId);
const selected = drafts.find((d) => d.selected) || drafts[0] || null;
let text = `✍️ Reply Drafts (V1/V2/V3)\nConversation: ${idShort(convId)}\n`;
if (note) text += `\n${note}\n`;
if (!drafts.length) {
text += "\nNo drafts yet. Tap Regenerate.";
return smartRender(ctx, text, draftsKeyboard(convId, null));
}
for (const d of drafts) {
const marker = d.selected ? "✅" : "▫️";
text += `\n${marker} V${d.version}\nSubject: ${d.subject || "—"}\n${shorten(d.body || "", 220)}\n`;
}
return smartRender(ctx, text, draftsKeyboard(convId, selected?.version || null));
}

bot.action(/^DRAFTS:open:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const conv = await sbGetConversationById(convId);
if (!conv) {
await smartRender(ctx, `❌ Conversation not found.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
return;
}
if (await blockInstantlyManagedAction(ctx, conv, convId, "Draft generation")) return;
const drafts = await sbListConversationDrafts(convId);
if (!drafts.length) {
// Show loading state immediately
await smartRender(
ctx,
`✍️ Reply Drafts (V1/V2/V3)\nConversation: ${idShort(convId)}\n\n⏳ Generating drafts, please wait...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
// Do slow generation
const generated = await generateConversationDrafts(conv);
await sbSaveConversationDraftVersion(convId, 1, generated?.v1?.subject || conv.subject || "Re:", generated?.v1?.body || "", true);
await sbSaveConversationDraftVersion(convId, 2, generated?.v2?.subject || conv.subject || "Re:", generated?.v2?.body || "", false);
await sbSaveConversationDraftVersion(convId, 3, generated?.v3?.subject || conv.subject || "Re:", generated?.v3?.body || "", false);
}
// Show final result
await renderDraftsCard(ctx, convId);
} catch (err) {
logError("DRAFTS:open", err);
await smartRender(ctx, `❌ Draft error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
}
}));

// Redirect OPENCALL -> CALL (triage buttons emit OPENCALL:id)
bot.action(/^OPENCALL:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const id = ctx.match[1];
const c = await sbGetCall(id);
if (!c) return ctx.reply("Call not found.");
const textHtml = buildCallCardTextHTML(c);
const msg = await ctx.reply(textHtml, { parse_mode: "HTML", ...callKeyboard(c) });
if (msg?.message_id) registerLiveCard(msg, { type: "call", ref_id: c.id, card_key: `call:${c.id}` });
}));

bot.action(/^DRAFTS:view:(.+):(1|2|3)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const version = parseInt(ctx.match[2], 10);
try {
const conv = await sbGetConversationById(convId);
if (!conv) {
return smartRender(ctx, `❌ Conversation not found.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (await blockInstantlyManagedAction(ctx, conv, convId, "Draft viewing")) return;
const drafts = await sbListConversationDrafts(convId);
const draft = drafts.find((d) => d.version === version);
if (!draft) {
return smartRender(ctx, `❌ Draft V${version} not found.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `DRAFTS:open:${convId}`)]]));
}
const selected = drafts.find((d) => d.selected);
const isSelected = selected?.version === version;
const marker = isSelected ? "✅ SELECTED" : "";
let text = `✍️ Draft V${version} ${marker}\nConversation: ${idShort(convId)}\n\n`;
text += `📧 Subject: ${draft.subject || "—"}\n\n`;
text += `📝 Body:\n${draft.body || "(empty)"}`;
const buttons = [
[Markup.button.callback(isSelected ? "✅ Selected" : "✅ Select This", `DRAFTS:use:${convId}:${version}`)],
[Markup.button.callback("⬅ Back to Drafts", `DRAFTS:open:${convId}`)]
];
await smartRender(ctx, text, Markup.inlineKeyboard(buttons));
} catch (err) {
logError("DRAFTS:view", err);
await smartRender(ctx, `❌ Error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `DRAFTS:open:${convId}`)]]));
}
}));

bot.action(/^DRAFTS:use:(.+):(1|2|3)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const version = Number(ctx.match[2]);
try {
const conv = await sbGetConversationById(convId);
if (!conv) {
return smartRender(ctx, `❌ Conversation not found.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (await blockInstantlyManagedAction(ctx, conv, convId, "Draft selection")) return;
await sbSelectConversationDraft(convId, version);
// Show the draft view with updated selection
const drafts = await sbListConversationDrafts(convId);
const draft = drafts.find((d) => d.version === version);
if (!draft) {
return renderDraftsCard(ctx, convId, `✅ Selected V${version}`);
}
let text = `✍️ Draft V${version} ✅ SELECTED\nConversation: ${idShort(convId)}\n\n`;
text += `📧 Subject: ${draft.subject || "—"}\n\n`;
text += `📝 Body:\n${draft.body || "(empty)"}`;
const buttons = [
[Markup.button.callback("✅ Selected", `DRAFTS:use:${convId}:${version}`)],
[Markup.button.callback("⬅ Back to Drafts", `DRAFTS:open:${convId}`)]
];
await smartRender(ctx, text, Markup.inlineKeyboard(buttons));
} catch (err) {
logError("DRAFTS:use", err);
await smartRender(ctx, `❌ Select draft failed: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
}
}));

bot.action(/^DRAFTS:regen:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const conv = await sbGetConversationById(convId);
if (!conv) {
await smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
return;
}
if (await blockInstantlyManagedAction(ctx, conv, convId, "Draft regeneration")) return;
// Show loading state
await smartRender(
ctx,  `✍️ Reply Drafts (V1/V2/V3)\nConversation: ${idShort(convId)}\n\n⏳ Regenerating drafts, please wait...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
const generated = await generateConversationDrafts(conv);
await sbSaveConversationDraftVersion(convId, 1, generated?.v1?.subject || conv.subject || "Re:", generated?.v1?.body || "", true);
await sbSaveConversationDraftVersion(convId, 2, generated?.v2?.subject || conv.subject || "Re:", generated?.v2?.body || "", false);
await sbSaveConversationDraftVersion(convId, 3, generated?.v3?.subject || conv.subject || "Re:", generated?.v3?.body || "", false);
await renderDraftsCard(ctx, convId, "Regenerated drafts");
} catch (err) {
logError("DRAFTS:regen", err);
await smartRender(ctx, `❌ Regenerate failed: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
}
}));

bot.action(/^DRAFTS:edit:(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const conv = await sbGetConversationById(convId);
if (!conv) {
await smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
return;
}
if (await blockInstantlyManagedAction(ctx, conv, convId, "Draft editing")) return;
const selected = await sbGetSelectedDraftBody(convId, "conversation");
if (!selected) return ctx.reply("No selected draft. Choose V1/V2/V3 first.");
const userId = String(ctx.from?.id || "");
draftEditState.set(userId, { convId, version: Number(selected.version || 1) });
await ctx.reply(`✏️ Send your edited reply now.\n\nFormat:\nLine 1 = Subject\nBlank line\nThen body\n\nIf you send only text, it will replace body and keep subject.`);
} catch (err) {
logError("DRAFTS:edit", err);
await ctx.reply(`❌ Edit setup failed: ${err.message}`).catch(() => {});
}
}));
// -------------------------------
// send request → webhook (n8n / make)
// -------------------------------
async function sendViaMake(
conv,
{ useDraft = 1, ccSupport = false, sendAs = "support", subjectOverride = null, bodyOverride =
null } = {}
) {
const trace_id = makeTraceId();
const idempotency_key = makeSendIdempotencyKey(conv, useDraft, sendAs);
const fromEmail = await resolveFromEmail(conv, sendAs);
if (sendAs === "outreach" && !fromEmail) {
return {
ok: false,
status: 422,
trace_id,
idempotency_key,
error: "outreach_sender_not_configured",
bodyText: "",
};
}
const payload = {
schema_version: "5.3",
event_type: "outbox.email.send_requested",
source: "telegram",
direction: "outbound",
trace_id,
idempotency_key,

conversation_id: conv.id,
thread_key: conv.thread_key,
coach_id: conv.coach_id || null,
coach_name: conv.coach_name || null,
contact_email: conv.contact_email || null,
subject: subjectOverride ?? (conv.subject || ""),
body: bodyOverride ?? "",
cc_support: !!ccSupport,
send_as: sendAs,
from_email: fromEmail,
// threading support
gmail_thread_id: conv.gmail_thread_id || null,
message_id_header: conv.message_id_header || null,
in_reply_to: conv.in_reply_to || null,
references: conv.references || null,
mirror_conversation_id: conv.mirror_conversation_id || null,
use_draft: Number(useDraft),
};
const validation = validateOutboundPayload(payload, {
  requireConversationId: true,
  requireThreadKey: true,
  requireSendAs: true,
  requireSubject: true,
  requireBody: true,
});
if (!validation.ok) {
logOutboundValidationError("sendViaMake", payload, validation.errors);
return {
ok: false,
status: 422,
trace_id: payload.trace_id,
idempotency_key: payload.idempotency_key,
error: "invalid_outbound_payload",
bodyText: validation.errors.join(","),
};
}
const sendHeaders = {};
if (BASE_WEBHOOK_SECRET) sendHeaders["x-nil-secret"] = BASE_WEBHOOK_SECRET;
const res = await postJsonWebhook(MAKE_SEND_WEBHOOK_URL, payload, {
headers: sendHeaders,
});
return {
ok: res.ok,
status: res.status,
trace_id,
idempotency_key,
error: res.error || null,
bodyText: res.bodyText || "",
};
}

async function blockInstantlyManagedAction(ctx, conv, convId, actionLabel = "This action") {
if (!isInstantlySource(conv)) return false;
await smartRender(
ctx,
`⚠ ${actionLabel} is disabled for Instantly-managed conversations.\n\nUse 📌 CC Support from the conversation card.`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
return true;
}

// ===============================
// SEND BUTTON PRESSED (single send)
// ===============================
bot.action(/^SEND:(.+):([01])$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const conv = await sbGetConversationById(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
if (await blockInstantlyManagedAction(ctx, conv, convId, "Manual send")) return;

// Determine send mode(s) based on conversation state
const isSupport = conv.source === "support";
const isCCd = conv.cc_support_suggested === true;
const isLockedToSupport = isSupport || isCCd;

// If locked to one mode, skip the choice
if (isLockedToSupport) {
// Support mode only
await smartRender(
ctx,
`📤 Send Draft (Support)\n\nSend lane is locked to Support.\n\n${isSupport ? "This is a Support conversation." : "CC Support has been enabled."}`,
Markup.inlineKeyboard([
[Markup.button.callback("✅ Send as Support", `CONFIRMSEND:${convId}:${useDraft}:support`)],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
])
);
} else {
// Programs without CC: can choose between outreach and support
const kb = Markup.inlineKeyboard([
[
Markup.button.callback("📤 Send as Outreach ✅", `CONFIRMSEND:${convId}:${useDraft}:outreach`),
Markup.button.callback("📤 Send as Support", `CONFIRMSEND:${convId}:${useDraft}:support`),
],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
]);
await smartRender(ctx, `📤 Send Draft\n\nChoose sending lane:\n\n(Outreach selected by default. Use Support only if CC is enabled manually.)`, kb);
}
}));
// ===============================
// CONFIRM SEND SCREEN (single send)
// ===============================
bot.action(/^CONFIRMSEND:(.+):([01]):(support|outreach)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const mode = ctx.match[3];
const conv = await sbGetConversationById(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
if (await blockInstantlyManagedAction(ctx, conv, convId, "Manual send")) return;

const fromEmail = await resolveFromEmail(conv, mode);
if (mode === "outreach" && !fromEmail) {
return smartRender(
ctx,
"❌ Outreach sender is not configured. Set OUTREACH_FROM_EMAIL (or conversation outreach sender) before sending.",
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
}
const modeLabel = mode === "support" ? "Support (forwarding)" : "Outreach (direct)";
const selectedDraft = await sbGetSelectedDraftBody(convId, "conversation");
const draftLabel = selectedDraft?.version ? `Selected V${selectedDraft.version}` : `V${useDraft}`;
const kb = Markup.inlineKeyboard([
[Markup.button.callback("✅ Send Now", `DOSEND:${convId}:${useDraft}:${mode}`)],
[Markup.button.callback("Cancel", `OPENCARD:${convId}`)],
]);
await smartRender(ctx, `⚠ Confirm send?\n\nMode: ${modeLabel}\nFrom: ${fromEmail}\nDraft: ${draftLabel}`, kb);
}));

// ===============================
// FINAL SEND EXECUTION (single send)
// ===============================
bot.action(/^DOSEND:(.+):([01]):(support|outreach)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const mode = ctx.match[3];
const conv = await sbGetConversationById(convId);
if (!conv) return smartRender(ctx, "❌ Conversation not found.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "DASH:back")]]));
if (await blockInstantlyManagedAction(ctx, conv, convId, "Manual send")) return;
// Pull the selected conversation draft body (kind="conversation")
const selected = await sbGetSelectedDraftBody(convId, "conversation");
const subjectOverride = selected?.subject || conv.subject || "";
const bodyOverride = selected?.body || "";
const result = await sendViaMake(conv, {
useDraft,
ccSupport: !!conv.cc_support_enabled, // IMPORTANT: actual toggle, not just suggested
sendAs: mode,
subjectOverride,
bodyOverride,
});
// OPS ledger event
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "message.send_requested",
source: "telegram",
direction: "outbound",
entity_type: "conversation",
entity_id: convId,
trace_id: result.trace_id,
idempotency_key: result.idempotency_key,
payload: { mode, useDraft, result },
});
const { text: cardText, msgCount, isInstantlyInbound } = await buildConversationCard(conv);
const errorHint = !result.ok
? `\n\nReason: ${shorten(result.error || result.bodyText || "unknown_error", 220)}`
: "";
const successText = result.ok ? `✅ Send queued.\n\n${cardText}` : `❌ Send failed (${result.status || "?"})${errorHint}`;
await smartRender(
ctx,
successText,
result.ok ? conversationCardKeyboard(conv, msgCount, { isInstantlyInbound }) : Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
// Instant refresh
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});

}));
// ==========================================================
// UNIVERSAL DELETE (SOFT BY DEFAULT; HARD ONLY FOR is_test=true)
// ==========================================================
const ENTITY_MAP = {
conversation: { table: "conversations", pk: "id", soft: true },
submission: { table: "submissions", pk: "submission_id", soft: true },
call: { table: "calls", pk: "id", soft: true },
person: { table: "people", pk: "id", soft: true },
coach: { table: "coaches", pk: "coach_id", soft: true }, // adjust pk if needed
message: { table: "messages", pk: "id", soft: true },
metric_event: { table: "metric_events", pk: "id", soft: true },
coach_event: { table: "coach_events", pk: "id", soft: true },
failure: { table: "failures", pk: "id", soft: true },
};
// confirm
bot.action(/^DELETECONFIRM:([a-z_]+):(.+)$/, safeAction(async (ctx) => {

if (!isAdmin(ctx)) return;
const entityType = ctx.match[1];
const stableId = ctx.match[2];
if (!ENTITY_MAP[entityType]) return ctx.reply(`Delete not supported for: ${entityType}`);
await ctx.reply(
`⚠ Delete ${entityType}:${stableId}?\n\nSoft-delete by default.\nHard-delete only if
is_test=true.`,
Markup.inlineKeyboard([
[Markup.button.callback("✅ Yes Delete", `DELETE:${entityType}:${stableId}`)],
[Markup.button.callback("Cancel", "DASH:back")],
])
).catch(() => {});
}));
// do delete
bot.action(/^DELETE:([a-z_]+):(.+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const entityType = ctx.match[1];
const stableId = ctx.match[2];
const meta = ENTITY_MAP[entityType];
if (!meta) return ctx.reply(`Delete not supported for: ${entityType}`);
const nowIso = new Date().toISOString();
// ledger
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "card.deleted",
source: "telegram",
direction: "inbound",
entity_type: entityType,
entity_id: (entityType !== "submission" ? stableId : null),
submission_id: (entityType === "submission" ? stableId : null),
payload: {
entityType,
stableId,
requested_by: String(ctx.from?.id || ""),
reason: "manual_delete",
},
});

// fetch row
let row = null;
try {
const { data, error } = await ops()
.from(meta.table)
.select("*")
.eq(meta.pk, stableId)
.maybeSingle();
if (error) throw new Error(error.message);
row = data || null;
} catch (e) {
return ctx.reply(`Lookup failed: ${e.message || e}`);
}
if (!row) return ctx.reply("Not found.");
const isTest = row.is_test === true;
// hard delete only for test rows
if (isTest) {
const { error } = await ops().from(meta.table).delete().eq(meta.pk, stableId);
if (error) return ctx.reply(`❌ Hard delete failed: ${error.message}`);
await ctx.reply("🗑 Deleted (hard, test row).");
} else {
// soft delete
const patch = {
deleted_at: nowIso,
deleted_by: String(ctx.from?.id || ""),
delete_reason: "manual_delete",
updated_at: nowIso,
};
const { error } = await ops().from(meta.table).update(patch).eq(meta.pk, stableId);
if (error) return ctx.reply(`❌ Soft delete failed: ${error.message}`);
await ctx.reply("🗑 Deleted (soft).");
}
// refresh (best effort)
if (entityType === "conversation") refreshQueue.add(`conversation:${stableId}`);
if (entityType === "call") refreshQueue.add(`call:${stableId}`);
if (entityType === "submission") refreshQueue.add(`submission:${stableId}`);
refreshLiveCards(true).catch(() => {});
}));

// ==========================================================
// LIVE AUTO CARD REFRESH (v5.3 FINAL OPS ENGINE)
// ==========================================================
const liveCards = new Map();
// msgId -> { chat_id, card_key, type, ref_id, filterSource?, added_at }
const refreshQueue = new Set();
// holds card_keys OR surface keys (dashboard:all, triage:all, etc.)
let lastRefreshMs = 0;
// ----------------------------------------------------------
// REGISTER CARD
// ----------------------------------------------------------
function registerLiveCard(msg, meta = {}) {
if (!msg?.message_id) return;
const chatId = msg.chat?.id ?? meta.chat_id;
if (!chatId) return;
liveCards.set(msg.message_id, {
...meta,
chat_id: chatId,
added_at: Date.now(),
});
}
// ----------------------------------------------------------
// QUEUE REFRESH (USE EVERYWHERE) - with overflow protection
// ----------------------------------------------------------
const MAX_REFRESH_QUEUE_SIZE = 1000;

function queueCardRefresh(card_key) {
if (!card_key) return;

// Prevent queue overflow
if (refreshQueue.size >= MAX_REFRESH_QUEUE_SIZE) {
console.log(`[WARN] Refresh queue full (${refreshQueue.size}), clearing`);
refreshQueue.clear();
}

refreshQueue.add(card_key);
}
// ----------------------------------------------------------
// CLEANUP OLD CARDS (improved)
// ----------------------------------------------------------
function cleanupLiveCards() {
const ttl = (LIVE_CARD_TTL_MINUTES || 60) * 60 * 1000;
const now = Date.now();
let cleaned = 0;

for (const [msgId, m] of liveCards.entries()) {
if (!m?.added_at || (now - m.added_at) > ttl) {
liveCards.delete(msgId);
cleaned++;
}
}

// Also limit total card count to prevent memory issues
const MAX_LIVE_CARDS = 500;
if (liveCards.size > MAX_LIVE_CARDS) {
// Sort by age and remove oldest
const sorted = Array.from(liveCards.entries())
.sort((a, b) => (a[1].added_at || 0) - (b[1].added_at || 0));
const toRemove = sorted.slice(0, liveCards.size - MAX_LIVE_CARDS);
for (const [msgId] of toRemove) {
liveCards.delete(msgId);
cleaned++;
}
}

if (cleaned > 0) {
console.log(`[INFO] Cleaned up ${cleaned} old live cards`);
}
}
// ----------------------------------------------------------
// SAFE EDIT (with timeout)
// ----------------------------------------------------------
async function safeEditMessageText(chat_id, message_id, text, extra) {
try {
await withTimeout(
bot.telegram.editMessageText(chat_id, message_id, undefined, text, extra),
7000,
"Edit timed out"
);
return true;
} catch (err) {
const msg = String(err?.description || err?.message || "");
if (msg.includes("message is not modified")) return true;
if (
msg.includes("message to edit not found") ||
msg.includes("MESSAGE_ID_INVALID") ||
msg.includes("chat not found") ||
msg.includes("Forbidden") ||
msg.includes("bot was blocked") ||
msg.includes("timed out")
) {
liveCards.delete(message_id);
return false;
}
console.log(`[WARN] Edit failed: ${msg.substring(0, 60)}`);
return false;
}
}
// ----------------------------------------------------------
// MAIN REFRESH LOOP (with rate limiting)
// ----------------------------------------------------------
let refreshInProgress = false;
const editCountPerSecond = new Map(); // track edits per second for rate limiting

async function refreshLiveCards(force = false) {
if (!ENABLE_TELEGRAM_LIVE_REFRESH) return;
if (refreshInProgress) {
console.log("[INFO] Refresh already in progress, skipping");
return;
}

cleanupLiveCards();
const now = Date.now();
if (!force && now - lastRefreshMs < (REFRESH_MIN_INTERVAL_MS || 1500)) return;
lastRefreshMs = now;

refreshInProgress = true;
try {
const hasQueue = refreshQueue.size > 0;
let editCount = 0;
const currentSecond = Math.floor(now / 1000);

// Rate limit: max 20 edits per second to avoid Telegram API throttling
const MAX_EDITS_PER_SECOND = 20;
const secondKey = currentSecond;
const currentCount = editCountPerSecond.get(secondKey) || 0;

if (currentCount >= MAX_EDITS_PER_SECOND) {
console.log("[INFO] Rate limit reached, deferring refresh");
return;
}

for (const [msgId, meta] of liveCards.entries()) {
// Check rate limit
if (editCount >= MAX_EDITS_PER_SECOND - currentCount) {
console.log("[INFO] Approaching rate limit, stopping refresh batch");
break;
}

try {
const key = meta.card_key;
// targeted refresh logic
if (hasQueue) {
if (!key) continue;
if (
!refreshQueue.has(key) &&
!refreshQueue.has(`${meta.type}:all`) &&
!refreshQueue.has("dashboard:all")
) continue;
}
// ======================
// CONVERSATION CARD
// ======================
if (meta.type === "conversation") {
const conv = await withTimeout(
sbGetConversationById(meta.ref_id),
5000,
"DB query timed out"
);
if (!conv) continue;
const { text, msgCount, isInstantlyInbound } = await buildConversationCard(conv);
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
text,
conversationCardKeyboard(conv, msgCount, { isInstantlyInbound })
);
if (edited) editCount++;
}
// ======================
// SUBMISSION
// ======================
else if (meta.type === "submission") {
const sub = await withTimeout(
sbGetSubmission(meta.ref_id),
5000,
"DB query timed out"
);
if (!sub) continue;
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
buildSubmissionCard(sub),
submissionKeyboard(sub)
);
if (edited) editCount++;
}
// ======================
// CALL CARD (NEW v5.3)
// ======================
else if (meta.type === "call") {
const call = await withTimeout(
sbGetCall(meta.ref_id),
5000,
"DB query timed out"
);
if (!call) continue;
const textHtml = buildCallCardTextHTML(call);
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
textHtml,
{ parse_mode: "HTML", ...callKeyboard(call) }
);
if (edited) editCount++;
}
// ======================
// THREAD VIEW
// ======================
else if (meta.type === "thread_view") {
const convId = meta.conv_id || String(meta.ref_id || "").split(":")[0];
if (!convId) continue;
const parsedOffset = Number(String(meta.ref_id || "").split(":")[1] || 0);
const offset = Number(meta.offset ?? parsedOffset ?? 0);
const limit = Number(meta.limit ?? 6);
const page = await withTimeout(
buildThreadPage(convId, offset, limit),
5000,
"Thread load timed out"
);
if (page?.ok) {
const edited = await safeEditMessageText(meta.chat_id, msgId, page.text, page.keyboard);
if (edited) editCount++;
}
}
// ======================
// POOLS / COACH CARD
// ======================
else if (meta.type === "coach") {
const coach = await withTimeout(
sbGetCoach(meta.ref_id),
5000,
"DB query timed out"
);
if (!coach) continue;
const filterSource = meta.filterSource || "all";
const convs = await sbListConversationsByCoach({ coach_id: coach.coach_id, source: filterSource, limit: 10 }).catch(() => []);
const coachText = `🧑‍🏫 COACH
--
Name: ${coach.coach_name || "—"}

Program: ${coach.program || coach.school || "—"}

Active Conversations: ${convs.length}

--
Created: ${coach.created_at || "—"}
--`;
const coachKb = Markup.inlineKeyboard([
[Markup.button.callback("📬 Conversations", `COACH:convs:${coach.coach_id}`)],
[Markup.button.callback("⬅ Back", "POOLS:open")],
]);
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
coachText,
coachKb
);
if (edited) editCount++;
}
// ======================
// TRIAGE VIEW
// ======================
else if (meta.type === "triage") {
const filterSource = meta.filterSource || "all";
if (typeof triageText !== "function" || typeof triageKeyboard !== "function") continue;
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
await triageText(filterSource),
triageKeyboard(filterSource)
);
if (edited) editCount++;
}
// ======================
// TODAY VIEW
// ======================
else if (meta.type === "today") {
if (typeof todayText !== "function" || typeof todayKeyboard !== "function") continue;
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
await todayText(),
todayKeyboard()
);
if (edited) editCount++;
}
// ======================
// METRICS / SUMMARY
// ======================
else if (meta.type === "metrics") {
const filterSource = meta.filterSource || "all";
if (typeof metricsText !== "function" || typeof metricsKeyboard !== "function") continue;
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
await metricsText(filterSource),
metricsKeyboard()
);
if (edited) editCount++;
}
// ======================
// METRICS YEAR SUMMARY
// ======================
else if (meta.type === "metrics_year") {
const filterSource = meta.ref_id || "all";
const y = await sbMetricSummary({ source: filterSource, window: "year" }).catch(() => ({}));
const text = buildYearSummaryText(y, filterSource);
await safeEditMessageText(
meta.chat_id,
msgId,
text,
yearSummaryKeyboard()
);
}
// ======================
// DASHBOARD
// ======================
else if (meta.type === "dashboard") {
const filterSource = meta.filterSource || "all";
const edited = await safeEditMessageText(
meta.chat_id,
msgId,
await dashboardText(filterSource),
dashboardKeyboardV50()
);
if (edited) editCount++;
}

} catch (err) {
// never crash loop
console.log(`[WARN] Refresh error for card ${msgId}: ${err.message?.substring(0, 40)}`);
}
}

// Update edit counter
editCountPerSecond.set(secondKey, currentCount + editCount);

// Cleanup old counters (keep only last 5 seconds)
for (const [key] of editCountPerSecond.entries()) {
if (key < currentSecond - 5) {
editCountPerSecond.delete(key);
}
}

refreshQueue.clear();
} catch (err) {
console.log(`[ERROR] Refresh loop error: ${err.message}`);
} finally {
refreshInProgress = false;
}
}
// ----------------------------------------------------------
// AUTO LOOP
// ----------------------------------------------------------
setInterval(() => {
refreshLiveCards(false).catch(() => {});
}, 6 * 1000);
setInterval(() => {
runOutboxSenderTick().catch(() => {});
}, OUTBOX_POLL_MS);
setTimeout(() => {
runOutboxSenderTick().catch(() => {});
}, 1500);
async function syncConversationRoleFromSubmission({ email, role, submission_id, nowIso }) {
const normalized = normalizeEmail(email);
if (!normalized) return null;
const convo = await sbFindConversationByEmail(normalized);
if (!convo?.id) return null;

const nextRole = normalizeRole(role) || "parent";
const currentRole = normalizeRole(convo.role) || "parent";

let updatePatch = {
updated_at: nowIso,
role_source: "submission_link",
role_last_updated_at: nowIso,
};

// Safe linking rule:
if (!convo.role) {
// No existing role, set it directly
updatePatch.role = nextRole;
updatePatch.role_confidence = "high";
} else if (currentRole === nextRole) {
// Same role, no change needed
return convo.id;
} else {
// CONFLICT: Different roles. Set pending instead of overwriting.
updatePatch.role_pending = nextRole;
updatePatch.role_confidence = "low";
}

try {
const { error } = await ops()
.from("conversations")
.update(updatePatch)
.eq("id", convo.id);
if (error) {
if (isMissingColumnError(error)) return null;
throw new Error(error.message);
}
} catch (err) {
logError("syncConversationRoleFromSubmission", err);
return null;
}

try {
await sbInsertOpsEventSafe({
schema_version: "5.3",
event_type: "conversation.role.updated",
source: "ops",
direction: "inbound",
entity_type: "conversation",
entity_id: convo.id,
submission_id: submission_id || null,
client_email: normalized,
payload: {
previous_role: convo.role || null,
role: nextRole,
conflict: currentRole !== nextRole,
pending: updatePatch.role_pending || null,
},
});
} catch (err) {
logError("conversation.role.updated", err);
}

refreshQueue.add(makeCardKey("conversation", convo.id));
refreshQueue.add("triage:all");
refreshQueue.add("dashboard:all");
refreshQueue.add("allq:all");
return convo.id;
}
// ---------- CANONICAL OPS INGEST: /ops/ingest (v5.3 CLEAN) ----------
app.post("/ops/ingest", async (req, res) => {
try {
  // Validate auth first
  if (!verifyOpsIngestAuth(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  
  // Validate request body
  const b = req.body;
  if (!b || typeof b !== "object") {
    return res.status(400).json({ ok: false, error: "Request body must be JSON object" });
  }
  
  const nowIso = new Date().toISOString();
  // ---- normalize canonical envelope ----
  const schema_version = b.schema_version || "5.3";
  let event_type = String(b.event_type || "unknown.event").trim();
  const source = String(b.source || "unknown").trim();
  const direction = String(b.direction || "inbound").trim();
  const trace_id = String(b.trace_id || uuidv4()).trim();
  let idempotency_key = b.idempotency_key ? String(b.idempotency_key).trim() : null;
  const entity_type = b.entity_type ? String(b.entity_type).trim() : null;
  const entity_id = b.entity_id ? String(b.entity_id).trim() : null;
  const submission_id = (b.submission_id || b.payload?.submission_id || b.payload?.submissionId || "").toString().trim() || null;
  const client_email = (b.client?.email || b.client_email || "").toString().trim() || null;
  const client_phone_e164 = (b.client?.phone_e164 || b.client_phone_e164 || "").toString().trim() || null;

  let payload = b.payload || b;
  if (!payload || typeof payload !== "object") {
    payload = {};
  }

  // Legacy compatibility: map older email_reply events into Instantly receipt handling.
  if (event_type === "email_reply") {
    const legacyCoachReply = safeStr(payload?.coach_reply_body || payload?.coachReplyBody || payload?.reply_body || payload?.replyBody || b.reply_body || b.replyBody || "");
    const legacyAiReply = safeStr(payload?.ai_reply_body || payload?.aiReplyBody || b.ai_reply_body || b.aiReplyBody || "");
    payload = {
      ...payload,
      coach_reply_body: legacyCoachReply,
      ai_reply_body: legacyAiReply,
      legacy_event_type: "email_reply",
    };
    event_type = "instantly_reply_sent";
  }

  if (!idempotency_key && (event_type === "instantly_reply_sent" || event_type === "instantly_email_sent")) {
    const idemLeadId = payload?.lead_id || payload?.leadId || b.lead_id || b.leadId || "";
    const idemTs = payload?.timestamp || payload?.created_at || b.timestamp || nowIso;
    idempotency_key = deriveInstantlyReplyIdempotencyKey({ leadId: String(idemLeadId).trim(), timestamp: String(idemTs).trim() });
  }
  
  // ---- 1) insert ledger with dedupe handling ----
  const inserted = await sbInsertOpsEventSafe({
  schema_version,
  event_type,
  source,
  direction,
  trace_id,
  idempotency_key,
  entity_type,
  entity_id,
  submission_id,
  client_email,
  client_phone_e164,
  payload,
  received_at: nowIso,
  }).catch((err) => {
    logError("ops.ingest.insert_event", err);
    return { deduped: false, error: err };
  });
  
  // Safety check on response
  if (!inserted) {
    return res.status(500).json({ ok: false, error: "Failed to insert event" });
  }
  
  // if deduped, do NOT re-run state upserts
  if (inserted?.deduped) {
    return res.json({ ok: true, deduped: true });
  }
  
  if (inserted?.error) {
    return res.status(500).json({ ok: false, error: "Event insertion failed" });
  }
// ---- 2) route state updates (minimal + safe) ----
// SUBMISSIONS
if (event_type === "submission.created") {
if (!submission_id) throw new Error("submission.created missing submission_id");
const p = payload || {};
const canon = canonicalizeSubmissionPayload(p, { source }); // <- you implement based on your form fields
const row = {
submission_id,
...canon,
// Include these fields if desired: first_name, last_name, email, phone_e164, state, athlete_name, referral, ...
submission_payload: p, // keep raw
created_at: canon.created_at || nowIso,
updated_at: nowIso,
};
await sbUpsertSubmissionSafe(row);
await syncConversationRoleFromSubmission({
email: canon.email,
role: canon.your_role,
submission_id,
nowIso,
});
refreshQueue.add(makeCardKey("submission", submission_id));
refreshQueue.add("dashboard:all");
refreshQueue.add("allq:all");
}
if (event_type === "submission.updated") {
if (!submission_id) throw new Error("submission.updated missing submission_id");
const p = payload || {};
const canon = canonicalizeSubmissionPayload(p, { source });
const patch = {
...canon,
submission_payload: p,
updated_at: nowIso,
};
await sbUpdateSubmissionSafe(submission_id, patch);
await syncConversationRoleFromSubmission({
email: canon.email,
role: canon.your_role,
submission_id,
nowIso,
});
refreshQueue.add(makeCardKey("submission", submission_id));
refreshQueue.add("dashboard:all");
refreshQueue.add("allq:all");
}
// INSTANTLY REPLY RECEIPT (AI already replied)
if (event_type === "instantly_reply_sent") {
  const lead_email_raw = payload?.lead_email || payload?.leadEmail || b.lead_email || b.leadEmail || null;
  const lead_name = payload?.lead_name || payload?.leadName || b.lead_name || b.leadName || null;
  const coach_reply_body = safeStr(payload?.coach_reply_body || payload?.coachReplyBody || b.coach_reply_body || b.coachReplyBody || "");
  const ai_reply_body = safeStr(payload?.ai_reply_body || payload?.aiReplyBody || b.ai_reply_body || b.aiReplyBody || "");
  const campaign_id = payload?.campaign_id || payload?.campaignId || b.campaign_id || b.campaignId || null;
  const lead_id = payload?.lead_id || payload?.leadId || b.lead_id || b.leadId || null;
  const reply_ts_raw = payload?.timestamp || payload?.created_at || b.timestamp || nowIso;
  const replyTsIso = (() => {
    const d = new Date(reply_ts_raw);
    return Number.isFinite(d.getTime()) ? d.toISOString() : nowIso;
  })();
  const lead_email = normalizeEmail(lead_email_raw);

  if (lead_email) {
    let existingConv = null;
    try {
      const lookup = await dbSelectFirst([
        () => ops()
          .from("conversations")
          .select("id, thread_key, lane, source")
          .eq("normalized_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, source")
          .eq("normalized_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, lane, source")
          .ilike("contact_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, source")
          .ilike("contact_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      existingConv = lookup?.data || null;
    } catch (lookupErr) {
      logError("instantly_reply_sent.lookup_conversation", lookupErr);
      existingConv = null;
    }

    const previewSource = ai_reply_body || coach_reply_body;
    const convPreview = shorten(previewSource, 240);
    const baseThreadKey = existingConv?.thread_key || `instantly:${safeStr(lead_id) || hashStable(lead_email)}`;
    let conversationId = existingConv?.id || null;

    if (conversationId) {
      const updatePatch = {
        updated_at: nowIso,
        source: "instantly",
        pipeline: "active",
        status: "active",
        contact_email: lead_email,
        normalized_email: lead_email,
        preview: convPreview,
      };
      if (lead_name) updatePatch.coach_name = lead_name;
      if (!existingConv?.lane) updatePatch.lane = "program";

      try {
        const { error: updErr } = await ops()
          .from("conversations")
          .update(updatePatch)
          .eq("id", conversationId);
        if (updErr && isMissingColumnError(updErr)) {
          const fallbackPatch = { ...updatePatch };
          delete fallbackPatch.lane;
          delete fallbackPatch.status;
          delete fallbackPatch.normalized_email;
          const { error: fallbackErr } = await ops()
            .from("conversations")
            .update(fallbackPatch)
            .eq("id", conversationId);
          if (fallbackErr) throw fallbackErr;
        } else if (updErr) {
          throw updErr;
        }
      } catch (updErr) {
        logError("instantly_reply_sent.update_conversation", updErr);
      }
    } else {
      const insertRow = {
        thread_key: baseThreadKey,
        source: "instantly",
        lane: "program",
        pipeline: "active",
        status: "active",
        contact_email: lead_email,
        normalized_email: lead_email,
        coach_name: lead_name || null,
        subject: campaign_id ? `Instantly Reply (${campaign_id})` : "Instantly Reply",
        preview: convPreview,
        created_at: nowIso,
        updated_at: nowIso,
      };
      try {
        const { data: insertedConv, error: insErr } = await ops()
          .from("conversations")
          .insert(insertRow)
          .select("id")
          .maybeSingle();
        if (insErr && isMissingColumnError(insErr)) {
          const fallbackRow = { ...insertRow };
          delete fallbackRow.lane;
          delete fallbackRow.status;
          delete fallbackRow.normalized_email;
          const { data: fallbackConv, error: fallbackErr } = await ops()
            .from("conversations")
            .insert(fallbackRow)
            .select("id")
            .maybeSingle();
          if (fallbackErr) throw fallbackErr;
          conversationId = fallbackConv?.id || null;
        } else if (insErr) {
          throw insErr;
        } else {
          conversationId = insertedConv?.id || null;
        }
      } catch (insErr) {
        logError("instantly_reply_sent.insert_conversation", insErr);
      }
    }

    if (conversationId) {
      if (coach_reply_body) {
        try {
          const coachMsg = {
            conversation_id: conversationId,
            direction: "inbound",
            body: coach_reply_body,
            preview: shorten(coach_reply_body, 200),
            source_ref: lead_id || null,
            created_at: replyTsIso,
          };
          const { error: coachMsgErr } = await ops().from("messages").insert(coachMsg);
          if (coachMsgErr && isMissingColumnError(coachMsgErr)) {
            const fallbackCoachMsg = { ...coachMsg };
            delete fallbackCoachMsg.source_ref;
            const { error: fallbackCoachErr } = await ops().from("messages").insert(fallbackCoachMsg);
            if (fallbackCoachErr) throw fallbackCoachErr;
          } else if (coachMsgErr) {
            throw coachMsgErr;
          }
        } catch (err) {
          logError("instantly_reply_sent.insert_coach_message", err);
        }
      }

      if (ai_reply_body) {
        try {
          const aiMsg = {
            conversation_id: conversationId,
            direction: "outbound",
            body: ai_reply_body,
            preview: shorten(ai_reply_body, 200),
            sender: "instantly_ai",
            source_ref: lead_id || null,
            created_at: replyTsIso,
          };
          const { error: aiMsgErr } = await ops().from("messages").insert(aiMsg);
          if (aiMsgErr && isMissingColumnError(aiMsgErr)) {
            const fallbackAiMsg = { ...aiMsg };
            delete fallbackAiMsg.sender;
            delete fallbackAiMsg.source_ref;
            const { error: fallbackAiErr } = await ops().from("messages").insert(fallbackAiMsg);
            if (fallbackAiErr) throw fallbackAiErr;
          } else if (aiMsgErr) {
            throw aiMsgErr;
          }
        } catch (err) {
          logError("instantly_reply_sent.insert_ai_message", err);
        }
      }

      await sbInsertOpsEventSafe({
        schema_version: "5.3",
        event_type: "instantly_reply_handled",
        source: "instantly",
        direction: "inbound",
        trace_id,
        idempotency_key: `${idempotency_key || "instantly_reply_sent"}:handled`,
        entity_type: "conversation",
        entity_id: conversationId,
        client_email: lead_email,
        payload: {
          campaign_id: campaign_id || null,
          lead_id: lead_id || null,
          lead_name: lead_name || null,
          timestamp: replyTsIso,
        },
      }).catch((ledgerErr) => logError("instantly_reply_sent.ledger", ledgerErr));

      const coachPreview = shorten(coach_reply_body || "—", 200);
      const aiPreview = shorten(ai_reply_body || "—", 200);
      const who = lead_name || lead_email;
      const laneProgram = isProgramLane({ lane: existingConv?.lane || "program", source: "instantly" });
      const text = `💬 Instantly Reply Receipt
--
${who}

Coach said:
${coachPreview}

AI replied:
${aiPreview}

Ref: Campaign ${campaign_id || "—"} • Lead ${lead_id || "—"}`;

      const kb = laneProgram
        ? Markup.inlineKeyboard([[Markup.button.callback("📌 CC Support", `CC:${conversationId}`)]])
        : undefined;

      const notifyAdminIds = ADMIN_IDS.length ? ADMIN_IDS : [];
      for (const adminId of notifyAdminIds) {
        try {
          const msg = await bot.telegram.sendMessage(adminId, text, kb || undefined);
          if (msg?.message_id) {
            registerLiveCard(msg, {
              type: "conversation",
              card_key: `conversation:${conversationId}`,
              ref_id: conversationId,
            });
          }
        } catch (notifyErr) {
          logError("instantly_reply_sent.notify_admin", notifyErr);
        }
      }

      refreshQueue.add(makeCardKey("conversation", conversationId));
      refreshQueue.add("triage:all");
      refreshQueue.add("dashboard:all");
      refreshQueue.add("allq:all");
    } else {
      console.warn("[WARN] instantly_reply_sent skipped message/notify: no conversation id resolved", {
        lead_email,
        lead_id: lead_id || null,
      });
    }
  } else {
    console.warn("[WARN] instantly_reply_sent missing lead_email; skipping conversation upsert", {
      lead_id: lead_id || null,
      campaign_id: campaign_id || null,
    });
  }
}
// INSTANTLY OUTBOUND OUTREACH RECEIPT (silent log)
if (event_type === "instantly_email_sent") {
  const lead_email_raw = payload?.lead_email || payload?.leadEmail || b.lead_email || b.leadEmail || null;
  const lead_name = payload?.lead_name || payload?.leadName || b.lead_name || b.leadName || null;
  const campaign_id = payload?.campaign_id || payload?.campaignId || b.campaign_id || b.campaignId || null;
  const lead_id = payload?.lead_id || payload?.leadId || b.lead_id || b.leadId || null;
  const email_subject = payload?.email_subject || payload?.emailSubject || b.email_subject || b.emailSubject || "Instantly Outreach";
  const sent_ts_raw = payload?.timestamp || payload?.created_at || b.timestamp || nowIso;
  const sentTsIso = (() => {
    const d = new Date(sent_ts_raw);
    return Number.isFinite(d.getTime()) ? d.toISOString() : nowIso;
  })();
  const lead_email = normalizeEmail(lead_email_raw);

  if (lead_email) {
    let existingConv = null;
    try {
      const lookup = await dbSelectFirst([
        () => ops()
          .from("conversations")
          .select("id, thread_key, lane, source")
          .eq("normalized_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, source")
          .eq("normalized_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, lane, source")
          .ilike("contact_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        () => ops()
          .from("conversations")
          .select("id, thread_key, source")
          .ilike("contact_email", lead_email)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      existingConv = lookup?.data || null;
    } catch (lookupErr) {
      logError("instantly_email_sent.lookup_conversation", lookupErr);
      existingConv = null;
    }

    const baseThreadKey = existingConv?.thread_key || `instantly:${safeStr(lead_id) || hashStable(lead_email)}`;
    let conversationId = existingConv?.id || null;

    if (conversationId) {
      const updatePatch = {
        updated_at: nowIso,
        source: "instantly",
        pipeline: "actions_waiting",
        status: "waiting",
        contact_email: lead_email,
        normalized_email: lead_email,
        subject: safeStr(email_subject) || "Instantly Outreach",
        preview: "Outreach sent by Instantly AI",
      };
      if (lead_name) updatePatch.coach_name = lead_name;
      if (!existingConv?.lane) updatePatch.lane = "program";

      try {
        const { error: updErr } = await ops()
          .from("conversations")
          .update(updatePatch)
          .eq("id", conversationId);
        if (updErr && isMissingColumnError(updErr)) {
          const fallbackPatch = { ...updatePatch };
          delete fallbackPatch.lane;
          delete fallbackPatch.status;
          delete fallbackPatch.normalized_email;
          const { error: fallbackErr } = await ops()
            .from("conversations")
            .update(fallbackPatch)
            .eq("id", conversationId);
          if (fallbackErr) throw fallbackErr;
        } else if (updErr) {
          throw updErr;
        }
      } catch (updErr) {
        logError("instantly_email_sent.update_conversation", updErr);
      }
    } else {
      const insertRow = {
        thread_key: baseThreadKey,
        source: "instantly",
        lane: "program",
        pipeline: "actions_waiting",
        status: "waiting",
        contact_email: lead_email,
        normalized_email: lead_email,
        coach_name: lead_name || null,
        subject: safeStr(email_subject) || "Instantly Outreach",
        preview: "Outreach sent by Instantly AI",
        created_at: sentTsIso,
        updated_at: nowIso,
      };

      try {
        const { data: insertedConv, error: insErr } = await ops()
          .from("conversations")
          .insert(insertRow)
          .select("id")
          .maybeSingle();
        if (insErr && isMissingColumnError(insErr)) {
          const fallbackRow = { ...insertRow };
          delete fallbackRow.lane;
          delete fallbackRow.status;
          delete fallbackRow.normalized_email;
          const { data: fallbackConv, error: fallbackErr } = await ops()
            .from("conversations")
            .insert(fallbackRow)
            .select("id")
            .maybeSingle();
          if (fallbackErr) throw fallbackErr;
          conversationId = fallbackConv?.id || null;
        } else if (insErr) {
          throw insErr;
        } else {
          conversationId = insertedConv?.id || null;
        }
      } catch (insErr) {
        logError("instantly_email_sent.insert_conversation", insErr);
      }
    }

    if (conversationId) {
      await sbInsertOpsEventSafe({
        schema_version: "5.3",
        event_type: "outreach_sent",
        source: "instantly",
        direction: "inbound",
        trace_id,
        idempotency_key: `${idempotency_key || "instantly_email_sent"}:outreach_sent`,
        entity_type: "conversation",
        entity_id: conversationId,
        client_email: lead_email,
        payload: {
          campaign_id: campaign_id || null,
          lead_id: lead_id || null,
          lead_name: lead_name || null,
          email_subject: safeStr(email_subject) || null,
          timestamp: sentTsIso,
        },
      }).catch((ledgerErr) => logError("instantly_email_sent.ledger", ledgerErr));

      refreshQueue.add(makeCardKey("conversation", conversationId));
      refreshQueue.add("dashboard:all");
      refreshQueue.add("allq:all");
    }
  } else {
    console.warn("[WARN] instantly_email_sent missing lead_email; skipping conversation upsert", {
      lead_id: lead_id || null,
      campaign_id: campaign_id || null,
    });
  }
}
// CONVERSATIONS / MESSAGES (inbound/outbound)
if (event_type === EVENT_TYPES.CONVERSATION_UPDATED || event_type === EVENT_TYPES.MESSAGE_INGESTED) {
if (entity_id) refreshQueue.add(makeCardKey("conversation", entity_id));
refreshQueue.add("triage:all");
refreshQueue.add("pools:all");
refreshQueue.add("dashboard:all");
refreshQueue.add("allq:all");
}
// OUTBOX STATUS (n8n callbacks)
if (event_type.startsWith("outbox.email.") || event_type.startsWith("outbox.sms.")) {
// ex: outbox.email.sent / outbox.email.failed
if (payload?.outbox_id) {
refreshQueue.add(`outbox:${payload.outbox_id}`);
}
if (entity_id) refreshQueue.add(makeCardKey("conversation", entity_id));
refreshQueue.add("triage:all");

refreshQueue.add("dashboard:all");
}
// OUTREACH HANDOFF DETECTED
// Ownership note: n8n/provider intelligence is the upstream handoff detector.
// index.js remains the consumer/display/action layer for handoff state in Telegram.
if (event_type === EVENT_TYPES.HANDOFF_DETECTED) {
  if (!entity_id) {
    console.warn(`${EVENT_TYPES.HANDOFF_DETECTED} missing entity_id`);
  } else {
    const { error: hdErr } = await ops()
      .from("conversations")
      .update({
        needs_support_handoff: true,
        needs_support_handoff_at: nowIso,
        handoff_detected_reason: payload?.reason || payload?.detected_phrase || payload?.trigger || null,
        pipeline: "needs_reply",
        updated_at: nowIso,
      })
      .eq("id", entity_id);
    if (hdErr && !isMissingColumnError(hdErr)) {
      console.warn(`${EVENT_TYPES.HANDOFF_DETECTED} update error:`, hdErr.message);
    }
    refreshQueue.add(makeCardKey("conversation", entity_id));
    refreshQueue.add("triage:all");
    refreshQueue.add("dashboard:all");
    refreshQueue.add("allq:all");
  }
}
// CALLS
if (event_type.startsWith("call.")) {
if (entity_id) refreshQueue.add(makeCardKey("call", entity_id));
refreshQueue.add("today:all");
refreshQueue.add("triage:all");
refreshQueue.add("dashboard:all");
}
// METRICS / CLICKS
if (event_type.startsWith("click.") || event_type.startsWith("metric.") || event_type ===
"eapp.visit") {
refreshQueue.add("metrics:all");
refreshQueue.add("dashboard:all");
}
// ---- 3) refresh ----
refreshLiveCards(true).catch(() => {});
return res.json({ ok: true });
} catch (e) {
// dead-letter
try {
await ops().from("dead_letters").insert({
received_at: new Date().toISOString(),
error: String(e.message || e),
payload: req.body || null,
});
} catch (_) {}
return res.status(500).json({ ok: false, error: String(e.message || e) });
}
});
// ---------- METRIC/CLICK TRACKING ----------
app.post("/webhook/metric", async (req, res) => {
  try {
    const secret = req.header("x-nil-secret");

    if (!secret || secret !== BASE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { coach_id, kind, link, meta } = req.body || {};
    if (!kind) return res.status(400).json({ ok: false, error: "missing kind" });

    const parseTrackingParams = (rawLink, queryObj = {}) => {
      const out = {
        coach_id: null,
        campaign_id: null,
      };
      const readFromSearch = (sp) => {
        out.coach_id = sp.get("coach_id") || sp.get("coachId") || out.coach_id;
        out.campaign_id = sp.get("campaign_id") || sp.get("campaignId") || out.campaign_id;
      };

      try {
        const linkStr = String(rawLink || "").trim();
        if (linkStr) {
          const parsed = new URL(linkStr);
          readFromSearch(parsed.searchParams);
        }
      } catch (_) {
        // Ignore invalid URL and continue with request query/body fallbacks
      }

      const q = queryObj || {};
      out.coach_id = out.coach_id || q.coach_id || q.coachId || null;
      out.campaign_id = out.campaign_id || q.campaign_id || q.campaignId || null;

      return out;
    };

    const inferClickSource = (referrerRaw) => {
      const r = String(referrerRaw || "").trim().toLowerCase();
      if (!r) return "direct";
      if (
        r.includes("mail") ||
        r.includes("gmail") ||
        r.includes("outlook") ||
        r.includes("yahoo") ||
        r.includes("proton")
      ) {
        return "email";
      }
      return "direct";
    };

    const tracking = parseTrackingParams(link, req.query || {});
    const resolvedCoachId = tracking.coach_id || coach_id || null;
    const resolvedCampaignId = tracking.campaign_id || req.body?.campaign_id || req.body?.campaignId || null;
    const referrer = req.header("referer") || req.header("referrer") || meta?.referrer || req.body?.referrer || "";
    const clickSource = inferClickSource(referrer);

    // Insert into schema `nil`
    const { error } = await supabase
      .schema("nil")
      .from("click_events")
      .insert([
        {
          coach_id: resolvedCoachId ?? null,
          campaign_id: resolvedCampaignId ?? null,
          click_source: clickSource,
          kind,
          link: link ?? null,
          meta: meta ?? {},
        },
      ]);

    if (error) {
      console.error("[click_events insert error]", error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    let coachUpserted = false;
    if (resolvedCoachId) {
      const nowIso = new Date().toISOString();
      try {
        const { data: existingCoach, error: coachLookupErr } = await ops()
          .from("coaches")
          .select("coach_id, click_count")
          .eq("coach_id", resolvedCoachId)
          .maybeSingle();

        if (coachLookupErr && !isMissingColumnError(coachLookupErr)) {
          throw coachLookupErr;
        }

        if (existingCoach?.coach_id) {
          const nextCount = Number(existingCoach.click_count || 0) + 1;
          const { error: coachUpdateErr } = await ops()
            .from("coaches")
            .update({
              click_count: nextCount,
              last_click_at: nowIso,
              updated_at: nowIso,
            })
            .eq("coach_id", resolvedCoachId);
          if (coachUpdateErr && !isMissingColumnError(coachUpdateErr)) {
            throw coachUpdateErr;
          }
        } else {
          const { error: coachInsertErr } = await ops()
            .from("coaches")
            .insert({
              coach_id: resolvedCoachId,
              click_count: 1,
              last_click_at: nowIso,
              created_at: nowIso,
              updated_at: nowIso,
            });
          if (coachInsertErr && !isMissingColumnError(coachInsertErr)) {
            throw coachInsertErr;
          }
        }
        coachUpserted = true;
      } catch (coachErr) {
        console.error("[coaches upsert error]", coachErr?.message || String(coachErr));
      }
    }

    return res.status(200).json({
      ok: true,
      coach_id: resolvedCoachId,
      campaign_id: resolvedCampaignId,
      click_source: clickSource,
      coach_upserted: coachUpserted,
    });
  } catch (e) {
    console.error("[webhook/metric error]", String(e));
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- SUBMISSION OUTBOX API ----------
// POST /api/submissions – Write to nil.submissions + nil.n8n_outbox, return fast
app.post("/api/submissions", async (req, res) => {
  try {
    const body = req.body || {};

    // Extract fields
    const {
      idempotency_key,
      first_name,
      last_name,
      email,
      phone,
      state,
      role,
      intent = "coverage_interest",
      coverage_accident,
      coverage_hospital_indemnity,
    } = body;

    // Validate required fields
    if (!first_name || !last_name || !email || !phone || !state || !role) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }

    // Generate or use idempotency key
    let finalIdempotencyKey = idempotency_key || uuidv4();

    // Derive stable submission_id from idempotency_key
    const part1 = finalIdempotencyKey.slice(0, 8).toUpperCase();
    const part2 = finalIdempotencyKey.replace(/-/g, "").slice(8, 13).toUpperCase();
    const submission_id = `NWS-${part1}-${part2}`;

    // Build n8n payload (envelope for async delivery)
    const n8nPayload = {
      event_type: "submission.created",
      source: "website",
      direction: "inbound",
      schema_version: "5.2",
      trace_id: uuidv4(),
      idempotency_key: finalIdempotencyKey,
      entity_type: "submission",
      entity_id: submission_id,
      client: {
        first_name,
        last_name,
        email,
        phone,
        state,
        role,
        intent,
      },
      payload: {
        coverage_accident: coverage_accident === true,
        coverage_hospital_indemnity: coverage_hospital_indemnity === true,
      },
    };

    // Upsert submission record
    const submissionRow = {
      submission_id,
      first_name,
      last_name,
      email,
      phone,
      state,
      role,
      intent,
      coverage_accident: coverage_accident === true,
      coverage_hospital_indemnity: coverage_hospital_indemnity === true,
      n8n_status: "queued",
      created_at: new Date().toISOString(),
    };

    const { error: subError } = await ops()
      .from("submissions")
      .upsert(submissionRow, { onConflict: "submission_id" });

    if (subError) throw subError;

    // Upsert n8n outbox row
    const outboxRow = {
      submission_id,
      idempotency_key: finalIdempotencyKey,
      payload: n8nPayload,
      status: "queued",
    };

    const { error: outboxError } = await ops()
      .from("n8n_outbox")
      .upsert(outboxRow, { onConflict: "submission_id" });

    if (outboxError) throw outboxError;

    // Trigger dashboard refresh
    refreshQueue.add("dashboard:all");

    // Return immediately (fast UX)
    return res.status(200).json({
      ok: true,
      queued: true,
      submission_id,
      idempotency_key: finalIdempotencyKey,
    });
  } catch (error) {
    console.error("[api/submissions]", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

// GET /api/nil-outbox/claim – Claim queued rows for n8n
app.get("/api/nil-outbox/claim", async (req, res) => {
  try {
    const secret = req.headers["x-nil-secret"];
    if (!secret || secret !== BASE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const maxAgeMs = 48 * 60 * 60 * 1000;
    const nowMs = Date.now();

    const { data: claimedRows, error } = await ops()
      .from("n8n_outbox")
      .select("outbox_id, submission_id, idempotency_key, payload, attempt_count, created_at")
      .eq("status", "queued")
      .order("next_attempt_at", { ascending: true })
      .limit(limit);

    if (error) throw error;

    const rows = claimedRows || [];
    const expiredRows = [];
    const claimableRows = [];

    for (const row of rows) {
      const createdMs = row?.created_at ? new Date(row.created_at).getTime() : null;
      const isExpired = Number.isFinite(createdMs) ? (nowMs - createdMs) > maxAgeMs : false;
      if (isExpired) {
        expiredRows.push(row);
      } else {
        claimableRows.push(row);
      }
    }

    if (expiredRows.length > 0) {
      const expiredIds = expiredRows.map((r) => r.outbox_id).filter(Boolean);
      if (expiredIds.length > 0) {
        const { error: expireErr } = await ops()
          .from("n8n_outbox")
          .update({
            status: "expired",
            last_error: "expired_unclaimed_48h",
            updated_at: new Date().toISOString(),
          })
          .in("outbox_id", expiredIds);
        if (expireErr) {
          console.error("[api/nil-outbox/claim expire]", expireErr.message);
        }
      }
    }

    // Update claimed rows to 'sending'
    if (claimableRows.length > 0) {
      const outboxIds = claimableRows.map((r) => r.outbox_id);
      const { error: updateError } = await ops()
        .from("n8n_outbox")
        .update({
          status: "sending",
          attempt_count: supabase.sql`attempt_count + 1`,
        })
        .in("outbox_id", outboxIds);

      if (updateError) throw updateError;
    }

    return res.status(200).json({
      ok: true,
      rows: claimableRows,
      count: claimableRows.length,
      expired_count: expiredRows.length,
    });
  } catch (error) {
    console.error("[api/nil-outbox/claim]", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Internal error",
    });
  }
});

// POST /api/nil-outbox/result – Update after n8n sends
app.post("/api/nil-outbox/result", async (req, res) => {
  try {
    const secret = req.headers["x-nil-secret"];
    if (!secret || secret !== BASE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const { submission_id, status, last_error, success, message_id, error: result_error } = body;

    if (!submission_id || !["sent", "failed"].includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid submission_id or status",
      });
    }

    const hasSuccessBoolean = typeof success === "boolean";
    const hasMessageId = !!safeStr(message_id).trim();
    const hasErrorString = !!safeStr(result_error || last_error).trim();
    const validResultPayload = hasSuccessBoolean && (hasMessageId || hasErrorString);
    if (!validResultPayload) {
      const reason = "invalid_outbox_result_payload: requires success(boolean) + message_id or error";
      await writeDeadLetterSafe(reason, {
        endpoint: "/api/nil-outbox/result",
        body,
      });
      return res.status(400).json({
        ok: false,
        error: reason,
      });
    }

    const normalizedStatus = success === true ? "sent" : "failed";
    if (normalizedStatus !== status) {
      return res.status(400).json({
        ok: false,
        error: "status does not match success flag",
      });
    }

    const now = new Date().toISOString();
    const updatePatch = {
      status,
      last_error: (result_error || last_error) || null,
      message_id: hasMessageId ? String(message_id) : null,
    };

    if (status === "sent") {
      updatePatch.sent_at = now;
      updatePatch.retry_count = 0;
    }

    if (status === "failed") {
      const { data: existingOutbox, error: existingErr } = await ops()
        .from("n8n_outbox")
        .select("retry_count")
        .eq("submission_id", submission_id)
        .maybeSingle();
      if (existingErr) throw existingErr;

      const nextRetryCount = Number(existingOutbox?.retry_count || 0) + 1;
      updatePatch.retry_count = nextRetryCount;

      if (nextRetryCount > 3) {
        updatePatch.status = "dead";
        updatePatch.dead_at = now;
        await writeDeadLetterSafe("n8n_outbox_retry_exhausted", {
          submission_id,
          retry_count: nextRetryCount,
          status,
          last_error: updatePatch.last_error,
          message_id: updatePatch.message_id,
        });
      }
    }

    // Update outbox
    const { error: outboxError } = await ops()
      .from("n8n_outbox")
      .update(updatePatch)
      .eq("submission_id", submission_id);

    if (outboxError) throw outboxError;

    // Update submissions
    const submissionPatch = {
      n8n_status: updatePatch.status || status,
      n8n_last_error: (result_error || last_error) || null,
    };

    if (status === "sent") {
      submissionPatch.n8n_sent_at = now;
    }

    await ops()
      .from("submissions")
      .update(submissionPatch)
      .eq("submission_id", submission_id);

    // Trigger refresh
    refreshQueue.add("dashboard:all");

    return res.status(200).json({
      ok: true,
      submission_id,
      status: updatePatch.status || status,
      retry_count: updatePatch.retry_count ?? null,
    });
  } catch (error) {
    console.error("[api/nil-outbox/result]", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Internal error",
    });
  }
});

// ---------- HEALTH ----------
app.get("/health", (_req, res) => {
  const warnings = [];
  if (!MAKE_SEND_WEBHOOK_URL) warnings.push("MAKE_SEND_WEBHOOK_URL missing");
  if (!CC_SUPPORT_WEBHOOK_URL) warnings.push("CC_SUPPORT_WEBHOOK_URL missing");
  if (!HANDOFF_WEBHOOK_URL) warnings.push("HANDOFF_WEBHOOK_URL missing");
  if (!OPENAI_API_KEY) warnings.push("OPENAI_API_KEY missing");
  if (!SUPPORT_FROM_EMAIL) warnings.push("SUPPORT_FROM_EMAIL missing");
  if (!OUTREACH_FROM_EMAIL) warnings.push("OUTREACH_FROM_EMAIL missing");

  res.json({
    ok: true,
    service: "nil-wealth-telegram-shell",
    version: CODE_VERSION,
    build: String(BUILD_VERSION),
    warnings,
    config: {
      make_send_webhook_configured: !!MAKE_SEND_WEBHOOK_URL,
      cc_support_webhook_configured: !!CC_SUPPORT_WEBHOOK_URL,
      handoff_webhook_configured: !!HANDOFF_WEBHOOK_URL,
      openai_api_key_configured: !!OPENAI_API_KEY,
      support_from_email_configured: !!SUPPORT_FROM_EMAIL,
      outreach_from_email_configured: !!OUTREACH_FROM_EMAIL,
    },
    features: {
      telegram_bot_enabled: ENABLE_TELEGRAM_BOT,
      live_refresh_enabled: ENABLE_TELEGRAM_LIVE_REFRESH,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", (_req, res) => {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!BOT_TOKEN && ENABLE_TELEGRAM_BOT) missing.push("TELEGRAM_BOT_TOKEN");

  if (missing.length > 0) {
    return res.status(503).json({ ok: false, missing });
  }

  return res.json({ ok: true, missing: [] });
});

// ========== GLOBAL ERROR HANDLING MIDDLEWARE ==========
// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found",
    path: req.path,
    method: req.method,
  });
});

// Final catch-all error handler
app.use((err, req, res, next) => {
  const requestPath = req.path || "unknown";
  const method = req.method || "UNKNOWN";
  const statusCode = err?.statusCode || err?.status || 500;
  const errorMsg = err?.message || String(err) || "Unknown error";
  
  logError(`Express:${method} ${requestPath}`, err);
  
  // Don't expose internal error details to client
  const clientMessage = statusCode === 500 ? "Internal server error" : errorMsg;
  
  try {
    if (!res.headersSent) {
      res.status(statusCode).json({
        ok: false,
        error: clientMessage,
        status: statusCode,
      });
    }
  } catch (_) {
    // Response already sent or other issue, just log
    console.error("[FATAL] Could not send error response", errorMsg);
  }
});

// ---------- START ----------
const server = app.listen(PORT, "0.0.0.0", () => {
console.log(`Webhook server listening on 0.0.0.0:${PORT}`);
console.log(`${CODE_VERSION} · Build ${BUILD_VERSION}`);
});
if (ENABLE_TELEGRAM_BOT) {
// ==========================================================
// CRITICAL: GLOBAL TELEGRAM BOT PROTECTION MIDDLEWARE
// ==========================================================
// This middleware AUTOMATICALLY handles callback queries and adds timeout protection
// for ALL bot actions and commands, preventing timeouts and freezes

bot.use(async (ctx, next) => {
  try {
    // Harden raw Telegram calls used throughout handlers
    if (ctx && typeof ctx.reply === "function" && !ctx.__safeReplyWrapped) {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = async (...args) => {
        try {
          return await originalReply(...args);
        } catch (err) {
          logError("ctx.reply", err);
          return null;
        }
      };
      ctx.__safeReplyWrapped = true;
    }
    
    if (ctx && typeof ctx.editMessageText === "function" && !ctx.__safeEditWrapped) {
      const originalEditMessageText = ctx.editMessageText.bind(ctx);
      ctx.editMessageText = async (...args) => {
        try {
          return await originalEditMessageText(...args);
        } catch (err) {
          logError("ctx.editMessageText", err);
          return null;
        }
      };
      ctx.__safeEditWrapped = true;
    }
    
    if (ctx && typeof ctx.deleteMessage === "function" && !ctx.__safeDeleteWrapped) {
      const originalDelete = ctx.deleteMessage.bind(ctx);
      ctx.deleteMessage = async (...args) => {
        try {
          return await originalDelete(...args);
        } catch (err) {
          // Silently ignore delete errors (message may already be deleted)
          return null;
        }
      };
      ctx.__safeDeleteWrapped = true;
    }
    
    // Auto-answer callback query to prevent loading spinner timeout
    if (ctx.update?.callback_query?.id) {
      ctx.answerCbQuery().catch((err) => {
        const msg = String(err?.description || err?.message || "");
        if (
          !msg.includes("query is too old") &&
          !msg.includes("QUERY_ID_INVALID") &&
          !msg.includes("already answered")
        ) {
          console.log(`[WARN] Auto answerCbQuery failed: ${msg.substring(0, 50)}`);
        }
      });
    }

    // Add timeout protection to all handler executions
    let middlewareTimeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      middlewareTimeoutId = setTimeout(() => reject(new Error("Handler execution timeout")), 35000);
    });

    try {
      await Promise.race([next(), timeoutPromise]);
    } catch (err) {
      const errMsg = String(err?.message || "Unknown error");
      console.log(`[ERROR] Handler error: ${errMsg.substring(0, 60)}`);
      // Re-throw so bot.catch() can handle it
      throw err;
    } finally {
      if (middlewareTimeoutId) clearTimeout(middlewareTimeoutId);
    }
  } catch (err) {
    logError("bot.middleware", err);
    throw err;
  }
});

// Global error handler for bot actions/commands
bot.catch((err, ctx) => {
  if (!ctx) {
    console.error("[BOT ERROR] No context:", err);
    return;
  }
  
  try {
    const updateId = ctx?.update?.update_id || "unknown";
    const userId = ctx?.from?.id || "unknown";
    console.error(`[BOT ERROR] Update ${updateId} (user ${userId}):`, err?.message);
    logError("bot.middleware", err);
  } catch (_) {}
  
  try {
    // Try to answer callback query if not already answered
    if (ctx.update?.callback_query?.id) {
      ctx.answerCbQuery("Error occurred").catch(() => {});
    }
    
    // Send user-friendly error message
    const errMsg = String(err?.message || "");
    if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
      ctx.reply("⏱ Request timed out. Try /dashboard to refresh.").catch(() => {});
    } else if (errMsg.includes("not found")) {
      ctx.reply("❌ Item not found. Try /dashboard to refresh.").catch(() => {});
    } else if (errMsg.includes("Database")) {
      ctx.reply("⚠️ Database issue. Try again in a moment.").catch(() => {});
    } else {
      ctx.reply("❌ An error occurred. Try /dashboard to refresh.").catch(() => {});
    }
  } catch (replyErr) {
    logError("bot.catch_reply", replyErr);
  }
});

// Launch bot with infinite retry on 409 Conflict (non-blocking)
let botLaunchRetries = 0;
let botConnected = false;

function launchBotWithRetry() {
  bot.launch().then(() => {
    botConnected = true;
    botLaunchRetries = 0;
    console.log("✅ Bot connected successfully");
  }).catch((err) => {
    const errMsg = String(err?.message || err?.description || "");
    const errCode = err?.error_code;
    const is409 = errCode === 409 || errMsg.includes("Conflict");
    
    if (!botConnected) {
      logError("bot.launch", err);
    }
    
    // Exponential backoff: 2s, 4s, 8s, 16s, 30s, 60s, 120s, then cap at 120s
    botLaunchRetries++;
    const maxBackoff = 120000; // 2 minutes max
    const backoffMs = Math.min(2000 * Math.pow(2, Math.min(botLaunchRetries - 1, 3)), maxBackoff);
    const backoffSec = Math.round(backoffMs / 1000);
    
    if (is409) {
      console.warn(`[WARN] 409 Conflict (attempt ${botLaunchRetries}). Retrying in ${backoffSec}s...`);
    } else {
      console.warn(`[WARN] Bot launch error (attempt ${botLaunchRetries}): ${errMsg.substring(0, 60)}. Retrying in ${backoffSec}s...`);
    }
    
    // Retry without exiting
    setTimeout(launchBotWithRetry, backoffMs);
  });
}

launchBotWithRetry();

console.log(`Bot running: ${CODE_VERSION}`);
console.log(`✅ Global protection middleware active`);
} else {
console.log("Telegram bot launch disabled (ENABLE_TELEGRAM_BOT=false)");
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[INFO] Received ${signal}. Starting graceful shutdown...`);

  try {
    if (ENABLE_TELEGRAM_BOT) {
      await bot.stop(signal).catch(() => {});
    }
  } catch (_) {}

  server.close((err) => {
    if (err) {
      console.error("[ERROR] HTTP server close error:", err);
      process.exit(1);
      return;
    }
    console.log("[INFO] Graceful shutdown complete.");
    process.exit(0);
  });

  // Force-exit if close hangs (e.g., stuck sockets)
  setTimeout(() => {
    console.error("[WARN] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT");
});

process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[ERROR] Uncaught Exception:", err);
  gracefulShutdown("uncaughtException");
});

