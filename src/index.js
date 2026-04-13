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
"Index.js V7.0";
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
const BASE_WEBHOOK_SECRET = (process.env.BASE_WEBHOOK_SECRET || "").trim();
const OPS_WEBHOOK_HMAC_SECRET = (process.env.OPS_WEBHOOK_HMAC_SECRET ||
"").trim(); // optional, preferred if set
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY ||
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
const TELEGRAM_BOT_ACTIVE = ENABLE_TELEGRAM_BOT && !!BOT_TOKEN;
const TELEGRAM_BOT_DISABLED_REASON = !ENABLE_TELEGRAM_BOT
? "ENABLE_TELEGRAM_BOT=false"
: !BOT_TOKEN
? "Missing TELEGRAM_BOT_TOKEN"
: "";
const ENABLE_TELEGRAM_LIVE_REFRESH =
String(process.env.ENABLE_TELEGRAM_LIVE_REFRESH || "true").toLowerCase() !== "false";
const ENABLE_PERF_LOGS =
String(process.env.ENABLE_PERF_LOGS || "false").toLowerCase() === "true";
const PERF_LOG_WARN_MS = Number(process.env.PERF_LOG_WARN_MS || 1200);
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 60 * 60 * 1000);
const WATCHDOG_STALE_MINUTES = Number(process.env.WATCHDOG_STALE_MINUTES || 60);
const WATCHDOG_SCHEMA_CHECK_INTERVAL_MS = Number(process.env.WATCHDOG_SCHEMA_CHECK_INTERVAL_MS || 60 * 60 * 1000);
const WORKFLOW_HEALTH_DEFAULT_STALE_MINUTES = Number(process.env.WORKFLOW_HEALTH_DEFAULT_STALE_MINUTES || 60);
function normalizeAbsoluteHttpUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/g, "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

const WORKFLOW_HEALTH_EVENT_DRIVEN_STALE_MINUTES = Number(process.env.WORKFLOW_HEALTH_EVENT_DRIVEN_STALE_MINUTES || 60);
const N8N_BASE_URL = String(process.env.N8N_BASE_URL || "https://nilwealthstrategies.app.n8n.cloud").replace(/\/+$/, "");
const N8N_API_KEY = String(process.env.N8N_API_KEY || "").trim();
const OPS_RISK_BURST_WINDOW_MINUTES = Number(process.env.OPS_RISK_BURST_WINDOW_MINUTES || 60);
const OPS_RISK_ERROR_BURST_THRESHOLD = Number(process.env.OPS_RISK_ERROR_BURST_THRESHOLD || 5);
const WATCHDOG_ALERT_COOLDOWN_MINUTES = Number(process.env.WATCHDOG_ALERT_COOLDOWN_MINUTES || 30);
const WATCHDOG_ALERT_BUSINESS_START_HOUR = Number(process.env.WATCHDOG_ALERT_BUSINESS_START_HOUR || 9);
const WATCHDOG_ALERT_BUSINESS_END_HOUR = Number(process.env.WATCHDOG_ALERT_BUSINESS_END_HOUR || 18);
const WATCHDOG_NOTIFY_ADMINS =
String(process.env.WATCHDOG_NOTIFY_ADMINS || "true").toLowerCase() === "true";
const WATCHDOG_ALERT_ONLY_WARN =
String(process.env.WATCHDOG_ALERT_ONLY_WARN || "true").toLowerCase() === "true";
const ADMIN_IDLE_DASHBOARD_RESET_HOURS = Number(process.env.ADMIN_IDLE_DASHBOARD_RESET_HOURS || 5);
const ADMIN_IDLE_DASHBOARD_CHECK_MS = Number(process.env.ADMIN_IDLE_DASHBOARD_CHECK_MS || 5 * 60 * 1000);
const DASHBOARD_CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS || 3000);
const DASHBOARD_SPEED_MODE = String(process.env.DASHBOARD_SPEED_MODE || "true").toLowerCase() !== "false";
const DASHBOARD_METRICS_CACHE_TTL_MS = Number(process.env.DASHBOARD_METRICS_CACHE_TTL_MS || 10000);
const DASHBOARD_OPS_CACHE_TTL_MS = Number(process.env.DASHBOARD_OPS_CACHE_TTL_MS || 20000);
const APP_BOOT_TS_MS = Date.now();
const CLICK_TRACKER_BASE_URL = normalizeAbsoluteHttpUrl(process.env.CLICK_TRACKER_BASE_URL || "");
const DEFAULT_PARENT_GUIDE_URL = "https://parentsguide.mynilwealthstrategies.com/";
const DEFAULT_OFFICIAL_WEBSITE_URL = "https://mynilwealthstrategies.com/";
const DEFAULT_AFLAC_PROOF_URL = "https://drive.google.com/file/d/1YPaNQtr6oIhpSKhEaYXRw9FZH41RVdQd/view?usp=sharing";
const FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY =
String(process.env.FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY || "false").toLowerCase() === "true";
// NY time
const NY_TZ = "America/New_York";
// ---------- GUARDS ----------
const STARTUP_CONFIG_ERRORS = [];
if (!BASE_WEBHOOK_SECRET && !OPS_WEBHOOK_HMAC_SECRET) {
  STARTUP_CONFIG_ERRORS.push("Missing BASE_WEBHOOK_SECRET or OPS_WEBHOOK_HMAC_SECRET");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  STARTUP_CONFIG_ERRORS.push("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
// ---------- CLIENTS ----------
if (!TELEGRAM_BOT_ACTIVE) {
  console.error(`[CONFIG] Telegram bot disabled at runtime: ${TELEGRAM_BOT_DISABLED_REASON}`);
}
for (const msg of STARTUP_CONFIG_ERRORS) {
  console.error(`[CONFIG] ${msg}`);
}
const bot = new Telegraf(BOT_TOKEN || "0:telegram-bot-disabled");
const app = express();
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString("utf8") : "";
  },
}));
const supabase = createClient(
SUPABASE_URL || "https://placeholder.supabase.co",
SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-role-key",
{
auth: { persistSession: false },
}
);
const ops = () => supabase.schema("nil");

const _tgSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
bot.telegram.sendMessage = async (...args) => {
  if (!TELEGRAM_BOT_ACTIVE) return null;
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
const adminActivity = new Map(); // userId -> { chatId, lastActivityAt, lastCardType, lastMessageId, lastResetAt }
const dashboardTextCache = new Map(); // filterSource -> { ts, text }
const dashboardMetricsCache = new Map(); // filterSource -> { ts, data }
const dashboardOpsDeliveryCache = new Map(); // filterSource -> { ts, data }
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
const EXPECTED_NIL_RELATIONS = [
  "analytics_metrics",
  "calls",
  "card_mirrors",
  "click_analytics_daily",
  "click_events",
  "click_link_registry",
  "coaches",
  "conversations",
  "dead_letter_events",
  "dead_letters",
  "drafts",
  "eapp_visits",
  "email_messages",
  "email_outbox",
  "email_sequences",
  "events",
  "lead_metrics",
  "lead_sources",
  "leads",
  "message_drafts",
  "messages",
  "metric_events",
  "n8n_outbox",
  "ops_events",
  "people",
  "processed_events",
  "sms_outbox",
  "submissions",
  "support_tickets",
  "v_analytics_summary",
  "v_calls_card",
  "v_click_conversion_funnel",
  "v_click_daily_summary",
  "v_click_device_breakdown",
  "v_click_email_client_breakdown",
  "v_click_geographic_breakdown",
  "v_click_lead_stats",
  "v_click_monthly_summary",
  "v_click_summary_today",
  "v_click_top_guide_sections",
  "v_click_weekly_summary",
  "v_click_yearly_summary",
  "v_coach_followups_due_now",
  "v_conversations_card",
  "v_search",
  "v_top_leads",
  "v_triage_due_now",
];
let watchdogSnapshot = {
  lastRunAt: null,
  overallStatus: "unknown",
  freshness: { overall: "unknown", checks: [] },
  reconciliation: { overall: "unknown", checks: [] },
  cards: { overall: "unknown", checks: [] },
  workflows: { overall: "unknown", checks: [] },
  operationsRisk: { overall: "unknown", checks: [] },
  schema: {
    overall: "unknown",
    checkedAt: null,
    expectedCount: EXPECTED_NIL_RELATIONS.length,
    coveredCount: 0,
    missing: EXPECTED_NIL_RELATIONS,
  },
};
let lastSchemaCheckAt = null;
let lastWatchdogAlertAt = 0;
let lastWatchdogAlertStatus = "unknown";
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

async function trackPerf(label, fn, { warnMs = PERF_LOG_WARN_MS } = {}) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (ENABLE_PERF_LOGS || durationMs >= warnMs) {
      console.log(`[PERF] ${label} ${durationMs}ms`);
    }
  }
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

function fastAnswerCbQuery(ctx, text = undefined) {
  if (!ctx?.update?.callback_query?.id) return;
  ctx.answerCbQuery(text).catch((err) => {
    const msg = String(err?.description || err?.message || "");
    if (
      !msg.includes("query is too old") &&
      !msg.includes("QUERY_ID_INVALID") &&
      !msg.includes("already answered")
    ) {
      console.log(`[WARN] fastAnswerCbQuery failed: ${msg}`);
    }
  });
}

async function safeReplyWithFallback(ctx, text, extra = undefined) {
  const primary = await ctx.reply(text, extra).catch(() => null);
  if (primary?.message_id) return primary;
  const chatId = ctx?.chat?.id ?? ctx?.update?.callback_query?.message?.chat?.id ?? ctx?.from?.id;
  if (chatId == null) return null;
  return bot.telegram.sendMessage(chatId, text, extra).catch(() => null);
}

// Action handler wrapper - ensures callbacks are answered and errors handled
function safeAction(handler) {
  return async (ctx) => {
    try {
      if (isAdmin(ctx)) {
        markAdminActivity({
          userId: String(ctx.from?.id || ""),
          chatId: ctx.chat?.id ?? ctx.from?.id,
        });
      }
      // Answer callback query immediately without blocking handler.
      fastAnswerCbQuery(ctx);
      
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
          await safeReplyWithFallback(ctx, "⏱ Request timed out. Please try again.");
        } else if (errMsg.includes("not found")) {
          await safeReplyWithFallback(ctx, "❌ Item not found. It may have been deleted.");
        } else {
          await safeReplyWithFallback(ctx, "❌ An error occurred. Please try /dashboard to refresh.");
        }
      } catch (_) {}
    }
  };
}

// Command handler wrapper - similar protection for commands
function safeCommand(handler) {
  return async (ctx) => {
    try {
      if (isAdmin(ctx)) {
        markAdminActivity({
          userId: String(ctx.from?.id || ""),
          chatId: ctx.chat?.id ?? ctx.from?.id,
        });
      }
      await withTimeout(
        handler(ctx),
        30000,
        "Command took too long - please try again"
      );
    } catch (err) {
      logError("bot.command", err);
      try {
        await safeReplyWithFallback(ctx, "❌ An error occurred. Please try again.");
      } catch (_) {}
    }
  };
}

// ---------- AUTH ----------
function isAdmin(ctx) {
if (!ADMIN_IDS.length) return true;
return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}

async function requireAdminOrNotify(ctx, origin = "unknown") {
  if (isAdmin(ctx)) return true;
  const userId = String(ctx.from?.id || "unknown");
  const chatId = String(ctx.chat?.id || "unknown");
  console.warn(`[AUTH] blocked ${origin} for user ${userId} in chat ${chatId}`);
  try {
    await safeReplyWithFallback(ctx, `⛔ Access denied for this bot.\nYour Telegram ID: ${userId}\nAsk admin to add it to ADMIN_TELEGRAM_IDS.`);
  } catch (_) {}
  return false;
}
function verifyWebhookSecret(req) {
const got = req.headers["x-nil-secret"];
return got && String(got) === String(BASE_WEBHOOK_SECRET);
}
function verifyHmac(req) {
if (!OPS_WEBHOOK_HMAC_SECRET) return false;

const sig = String(req.headers["x-ops-signature"] || "").trim();
if (!sig) return false;
const candidates = [];
if (typeof req.rawBody === "string" && req.rawBody.length > 0) {
  candidates.push(req.rawBody);
}
const normalized = JSON.stringify(req.body ?? {});
if (!candidates.includes(normalized)) {
  candidates.push(normalized);
}

for (const body of candidates) {
  const expected = crypto
    .createHmac("sha256", OPS_WEBHOOK_HMAC_SECRET)
    .update(body)
    .digest("hex");
  if (sig === expected) return true;
}
return false;
}
function verifyOpsIngestAuth(req) {
if (verifyHmac(req)) return true;
return verifyWebhookSecret(req);
}

function normalizeWorkflowAuditValue(value) {
return String(value || "").trim();
}

function workflowNodeHeaderValue(node, headerName) {
const params = node?.parameters || {};
const list = params?.headerParameters?.parameters;
if (!Array.isArray(list)) return "";
const found = list.find((entry) => String(entry?.name || "").toLowerCase() === String(headerName || "").toLowerCase());
return normalizeWorkflowAuditValue(found?.value || "");
}

function workflowNodeUrl(node) {
return normalizeWorkflowAuditValue(node?.parameters?.url || "");
}

function auditWorkflowDefinition(workflow) {
const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
const workflowId = String(workflow?.id || "");
const workflowName = String(workflow?.name || "").toLowerCase();
const isOpsIngestSender = workflowId === "bedvcYsvsKV6H2uK" || workflowName.includes("ops ingest sender");
const issues = [];
for (const node of nodes) {
  if (String(node?.type || "") !== "n8n-nodes-base.httpRequest") continue;
  const nodeName = String(node?.name || "unnamed_node");
  const url = workflowNodeUrl(node);
  const authHeader = workflowNodeHeaderValue(node, "Authorization");
  const nilSecretHeader = workflowNodeHeaderValue(node, "x-nil-secret");

  if (!isOpsIngestSender && url.includes("/ops/ingest") && !url.includes("OPS_INGEST_SENDER_URL")) {
    issues.push({
      severity: "warn",
      type: "legacy_direct_ops_ingest",
      node: nodeName,
      summary: `${nodeName} posts directly to /ops/ingest instead of WF09 HMAC sender`,
    });
  }

  if (authHeader.includes("Bearer ") && !authHeader.includes("$env.")) {
    issues.push({
      severity: "warn",
      type: "hardcoded_bearer",
      node: nodeName,
      summary: `${nodeName} uses a hard-coded Bearer token`,
    });
  }

  if (nilSecretHeader && !nilSecretHeader.includes("$env.") && !nilSecretHeader.includes("={{")) {
    issues.push({
      severity: "degraded",
      type: "literal_nil_secret",
      node: nodeName,
      summary: `${nodeName} uses a literal x-nil-secret header`,
    });
  }
}
return issues;
}

function summarizeWorkflowAuditIssues(issues = [], limit = 3) {
return issues.slice(0, limit).map((issue) => issue.summary);
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
function markAdminActivity({ userId = null, chatId = null, cardType = null, messageId = null } = {}) {
  try {
    const resolvedUserId = String(userId || chatId || "");
    if (!resolvedUserId) return;
    if (ADMIN_IDS.length && !ADMIN_IDS.includes(resolvedUserId)) return;
    const prev = adminActivity.get(resolvedUserId) || {};
    adminActivity.set(resolvedUserId, {
      ...prev,
      chatId: String(chatId || prev.chatId || resolvedUserId),
      lastActivityAt: Date.now(),
      lastCardType: cardType || prev.lastCardType || null,
      lastMessageId: messageId || prev.lastMessageId || null,
      lastResetAt: prev.lastResetAt || 0,
    });
  } catch (_) {}
}
async function runIdleDashboardResetSweep() {
  if (!TELEGRAM_BOT_ACTIVE) return;
  const idleMs = ADMIN_IDLE_DASHBOARD_RESET_HOURS * 60 * 60 * 1000;
  if (!Number.isFinite(idleMs) || idleMs <= 0) return;
  const now = Date.now();

  for (const [userId, state] of adminActivity.entries()) {
    const chatId = state?.chatId || userId;
    const lastActivityAt = Number(state?.lastActivityAt || 0);
    if (!lastActivityAt || now - lastActivityAt < idleMs) continue;

    const currentFilter = userFilters.get(userId) || "all";
    const currentCardType = String(state?.lastCardType || "");
    const needsReset = currentFilter !== "all" || (currentCardType && currentCardType !== "dashboard");
    if (!needsReset) continue;

    userFilters.set(userId, "all");
    userRoleFilters.set(userId, "all");

    const text = await dashboardText("all").catch(() => null);
    if (!text) continue;
    const msg = await bot.telegram.sendMessage(String(chatId), text, dashboardKeyboardV50()).catch(() => null);
    if (msg?.message_id) {
      registerLiveCard(msg, {
        type: "dashboard",
        card_key: "dashboard:all:all:idle_reset",
        ref_id: "all",
        filterSource: "all",
        user_id: userId,
      });
    }
    adminActivity.set(userId, {
      ...state,
      chatId: String(chatId),
      lastActivityAt: now,
      lastCardType: "dashboard",
      lastMessageId: msg?.message_id || state?.lastMessageId || null,
      lastResetAt: now,
    });
  }
}
async function forceAdminDashboardReset({ userId, chatId, reason = "manual" } = {}) {
  const resolvedUserId = String(userId || chatId || "");
  const resolvedChatId = String(chatId || userId || "");
  if (!resolvedUserId || !resolvedChatId) return null;
  userFilters.set(resolvedUserId, "all");
  userRoleFilters.set(resolvedUserId, "all");

  const text = await dashboardText("all").catch(() => null);
  if (!text) return null;

  const msg = await bot.telegram.sendMessage(resolvedChatId, text, dashboardKeyboardV50()).catch(() => null);
  if (msg?.message_id) {
    registerLiveCard(msg, {
      type: "dashboard",
      card_key: `dashboard:all:all:force_${reason}`,
      ref_id: "all",
      filterSource: "all",
      user_id: resolvedUserId,
    });
  }

  adminActivity.set(resolvedUserId, {
    ...(adminActivity.get(resolvedUserId) || {}),
    chatId: resolvedChatId,
    lastActivityAt: Date.now(),
    lastCardType: "dashboard",
    lastMessageId: msg?.message_id || null,
    lastResetAt: Date.now(),
  });
  return msg;
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
const payload = JSON.stringify(bodyObj ?? {});
return crypto
.createHmac("sha256", OPS_WEBHOOK_HMAC_SECRET)
.update(payload)
.digest("hex");
}
async function postOpsIngestEvent(eventBody) {
const safeBody = eventBody ?? {};
const headers = { "content-type": "application/json" };
if (BASE_WEBHOOK_SECRET) headers["x-nil-secret"] = BASE_WEBHOOK_SECRET;
if (OPS_WEBHOOK_HMAC_SECRET) {
headers["x-ops-signature"] = buildOpsSignature(safeBody);
}
const resp = await fetch(`http://127.0.0.1:${PORT}/ops/ingest`, {
method: "POST",
headers,
body: JSON.stringify(safeBody),
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
if (source && source !== "all") {
  const safeSrc = sourceSafe(source);
  q = q.or(`source.eq.${safeSrc},source.is.null,source.eq.`);
}
if (role && role !== "all") q = q.eq("role", role);
const { count, error } = await q;
if (error) {
  if (role && String(error.message || "").toLowerCase().includes("role")) {
    let fallback = ops().from("conversations").select("id", { count: "exact", head: true });
    if (pipeline) fallback = fallback.eq("pipeline", pipeline);
    if (source && source !== "all") {
      const safeSrc = sourceSafe(source);
      fallback = fallback.or(`source.eq.${safeSrc},source.is.null,source.eq.`);
    }
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
const breakdown = await sbNeedsReplyBreakdown({ source, role });
return breakdown.urgentCount;
} catch (err) {
console.warn("sbCountUrgentAuto exception:", err.message);
return 0;
}
}
// Auto-urgent: list needs_reply items with >24h wait time
async function sbListUrgentAuto({ source = "all", role = "all", limit = 8, offset = 0, scanLimit = 500 } = {}) {
try {
const OVERDUE_MINUTES = 24 * 60;
const rows = await sbListConversations({ pipeline: "needs_reply", source, role, limit: scanLimit });
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
return urgent.slice(offset, offset + limit);
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
const breakdown = await sbNeedsReplyBreakdown({ source, role });
return breakdown.nonUrgentCount;
} catch (err) {
console.warn("sbCountNeedsReplyNonUrgent exception:", err.message);
return 0;
}
}

async function sbNeedsReplyBreakdown({ source = "all", role = "all", limit = 500 } = {}) {
try {
const OVERDUE_MINUTES = 24 * 60;
const rows = await sbListConversations({ pipeline: "needs_reply", source, role, limit });
let urgentCount = 0;
let nonUrgentCount = 0;
for (const c of rows || []) {
const waitingMin = tComputeWaitingMinutes(c);
if (waitingMin == null || waitingMin <= OVERDUE_MINUTES) {
nonUrgentCount++;
} else {
urgentCount++;
}
}
return { urgentCount, nonUrgentCount };
} catch (err) {
console.warn("sbNeedsReplyBreakdown exception:", err.message);
return { urgentCount: 0, nonUrgentCount: 0 };
}
}

async function sbCountUrgentCombined({ source = "all", role = "all" } = {}) {
  try {
    const [autoUrgentCount, pipelineUrgentCount] = await Promise.all([
      sbCountUrgentAuto({ source, role }),
      sbCountConversations({ pipeline: "urgent", source, role }),
    ]);
    return Number(autoUrgentCount || 0) + Number(pipelineUrgentCount || 0);
  } catch (err) {
    console.warn("sbCountUrgentCombined exception:", err.message);
    return 0;
  }
}

async function sbListUrgentCombined({ source = "all", role = "all", limit = 8, offset = 0 } = {}) {
  try {
    const fetchSpan = Math.max((offset + limit) * 4, 24);
    const [autoUrgentRows, pipelineUrgentRows] = await Promise.all([
      sbListUrgentAuto({ source, role, limit: fetchSpan, offset: 0, scanLimit: 500 }),
      sbListConversations({ pipeline: "urgent", source, role, limit: fetchSpan, offset: 0 }),
    ]);

    const deduped = new Map();
    for (const row of [...(pipelineUrgentRows || []), ...(autoUrgentRows || [])]) {
      if (!row?.id) continue;
      if (!deduped.has(row.id)) deduped.set(row.id, row);
    }

    const rows = Array.from(deduped.values());
    rows.sort((a, b) => {
      const aw = tComputeWaitingMinutes(a) || 0;
      const bw = tComputeWaitingMinutes(b) || 0;
      if (bw !== aw) return bw - aw;
      const at = new Date(a.updated_at || 0).getTime() || 0;
      const bt = new Date(b.updated_at || 0).getTime() || 0;
      return bt - at;
    });

    return rows.slice(offset, offset + limit);
  } catch (err) {
    console.warn("sbListUrgentCombined exception:", err.message);
    return [];
  }
}

async function sbCoachIdsForSource(source = "all") {
  if (source === "all") return null;
  try {
    const safeSrc = sourceSafe(source);
    const { data, error } = await ops()
      .from("conversations")
      .select("coach_id")
      .or(`source.eq.${safeSrc},source.is.null,source.eq.`)
      .not("coach_id", "is", null)
      .limit(5000);
    if (error) return null;
    const ids = new Set((data || []).map((r) => String(r.coach_id || "").trim()).filter(Boolean));
    return ids;
  } catch (_) {
    return null;
  }
}

function normalizeGuideKey(rawType) {
  const t = String(rawType || "").trim().toLowerCase();
  if (!t) return "";
  if ((t.includes("aflac") && t.includes("proof")) || (t.includes("google") && t.includes("drive"))) return "aflac-proof";
  if (t.includes("parent") && t.includes("guide")) return "parent-guide";
  if (t.includes("supplemental") && t.includes("guide")) return "supplemental-health-guide";
  if (t.includes("risk") && t.includes("guide")) return "risk-awareness-guide";
  if (t.includes("tax") && t.includes("guide")) return "tax-education-guide";
  if (t.includes("enroll")) return "enroll";
  if (t.includes("eapp")) return "eapp";
  if (t.includes("guide")) return "guide";
  return "";
}

function guideKeyFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch (_) {
    return "";
  }

  const host = String(parsed.hostname || "").toLowerCase();
  const path = String(parsed.pathname || "").toLowerCase();

  if (path.startsWith("/go/")) {
    const slug = path.slice(4).split("/")[0].split("-");
    const candidate = slug.length > 1 ? slug.slice(0, -1).join("-") : slug[0] || "";
    if (candidate === "parent-guide") return "parent-guide";
    if (candidate === "supplemental-health-guide") return "supplemental-health-guide";
    if (candidate === "risk-awareness-guide") return "risk-awareness-guide";
    if (candidate === "tax-education-guide") return "tax-education-guide";
    if (candidate === "enroll") return "enroll";
    if (candidate === "eapp") return "eapp";
    if (candidate === "website") return "website";
    if (candidate === "aflac-proof") return "aflac-proof";
  }

  if (host.includes("parentsguide.mynilwealthstrategies.com")) return "parent-guide";
  if (host.includes("supplementalhealth.mynilwealthstrategies.com")) return "supplemental-health-guide";
  if (host.includes("riskawareness.mynilwealthstrategies.com")) return "risk-awareness-guide";
  if (host.includes("taxeducation.mynilwealthstrategies.com")) return "tax-education-guide";
  if (host.includes("enrollment.mynilwealthstrategies.com")) {
    if (path.includes("eapp")) return "eapp";
    return "enroll";
  }
  if (host.includes("mynilwealthstrategies.com")) return "website";
  if (host.includes("drive.google.com") && path.includes("/file/d/")) return "aflac-proof";

  return "";
}

function buildTrackedGuideLink(rawUrl, conv) {
  const guideKey = guideKeyFromUrl(rawUrl);
  if (!guideKey) return rawUrl;

  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch (_) {
    return rawUrl;
  }

  const recipientEmail = normalizeEmail(conv?.contact_email || "");
  const coachId = String(conv?.coach_id || "").trim();

  if (parsed.pathname.startsWith("/go/")) {
    if (recipientEmail && !parsed.searchParams.get("pk")) {
      parsed.searchParams.set("pk", hashStable(recipientEmail));
    }
    if (coachId && !parsed.searchParams.get("coach_id")) {
      parsed.searchParams.set("coach_id", coachId);
    }
    return parsed.toString();
  }

  if (!recipientEmail) return rawUrl;

  const prettyTracked = new URL("https://mynilwealthstrategies.com");
  const coachSuffix = coachId ? `-${encodeURIComponent(coachId)}` : "";
  prettyTracked.pathname = coachSuffix ? `/go/${guideKey}${coachSuffix}` : `/go/${guideKey}`;
  prettyTracked.searchParams.set("pk", hashStable(recipientEmail));

  if (!CLICK_TRACKER_BASE_URL) {
    return prettyTracked.toString();
  }

  try {
    new URL(CLICK_TRACKER_BASE_URL);
  } catch (_) {
    return rawUrl;
  }

  return prettyTracked.toString();
}

function parentGuideLinkForConversation(conv) {
  return buildTrackedGuideLink(DEFAULT_PARENT_GUIDE_URL, conv);
}

function officialWebsiteLinkForConversation(conv) {
  return buildTrackedGuideLink(DEFAULT_OFFICIAL_WEBSITE_URL, conv);
}

function aflacProofLinkForConversation(conv) {
  return buildTrackedGuideLink(DEFAULT_AFLAC_PROOF_URL, conv);
}

function rewriteOutboundTrackedLinks(rawBody, conv) {
  const body = String(rawBody || "");
  if (!body) return body;

  const urlRegex = /https?:\/\/[^\s<>()]+/gi;
  return body.replace(urlRegex, (fullMatch) => {
    const trimmed = fullMatch.replace(/[),.;!?]+$/g, "");
    const suffix = fullMatch.slice(trimmed.length);
    const rewritten = buildTrackedGuideLink(trimmed, conv);
    return `${rewritten}${suffix}`;
  });
}

function normalizeMessageSpacing(value) {
  const text = String(value || "").replace(/\r\n/g, "\n");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureAflacOption3(body, conv) {
  const text = normalizeMessageSpacing(body);
  if (!text) return text;
  const trackedAflacProofLink = aflacProofLinkForConversation(conv) || DEFAULT_AFLAC_PROOF_URL;
  if (text.includes(trackedAflacProofLink) || text.includes("To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury:")) {
    return text;
  }
  const option3Block = [
    "To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury:",
    "Backed by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders.",
    trackedAflacProofLink,
  ].join("\n");
  return `${text}\n\n${option3Block}`.trim();
}

function isForwardedGuideSignal(rawType) {
  return Boolean(normalizeGuideKey(rawType));
}

function isCoachLikeActorType(rawActorType) {
  const t = String(rawActorType || "").trim().toLowerCase();
  if (!t) return false;
  return t.includes("coach") || t.includes("program");
}

function isBotLikeActorType(rawActorType) {
  const t = String(rawActorType || "").trim().toLowerCase();
  if (!t) return false;
  return t.includes("bot") || t.includes("crawler") || t.includes("spider") || t.includes("prefetch") || t.includes("preview");
}

function isLikelyCoachSelfClick(row = {}) {
  if (row?.is_coach_self_click === true) return true;
  const actorType = String(row?.actor_type || "").trim().toLowerCase();
  const actorId = String(row?.actor_id || "").trim();
  const coachId = String(row?.coach_id || "").trim();
  if (!actorId || !coachId) return false;
  return isCoachLikeActorType(actorType) && actorId === coachId;
}

function includesForwardedFamilyEvidence(row = {}) {
  if (isLikelyCoachSelfClick(row)) return false;
  if (isCoachLikeActorType(row?.actor_type)) return false;
  if (isBotLikeActorType(row?.actor_type)) return false;
  const guideKey = normalizeGuideKey(row?.guide_key || row?.click_type || row?.kind || row?.event_type);
  if (guideKey) return true;
  const sourceTag = String(row?.click_source || "").toLowerCase();
  const typeTag = String(row?.click_type || row?.kind || row?.event_type || "").toLowerCase();
  return sourceTag === "email" || typeTag.includes("guide") || typeTag.includes("enroll") || typeTag.includes("eapp");
}

async function sbForwardedCoachIdsFromRegistry({ source = "all" } = {}) {
  try {
    const coachIdsForSource = await sbCoachIdsForSource(source);
    const { data, error } = await ops()
      .from("click_link_registry")
      .select("coach_id, guide_key, actor_type, actor_id, is_coach_self_click")
      .not("coach_id", "is", null)
      .limit(10000);
    if (error) return null;

    const coachIds = new Set();
    for (const row of data || []) {
      const coachId = String(row?.coach_id || "").trim();
      if (!coachId) continue;
      if (coachIdsForSource && !coachIdsForSource.has(coachId)) continue;
      if (isLikelyCoachSelfClick(row)) continue;
      if (isCoachLikeActorType(row?.actor_type)) continue;
      if (!isForwardedGuideSignal(row?.guide_key)) continue;
      coachIds.add(coachId);
    }

    return coachIds;
  } catch (_) {
    return null;
  }
}

async function sbCountForwardedCombined({ source = "all" } = {}) {
  try {
    const fromRegistry = await sbForwardedCoachIdsFromRegistry({ source });
    if (fromRegistry) return fromRegistry.size;

    const coachIdsForSource = await sbCoachIdsForSource(source);

    const { data: clicks, error } = await ops()
      .from("click_events")
      .select("coach_id, click_source, click_type, kind, event_type, guide_key, actor_type, actor_id, is_coach_self_click")
      .not("coach_id", "is", null)
      .limit(10000);
    if (error) return 0;

    const clickRows = clicks || [];
    const coachIds = new Set();
    for (const row of clickRows) {
      const coachId = String(row?.coach_id || "").trim();
      if (!coachId) continue;
      if (coachIdsForSource && !coachIdsForSource.has(coachId)) continue;
      if (!includesForwardedFamilyEvidence(row)) continue;
      coachIds.add(coachId);
    }

    return coachIds.size;
  } catch (err) {
    console.warn("sbCountForwardedCombined exception:", err.message);
    return 0;
  }
}

async function sbListForwardedCombined({ source = "all", limit = 8, offset = 0 } = {}) {
  try {
    const fetchSpan = Math.max((offset + limit) * 8, 64);
    const fromRegistry = await sbForwardedCoachIdsFromRegistry({ source });
    if (fromRegistry && fromRegistry.size) {
      const ids = Array.from(fromRegistry).slice(0, 200);
      const { data: convs, error: convErr } = await ops()
        .from("conversations")
        .select("id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at")
        .in("coach_id", ids)
        .order("updated_at", { ascending: false })
        .limit(fetchSpan);
      if (convErr) return [];

      const latestByCoach = new Map();
      for (const conv of convs || []) {
        const coachId = String(conv?.coach_id || "").trim();
        if (!coachId) continue;
        if (!latestByCoach.has(coachId)) latestByCoach.set(coachId, conv);
      }
      return Array.from(latestByCoach.values()).slice(offset, offset + limit);
    }

    const coachIdsForSource = await sbCoachIdsForSource(source);
    const { data: clicks, error } = await ops()
      .from("click_events")
      .select("coach_id, click_source, click_type, kind, event_type, guide_key, actor_type, actor_id, is_coach_self_click")
      .not("coach_id", "is", null)
      .limit(10000);
    if (error) return [];

    const clickedCoachIds = new Set();
    for (const row of clicks || []) {
      const coachId = String(row?.coach_id || "").trim();
      if (!coachId) continue;
      if (coachIdsForSource && !coachIdsForSource.has(coachId)) continue;
      if (!includesForwardedFamilyEvidence(row)) continue;
      clickedCoachIds.add(coachId);
    }

    const ids = Array.from(clickedCoachIds).slice(0, 200);
    if (!ids.length) return [];

    const { data: convs, error: convErr } = await ops()
      .from("conversations")
      .select("id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at")
      .in("coach_id", ids)
      .order("updated_at", { ascending: false })
      .limit(fetchSpan);
    if (convErr) return [];

    // One forwarded row per coach: multiple family clicks should not duplicate queue rows.
    const latestByCoach = new Map();
    for (const conv of convs || []) {
      const coachId = String(conv?.coach_id || "").trim();
      if (!coachId) continue;
      if (!latestByCoach.has(coachId)) {
        latestByCoach.set(coachId, conv);
      }
    }

    return Array.from(latestByCoach.values()).slice(offset, offset + limit);
  } catch (err) {
    console.warn("sbListForwardedCombined exception:", err.message);
    return [];
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
  const wd = await runDataWatchdog();
  return {
    config: {
      make_send_webhook_configured: !!MAKE_SEND_WEBHOOK_URL,
      cc_support_webhook_configured: !!CC_SUPPORT_WEBHOOK_URL,
      handoff_webhook_configured: !!HANDOFF_WEBHOOK_URL,
      openai_api_key_configured: !!OPENAI_API_KEY,
      support_from_email_configured: !!SUPPORT_FROM_EMAIL,
      outreach_from_email_configured: !!OUTREACH_FROM_EMAIL,
      click_tracker_base_configured: !!CLICK_TRACKER_BASE_URL,
    },
    runtime: {
      last_outbox_tick_at: lastOutboxTickAt,
      dead_letter_backlog: deadLetterBacklog,
      pending_handoff_conversations: Number.isFinite(pendingHandoffs) ? pendingHandoffs : null,
    },
    watchdog: wd,
  };
}

function watchdogKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "HEALTH:refresh")],
    [Markup.button.callback("⬅ Dashboard", "DASH:back")],
  ]);
}

function watchdogStatusLabel(status) {
  if (status === "ok") return "Healthy";
  if (status === "degraded") return "Monitor";
  if (status === "warn") return "Action Required";
  return "Unknown";
}

function watchdogStatusDot(status) {
  if (status === "ok") return "🟢";
  if (status === "degraded") return "🟡";
  if (status === "warn") return "🔴";
  return "⚪";
}

function watchdogStatusDisplay(status) {
  return `${watchdogStatusDot(status)} ${watchdogStatusLabel(status)}`;
}

function buildWatchdogCardText(wd) {
  const snapshot = wd || {};
  const freshness = snapshot.freshness || {};
  const rec = snapshot.reconciliation || {};
  const cards = snapshot.cards || {};
  const workflows = snapshot.workflows || {};
  const operationsRisk = snapshot.operationsRisk || {};
  const schema = snapshot.schema || {};
  const staleItems = (freshness.checks || [])
    .filter((c) => c.status === "stale")
    .map((c) => `${c.name} (${c.ageMinutes}m)`)
    .slice(0, 5);
  const freshnessUnknownCount = (freshness.checks || []).filter((c) => c.status === "unknown").length;
  const explainRecCheck = (check) => {
    if (!check) return "General data mismatch detected";
    if (check.name === "click_events_vs_aggregate") return "click totals do not match summary views";
    if (check.name === "processed_vs_dead_letter") return "too many failed events vs processed";
    if (check.name === "forwarded_registry_quality") return "forwarded click tracking quality issue";
    return `${check.name} needs review`;
  };
  const explainCardCheck = (check) => {
    if (!check) return "queue/card count check failed";
    if (check.name === "oldest_queue_age") {
      if (check.note === "oldest_queue_age_unavailable") return "oldest queued item age could not be read";
      if (check.note === "oldest_queue_age_over_threshold") {
        const age = Number.isFinite(check?.ageMinutes) ? `${check.ageMinutes}m` : "unknown";
        const threshold = Number.isFinite(check?.thresholdMinutes) ? `${check.thresholdMinutes}m` : `${URGENT_AFTER_MINUTES}m`;
        return `oldest queued item is ${age} (limit ${threshold})`;
      }
      return "oldest queue age check needs review";
    }
    if (check.note === "count_unavailable") return `${check.name}: count query unavailable`;
    if (check.note === "count_list_mismatch") return `${check.name}: count and list do not match`;
    return `${check.name}: card validation issue`;
  };
  const recIssueLines = (rec.checks || [])
    .filter((c) => c.status === "warn" || c.status === "unknown")
    .slice(0, 3)
    .map((c) => explainRecCheck(c));
  const cardIssueLines = (cards.checks || [])
    .filter((c) => c.status === "warn" || c.status === "degraded")
    .slice(0, 4)
    .map((c) => explainCardCheck(c));
  const workflowLines = (workflows.checks || [])
    .slice(0, 9)
    .map((wf) => {
      const age = Number.isFinite(wf?.ageMinutes) ? `${wf.ageMinutes}m` : "no signal";
      return `${wf.id}: ${watchdogStatusDisplay(wf.status)} (${age})`;
    });
  const workflowIssueLines = (workflows.checks || [])
    .filter((wf) => wf.status === "warn" || wf.status === "unknown" || wf.status === "degraded")
    .slice(0, 4)
    .map((wf) => {
      const issueText = Array.isArray(wf.issues) && wf.issues.length
        ? wf.issues.slice(0, 2).map((issue) => issue.summary).join(" | ")
        : (wf.detail || (wf.status === "unknown" ? "no recent signal" : "needs review"));
      return `${wf.id}: ${issueText}`;
    });
  const workflowWarnCount = (workflows.checks || []).filter((wf) => wf.status === "warn").length;
  const workflowUnknownCount = (workflows.checks || []).filter((wf) => wf.status === "unknown").length;
  const opsRiskIssueLines = (operationsRisk.checks || [])
    .filter((c) => c.status === "warn" || c.status === "unknown" || c.status === "degraded")
    .slice(0, 4)
    .map((c) => c.summary || `${c.name}: needs review`);
  const missingSample = (schema.missing || []).slice(0, 8);

  return `🛡 DATA WATCHDOG
--
Last Run: ${snapshot.lastRunAt || "never"}
Overall: ${watchdogStatusDisplay(snapshot.overallStatus)}

Freshness: ${watchdogStatusDisplay(freshness.overall)}
Stale Threshold: ${freshness.staleThresholdMinutes || WATCHDOG_STALE_MINUTES}m
Stale Sources: ${staleItems.length ? staleItems.join(", ") : "none"}
If wrong: ${staleItems.length ? "one or more feeds have not updated in time" : freshnessUnknownCount ? "some feeds have no readable timestamp" : "none"}

Reconciliation: ${watchdogStatusDisplay(rec.overall)}
If wrong: ${recIssueLines.length ? recIssueLines.join("; ") : "none"}

Cards & Dashboard: ${watchdogStatusDisplay(cards.overall)}
If wrong: ${cardIssueLines.length ? cardIssueLines.join("; ") : "none"}

Workflows WF01-WF09: ${watchdogStatusDisplay(workflows.overall)}
Warnings: ${workflowWarnCount} · Unknown: ${workflowUnknownCount}
${workflowLines.length ? workflowLines.join("\n") : "No workflow signals yet"}
If wrong: ${workflowIssueLines.length ? workflowIssueLines.join("; ") : "none"}

Operations Risk: ${watchdogStatusDisplay(operationsRisk.overall)}
If wrong: ${opsRiskIssueLines.length ? opsRiskIssueLines.join("; ") : "none"}

Schema Contract: ${watchdogStatusDisplay(schema.overall)}
Covered: ${schema.coveredCount ?? 0}/${schema.expectedCount ?? EXPECTED_NIL_RELATIONS.length}
Missing: ${schema.missing?.length || 0}${missingSample.length ? `\n${missingSample.join(", ")}${schema.missing.length > missingSample.length ? " ..." : ""}` : ""}
If wrong: ${schema.missing?.length ? "one or more required tables/views are missing" : "none"}
--`;
}

// ---------- LISTS ----------
async function sbListConversations({ pipeline, source = "all", role = "all", limit = 8, offset = 0 }) {
const buildQuery = (withRole, withHandoff, withCardExtras = true) => {
  const handoffCols = withHandoff ? ', needs_support_handoff, needs_support_handoff_at, handoff_detected_reason' : '';
  const cardCols = withCardExtras ? ', cc_support_suggested, gmail_url, mirror_conversation_id' : '';
  const fetchLimit = Math.max((offset + limit) * 2, limit * 2);
  let q = ops()
    .from("conversations")
    .select(
      withRole
        ? `id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at${cardCols}, role, role_pending, role_confidence${handoffCols}`
        : `id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at${cardCols}${handoffCols}`
    )
    .order("updated_at", { ascending: false })
    .limit(fetchLimit); // Fetch wider window for stable priority sorting with pagination
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
return sorted.slice(offset, offset + limit);
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

async function sbListMessagesOldest(conversation_id, { offset = 0, limit = 6 } = {}) {
const { data, error } = await ops()
.from("messages")
.select("id, direction, sender, from_email, to_email, subject, body, preview, created_at")
.eq("conversation_id", conversation_id)
.order("created_at", { ascending: true })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
}

async function sbCountMessagesByDirection(conversation_id, direction) {
const { count, error } = await ops()
.from("messages")
.select("id", { count: "exact", head: true })
.eq("conversation_id", conversation_id)
.eq("direction", direction);
if (error) throw new Error(error.message);
return count || 0;
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
const normalizeMetricEventType = (rawType) => {
const t = String(rawType || "").trim().toLowerCase();
if (!t) return null;
  if (t.includes("website_open") || t.includes("website opens") || t.includes("nilws_website_open") || t.includes("nilws website open")) return "website_open";
if (t.includes("thread_created") || t === "conversation.created") return "thread_created";
if (t.includes("eapp")) return "eapp_visit";
if (t.includes("sh_click") || t.includes("supplemental") || t.includes("supp_health")) return "supplemental_health_guide_click";
if (t.includes("risk_awareness") || (t.includes("risk") && t.includes("click"))) return "risk_awareness_guide_click";
if (t.includes("tax_education") || (t.includes("tax") && t.includes("click"))) return "tax_education_guide_click";
if (t.includes("enroll") || t.includes("portal") || t.includes("signup")) return "enroll_click";
if (t.includes("parent_guide") || t.includes("parents_guide") || t.includes("program_link") || t.includes("guide_open")) return "parent_guide_click";
if (["program_link_open", "parent_guide_open", "parent_guide_click", "program_guide_open", "guide_open", "parent_guide_click"].includes(t)) return "parent_guide_click";
if (["coverage_exploration", "coverage_explore", "coverage_click", "coverage_link_open"].includes(t)) return "supplemental_health_guide_click";
if (["sh_click", "supplemental_health_click", "supplemental_health_guide_click"].includes(t)) return "supplemental_health_guide_click";
if (["risk_awareness_click", "risk_awareness_guide_click"].includes(t)) return "risk_awareness_guide_click";
if (["tax_education_click", "tax_education_guide_click"].includes(t)) return "tax_education_guide_click";
if (["enroll_click", "enroll_portal_click", "enroll_portal_visit", "enroll_visit", "portal_click"].includes(t)) return "enroll_click";
if (["eapp_visit", "eapp_click", "eapp_open"].includes(t)) return "eapp_visit";
if (t === "thread_created" || t === "conversation.created") return "thread_created";
return null;
};
const metricEventTypeFromGuideKey = (rawGuideKey) => {
const g = normalizeGuideKey(rawGuideKey);
if (g === "parent-guide") return "parent_guide_click";
if (g === "supplemental-health-guide") return "supplemental_health_guide_click";
if (g === "risk-awareness-guide") return "risk_awareness_guide_click";
if (g === "tax-education-guide") return "tax_education_guide_click";
if (g === "enroll") return "enroll_click";
if (g === "eapp") return "eapp_visit";
return null;
};
const resolveMetricEventType = (row = {}) => {
const byGuide = metricEventTypeFromGuideKey(row?.guide_key || row?.guideKey || row?.guide);
if (byGuide) return byGuide;

const candidates = [row?.kind, row?.click_type, row?.event_type, row?.type, row?.event, row?.click_source];
for (const candidate of candidates) {
const mapped = normalizeMetricEventType(candidate);
if (mapped) return mapped;
}
return null;
};
const toNumber = (v) => {
const n = Number(v);
return Number.isFinite(n) ? n : 0;
};
const readNumeric = (row, keys) => {
for (const k of keys) {
if (row && row[k] != null) return toNumber(row[k]);
}
return 0;
};
const sourceFilter = source === "all" ? "all" : sourceSafe(source);
const rowMatchesSource = (row) => {
if (sourceFilter === "all") return true;
const rowSource = String(row?.source || row?.click_source || "").trim().toLowerCase();
if (!rowSource) return true;
if (rowSource.includes("support")) return sourceFilter === "support";
if (rowSource.includes("program") || rowSource.includes("outreach")) return sourceFilter === "programs";
return rowSource === sourceFilter;
};
const rowCreatedAt = (row, relation) => {
const direct = row?.created_at || row?.day || row?.date || row?.event_date || row?.week_start || row?.month_start || row?.year_start;
if (direct) return direct;
const year = toNumber(row?.year);
const month = toNumber(row?.month);
if (year > 0 && month >= 1 && month <= 12) {
return new Date(Date.UTC(year, month - 1, 1)).toISOString();
}
if (year > 0 && relation === "v_click_yearly_summary") {
return new Date(Date.UTC(year, 0, 1)).toISOString();
}
return now.toISOString();
};
const eventRows = [];
let rawClickEventCount = 0;
const fallbackCounts = {
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
};
const monthlyFallback = Array.from({ length: 12 }, () => ({
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
}));

const emptyCountsBucket = () => ({
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
});
const emptyMonthlyBuckets = () => Array.from({ length: 12 }, () => ({
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
}));

const addFallbackBucket = (targetCounts, targetMonthly, createdAt, bucket) => {
const ts = new Date(createdAt || now.toISOString()).getTime();
if (!Number.isFinite(ts)) return;
if (since) {
const sinceTs = new Date(since).getTime();
if (Number.isFinite(sinceTs) && ts < sinceTs) return;
}
targetCounts.parentGuideClicks += toNumber(bucket.parentGuideClicks);
targetCounts.supplementalHealthGuideClicks += toNumber(bucket.supplementalHealthGuideClicks);
targetCounts.riskAwarenessGuideClicks += toNumber(bucket.riskAwarenessGuideClicks);
targetCounts.taxEducationGuideClicks += toNumber(bucket.taxEducationGuideClicks);
targetCounts.enrollPortalClicks += toNumber(bucket.enrollPortalClicks);
targetCounts.eappVisits += toNumber(bucket.eappVisits);
const mi = new Date(ts).getMonth();
if (mi >= 0 && mi <= 11) {
  targetMonthly[mi].websiteOpens += toNumber(bucket.websiteOpens);
targetMonthly[mi].parentGuideClicks += toNumber(bucket.parentGuideClicks);
targetMonthly[mi].supplementalHealthGuideClicks += toNumber(bucket.supplementalHealthGuideClicks);
targetMonthly[mi].riskAwarenessGuideClicks += toNumber(bucket.riskAwarenessGuideClicks);
targetMonthly[mi].taxEducationGuideClicks += toNumber(bucket.taxEducationGuideClicks);
targetMonthly[mi].enrollPortalClicks += toNumber(bucket.enrollPortalClicks);
targetMonthly[mi].eappVisits += toNumber(bucket.eappVisits);
}
};

// 1) canonical metric events (source of truth)
try {
let q = ops()
.from("metric_events")
.select("event_type, source, created_at");
if (since) q = q.gte("created_at", since);
if (source !== "all") q = q.eq("source", sourceSafe(source));
const { data, error } = await q;
if (!error && Array.isArray(data)) {
for (const r of data) {
const eventType = resolveMetricEventType(r) || String(r.event_type || "");
eventRows.push({ event_type: eventType, created_at: r.created_at });
}
}
} catch (err) {
console.warn("sbMetricSummary metric_events fallback:", err?.message || err);
}

// 2) click_events fallback (webhook/metric writes here)
try {
const clickResult = await dbSelectFirst([
() => {
let cq = ops()
.from("click_events")
.select("kind, click_type, event_type, guide_key, click_source, created_at");
if (since) cq = cq.gte("created_at", since);
return cq;
},
() => {
let cq = ops()
.from("click_events")
.select("kind, click_type, event_type, guide_key, click_source, clicked_at");
if (since) cq = cq.gte("clicked_at", since);
return cq;
},
() => {
let cq = ops()
.from("click_events")
.select("kind, click_type, event_type, guide_key, click_source, event_time");
if (since) cq = cq.gte("event_time", since);
return cq;
},
() => ops().from("click_events").select("kind, click_type, event_type, guide_key, click_source"),
]);
if (!clickResult?.error && Array.isArray(clickResult?.data)) {
for (const r of clickResult.data) {
rawClickEventCount++;
const mappedType = resolveMetricEventType(r);
const clickCreatedAt = r.created_at || r.clicked_at || r.event_time || now.toISOString();
if (mappedType) eventRows.push({ event_type: mappedType, created_at: clickCreatedAt });
}
}
} catch (err) {
console.warn("sbMetricSummary click_events fallback:", err?.message || err);
}

// 3) eapp_visits fallback table
try {
let eq = ops()
.from("eapp_visits")
.select("created_at");
if (since) eq = eq.gte("created_at", since);
const { data: eappRows, error: eappErr } = await eq;
if (!eappErr && Array.isArray(eappRows)) {
for (const r of eappRows) eventRows.push({ event_type: "eapp_visit", created_at: r.created_at });
}
} catch (err) {
console.warn("sbMetricSummary eapp_visits fallback:", err?.message || err);
}

// 4) aggregate click fallback chain (strict priority, non-stacking)
const aggregatePriorityByWindow = {
week: ["v_click_weekly_summary", "v_click_daily_summary", "click_analytics_daily", "v_click_summary_today"],
month: ["v_click_monthly_summary", "v_click_daily_summary", "click_analytics_daily", "v_click_summary_today"],
year: ["v_click_yearly_summary", "v_click_monthly_summary", "v_click_daily_summary", "click_analytics_daily", "v_click_summary_today"],
all: ["v_click_yearly_summary", "v_click_monthly_summary", "v_click_daily_summary", "click_analytics_daily", "v_click_summary_today"],
};
const aggregateRelations = aggregatePriorityByWindow[window] || aggregatePriorityByWindow.month;
let usedAggregateRelation = null;
for (const relation of aggregateRelations) {
try {
const { data: rows, error: relationErr } = await ops()
.from(relation)
.select("*");
if (relationErr || !Array.isArray(rows) || rows.length === 0) continue;

const localCounts = emptyCountsBucket();
const localMonthly = emptyMonthlyBuckets();
for (const r of rows) {
if (!rowMatchesSource(r)) continue;
const createdAt = rowCreatedAt(r, relation);
const byKindType = resolveMetricEventType(r);
if (byKindType && (r.count != null || r.total != null || r.clicks != null)) {
const count = toNumber(r.count ?? r.total ?? r.clicks);
const bucket = { parentGuideClicks: 0, supplementalHealthGuideClicks: 0, riskAwarenessGuideClicks: 0, taxEducationGuideClicks: 0, enrollPortalClicks: 0, eappVisits: 0 };
if (byKindType === "website_open") bucket.websiteOpens = count;
if (byKindType === "parent_guide_click") bucket.parentGuideClicks = count;
if (byKindType === "supplemental_health_guide_click") bucket.supplementalHealthGuideClicks = count;
if (byKindType === "risk_awareness_guide_click") bucket.riskAwarenessGuideClicks = count;
if (byKindType === "tax_education_guide_click") bucket.taxEducationGuideClicks = count;
if (byKindType === "enroll_click") bucket.enrollPortalClicks = count;
if (byKindType === "eapp_visit") bucket.eappVisits = count;
addFallbackBucket(localCounts, localMonthly, createdAt, bucket);
continue;
}
addFallbackBucket(localCounts, localMonthly, createdAt, {
  websiteOpens: readNumeric(r, ["website_opens", "nilws_website_opens", "total_website_opens"]),
parentGuideClicks: readNumeric(r, ["parent_guide_clicks", "program_link_opens", "parent_guide_opens"]),
supplementalHealthGuideClicks: readNumeric(r, ["supplemental_health_guide_clicks", "supplemental_health_clicks", "sh_clicks", "coverage_exploration", "coverage_clicks"]),
riskAwarenessGuideClicks: readNumeric(r, ["risk_awareness_guide_clicks", "risk_awareness_clicks"]),
taxEducationGuideClicks: readNumeric(r, ["tax_education_guide_clicks", "tax_education_clicks"]),
enrollPortalClicks: readNumeric(r, ["enroll_clicks", "enroll_portal_visits", "enroll_portal_clicks", "total_enroll_clicks"]),
eappVisits: readNumeric(r, ["eapp_visits", "eapp_clicks", "total_eapp_visits"]),
});
}

const localTotal = localCounts.parentGuideClicks + localCounts.supplementalHealthGuideClicks + localCounts.riskAwarenessGuideClicks + localCounts.taxEducationGuideClicks + localCounts.enrollPortalClicks + localCounts.eappVisits;
if (localTotal <= 0) continue;

  fallbackCounts.websiteOpens += localCounts.websiteOpens;
fallbackCounts.parentGuideClicks += localCounts.parentGuideClicks;
fallbackCounts.supplementalHealthGuideClicks += localCounts.supplementalHealthGuideClicks;
fallbackCounts.riskAwarenessGuideClicks += localCounts.riskAwarenessGuideClicks;
fallbackCounts.taxEducationGuideClicks += localCounts.taxEducationGuideClicks;
fallbackCounts.enrollPortalClicks += localCounts.enrollPortalClicks;
fallbackCounts.eappVisits += localCounts.eappVisits;
for (let i = 0; i < 12; i++) {
  monthlyFallback[i].websiteOpens += localMonthly[i].websiteOpens;
monthlyFallback[i].parentGuideClicks += localMonthly[i].parentGuideClicks;
monthlyFallback[i].supplementalHealthGuideClicks += localMonthly[i].supplementalHealthGuideClicks;
monthlyFallback[i].riskAwarenessGuideClicks += localMonthly[i].riskAwarenessGuideClicks;
monthlyFallback[i].taxEducationGuideClicks += localMonthly[i].taxEducationGuideClicks;
monthlyFallback[i].enrollPortalClicks += localMonthly[i].enrollPortalClicks;
monthlyFallback[i].eappVisits += localMonthly[i].eappVisits;
}
usedAggregateRelation = relation;
break;
} catch (err) {
console.warn(`sbMetricSummary ${relation} fallback:`, err?.message || err);
}
}
if (!usedAggregateRelation) {
console.warn("sbMetricSummary aggregate fallback: no aggregate relation returned usable data");
}

const counts = {
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
threadsCreated: 0,
};
  for (const r of eventRows) {
    const evt = normalizeMetricEventType(r.event_type) || String(r.event_type || "");
    if (evt === "website_open") counts.websiteOpens++;
    if (evt === "parent_guide_click") counts.parentGuideClicks++;
    if (evt === "supplemental_health_guide_click") counts.supplementalHealthGuideClicks++;
    if (evt === "risk_awareness_guide_click") counts.riskAwarenessGuideClicks++;
    if (evt === "tax_education_guide_click") counts.taxEducationGuideClicks++;
    if (evt === "enroll_click") counts.enrollPortalClicks++;
    if (evt === "eapp_visit") counts.eappVisits++;
    if (evt === "thread_created")
      counts.threadsCreated++;
  }
const hasDirectGuideBreakdown =
  (counts.parentGuideClicks || 0) +
  (counts.supplementalHealthGuideClicks || 0) +
  (counts.riskAwarenessGuideClicks || 0) +
  (counts.taxEducationGuideClicks || 0) > 0;
if (!hasDirectGuideBreakdown) {
counts.parentGuideClicks = Math.max(counts.parentGuideClicks, fallbackCounts.parentGuideClicks);
counts.supplementalHealthGuideClicks = Math.max(counts.supplementalHealthGuideClicks, fallbackCounts.supplementalHealthGuideClicks);
counts.riskAwarenessGuideClicks = Math.max(counts.riskAwarenessGuideClicks, fallbackCounts.riskAwarenessGuideClicks);
counts.taxEducationGuideClicks = Math.max(counts.taxEducationGuideClicks, fallbackCounts.taxEducationGuideClicks);
}
counts.enrollPortalClicks = Math.max(counts.enrollPortalClicks, fallbackCounts.enrollPortalClicks);
counts.eappVisits = Math.max(counts.eappVisits, fallbackCounts.eappVisits);
const categoryTotalClicks =
  (counts.websiteOpens || 0) +
  (counts.parentGuideClicks || 0) +
  (counts.supplementalHealthGuideClicks || 0) +
  (counts.riskAwarenessGuideClicks || 0) +
  (counts.taxEducationGuideClicks || 0) +
  (counts.enrollPortalClicks || 0) +
  (counts.eappVisits || 0);
counts.totalClicks = categoryTotalClicks;
// Backward-compatible aliases for existing consumers.
counts.programLinkOpens = counts.parentGuideClicks;
counts.enrollClicks = counts.enrollPortalClicks;
  counts.nilwsWebsiteOpens = counts.websiteOpens;
  
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
  websiteOpens: 0,
parentGuideClicks: 0,
supplementalHealthGuideClicks: 0,
riskAwarenessGuideClicks: 0,
taxEducationGuideClicks: 0,
enrollPortalClicks: 0,
eappVisits: 0,
totalClicks: 0,
threads: 0,
callsAnswered: 0,
}));

for (const r of eventRows) {
const mi = monthIndex(r.created_at);
if (mi < 0 || mi > 11) continue;
const evt = normalizeMetricEventType(r.event_type) || String(r.event_type || "");
  if (evt === "website_open") monthly[mi].websiteOpens++;
if (evt === "parent_guide_click") monthly[mi].parentGuideClicks++;
if (evt === "supplemental_health_guide_click") monthly[mi].supplementalHealthGuideClicks++;
if (evt === "risk_awareness_guide_click") monthly[mi].riskAwarenessGuideClicks++;
if (evt === "tax_education_guide_click") monthly[mi].taxEducationGuideClicks++;
if (evt === "enroll_click") monthly[mi].enrollPortalClicks++;
if (evt === "eapp_visit") monthly[mi].eappVisits++;
if (evt === "thread_created")
monthly[mi].threads++;
}
for (let i = 0; i < 12; i++) {
  monthly[i].websiteOpens = Math.max(monthly[i].websiteOpens, monthlyFallback[i].websiteOpens || 0);
const hasDirectMonthlyGuideBreakdown =
  (monthly[i].parentGuideClicks || 0) +
  (monthly[i].supplementalHealthGuideClicks || 0) +
  (monthly[i].riskAwarenessGuideClicks || 0) +
  (monthly[i].taxEducationGuideClicks || 0) > 0;
if (!hasDirectMonthlyGuideBreakdown) {
monthly[i].parentGuideClicks = Math.max(monthly[i].parentGuideClicks, monthlyFallback[i].parentGuideClicks || 0);
monthly[i].supplementalHealthGuideClicks = Math.max(monthly[i].supplementalHealthGuideClicks, monthlyFallback[i].supplementalHealthGuideClicks || 0);
monthly[i].riskAwarenessGuideClicks = Math.max(monthly[i].riskAwarenessGuideClicks, monthlyFallback[i].riskAwarenessGuideClicks || 0);
monthly[i].taxEducationGuideClicks = Math.max(monthly[i].taxEducationGuideClicks, monthlyFallback[i].taxEducationGuideClicks || 0);
}
monthly[i].enrollPortalClicks = Math.max(monthly[i].enrollPortalClicks, monthlyFallback[i].enrollPortalClicks || 0);
monthly[i].eappVisits = Math.max(monthly[i].eappVisits, monthlyFallback[i].eappVisits || 0);
monthly[i].totalClicks =
  (monthly[i].websiteOpens || 0) +
  (monthly[i].parentGuideClicks || 0) +
  (monthly[i].supplementalHealthGuideClicks || 0) +
  (monthly[i].riskAwarenessGuideClicks || 0) +
  (monthly[i].taxEducationGuideClicks || 0) +
  (monthly[i].enrollPortalClicks || 0) +
  (monthly[i].eappVisits || 0);
}
for (let i = 0; i < 12; i++) {
monthly[i].opens = monthly[i].parentGuideClicks;
monthly[i].enrollClicks = monthly[i].enrollPortalClicks;
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
const bestMonth = monthly.reduce((a, b) => (b.totalClicks > a.totalClicks ? b : a),
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
const weekAgg = new Map(); // key -> { totalClicks }
for (const r of eventRows) {
const k = weekKey(r.created_at);
const cur = weekAgg.get(k) || { totalClicks: 0 };
const evt = normalizeMetricEventType(r.event_type) || String(r.event_type || "");
if (["parent_guide_click", "supplemental_health_guide_click", "risk_awareness_guide_click", "tax_education_guide_click", "enroll_click", "eapp_visit"].includes(evt)) cur.totalClicks++;
weekAgg.set(k, cur);
}
let bestWeek = null;
for (const [k, v] of weekAgg.entries()) {
if (!bestWeek || v.totalClicks > bestWeek.totalClicks) bestWeek = { label: k, ...v };
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
bestMonth: { label: bestMonth.label, totalClicks: bestMonth.totalClicks },
bestMonthEver: { label: bestMonthEver.label, totalClicks: bestMonthEver.totalClicks },
trend: {
totalClicks: trendOf("totalClicks"),
  websiteOpens: trendOf("websiteOpens"),
parentGuideClicks: trendOf("parentGuideClicks"),
supplementalHealthGuideClicks: trendOf("supplementalHealthGuideClicks"),
riskAwarenessGuideClicks: trendOf("riskAwarenessGuideClicks"),
taxEducationGuideClicks: trendOf("taxEducationGuideClicks"),
enrollPortalClicks: trendOf("enrollPortalClicks"),
eappVisits: trendOf("eappVisits"),
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

const coaches = data || [];
const coachIds = new Set(coaches.map((c) => String(c.coach_id || "").trim()).filter(Boolean));
const sinceYearIso = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();

const metricsByCoach = new Map();
for (const id of coachIds) {
  metricsByCoach.set(id, {
    guide_opens_year: 0,
    enroll_clicks_year: 0,
    eapp_visits_year: 0,
  });
}

try {
  const { data: regRows, error: regErr } = await ops()
    .from("click_link_registry")
    .select("coach_id, guide_key, person_key, created_at")
    .gte("created_at", sinceYearIso)
    .limit(50000);

  if (!regErr && Array.isArray(regRows) && regRows.length) {
    const uniq = new Set();
    for (const row of regRows) {
      const coachId = String(row?.coach_id || "").trim();
      if (!coachId || !coachIds.has(coachId)) continue;
      const guideKey = String(row?.guide_key || "").trim().toLowerCase();
      const personKey = String(row?.person_key || "").trim();
      if (!guideKey || !personKey) continue;
      const dedupe = `${coachId}|${guideKey}|${personKey}`;
      if (uniq.has(dedupe)) continue;
      uniq.add(dedupe);

      const m = metricsByCoach.get(coachId) || { guide_opens_year: 0, enroll_clicks_year: 0, eapp_visits_year: 0 };
      if (guideKey === "enroll") {
        m.enroll_clicks_year += 1;
      } else if (guideKey === "eapp") {
        m.eapp_visits_year += 1;
      } else {
        m.guide_opens_year += 1;
      }
      metricsByCoach.set(coachId, m);
    }
  } else {
    throw regErr || new Error("registry_unavailable");
  }
} catch (_) {
  // Fallback for older deployments: derive approximate unique counts from click_events.
  try {
    const { data: clickRows, error: clickErr } = await ops()
      .from("click_events")
      .select("coach_id, guide_key, click_type, kind, event_type, person_key, is_coach_self_click, created_at")
      .gte("created_at", sinceYearIso)
      .limit(50000);
    if (!clickErr && Array.isArray(clickRows)) {
      const uniq = new Set();
      for (const row of clickRows) {
        const coachId = String(row?.coach_id || "").trim();
        if (!coachId || !coachIds.has(coachId)) continue;
        if (row?.is_coach_self_click === true) continue;
        const guideKey = normalizeGuideKey(row?.guide_key || row?.click_type || row?.kind || row?.event_type);
        const personKey = String(row?.person_key || "").trim();
        if (!guideKey || !personKey) continue;
        const dedupe = `${coachId}|${guideKey}|${personKey}`;
        if (uniq.has(dedupe)) continue;
        uniq.add(dedupe);

        const m = metricsByCoach.get(coachId) || { guide_opens_year: 0, enroll_clicks_year: 0, eapp_visits_year: 0 };
        if (guideKey === "enroll") {
          m.enroll_clicks_year += 1;
        } else if (guideKey === "eapp") {
          m.eapp_visits_year += 1;
        } else {
          m.guide_opens_year += 1;
        }
        metricsByCoach.set(coachId, m);
      }
    }
  } catch (_) {}
}

// Map to expected format with derived flags
const rows = coaches.map((coach) => {
const coachId = String(coach.coach_id || "").trim();
const metric = metricsByCoach.get(coachId) || {
  guide_opens_year: 0,
  enroll_clicks_year: 0,
  eapp_visits_year: 0,
};
return {
coach_id: coach.coach_id,
coach_full_name: coach.coach_name,
program_name: coach.program || coach.school || "Unknown",
needs_reply: false,
followup_due: false,
is_active: true,
waiting_minutes: 0,
followup_next_action_at: null,
last_activity_at: coach.updated_at,
guide_opens_year: Number(metric.guide_opens_year || 0),
enroll_clicks_year: Number(metric.enroll_clicks_year || 0),
eapp_visits_year: Number(metric.eapp_visits_year || 0),
};
});

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

async function sbCountRowsSafe(relation, queryMutator = null) {
try {
let q = ops().from(relation).select("*", { count: "exact", head: true });
if (typeof queryMutator === "function") q = queryMutator(q);
const { count, error } = await q;
if (error) return null;
return Number(count) || 0;
} catch (_) {
return null;
}
}

async function sbOpsDeliverySummary() {
const [
emailTotal,
emailPending,
emailFailed,
smsTotal,
smsPending,
smsFailed,
processedEvents,
deadLetterEvents,
deadLetters,
supportTicketsOpen,
] = await Promise.all([
sbCountRowsSafe("email_outbox"),
sbCountRowsSafe("email_outbox", (q) => q.in("status", ["pending", "queued", "retrying"])),
sbCountRowsSafe("email_outbox", (q) => q.in("status", ["failed", "dead_letter", "error"])),
sbCountRowsSafe("sms_outbox"),
sbCountRowsSafe("sms_outbox", (q) => q.in("status", ["pending", "queued", "retrying"])),
sbCountRowsSafe("sms_outbox", (q) => q.in("status", ["failed", "dead_letter", "error"])),
sbCountRowsSafe("processed_events"),
sbCountRowsSafe("dead_letter_events"),
sbCountRowsSafe("dead_letters"),
sbCountRowsSafe("support_tickets", (q) => q.in("status", ["open", "new", "pending"])),
]);

return {
emailTotal,
emailPending,
emailFailed,
smsTotal,
smsPending,
smsFailed,
processedEvents,
deadLetterEvents,
deadLetters,
supportTicketsOpen,
};
}

function ageMinutesSince(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

function newestIsoTimestamp(values = []) {
  let bestMs = null;
  let bestIso = null;
  for (const raw of values || []) {
    if (!raw) continue;
    const iso = typeof raw === "string" ? raw : String(raw || "");
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) continue;
    if (bestMs == null || ms > bestMs) {
      bestMs = ms;
      bestIso = new Date(ms).toISOString();
    }
  }
  return bestIso;
}

function wfStatusFromLatest(latestAt, staleThresholdMinutes) {
  const ageMinutes = ageMinutesSince(latestAt);
  if (ageMinutes == null) {
    return { status: "ok", ageMinutes: null, noData: true };
  }
  const latestMs = new Date(latestAt).getTime();
  if (Number.isFinite(latestMs) && latestMs < APP_BOOT_TS_MS) {
    return { status: "ok", ageMinutes: null, noData: true };
  }
  return {
    status: ageMinutes > staleThresholdMinutes ? "warn" : "ok",
    ageMinutes,
    noData: false,
  };
}

async function sbLatestTimestampFromRelation(relation, columnCandidates) {
  for (const col of columnCandidates) {
    try {
      const { data, error } = await ops()
        .from(relation)
        .select(col)
        .order(col, { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) continue;
      const val = data?.[col];
      if (val) return val;
    } catch (_) {
      // Try the next column fallback.
    }
  }
  return null;
}

async function sbWatchdogFreshnessChecks() {
  const targets = [
    { name: "ops_events", relation: "ops_events", columns: ["created_at"] },
    { name: "conversations", relation: "conversations", columns: ["updated_at", "created_at"] },
    { name: "metric_events", relation: "metric_events", columns: ["created_at"] },
    { name: "click_events", relation: "click_events", columns: ["created_at"] },
    { name: "email_outbox", relation: "email_outbox", columns: ["updated_at", "created_at", "sent_at"] },
    { name: "sms_outbox", relation: "sms_outbox", columns: ["updated_at", "created_at", "sent_at"] },
    { name: "processed_events", relation: "processed_events", columns: ["created_at"] },
    { name: "dead_letter_events", relation: "dead_letter_events", columns: ["created_at"] },
    { name: "support_tickets", relation: "support_tickets", columns: ["updated_at", "created_at"] },
  ];

  const checks = [];
  for (const t of targets) {
    const latestAt = await sbLatestTimestampFromRelation(t.relation, t.columns);
    const ageMinutes = ageMinutesSince(latestAt);
    const status = ageMinutes == null
      ? "ok"
      : ageMinutes > WATCHDOG_STALE_MINUTES
        ? "stale"
        : "ok";
    checks.push({
      name: t.name,
      relation: t.relation,
      latestAt: latestAt || null,
      ageMinutes,
      status,
    });
  }

  const hasStale = checks.some((c) => c.status === "stale");
  return {
    overall: hasStale ? "warn" : "ok",
    staleThresholdMinutes: WATCHDOG_STALE_MINUTES,
    checks,
  };
}

async function sbWatchdogReconciliationChecks() {
  const checks = [];
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Reconcile click_events against first available aggregate relation.
  try {
    const { count, error } = await ops()
      .from("click_events")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    const eventClicks = error ? null : Number(count || 0);

    let aggregateClicks = null;
    let aggregateRelation = null;
    for (const relation of ["v_click_monthly_summary", "v_click_daily_summary", "click_analytics_daily", "v_click_summary_today"]) {
      try {
        const { data, error: relErr } = await ops().from(relation).select("*");
        if (relErr || !Array.isArray(data) || !data.length) continue;
        const total = data.reduce((acc, row) => {
          const n = Number(
            row?.enroll_clicks ??
            row?.total_clicks ??
            row?.clicks ??
            row?.count ??
            row?.total ??
            0
          );
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0);
        if (total > 0) {
          aggregateClicks = total;
          aggregateRelation = relation;
          break;
        }
      } catch (_) {
        // Try next aggregate relation.
      }
    }

    if (eventClicks != null && aggregateClicks != null) {
      const baseline = Math.max(eventClicks, aggregateClicks, 1);
      const driftPct = Math.round((Math.abs(eventClicks - aggregateClicks) / baseline) * 100);
      checks.push({
        name: "click_events_vs_aggregate",
        status: driftPct > 30 ? "warn" : "ok",
        driftPct,
        eventClicks,
        aggregateClicks,
        aggregateRelation,
      });
    } else {
      checks.push({
        name: "click_events_vs_aggregate",
        status: "ok",
        note: "insufficient_data",
      });
    }
  } catch (err) {
    checks.push({
      name: "click_events_vs_aggregate",
      status: "degraded",
      note: err?.message || String(err),
    });
  }

  // Reconcile processed events and dead-letter events ratio.
  try {
    const [processed, dead] = await Promise.all([
      sbCountRowsSafe("processed_events"),
      sbCountRowsSafe("dead_letter_events"),
    ]);
    if (processed != null && dead != null) {
      const failureRatePct = processed + dead > 0
        ? Math.round((dead / Math.max(processed + dead, 1)) * 100)
        : 0;
      checks.push({
        name: "processed_vs_dead_letter",
        status: failureRatePct > 20 ? "warn" : "ok",
        failureRatePct,
        processed,
        dead,
      });
    } else {
      checks.push({
        name: "processed_vs_dead_letter",
        status: "ok",
        note: "insufficient_data",
      });
    }
  } catch (err) {
    checks.push({
      name: "processed_vs_dead_letter",
      status: "degraded",
      note: err?.message || String(err),
    });
  }

  // Reconcile forwarded registry quality against click event candidates.
  try {
    const { data: forwardedClicks, error: fErr } = await ops()
      .from("click_events")
      .select("id, actor_type, is_coach_self_click, guide_key, click_type, kind, event_type")
      .gte("created_at", since)
      .limit(20000);

    const { count: registryUniqueCount, error: rErr } = await ops()
      .from("click_link_registry")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);

    if (!fErr && !rErr) {
      let candidateCount = 0;
      let botLikeCount = 0;
      for (const row of forwardedClicks || []) {
        if (isLikelyCoachSelfClick(row)) continue;
        const actorType = String(row?.actor_type || "").trim().toLowerCase();
        if (isBotLikeActorType(actorType)) {
          botLikeCount += 1;
          continue;
        }
        if (!isForwardedGuideSignal(row?.guide_key || row?.click_type || row?.kind || row?.event_type)) continue;
        candidateCount += 1;
      }

      const uniqueCount = Number(registryUniqueCount || 0);
      let status = "ok";
      let note = null;
      if (candidateCount >= 10 && uniqueCount === 0) {
        status = "warn";
        note = "registry_not_populating";
      } else if (uniqueCount > candidateCount + 5) {
        status = "warn";
        note = "registry_exceeds_candidates";
      } else if (candidateCount > 0) {
        const botShare = botLikeCount / Math.max(candidateCount + botLikeCount, 1);
        if (botShare > 0.4) {
          status = "warn";
          note = "high_bot_share";
        }
      }

      checks.push({
        name: "forwarded_registry_quality",
        status,
        candidateCount,
        registryUniqueCount: uniqueCount,
        botLikeCount,
        note,
      });
    } else {
      checks.push({
        name: "forwarded_registry_quality",
        status: "ok",
        note: fErr?.message || rErr?.message || "insufficient_data",
      });
    }
  } catch (err) {
    checks.push({
      name: "forwarded_registry_quality",
      status: "degraded",
      note: err?.message || String(err),
    });
  }

  const hasWarn = checks.some((c) => c.status === "warn");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  return {
    overall: hasWarn ? "warn" : hasDegraded ? "degraded" : "ok",
    checks,
  };
}

async function sbWatchdogCardChecks() {
  const oldestQueuedAgeMinutes = async () => {
    const oldestN8n = await dbSelectFirst([
      () => ops()
        .from("n8n_outbox")
        .select("created_at")
        .in("status", ["queued", "sending"])
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      () => ops()
        .from("n8n_outbox")
        .select("created_at")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const oldestEmail = await dbSelectFirst([
      () => ops()
        .from("email_outbox")
        .select("created_at")
        .in("status", ["pending", "queued", "retrying"])
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      () => ops()
        .from("email_outbox")
        .select("created_at")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const oldestSms = await dbSelectFirst([
      () => ops()
        .from("sms_outbox")
        .select("created_at")
        .in("status", ["pending", "queued", "retrying"])
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      () => ops()
        .from("sms_outbox")
        .select("created_at")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const candidates = [
      oldestN8n?.data?.created_at || null,
      oldestEmail?.data?.created_at || null,
      oldestSms?.data?.created_at || null,
    ].filter(Boolean);

    if (!candidates.length) return null;
    let oldestMs = null;
    for (const ts of candidates) {
      const ms = new Date(ts).getTime();
      if (!Number.isFinite(ms)) continue;
      if (oldestMs == null || ms < oldestMs) oldestMs = ms;
    }
    if (oldestMs == null) return null;
    return Math.floor((Date.now() - oldestMs) / 60000);
  };

  const checks = [];
  const runCheck = async (name, countFn, listFn = null) => {
    try {
      const count = await countFn();
      const list = listFn ? await listFn() : null;
      let status = "ok";
      let note = null;
      if (count == null || !Number.isFinite(Number(count))) {
        status = "degraded";
        note = "count_unavailable";
      } else if (listFn && Number(count) > 0 && Array.isArray(list) && list.length === 0) {
        status = "warn";
        note = "count_list_mismatch";
      }
      checks.push({
        name,
        status,
        count: Number.isFinite(Number(count)) ? Number(count) : null,
        sampleSize: Array.isArray(list) ? list.length : null,
        note,
      });
    } catch (err) {
      checks.push({
        name,
        status: "warn",
        note: err?.message || String(err),
      });
    }
  };

  await runCheck("urgent", () => sbCountUrgentCombined({ source: "all", role: "all" }), () => sbListUrgentCombined({ source: "all", role: "all", limit: 8 }));
  await runCheck("needs_reply", () => sbCountNeedsReplyNonUrgent({ source: "all", role: "all" }), () => sbListConversations({ pipeline: "needs_reply", source: "all", role: "all", limit: 8 }));
  await runCheck("actions_waiting", () => sbCountConversations({ pipeline: "actions_waiting", source: "all", role: "all" }), () => sbListConversations({ pipeline: "actions_waiting", source: "all", role: "all", limit: 8 }));
  await runCheck("active", () => sbCountConversations({ pipeline: "active", source: "all", role: "all" }), () => sbListConversations({ pipeline: "active", source: "all", role: "all", limit: 8 }));
  await runCheck("forwarded", () => sbCountForwardedCombined({ source: "all" }), () => sbListForwardedCombined({ source: "all", limit: 8 }));
  await runCheck("followups", () => sbCountConversations({ pipeline: "followups", source: "all", role: "all" }), () => sbListConversations({ pipeline: "followups", source: "all", role: "all", limit: 8 }));
  await runCheck("completed", () => sbCountConversations({ pipeline: "completed", source: "all", role: "all" }), () => sbListConversations({ pipeline: "completed", source: "all", role: "all", limit: 8 }));
  await runCheck("submissions", () => sbCountSubmissions());
  await runCheck("calls", () => sbCountCalls());
  await runCheck("handoff", () => sbCountHandoffPending({ source: "all" }), () => sbListHandoffPending({ source: "all", limit: 8 }));

  try {
    const ageMinutes = await oldestQueuedAgeMinutes();
    const thresholdMinutes = URGENT_AFTER_MINUTES;
    let status = "ok";
    let note = null;
    if (!Number.isFinite(Number(ageMinutes))) {
      status = "degraded";
      note = "oldest_queue_age_unavailable";
    } else if (Number(ageMinutes) > thresholdMinutes) {
      status = "warn";
      note = "oldest_queue_age_over_threshold";
    }
    checks.push({
      name: "oldest_queue_age",
      status,
      ageMinutes: Number.isFinite(Number(ageMinutes)) ? Number(ageMinutes) : null,
      thresholdMinutes,
      note,
    });
  } catch (err) {
    checks.push({
      name: "oldest_queue_age",
      status: "degraded",
      note: err?.message || "oldest_queue_age_unavailable",
    });
  }

  const hasWarn = checks.some((c) => c.status === "warn");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  return {
    overall: hasWarn ? "warn" : hasDegraded ? "degraded" : "ok",
    checks,
  };
}

async function sbLatestConversationTimestampBySource(source) {
  if (!source) return null;
  const result = await dbSelectFirst([
    () => ops()
      .from("conversations")
      .select("updated_at")
      .eq("source", source)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    () => ops()
      .from("conversations")
      .select("created_at")
      .eq("source", source)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (result?.error) return null;
  return result?.data?.updated_at || result?.data?.created_at || null;
}

async function sbLatestNeedsSupportHandoffTimestamp() {
  const result = await dbSelectFirst([
    () => ops()
      .from("conversations")
      .select("needs_support_handoff_at")
      .eq("needs_support_handoff", true)
      .order("needs_support_handoff_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    () => ops()
      .from("conversations")
      .select("updated_at")
      .eq("needs_support_handoff", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (result?.error) return null;
  return result?.data?.needs_support_handoff_at || result?.data?.updated_at || null;
}

async function sbListRecentOpsEvents(limit = 1500) {
  try {
    const { data, error } = await ops()
      .from("ops_events")
      .select("event_type, source, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch (_) {
    return [];
  }
}

function latestOpsEventTimestamp(rows, matcher) {
  if (!Array.isArray(rows) || !rows.length || typeof matcher !== "function") return null;
  for (const row of rows) {
    if (!row?.created_at) continue;
    if (matcher(row)) return row.created_at;
  }
  return null;
}

// --- Live n8n API helpers ---
async function fetchN8nAPI(path, timeoutMs = 9000) {
  const url = `${N8N_BASE_URL}/api/v1${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "X-N8N-API-KEY": N8N_API_KEY, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Fetch all workflows + recent executions from live n8n, with graceful degradation.
async function fetchN8nLiveData() {
  try {
    const [wfResp, execResp] = await Promise.all([
      fetchN8nAPI("/workflows?limit=250"),
      fetchN8nAPI("/executions?limit=100&includeData=false"),
    ]);
    const workflows = wfResp?.data || wfResp?.workflows || [];
    const executions = execResp?.data || execResp?.results || [];
    const workflowDetailsEntries = await Promise.all(
      workflows.map(async (wf) => {
        try {
          const detail = await fetchN8nAPI(`/workflows/${wf.id}`);
          return [String(wf.id), detail];
        } catch (_) {
          return [String(wf.id), null];
        }
      })
    );
    const workflowDetails = Object.fromEntries(workflowDetailsEntries);
    return { workflows, executions, workflowDetails, error: null };
  } catch (err) {
    return { workflows: [], executions: [], workflowDetails: {}, error: shortErrorReason(err) };
  }
}

// Match a set of keyword patterns against an n8n workflow name (any match = hit).
function n8nWorkflowMatch(wfName, keywords) {
  const n = wfName.toLowerCase();
  return keywords.some((k) => n.includes(k));
}

// For a WF definition, find all matching live workflows and derive health.
function deriveWfHealthFromLive(wfDef, liveWorkflows, executions, workflowDetails = {}) {
  const matched = liveWorkflows.filter((w) => n8nWorkflowMatch(String(w.name || ""), wfDef.keywords));
  if (matched.length === 0) {
    return { status: "unknown", detail: "no matching workflow found in n8n", noData: true, issues: [] };
  }

  // Consider the WF healthy if at least one matched workflow is active.
  const activeMatches = matched.filter((w) => w.active === true);
  if (activeMatches.length === 0) {
    const inactive = matched.filter((w) => !w.active).map((w) => w.name).join(", ");
    return { status: "degraded", detail: `no active workflow (inactive: ${inactive})`, noData: false, issues: [] };
  }

  if (activeMatches.length > 1) {
    const activeNames = activeMatches.map((w) => w.name).join(", ");
    return {
      status: "degraded",
      detail: `multiple active workflows (${activeMatches.length}): ${activeNames}`,
      noData: false,
      issues: [],
    };
  }

  const activeWorkflow = activeMatches[0];
  const staticIssues = auditWorkflowDefinition(workflowDetails[String(activeWorkflow.id)] || activeWorkflow);
  const issueSummaries = summarizeWorkflowAuditIssues(staticIssues, 2);

  // Check last execution status across active matched workflows only.
  const matchedIds = new Set(activeMatches.map((w) => w.id));
  const relevantExecs = executions.filter((e) => matchedIds.has(e.workflowId));
  const latestExec = relevantExecs[0] || null; // already ordered desc by n8n API
  if (latestExec) {
    const finished = latestExec.stoppedAt || latestExec.finishedAt || latestExec.startedAt || null;
    if (latestExec.status === "error" || latestExec.status === "crashed") {
      const ageMin = finished ? Math.round((Date.now() - new Date(finished).getTime()) / 60000) : null;
      return {
        status: "warn",
        detail: `last exec ${latestExec.status}${ageMin != null ? ` (${ageMin}m ago)` : ""}${issueSummaries.length ? `; config: ${issueSummaries.join(" | ")}` : ""}`,
        noData: false,
        lastExecAt: finished,
        lastExecStatus: latestExec.status,
        issues: staticIssues,
      };
    }
    const ageMin = finished ? Math.round((Date.now() - new Date(finished).getTime()) / 60000) : null;
    const ignoredInactive = Math.max(0, matched.length - activeMatches.length);
    const status = staticIssues.length ? "degraded" : "ok";
    return {
      status,
      detail: `active (${activeMatches.length}), last exec ${latestExec.status}${ageMin != null ? ` (${ageMin}m ago)` : ""}${ignoredInactive ? `, ignored ${ignoredInactive} inactive` : ""}${issueSummaries.length ? `; config: ${issueSummaries.join(" | ")}` : ""}`,
      noData: false,
      lastExecAt: finished,
      lastExecStatus: latestExec.status,
      issues: staticIssues,
    };
  }

  const ignoredInactive = Math.max(0, matched.length - activeMatches.length);
  return {
    status: staticIssues.length ? "degraded" : "ok",
    detail: `active (${activeMatches.length}), no recent executions${ignoredInactive ? `, ignored ${ignoredInactive} inactive` : ""}${issueSummaries.length ? `; config: ${issueSummaries.join(" | ")}` : ""}`,
    noData: false,
    issues: staticIssues,
  };
}

async function sbWatchdogWorkflowChecks() {
  const { workflows: liveWorkflows, executions, workflowDetails, error: apiError } = await fetchN8nLiveData();

  // WF01–WF09 definitions with keyword sets matching real n8n workflow names
  const wfDefs = [
    { id: "WF01", name: "Form + Calendly Intake",    keywords: ["instant submission", "intake", "form", "calendly"] },
    { id: "WF02", name: "Gmail Support Watch",        keywords: ["support handler", "gmail support", "support watch", "gmail"] },
    { id: "WF03", name: "Send Executor + CC Support", keywords: ["cc support", "send executor"] },
    { id: "WF04", name: "Lead Pipeline",              keywords: ["lead generation", "lead pipeline", "lead gen"] },
    { id: "WF05", name: "Ops + Maintenance",          keywords: ["dead letter replayer", "mirror reconciler", "role conflict", "dead letter", "maintenance"] },
    { id: "WF06", name: "Analytics Ingest",           keywords: ["analytics sync", "analytics ingest", "analytics"] },
    { id: "WF07", name: "Event Intelligence",         keywords: ["conversation identity", "identity linker", "event intel"] },
    { id: "WF08", name: "Outbox Dispatcher",          keywords: ["outbox", "send emails", "outbox dispatcher"] },
    { id: "WF09", name: "Ops Ingest Sender",          keywords: ["sla escalator", "ops ingest", "instantly campaign"] },
  ];

  const checks = wfDefs.map((wfDef) => {
    if (apiError) {
      return {
        id: wfDef.id,
        name: wfDef.name,
        status: "degraded",
        detail: `n8n API unreachable: ${apiError}`,
        noData: true,
      };
    }
    const health = deriveWfHealthFromLive(wfDef, liveWorkflows, executions, workflowDetails);
    return {
      id: wfDef.id,
      name: wfDef.name,
      status: health.status,
      detail: health.detail,
      noData: health.noData === true,
      lastExecAt: health.lastExecAt || null,
      lastExecStatus: health.lastExecStatus || null,
      issues: Array.isArray(health.issues) ? health.issues : [],
    };
  });

  const hasWarn = checks.some((c) => c.status === "warn");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  return {
    overall: hasWarn ? "warn" : hasDegraded ? "degraded" : "ok",
    checks,
    apiError: apiError || null,
  };
}

async function sbWatchdogOperationsRiskChecks() {
  const checks = [];
  const windowIso = new Date(Date.now() - OPS_RISK_BURST_WINDOW_MINUTES * 60 * 1000).toISOString();

  const endpointChecks = [
    { key: "make_send_webhook", configured: !!MAKE_SEND_WEBHOOK_URL },
    { key: "cc_support_webhook", configured: !!CC_SUPPORT_WEBHOOK_URL },
    { key: "handoff_webhook", configured: !!HANDOFF_WEBHOOK_URL },
  ];
  const missingEndpoints = endpointChecks.filter((c) => !c.configured).map((c) => c.key);
  checks.push({
    name: "endpoint_config",
    status: missingEndpoints.length ? "degraded" : "ok",
    summary: missingEndpoints.length
      ? `missing endpoint config: ${missingEndpoints.join(", ")}`
      : "all required endpoint configs are set",
  });

  try {
    // Live n8n API connectivity check — actual round-trip to n8n cloud
    const start = Date.now();
    await fetchN8nAPI("/workflows?limit=1", 8000);
    const latencyMs = Date.now() - start;
    checks.push({
      name: "n8n_heartbeat",
      status: "ok",
      summary: `n8n API reachable (${latencyMs}ms)`,
      latencyMs,
    });
  } catch (err) {
    checks.push({
      name: "n8n_heartbeat",
      status: "warn",
      summary: `n8n API unreachable: ${shortErrorReason(err)}`,
    });
  }

  try {
    const [deadLetterEvents, deadLetters, emailFailed, smsFailed] = await Promise.all([
      sbCountRowsSafe("dead_letter_events", (q) => q.gte("created_at", windowIso)),
      sbCountRowsSafe("dead_letters", (q) => q.gte("received_at", windowIso)),
      sbCountRowsSafe("email_outbox", (q) => q.in("status", ["failed", "dead_letter", "error"]).gte("updated_at", windowIso)),
      sbCountRowsSafe("sms_outbox", (q) => q.in("status", ["failed", "dead_letter", "error"]).gte("updated_at", windowIso)),
    ]);
    const total = Number(deadLetterEvents || 0) + Number(deadLetters || 0) + Number(emailFailed || 0) + Number(smsFailed || 0);
    checks.push({
      name: "error_burst",
      status: total > OPS_RISK_ERROR_BURST_THRESHOLD ? "warn" : "ok",
      summary:
        total > OPS_RISK_ERROR_BURST_THRESHOLD
          ? `${total} errors in last ${OPS_RISK_BURST_WINDOW_MINUTES}m (limit ${OPS_RISK_ERROR_BURST_THRESHOLD})`
          : `${total} errors in last ${OPS_RISK_BURST_WINDOW_MINUTES}m`,
      total,
    });
  } catch (err) {
    checks.push({
      name: "error_burst",
      status: "degraded",
      summary: `unable to read error burst: ${shortErrorReason(err)}`,
    });
  }

  try {
    const { data, error } = await ops()
      .from("dead_letters")
      .select("error, received_at")
      .gte("received_at", windowIso)
      .order("received_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const authErrCount = (data || []).filter((r) => {
      const msg = String(r?.error || "").toLowerCase();
      return msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("auth") || msg.includes("token") || msg.includes("signature");
    }).length;

    checks.push({
      name: "auth_signature_errors",
      status: authErrCount > 0 ? "warn" : "ok",
      summary: authErrCount > 0
        ? `${authErrCount} auth/signature errors in last ${OPS_RISK_BURST_WINDOW_MINUTES}m`
        : "no auth/signature errors detected",
      authErrCount,
    });
  } catch (err) {
    checks.push({
      name: "auth_signature_errors",
      status: "degraded",
      summary: `unable to read auth/signature errors: ${shortErrorReason(err)}`,
    });
  }

  try {
    if (!CLICK_TRACKER_BASE_URL) {
      checks.push({
        name: "cloudflare_click_tracker",
        status: "degraded",
        summary: "CLICK_TRACKER_BASE_URL missing",
      });
    } else {
      const url = `${CLICK_TRACKER_BASE_URL.replace(/\/+$/g, "")}/parent-guide`;
      const resp = await fetch(url, { method: "GET", redirect: "manual" });
      const location = String(resp.headers.get("location") || "");
      const ok = resp.status >= 300 && resp.status < 400 && !!location;
      checks.push({
        name: "cloudflare_click_tracker",
        status: ok ? "ok" : "warn",
        summary: ok ? `click tracker reachable (${resp.status})` : `click tracker unhealthy (${resp.status})`,
        location: location || null,
      });
    }
  } catch (err) {
    checks.push({
      name: "cloudflare_click_tracker",
      status: "warn",
      summary: `click tracker unreachable: ${shortErrorReason(err)}`,
    });
  }

  try {
    const workerSoftErrors = await sbCountRowsSafe("click_events", (q) => q.eq("kind", "cloudflare_worker_soft_error").gte("created_at", windowIso));
    checks.push({
      name: "cloudflare_worker_soft_errors",
      status: Number(workerSoftErrors || 0) > 0 ? "warn" : "ok",
      summary: Number(workerSoftErrors || 0) > 0
        ? `${Number(workerSoftErrors || 0)} cloudflare worker soft errors in last ${OPS_RISK_BURST_WINDOW_MINUTES}m`
        : "no cloudflare worker soft errors detected",
      total: Number(workerSoftErrors || 0),
    });
  } catch (err) {
    checks.push({
      name: "cloudflare_worker_soft_errors",
      status: "degraded",
      summary: `unable to read cloudflare worker soft errors: ${shortErrorReason(err)}`,
    });
  }

  const hasWarn = checks.some((c) => c.status === "warn");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  return {
    overall: hasWarn ? "warn" : hasDegraded ? "degraded" : "ok",
    checks,
  };
}

async function sbWatchdogSchemaContract(force = false) {
  const nowMs = Date.now();
  if (!force && lastSchemaCheckAt && nowMs - lastSchemaCheckAt < WATCHDOG_SCHEMA_CHECK_INTERVAL_MS) {
    return watchdogSnapshot.schema;
  }

  const missing = [];
  const covered = [];
  for (const relation of EXPECTED_NIL_RELATIONS) {
    try {
      const { error } = await ops().from(relation).select("*").limit(1);
      if (error) {
        missing.push(relation);
      } else {
        covered.push(relation);
      }
    } catch (_) {
      missing.push(relation);
    }
  }

  lastSchemaCheckAt = nowMs;
  return {
    overall: missing.length ? "warn" : "ok",
    checkedAt: new Date(nowMs).toISOString(),
    expectedCount: EXPECTED_NIL_RELATIONS.length,
    coveredCount: covered.length,
    missing,
  };
}

function buildWatchdogAlertText(snapshot, previousStatus) {
  const freshness = snapshot?.freshness || {};
  const reconciliation = snapshot?.reconciliation || {};
  const cards = snapshot?.cards || {};
  const workflows = snapshot?.workflows || {};
  const operationsRisk = snapshot?.operationsRisk || {};
  const schema = snapshot?.schema || {};
  const staleCount = (freshness.checks || []).filter((c) => c.status === "stale").length;
  const recWarnCount = (reconciliation.checks || []).filter((c) => c.status === "warn").length;
  const cardWarnCount = (cards.checks || []).filter((c) => c.status === "warn" || c.status === "degraded").length;
  const wfWarnCount = (workflows.checks || []).filter((c) => c.status === "warn").length;
  const wfUnknownCount = (workflows.checks || []).filter((c) => c.status === "unknown").length;
  const opsWarnCount = (operationsRisk.checks || []).filter((c) => c.status === "warn").length;
  const opsIssueCount = (operationsRisk.checks || []).filter((c) => c.status !== "ok").length;
  const schemaMissing = (schema.missing || []).length;
  const prevLabel = watchdogStatusLabel(previousStatus);
  const nextLabel = watchdogStatusLabel(snapshot.overallStatus);
  const trend = previousStatus && previousStatus !== "unknown" ? `${prevLabel} -> ${nextLabel}` : nextLabel;
  return `🛡 Watchdog Alert\n` +
    `Status: ${trend}\n` +
    `Freshness: ${watchdogStatusLabel(freshness.overall)} (stale: ${staleCount})\n` +
    `Reconciliation: ${watchdogStatusLabel(reconciliation.overall)} (warn: ${recWarnCount})\n` +
    `Cards & Dashboard: ${watchdogStatusLabel(cards.overall)} (warn: ${cardWarnCount})\n` +
    `Workflows WF01-WF09: ${watchdogStatusLabel(workflows.overall)} (warn: ${wfWarnCount}, unknown: ${wfUnknownCount})\n` +
    `Operations Risk: ${watchdogStatusLabel(operationsRisk.overall)} (warn: ${opsWarnCount}, issues: ${opsIssueCount})\n` +
    `Schema: ${watchdogStatusLabel(schema.overall)} (missing: ${schemaMissing})\n` +
    `Checked: ${snapshot.lastRunAt || new Date().toISOString()}`;
}

function isWithinNyBusinessHours(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return isWeekday && hour >= WATCHDOG_ALERT_BUSINESS_START_HOUR && hour < WATCHDOG_ALERT_BUSINESS_END_HOUR;
}

async function sendWatchdogAdminAlert(snapshot, previousStatus) {
  if (!WATCHDOG_NOTIFY_ADMINS || !TELEGRAM_BOT_ACTIVE || !ADMIN_IDS.length) return;
  if (!isWithinNyBusinessHours()) return;
  const now = Date.now();
  const cooldownMs = WATCHDOG_ALERT_COOLDOWN_MINUTES * 60 * 1000;
  const severe = snapshot.overallStatus === "warn" || snapshot.overallStatus === "degraded";
  const changed = previousStatus !== snapshot.overallStatus;
  const recovered = snapshot.overallStatus === "ok" && (previousStatus === "warn" || previousStatus === "degraded");
  const cooldownElapsed = !lastWatchdogAlertAt || (now - lastWatchdogAlertAt) >= cooldownMs;

  if (WATCHDOG_ALERT_ONLY_WARN && snapshot.overallStatus !== "warn") return;

  // Alert on status transitions, on recovery, and periodic reminders while degraded.
  if (!(changed || recovered || (severe && cooldownElapsed))) return;

  const text = buildWatchdogAlertText(snapshot, previousStatus);
  for (const adminId of ADMIN_IDS) {
    await bot.telegram.sendMessage(String(adminId), text).catch(() => null);
  }
  lastWatchdogAlertAt = now;
  lastWatchdogAlertStatus = snapshot.overallStatus;
}

async function runDataWatchdog({ forceSchema = false, notifyAdmins = false } = {}) {
  const previousStatus = watchdogSnapshot?.overallStatus || "unknown";
  try {
    const [freshness, reconciliation, cards, workflows, operationsRisk, schema] = await Promise.all([
      sbWatchdogFreshnessChecks(),
      sbWatchdogReconciliationChecks(),
      sbWatchdogCardChecks(),
      sbWatchdogWorkflowChecks(),
      sbWatchdogOperationsRiskChecks(),
      sbWatchdogSchemaContract(forceSchema),
    ]);

    const statuses = [freshness?.overall, reconciliation?.overall, cards?.overall, workflows?.overall, operationsRisk?.overall, schema?.overall];
    const overallStatus = statuses.includes("warn")
      ? "warn"
      : statuses.includes("degraded")
        ? "degraded"
        : "ok";

    watchdogSnapshot = {
      lastRunAt: new Date().toISOString(),
      overallStatus,
      freshness,
      reconciliation,
      cards,
      workflows,
      operationsRisk,
      schema,
    };
    if (notifyAdmins) {
      await sendWatchdogAdminAlert(watchdogSnapshot, previousStatus);
    } else {
      lastWatchdogAlertStatus = watchdogSnapshot.overallStatus;
    }
    return watchdogSnapshot;
  } catch (err) {
    watchdogSnapshot = {
      ...watchdogSnapshot,
      lastRunAt: new Date().toISOString(),
      overallStatus: "warn",
      error: err?.message || String(err),
    };
    if (notifyAdmins) {
      await sendWatchdogAdminAlert(watchdogSnapshot, previousStatus);
    } else {
      lastWatchdogAlertStatus = watchdogSnapshot.overallStatus;
    }
    return watchdogSnapshot;
  }
}

async function sbLeadAnalyticsSnapshot() {
const toNumber = (v) => {
const n = Number(v);
return Number.isFinite(n) ? n : 0;
};
const metricValue = (row, keys) => {
for (const k of keys) {
if (row?.[k] != null) return toNumber(row[k]);
}
return 0;
};
const { dayStartISO, dayEndISO } = nyParts(new Date());
const isToday = (ts) => {
if (!ts) return false;
const t = new Date(ts).getTime();
if (!Number.isFinite(t)) return false;
return t >= new Date(dayStartISO).getTime() && t < new Date(dayEndISO).getTime();
};

let analytics = null;
try {
const { data, error } = await ops()
.from("v_analytics_summary")
.select("*")
.single();
if (!error && data) analytics = data;
} catch (_) {}

let topLeads = [];
try {
const { data, error } = await ops()
.from("v_top_leads")
.select("*")
.limit(10);
if (!error && Array.isArray(data)) topLeads = data;
} catch (_) {}
if (!topLeads.length) {
try {
const { data, error } = await ops()
.from("leads")
.select("full_name, organization, engagement_score")
.order("engagement_score", { ascending: false })
.limit(10);
if (!error && Array.isArray(data)) topLeads = data;
} catch (_) {}
}

const statuses = { ready: 0, outreach_started: 0, replied: 0, no_email: 0, bounced: 0 };
try {
const { data, error } = await ops()
.from("leads")
.select("status");
if (!error && Array.isArray(data)) {
for (const row of data) {
if (Object.prototype.hasOwnProperty.call(statuses, row.status)) statuses[row.status]++;
}
}
} catch (_) {}

let leadMetricRows = [];
try {
const { data, error } = await ops()
.from("lead_metrics")
.select("*")
.limit(5000);
if (!error && Array.isArray(data)) leadMetricRows = data;
} catch (_) {}

const metricTotals = leadMetricRows.reduce((acc, row) => {
const sent = metricValue(row, ["emails_sent", "total_emails_sent", "sent", "send_count"]);
const opens = metricValue(row, ["opens", "total_opens", "open_count"]);
const clicks = metricValue(row, ["clicks", "total_clicks", "click_count"]);
const replies = metricValue(row, ["replies", "total_replies", "reply_count"]);
acc.totalSent += sent;
acc.totalOpens += opens;
acc.totalClicks += clicks;
acc.totalReplies += replies;
if (isToday(row.created_at || row.metric_date || row.date || row.day)) {
acc.todaySent += sent;
acc.todayOpens += opens;
acc.todayClicks += clicks;
acc.todayReplies += replies;
}
return acc;
}, { totalSent: 0, totalOpens: 0, totalClicks: 0, totalReplies: 0, todaySent: 0, todayOpens: 0, todayClicks: 0, todayReplies: 0 });

const leadSourcesCount = await sbCountRowsSafe("lead_sources");
const totalLeads = Number(analytics?.total_leads) || Object.values(statuses).reduce((a, b) => a + b, 0);
const leadsToday = Number(analytics?.leads_today) || 0;
const totalEmailsSent = Number(analytics?.total_emails_sent) || metricTotals.totalSent;
const totalOpens = Number(analytics?.total_opens) || metricTotals.totalOpens;
const totalClicks = Number(analytics?.total_clicks) || metricTotals.totalClicks;
const totalReplies = Number(analytics?.total_replies) || metricTotals.totalReplies;
const emailsSentToday = Number(analytics?.emails_sent_today) || metricTotals.todaySent;
const opensToday = Number(analytics?.opens_today) || metricTotals.todayOpens;
const clicksToday = Number(analytics?.clicks_today) || metricTotals.todayClicks;
const repliesToday = Number(analytics?.replies_today) || metricTotals.todayReplies;

const openRatePct = Number(analytics?.open_rate_pct) || (totalEmailsSent ? Math.round((totalOpens / totalEmailsSent) * 100) : 0);
const clickRatePct = Number(analytics?.click_rate_pct) || (totalEmailsSent ? Math.round((totalClicks / totalEmailsSent) * 100) : 0);
const replyRatePct = Number(analytics?.reply_rate_pct) || (totalEmailsSent ? Math.round((totalReplies / totalEmailsSent) * 100) : 0);

return {
statuses,
topLeads,
leadSourcesCount,
analytics: {
total_leads: totalLeads,
leads_today: leadsToday,
total_emails_sent: totalEmailsSent,
total_opens: totalOpens,
total_clicks: totalClicks,
total_replies: totalReplies,
emails_sent_today: emailsSentToday,
opens_today: opensToday,
clicks_today: clicksToday,
replies_today: repliesToday,
open_rate_pct: openRatePct,
click_rate_pct: clickRatePct,
reply_rate_pct: replyRatePct,
},
};
}

async function smartRender(ctx, text, keyboard) {
const safeText = sanitizeDisplayText(text);
// stop Telegram spinner when this was a button click
try {
if (ctx.update?.callback_query?.id) {
fastAnswerCbQuery(ctx);
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
let msg = await withTimeout(
ctx.reply(safeText, keyboard),
8000,
"Send message timed out"
);
if (!msg?.message_id) {
  const chatId =
    ctx.chat?.id ??
    ctx.update?.callback_query?.message?.chat?.id ??
    ctx.from?.id;
  if (chatId != null) {
    msg = await withTimeout(
      bot.telegram.sendMessage(chatId, safeText, keyboard),
      8000,
      "Fallback send message timed out"
    ).catch((sendErr) => {
      logError("smartRender.fallbackSend", sendErr);
      return null;
    });
  }
}
if (!msg?.message_id) {
  throw new Error("smartRender_failed_to_send_message");
}
return { mode: "reply", message_id: msg?.message_id, chat_id: msg?.chat?.id };
} catch (err) {
console.log(`[ERROR] Failed to send message: ${err.message}`);
throw err;
}
}

// ---------- LEADS DISPLAY ----------
async function leadsText() {
  try {
    const snapshot = await sbLeadAnalyticsSnapshot();
    const analytics = snapshot.analytics || {};
    const topLeads = snapshot.topLeads || [];
    const statuses = snapshot.statuses || { ready: 0, outreach_started: 0, replied: 0, no_email: 0, bounced: 0 };
    const leadSourcesCount = snapshot.leadSourcesCount;
    
    let text = `🎯 NIL LEADS DASHBOARD
📊 Overview

• Total Leads: ${analytics?.total_leads || 0}
• New Today: ${analytics?.leads_today || 0}
• With Email: ${statuses.ready + statuses.outreach_started + statuses.replied}
• Lead Sources: ${leadSourcesCount == null ? "n/a" : leadSourcesCount}

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
    const snapshot = await sbLeadAnalyticsSnapshot();
    const analytics = snapshot.analytics || {};
    
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
const cacheKey = String(filterSource || "all");
const cached = dashboardTextCache.get(cacheKey);
if (cached && Date.now() - cached.ts < DASHBOARD_CACHE_TTL_MS) {
return cached.text;
}

const getCachedDashboardMetrics = async () => {
  const cachedMetrics = dashboardMetricsCache.get(cacheKey);
  if (cachedMetrics && Date.now() - cachedMetrics.ts < DASHBOARD_METRICS_CACHE_TTL_MS) {
    return cachedMetrics.data;
  }
  const data = await trackPerf(
    `dashboard.metrics.${filterSource}`,
    () => sbMetricSummary({ source: filterSource, window: "all" }).catch(() => ({}))
  );
  dashboardMetricsCache.set(cacheKey, { ts: Date.now(), data });
  return data;
};

const getCachedOpsDelivery = async () => {
  const cachedOps = dashboardOpsDeliveryCache.get(cacheKey);
  if (cachedOps && Date.now() - cachedOps.ts < DASHBOARD_OPS_CACHE_TTL_MS) {
    return cachedOps.data;
  }
  const data = await sbOpsDeliverySummary().catch(() => ({}));
  dashboardOpsDeliveryCache.set(cacheKey, { ts: Date.now(), data });
  return data;
};

const { dayKey, time } = nyParts(new Date());
const filterLabel =
filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" :
"🌐 All";

const needsReplyBreakdownPromise = sbNeedsReplyBreakdown({ source: filterSource });
const urgentCombinedPromise = sbCountUrgentCombined({ source: filterSource, role: "all" });
const forwardedCombinedPromise = sbCountForwardedCombined({ source: filterSource });
const metricSummaryPromise = getCachedDashboardMetrics();
const opsDeliveryPromise = getCachedOpsDelivery();
const [
handoffCount,
needsReplyBreakdown,
urgentCombinedCount,
waitingCount,
activeCount,
forwardedCount,
followCount,
completedCount,
submissionsCount,
callsCount,
lastIngestAt,
opsDelivery,
] = await trackPerf(`dashboard.counts.${filterSource}`, () => Promise.all([
sbCountHandoffPending({ source: filterSource }),
needsReplyBreakdownPromise,
urgentCombinedPromise,
sbCountConversations({ pipeline: "actions_waiting", source: filterSource }),
sbCountConversations({ pipeline: "active", source: filterSource }),
forwardedCombinedPromise,
sbCountConversations({ pipeline: "followups", source: filterSource }),
sbCountConversations({ pipeline: "completed", source: filterSource }),
sbCountSubmissions(),
sbCountCalls(),
// In speed mode skip expensive ingest timestamp call on every dashboard open.
DASHBOARD_SPEED_MODE ? Promise.resolve(null) : sbGetLastOpsEventTimestamp(),
opsDeliveryPromise,
]));

const urgentCount = Number(urgentCombinedCount || 0);
const needsReplyCount = needsReplyBreakdown?.nonUrgentCount || 0;
const threadsCount = DASHBOARD_SPEED_MODE
  ? urgentCount + needsReplyCount + waitingCount + activeCount + forwardedCount + followCount + completedCount
  : await sbCountConversations({ source: filterSource });

const counts = {
handoffCount,
urgentCount,
threadsCount,
needsReplyCount,
waitingCount,
activeCount,
forwardedCount,
followCount,
completedCount,
submissionsCount,
callsCount,
};
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
threadsCount: capQueueCount(counts.threadsCount, MAX_QUEUE_DISPLAY),
needsReplyCount: capQueueCount(counts.needsReplyCount, MAX_QUEUE_DISPLAY),
waitingCount: capQueueCount(counts.waitingCount, MAX_QUEUE_DISPLAY),
activeCount: capQueueCount(counts.activeCount, MAX_QUEUE_DISPLAY),
forwardedCount: capQueueCount(counts.forwardedCount, MAX_QUEUE_DISPLAY),
submissionsCount: capQueueCount(counts.submissionsCount, MAX_QUEUE_DISPLAY),
followCount: capQueueCount(counts.followCount, MAX_QUEUE_DISPLAY),
callsCount: capQueueCount(counts.callsCount, MAX_QUEUE_DISPLAY),
completedCount: capQueueCount(counts.completedCount, MAX_QUEUE_DISPLAY),
};
const m = await metricSummaryPromise;
const rendered = buildDashboardText({
codeVersion: CODE_VERSION,
buildVersion: BUILD_VERSION,
today: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" }).format(new Date()),
time,
filterLabel,
staleWarning,
capped,
metrics: m,
opsDelivery,
});
dashboardTextCache.set(cacheKey, { ts: Date.now(), text: rendered });
return rendered;
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
Markup.button.callback("🗂 Queues", "ALLQ:open"),
Markup.button.callback("⚡️ Triage", "TRIAGE:open"),
Markup.button.callback("🔎 Search", "SEARCH:help"),

],
// Row 3
[
Markup.button.callback("📊 Metrics", "METRICS:open"),
Markup.button.callback("📅 Today", "TODAY:open"),
Markup.button.callback("👥 Clients", "CLIENTS:open"),
],
[
Markup.button.callback("🩺 Health", "HEALTH:open"),
Markup.button.callback("↻ Refresh", "DASH:refresh"),
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
Markup.button.callback("🤖 Instantly Threads", "VIEW:active"),
Markup.button.callback("📌 Loop in Support", "HANDOFF:open"),
],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}

if (filterSource === "support") {
return Markup.inlineKeyboard([
[
Markup.button.callback("‼️ Urgent", "VIEW:urgent"),
Markup.button.callback("📝 Needs Reply", "VIEW:needs_reply"),
],
[
Markup.button.callback("⏳ Waiting", "VIEW:actions_waiting"),
Markup.button.callback("💬 Active", "VIEW:active"),
],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}

return Markup.inlineKeyboard([
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
async function showConversationList(ctx, viewKey, rows, filterSource, roleFilter = "all", pageMeta = null) {
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
const pageInfo = pageMeta
? `Page ${pageMeta.currentPage}/${pageMeta.totalPages} (${pageMeta.totalCount} total)`
: null;

// buttons - queue pagination + back navigation
const kb = [];
if (pageMeta && pageMeta.totalPages > 1) {
  const nav = [];
  if (pageMeta.currentPage > 1) {
    nav.push(Markup.button.callback("◀️ Prev", `VIEW:${viewKey}:${pageMeta.currentPage - 1}`));
  }
  if (pageMeta.currentPage < pageMeta.totalPages) {
    nav.push(Markup.button.callback("Next ▶️", `VIEW:${viewKey}:${pageMeta.currentPage + 1}`));
  }
  if (pageMeta.currentPage !== pageMeta.totalPages) {
    nav.push(Markup.button.callback("⏩ Last", `VIEW:${viewKey}:${pageMeta.totalPages}`));
  }
  if (nav.length) kb.push(nav);
}
kb.push([Markup.button.callback("⬅️ Back", "ALLQ:open")]);
const msg = await smartRender(ctx,
`${header}${overflowNote}${pageInfo ? `\n${pageInfo}` : ""}\n\n${body}`,
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
async function buildConversationCard(conv, options = {}) {
const [msgCount, latest, oldest, inboundCount] = await Promise.all([
sbCountMessages(conv.id).catch(() => 0),
sbListMessages(conv.id, { offset: 0, limit: 1 }).catch(() => []),
sbListMessagesOldest(conv.id, { offset: 0, limit: 1 }).catch(() => []),
sbCountMessagesByDirection(conv.id, "inbound").catch(() => 0),
]);
const latestMessage = Array.isArray(latest) && latest.length ? latest[0] : null;
const oldestMessage = Array.isArray(oldest) && oldest.length ? oldest[0] : null;
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
oldestMessage,
inboundCount,
instantlyThreadSummary,
urgentAfterMinutes: URGENT_AFTER_MINUTES,
displayMode: options?.displayMode,
senderProfiles: {
supportFromEmail: SUPPORT_FROM_EMAIL,
outreachFromEmail: OUTREACH_FROM_EMAIL,
},
});
const hasInstantlyCard = isInstantlySource(conv) && msgCount > 0;
return {
text,
msgCount,
isInstantlyInbound,
hasInstantlyCard,
currentView: isInstantlyInbound ? "instantly" : "conversation",
};
}
function conversationCardKeyboard(conv, msgCount = null, options = {}) {
const isInstantlyInbound = options?.isInstantlyInbound === true;
const currentView = options?.currentView || (isInstantlyInbound ? "instantly" : "conversation");
const hasInstantlyCard = options?.hasInstantlyCard === true || isInstantlyInbound;
const id = conv.id;
// Mirror button only if present
const mirrorRow = conv.mirror_conversation_id
? [Markup.button.callback("Open Mirror", `OPENMIRROR:${id}`)]
: [];
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
const cardSwitchRow = hasInstantlyCard
? [Markup.button.callback(
    currentView === "instantly" ? "↔ Conversation Card" : "↔ Instantly Card",
    `CARDVIEW:${id}:${currentView === "instantly" ? "conversation" : "instantly"}`
  )]
: [];
if (isInstantlyInbound) {
const rows = [
[Markup.button.callback("🧵 View Thread", `THREAD:${id}:0`)],
[...cardSwitchRow],
[Markup.button.callback("✏️ Drafts V1/V2/V3", `DRAFTS:open:${id}`)],
[Markup.button.callback("📌 Loop in Support", `CC:${id}`)],
[Markup.button.callback("👥 People", `PEOPLE:${id}`)],
];
const conflictAndMirror = [...roleConflictRow, ...mirrorRow];
if (conflictAndMirror.length) rows.push(conflictAndMirror);
rows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
return Markup.inlineKeyboard(rows);
}
// Instantly AI manages outreach replies — Telegram is read-only viewer + support handoff point
const isInstantlyManaged = isInstantlySource(conv);
const loopBtnLabel = conv.needs_support_handoff ? "🚨 Loop in Support NOW" : "📌 Loop in Support";

if (isInstantlyManaged) {
  // Program/outreach card: simple and consistent ordering.
  const rows = [
    [Markup.button.callback(threadLabel, `THREAD:${id}:0`)],
    ...(cardSwitchRow.length ? [[...cardSwitchRow]] : []),
    [Markup.button.callback("✏️ Drafts V1/V2/V3", `DRAFTS:open:${id}`)],
    [Markup.button.callback(loopBtnLabel, `CC:${id}`)],
    [Markup.button.callback("👥 People", `PEOPLE:${id}`)],
  ];
  const conflictAndMirror = [...roleConflictRow, ...mirrorRow];
  if (conflictAndMirror.length) rows.push(conflictAndMirror);
  rows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
  return Markup.inlineKeyboard(rows);
}

// Support lane card: no loop-in-support action.
const rows = [
  [Markup.button.callback(threadLabel, `THREAD:${id}:0`)],
  [Markup.button.callback("✏️ Drafts V1/V2/V3", `DRAFTS:open:${id}`)],
  [Markup.button.callback("👥 People", `PEOPLE:${id}`)],
];
const conflictAndMirror = [...roleConflictRow, ...mirrorRow];
if (conflictAndMirror.length) rows.push(conflictAndMirror);
rows.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
return Markup.inlineKeyboard(rows);
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
if (!(await requireAdminOrNotify(ctx, "start"))) return;
await safeReplyWithFallback(ctx, "✅ NIL Wealth Ops Bot running.\nType /dashboard");
}));

bot.command("dashboard", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "dashboard_command"))) return;
const filterSource = getAdminFilter(ctx);
const dashboardBody = await dashboardText(filterSource);
let msg = await ctx.reply(dashboardBody, dashboardKeyboardV50());
if (!msg?.message_id) {
  // Fallback path in case wrapped ctx.reply returns null silently.
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId != null) {
    msg = await bot.telegram.sendMessage(chatId, dashboardBody, dashboardKeyboardV50()).catch((err) => {
      logError("dashboard_command.send_fallback", err);
      return null;
    });
  }
}
if (!msg?.message_id) {
  await ctx.reply("❌ Dashboard render failed. Try /diag and verify ADMIN_TELEGRAM_IDS + bot permissions.").catch(() => {});
  return;
}
if (msg?.message_id) {
  registerLiveCard(msg, {
    type: "dashboard",
    card_key: `dashboard:${filterSource}:all:command`,
    ref_id: "all",
    filterSource,
    user_id: String(ctx.from?.id || ""),
  });
}
}));

bot.command("leads", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "leads_command"))) return;
await ctx.reply(await leadsText(), leadsKeyboard());
}));

bot.command("analytics", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "analytics_command"))) return;
await ctx.reply(await analyticsText(), analyticsKeyboard());
}));

bot.command("health", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "health_command"))) return;
const summary = await buildOpsHealthSummary();
await ctx.reply(buildOpsHealthText(summary));
}));

bot.command("watchdog", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "watchdog_command"))) return;
const wd = await runDataWatchdog({ forceSchema: true });
await ctx.reply(buildWatchdogCardText(wd), watchdogKeyboard());
}));

bot.command("reset", safeCommand(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "reset_command"))) return;
const userId = String(ctx.from?.id || "");
const chatId = String(ctx.chat?.id || userId);
const msg = await forceAdminDashboardReset({ userId, chatId, reason: "command" });
if (!msg) {
  await ctx.reply("❌ Reset failed. Try /dashboard.").catch(() => {});
} else {
  await ctx.reply("✅ Reset complete. Dashboard is back to default (All filter).", Markup.inlineKeyboard([[Markup.button.callback("⬅ Dashboard", "DASH:back")]])).catch(() => {});
}
}));

// ── /test — AI scenario test mini-dashboard ──────────────────────────────────

// In-memory page cache for test results — keyed by convId, cleared on restart
const testScenarioCache = new Map();
const testScenarioCursors = {
  OUTREACH_COACH_INTEREST: 0,
  PARENT_BASIC_QUESTION: 0,
  OBJECTION_INSURANCE: 0,
  REMOVAL_DEMAND: 0,
};
const testReplyStyleCursors = {
  OUTREACH_COACH_INTEREST: 0,
  PARENT_BASIC_QUESTION: 0,
  OBJECTION_INSURANCE: 0,
  REMOVAL_DEMAND: 0,
};

// Word/sentence-safe truncation — never cuts mid-word
function testTrunc(str, maxLen) {
  const s = String(str || "");
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  // Try to end at sentence boundary
  const lastPeriod = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastPeriod > maxLen * 0.55) return s.slice(0, lastPeriod + 1).trimEnd();
  // Fall back to word boundary
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.7) return s.slice(0, lastSpace).trimEnd() + "…";
  return cut.trimEnd() + "…";
}

// HTML escape for test card content
function escT(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripLeadingGreetingLine(text) {
  const lines = String(text || "").split(/\r?\n/);
  while (lines.length) {
    const first = String(lines[0] || "").trim();
    if (!first) {
      lines.shift();
      continue;
    }
    if (/^(hi|hello|hey|dear)\b[\s,!.:-]*/i.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

function promoteV3ToV1(drafts) {
  const v1 = drafts?.v1 || {};
  const v2 = drafts?.v2 || {};
  const v3 = drafts?.v3 || {};
  return {
    v1: { subject: v3.subject || v1.subject || "", body: stripLeadingGreetingLine(v3.body || v1.body || "") },
    v2: { subject: v1.subject || v2.subject || "", body: stripLeadingGreetingLine(v1.body || v2.body || "") },
    v3: { subject: v2.subject || v3.subject || "", body: stripLeadingGreetingLine(v2.body || v3.body || "") },
  };
}

function testVersionFromPage(cached, pageIdx) {
  const map = cached?.draftPageIndex || {};
  if (map.drafts === pageIdx) {
    return cached?.selectedDraftVersion || "v1";
  }
  return null;
}

function buildTestDraftPage(cached) {
  const selected = cached?.selectedDraftVersion || "v1";
  const subject = cached?.draftSubjects?.[selected] || "";
  const body = cached?.draftBodies?.[selected] || "";
  const label = selected.toUpperCase();
  return [
    `✍️ Reply Drafts (V1/V2/V3)`,
    `Conversation: ${cached?.convId || "SIM"}`,
    `Selected: ${label}`,
    ``,
    `Subject: ${escT(subject)}`,
    ``,
    escT(body),
  ].join("\n");
}

// Paged keyboard — only Prev/Next + Re-run + All Scenarios
function testPageKb(scType, convId, pageIdx, totalPages) {
  const rows = [];
  const cached = testScenarioCache.get(convId);
  const version = testVersionFromPage(cached, pageIdx);
  if (version) {
    rows.push([
      Markup.button.callback(version === "v1" ? "✅ V1" : "V1", `TEST:draft:${convId}:v1`),
      Markup.button.callback(version === "v2" ? "✅ V2" : "V2", `TEST:draft:${convId}:v2`),
      Markup.button.callback(version === "v3" ? "✅ V3" : "V3", `TEST:draft:${convId}:v3`),
    ]);
  }
  const navRow = [];
  if (pageIdx > 0) navRow.push(Markup.button.callback("◀ Prev", `TEST:page:${convId}:${pageIdx - 1}`));
  if (pageIdx < totalPages - 1) navRow.push(Markup.button.callback("Next ▶", `TEST:page:${convId}:${pageIdx + 1}`));
  if (navRow.length) rows.push(navRow);
  rows.push([
    Markup.button.callback("🔄 Re-run", `TEST:run:${scType}`),
    Markup.button.callback("⬅ All Scenarios", "TEST:back"),
  ]);
  return Markup.inlineKeyboard(rows);
}

// Full scenario runner — returns { convId, scType, pages }
async function runTestScenario(scType) {
  const notContains = (v, ...terms) => { const l = v.toLowerCase(); return !terms.some(t => l.includes(t.toLowerCase())); };
  const contains = (v, ...terms) => { const l = v.toLowerCase(); return terms.some(t => l.includes(t.toLowerCase())); };
  const wcount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

  async function askAI(system, user, json = false) {
    const key = process.env.OPENAI_API_KEY || "";
    const retryable = new Set([429, 500, 502, 503, 504]);
    let lastStatus = 0;
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "gpt-4o-mini", temperature: 0.85,
            ...(json ? { response_format: { type: "json_object" } } : {}),
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
        });
        if (res.ok) return (await res.json())?.choices?.[0]?.message?.content || "";
        lastStatus = Number(res.status || 0);
        if (!retryable.has(lastStatus) || attempt === 4) {
          throw new Error(`OpenAI ${lastStatus}`);
        }
      } catch (err) {
        lastErr = err;
        if (attempt === 4) break;
      }
      const backoffMs = 350 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (lastStatus) throw new Error(`OpenAI ${lastStatus}`);
    throw new Error(String(lastErr?.message || "OpenAI request failed"));
  }

  const TEST_SUPPORT_SYS = "You write thorough, structured support replies for Wealth Strategies. Support tone must be formal, polished, complete, and easy to read. Replies must fully answer every question the sender asked before offering any next step. Use only the facts in the current thread payload and never pull details from any other client or conversation. Keep the focus on supplemental health coverage first, with risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist. Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them. If tax is asked, include a clear explanation of 1099 reporting, taxable income basics, and practical next steps like tracking expenses and planning estimated taxes. If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills. Do not mention any insurer except Aflac, and mention extra carrier credibility details only when credibility is explicitly asked. HARD VOCABULARY RULE: use plain everyday words that any parent can read easily. No big words, no industry jargon, no corporate language. If a term must be used, explain what it means right away. Return strict JSON with v1, v2, v3, and rec.";

  const OUTREACH_SYS = "You write thorough, human outreach replies for coach conversations. Tone must be conversational and relationship-building while still professional. Use only the facts in the current thread payload and never pull details from any other client or conversation. Replies must directly and fully answer every question the coach asked before suggesting a next step. If parent-group support is relevant, mention it only after the direct answer is clear. Use simple, everyday words that are easy to understand on a quick read. No corporate polish, no formal greetings, no hype language. Return JSON with v1,v2,v3 each containing subject and body.";

  // Step 1: Generate fresh scenario — NO named insurance companies
  const typePrompts = {
    OUTREACH_COACH_INTEREST: `"s1": { "type": "OUTREACH_COACH_INTEREST", "name": "<coach full name>", "email": "<coach email>", "school": "<high school name>", "sport": "<sport>", "state": "<US state>", "subject": "<reply subject line>", "message": "<65-90 word coach response that is realistic and measured, not overly excited. They ask practical questions about fit, timing, parent communication, and whether this creates extra work for staff. Tone should sound like a busy high school coach.>" }`,
    PARENT_BASIC_QUESTION: `"s1": { "type": "PARENT_BASIC_QUESTION", "name": "<parent full name>", "email": "<parent email>", "school": "<high school>", "sport": "<sport>", "state": "<US state>", "subject": "<subject line>", "message": "<65-90 word parent question that feels real and specific. The question should be about ONE of these topics picked by the scenario angle: coverage basics and whether it is optional; accident insurance or hospital indemnity and what they actually pay; tax documents or 1099 reporting for student athletes; risk awareness and injury costs; or a specific FAQ about how the process works or what families need to do. Write like a real parent — cautious, specific, and practical. Do NOT name any insurer except Aflac if needed for credibility context; avoid all other insurer names.>" }`,
    OBJECTION_INSURANCE: `"s1": { "type": "OBJECTION_INSURANCE", "name": "<parent full name>", "email": "<parent email>", "school": "<high school>", "sport": "<sport>", "state": "<US state>", "subject": "<subject line>", "message": "<65-90 word parent objection that sounds realistic and skeptical. The objection can vary: they may say they already have coverage, they may say they do not need insurance, they may ask why this is needed, they may worry about cost or pressure, or they may be cautious and unconvinced. Keep it practical and specific. Do NOT name any insurer except Aflac if needed for credibility context; avoid all other insurer names.>" }`,
    REMOVAL_DEMAND: `"s1": { "type": "REMOVAL_DEMAND", "name": "<full name>", "email": "<email>", "school": "<high school>", "sport": "<sport>", "state": "<US state>", "subject": "<frustrated subject line>", "message": "<55-70 word person firmly demanding removal from all lists, calling it unsolicited or a sales pitch, clearly wants no further contact.>" }`,
  };

  const scenarioAngleByType = {
    OUTREACH_COACH_INTEREST: [
      "coach worries about parent confusion if message sounds salesy",
      "coach asks about staff workload and exact handoff process",
      "coach asks how to explain optional participation to skeptical parents",
      "coach asks if this fits preseason injury concerns and budget pressure",
      "coach asks how to share one forwardable message without extra meetings",
      "coach asks about timing around tryouts and parent-night logistics",
    ],
    PARENT_BASIC_QUESTION: [
      "parent asks what this adds beyond existing health coverage and whether it is optional",
      "parent asks exactly what accident insurance pays and when it would kick in for their kid",
      "parent asks what hospital indemnity actually covers and how a claim would work",
      "parent asks about tax documents — will their athlete get a 1099 and what do they need to do with it",
      "parent asks about injury risk for high school athletes and what the actual financial exposure looks like",
      "parent asks if they can look at the options without anyone calling them or pressuring them to sign up",
      "parent asks a specific FAQ about how enrollment works and whether the coach handles any of the paperwork",
      "parent asks what out-of-pocket costs look like after a sports injury and how supplemental coverage fits in",
      "parent asks about coverage during away games or travel and what happens if their child gets hurt at a tournament",
      "parent asks about the difference between their primary health insurance and what this supplemental coverage adds",
    ],
    OBJECTION_INSURANCE: [
      "parent says they already pay for strong coverage and sees no gap",
      "parent says they do not need insurance and asks why this is being sent",
      "parent objects to anything that sounds like duplicate coverage",
      "parent pushes back on added costs and asks for practical examples",
      "parent questions whether this helps with deductible or copay pressure",
      "parent says current plan is enough and asks why this exists",
      "parent says they are worried this is sales pressure and asks for plain facts only",
      "parent says they are cautious about signing up for anything and wants to understand risk first",
      "parent asks why families should care if they rarely use healthcare services",
      "parent says this feels unnecessary and asks what real problem it solves",
    ],
    REMOVAL_DEMAND: [
      "recipient demands immediate removal and no future contact",
      "recipient says email is unwanted and asks for confirmation of opt-out",
      "recipient is frustrated and wants permanent suppression",
      "recipient requests deletion from outreach lists with no follow-up",
      "recipient insists on stop-contact confirmation in writing",
      "recipient threatens complaint if messages continue",
    ],
  };
  const defaultAngles = scenarioAngleByType[scType] || ["general realistic support/outreach scenario"];
  const angleCursor = Number(testScenarioCursors[scType] || 0);
  const selectedScenarioAngle = defaultAngles[angleCursor % defaultAngles.length];
  testScenarioCursors[scType] = angleCursor + 1;

  const raw = await askAI(
    "Generate realistic test data for NIL Wealth Strategies email scenarios. Return only valid JSON with no markdown code blocks.",
    `Generate one inbound email scenario. Use a unique realistic name, high school, sport, US state.\n\nHard realism rules:\n- Write like real people under time pressure, not marketing copy\n- No hype language, no over-enthusiasm, no "too good to be true" tone\n- Keep details practical and believable\n- Coach messages should sound grounded and operational\n- Parent messages should sound cautious and specific\n- Use this required scenario angle so each run is materially different: ${selectedScenarioAngle}\n- Build a clearly new scenario, not a slight variation of common examples\n- Avoid repeating common opener patterns like "I already have coverage" unless the selected angle truly requires it\n\nReturn JSON: { ${typePrompts[scType]} }`,
    true
  );
  const sc = JSON.parse(raw)?.s1;
  if (!sc?.name || !sc?.message) throw new Error("Scenario generation returned incomplete data");

  const convId = `SIM-${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const lane = scType === "OUTREACH_COACH_INTEREST" ? "🏈 Programs" : "📧 Support";
  const roleStr = scType === "OUTREACH_COACH_INTEREST" ? "Coach" : "Parent";
  const ts = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const replyStyleByType = {
    OUTREACH_COACH_INTEREST: [
      "Style lane A: short punchy lines with calm confidence",
      "Style lane B: story-first one quick personal line then direct next step",
      "Style lane C: coach-to-coach straight talk with no fluff",
      "Style lane D: practical and grounded with simple words",
      "Style lane E: low-pressure check-in with direct ask",
    ],
    PARENT_BASIC_QUESTION: [
      "Style lane A: answer-first with clear plain-language examples",
      "Style lane B: warm reassurance first, then detailed explanation",
      "Style lane C: step-by-step structure with very simple wording",
      "Style lane D: practical FAQ style with short direct sections",
      "Style lane E: concern-first response with options to continue",
    ],
    OBJECTION_INSURANCE: [
      "Style lane A: acknowledge concern first, then practical gap examples",
      "Style lane B: calm no-pressure response with plain-language comparisons",
      "Style lane C: skeptical-parent style with direct facts and options",
      "Style lane D: cost-and-risk framing in simple terms",
      "Style lane E: cautious-family framing with review-first next steps",
    ],
    REMOVAL_DEMAND: [
      "Style lane A: concise apology and direct removal confirmation",
      "Style lane B: clear compliance-first acknowledgment",
      "Style lane C: calm minimal wording with written confirmation focus",
      "Style lane D: direct opt-out confirmation with no extra language",
      "Style lane E: respectful closure with no re-engagement language",
    ],
  };
  const stylePool = replyStyleByType[scType] || ["Style lane: clear and practical"];
  const styleCursor = Number(testReplyStyleCursors[scType] || 0);
  const selectedReplyStyle = stylePool[styleCursor % stylePool.length];
  testReplyStyleCursors[scType] = styleCursor + 1;

  // Step 2: Generate V1/V2/V3 drafts for all scenario types
  let v1 = "", v2 = "", v3 = "", v1subj = "", v2subj = "", v3subj = "";
  let checkBody = "", checkRec = "";

  if (scType === "OUTREACH_COACH_INTEREST") {
    const payload = JSON.stringify({ contact_email: sc.email, subject: sc.subject, latest_inbound: sc.message, coach_name: sc.name, school: sc.school, sport: sc.sport });
    const result = JSON.parse(await askAI(OUTREACH_SYS,
      `Create 3 follow-up reply drafts for this outreach conversation:\n${payload}\n\nRules:\n- Hard memory rule: use only the facts in this thread payload\n- Do not pull from any other client, coach, parent, campaign, or prior conversation outside this thread\n- Tone: conversational and relationship-building, while still professional\n- Voice should feel credible and coach-to-coach without sounding overly cool\n- Keep phrasing fluent and natural; avoid forced wording\n- Fully answer the coach's actual questions before mentioning any next step\n- If the coach asked multiple questions, cover each one fully and clearly\n- V1, V2, and V3 each must fully answer every coach question before any CTA or support mention\n- If you use a greeting, use "Coach [LastName]" only\n- Do not use first name only, and do not use full name in greeting\n- INTRO HARD RULE: open with this exact meaning (exact text or a very close variation): "Hey Coach [LastName] - I'm with NIL Wealth Strategies. We help student athletes at all levels really understand financial risks, how NIL income is taxed, and how to plan for injury-related expenses - things that usually are not explained in a clear or practical way. I'm a former D1 athlete, and during my college career I went through three surgeries, so I saw firsthand how quickly out-of-pocket costs can stack up after an injury. Because of that, we prioritize high school athletes specifically for injury expense coverage, since parents are often the ones left dealing with those gaps that primary insurance does not fully cover on its own."\n- Personal background is mandatory in every version: former D1 + three surgeries + out-of-pocket impact context\n- V2 is the quality bar for tone: warm, natural, relationship-focused, and easy to read\n- Make V1 sound very close to that same warm V2 tone, but slightly more direct\n- Make V3 sound close to that same warm V2 tone too, while being complete and professional\n- If introducing this to families is relevant, include this simple line in the reply: "I can send a message you can forward, and you can review it before it is sent."\n- If parent-group help is relevant, mention CC support only after the direct answer and frame it as an easy follow-up\n- Keep wording simple and clear, avoid big words and avoid slang\n- Use simple vocabulary that is easy to understand on a quick read\n- Keep punctuation light, no hype punctuation and no repeated exclamation points\n- No formal greetings no corporate polish\n- No meeting or call suggestions unless explicitly asked\n- LENGTH HARD RULE: each version must be a complete, longer answer and should normally be 170-280 words unless the inbound explicitly asks for a short response\n- Build each version in at least two paragraphs: paragraph one is intro context, paragraph two fully answers the coach's question(s) with specifics and then gives the next step\n- Fully answer every point in the message — no word limit, write as much as needed\n- Include one clear next step\n- After answering, include practical next steps by offering 2-3 simple options or inviting a direct reply to continue the conversation\n- HARD UNIQUENESS RULE: V1, V2, and V3 must each be completely unique in opener, sentence flow, phrasing, and CTA wording\n- Do not reuse the same first sentence across versions\n- Do not mention AI\n- Do not name any insurer except Aflac\n- ${selectedReplyStyle}\nReturn: {"v1":{"subject":"...","body":"..."},"v2":{"subject":"...","body":"..."},"v3":{"subject":"...","body":"..."}}`,
      true
    ));
    const reordered = promoteV3ToV1(result || {});
    v1 = reordered.v1.body || ""; v1subj = reordered.v1.subject || sc.subject;
    v2 = reordered.v2.body || ""; v2subj = reordered.v2.subject || sc.subject;
    v3 = reordered.v3.body || ""; v3subj = reordered.v3.subject || sc.subject;
    checkBody = v1;
  } else {
    const typeRules = {
      PARENT_BASIC_QUESTION: "- V1 must clearly state the coverage is optional and family-driven, not required\n- V1 must clarify this does not replace existing insurance — it is supplemental\n- Do not name any insurer except Aflac\n- If carrier credibility is mentioned, include: Aflac holds an AM Best financial strength rating of A+ (Superior), and coaches including Deion Sanders, Nick Saban, and Dawn Staley have publicly endorsed Aflac's mission of protecting families",
      OBJECTION_INSURANCE: "- V1 must acknowledge the parent's concern directly and respectfully in plain language\n- V1 must explain what gap supplemental coverage fills (deductibles, copays, out-of-pocket costs) with clear practical examples\n- If the parent says they already have coverage, V1 must clarify this does not replace their existing plan\n- V1 must explain why families who are cautious may still want to review the option before deciding\n- Leave the door open without pressure\n- Do not name any insurer except Aflac\n- If carrier credibility is mentioned, include: Aflac holds an AM Best financial strength rating of A+ (Superior), and coaches including Deion Sanders, Nick Saban, and Dawn Staley have publicly endorsed Aflac's mission of protecting families",
      REMOVAL_DEMAND: "- V1 must acknowledge frustration and apologize for the disruption\n- V1 must confirm removal and not attempt to retain or re-sell\n- Do not recommend any guide or include any link in V1",
    }[scType] || "";
    const result = JSON.parse(await askAI(TEST_SUPPORT_SYS,
      `Create 3 support reply drafts for this inbound conversation:\n${JSON.stringify({ contact_email: sc.email, subject: sc.subject, message: sc.message, school: sc.school, sport: sc.sport })}\n\nRules:\n- FORMAL tone — professional, complete sentences, warm but polished\n- Fully answer every sender question or concern before offering a next step\n- Keep the focus on supplemental health coverage first, then risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist\n- Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them\n- If tax is asked, include a clear explanation of 1099 reporting, taxable income basics, and practical next steps like tracking expenses and planning estimated taxes\n- If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills\n- V1: answer-first and thorough — open directly with the full answer, cover every part of the question in depth, professional tone\n- V2: warm and thorough — open with empathy or acknowledgment first, then give the same complete answer with a relationship-focused tone\n- V3: organized and thorough — open from a completely different angle than V1 and V2, give the full answer in a different structural order, every question still fully covered\n- HARD UNIQUENESS RULE: not one sentence should repeat across V1, V2, V3. Different openers, different sentence flow, different phrasing throughout, different closing CTA\n- Each version must go deep on every question asked — do not skip or skim anything\n- HARD VOCABULARY RULE: use plain everyday words that any parent can read easily. No big words, no jargon, no corporate language. If a term must be used, explain what it means right away\n- Fully answer every point in the message — no word limit, write as much as needed\n- After answering, include practical next steps by offering 2-3 simple options or inviting a direct reply to continue the conversation\n- Reply style lane for this run: ${selectedReplyStyle}\n- No greeting line at the start\n- Do not mention AI\n- Do not name any insurer except Aflac\n- If carrier credibility is explicitly asked, include: Aflac holds an AM Best financial strength rating of A+ (Superior), and coaches including Deion Sanders, Nick Saban, and Dawn Staley have publicly endorsed Aflac's mission of protecting families\n${typeRules}\nAlso include a recommendation.\nReturn: {"v1":{"subject":"...","body":"..."},"v2":{"subject":"...","body":"..."},"v3":{"subject":"...","body":"..."},"rec":{"include_link":"yes|no","guide":"parent-guide|supplemental-health-guide|none"}}`,
      true
    ));
    const reordered = promoteV3ToV1(result || {});
    v1 = reordered.v1.body || ""; v1subj = reordered.v1.subject || sc.subject;
    v2 = reordered.v2.body || ""; v2subj = reordered.v2.subject || sc.subject;
    v3 = reordered.v3.body || ""; v3subj = reordered.v3.subject || sc.subject;
    checkBody = v1;
    const rec = result?.rec || {};
    checkRec = `include_link=${rec.include_link || "no"}\nrecommended_guide=${rec.guide || "none"}`;
  }

  // Step 3: CC Support content (Coach Interest + Objection only)
  let ccBridge = "", ccSupport = "";
  if (scType === "OUTREACH_COACH_INTEREST") {
    try {
      const simulatedConv = {
        contact_email: sc.email,
        coach_id: sc.coach_id || "",
      };
      const parentGuideLink = parentGuideLinkForConversation(simulatedConv) || DEFAULT_PARENT_GUIDE_URL;
      const officialWebsiteLink = officialWebsiteLinkForConversation(simulatedConv) || DEFAULT_OFFICIAL_WEBSITE_URL;
      const aflacProofLink = aflacProofLinkForConversation(simulatedConv) || DEFAULT_AFLAC_PROOF_URL;
      const ccSys = "You generate CC Support messages for Wealth Strategies. Bridge: concise, conversational, polished note from outreach person to coach looping in support. The bridge must explicitly tell the coach that the note below is what they can forward to the parent group. Support: formal, persuasive, complete message the coach forwards to parent group. The support message must be parent-focused only and must never include or summarize private coach conversation details. Keep the focus on how this helps athletes and families. HARD SCOPE RULE: only include information needed to answer this thread and do not add unrelated detail. The first two support paragraphs must be practical and direct, not promotional, and must explain primary-insurance gaps and supplemental coverage in plain language. Do not mention any insurer except Aflac. Return JSON.";
      const ccResult = JSON.parse(await askAI(ccSys,
        `Generate CC messages for this coach conversation:\nCoach: ${sc.name} — ${sc.school} ${sc.sport} (${sc.state})\n\nBridge (conversational, professional; outreach person says support team is looped in; explicitly say the note below is what the coach can forward to the parent group; do not repeat the coach name in the bridge body):\nSupport (formal, written to be forwarded to the parent group; parent-focused only; do not quote or summarize private coach conversation details; explain how this supports families and athletes; the first two paragraphs must use this practical tone and meaning in plain wording: families need help understanding injury expense coverage for student-athletes; primary insurance does not always cover everything; high school and youth families often carry extra costs; supplemental health works alongside primary insurance and can pay families directly for covered injuries; funds can help with medical bills, travel, time off work, and other out-of-pocket costs; families also get simple guidance on financial risk and NIL income tax education. Include this exact line: "You can respond to this message with any questions — we're happy to help."; include mandatory links exactly as written:\nLearn more in the Parent Guide:\n${parentGuideLink}\nOfficial Wealth Strategies Website:\n${officialWebsiteLink}\nTo see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury:\n${aflacProofLink}\nInclude this credibility line in plain wording: Backed by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders. Include this role clarity note in simple wording: Coaches do not sell, explain, or enroll insurance. Coaches do not handle money or paperwork. Families review coverage and enroll directly with Aflac. NIL Wealth Strategies provides education and support only.):\n\nReturn: {"bridge":{"body":"..."},"support":{"body":"..."}}`,
        true
      ));
      ccBridge = ccResult?.bridge?.body || "";
      ccSupport = ccResult?.support?.body || "";
      const hasParentLabel = ccSupport.includes("Learn more in the Parent Guide:");
      const hasWebsiteLabel = ccSupport.includes("Official Wealth Strategies Website:");
      const hasAflacLabel = ccSupport.includes("To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury:");
      const hasRoleClarity = /coaches do not sell, explain, or enroll insurance/i.test(ccSupport)
        && /coaches do not handle money or paperwork/i.test(ccSupport)
        && /families review coverage and enroll directly with aflac/i.test(ccSupport)
        && /nil wealth strategies provides education and support only/i.test(ccSupport);
      const hasParentLink = ccSupport.includes(parentGuideLink);
      const hasWebsiteLink = ccSupport.includes(officialWebsiteLink);
      const hasAflacLink = ccSupport.includes(aflacProofLink);
      if (!hasParentLabel || !hasWebsiteLabel || !hasAflacLabel || !hasParentLink || !hasWebsiteLink || !hasAflacLink || !hasRoleClarity) {
        ccSupport = `${String(ccSupport || "").trim()}\n\nCoaches do not sell, explain, or enroll insurance.\nCoaches do not handle money or paperwork.\nFamilies review coverage and enroll directly with Aflac.\nNIL Wealth Strategies provides education and support only.\n\nLearn more in the Parent Guide:\n${parentGuideLink}\n\nOfficial Wealth Strategies Website:\n${officialWebsiteLink}\n\nTo see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury:\nBacked by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders.\n${aflacProofLink}`.trim();
      }
    } catch {}
  }

  // Step 4: Behavior checks — failures only
  const failures = {
    OUTREACH_COACH_INTEREST: () => [
      notContains(checkBody, "dear ", "hi ", "hello ") ? null : "Formal greeting used (Dear/Hi/Hello) — must be casual",
      notContains(checkBody, "schedule a call", "book a time", "calendar", "let's hop on") ? null : "Pushed meeting/calendar without being asked",
      notContains(checkBody, "nil income", "nil earnings", "nil tax") ? null : "Mentioned NIL income/tax without being asked",
      contains(checkBody, "send", "forward", "reply", "let me know", "share", "happy to") ? null : "No clear next step included",
      notContains(checkBody, "chatgpt", "generated", "automated") ? null : "Mentioned AI/automated tools",
    ].filter(Boolean),
    PARENT_BASIC_QUESTION: () => [
      notContains(checkBody, "hey ", "yeah,", "nope", "totally,") ? null : "Casual tone detected — support must be formal",
      !(/^(hi|hello|hey|dear)\b/i.test(checkBody.trim())) ? null : "Starts with greeting — omit per style rules",
      contains(checkBody, "optional", "not required", "family-driven", "no requirement") ? null : "Did not clearly state coverage is optional",
      contains(checkBody, "does not replace", "supplement", "alongside", "not a replacement") ? null : "Did not clarify it does not replace existing insurance",
      notContains(checkBody, "nil income", "nil earnings", "nil tax") ? null : "Mentioned NIL income/tax without being asked",
      contains(checkRec, "supplemental-health-guide", "parent-guide") ? null : "Did not recommend a relevant guide",
    ].filter(Boolean),
    OBJECTION_INSURANCE: () => [
      notContains(checkBody, "hey ,", "nope,", "totally,", "yeah,") ? null : "Casual tone — support must be formal",
      contains(checkBody, "understand", "appreciate", "valid concern", "reasonable concern", "good question", "i hear you", "i hear your concern", "that concern") ? null : "Did not acknowledge the objection or concern",
      contains(checkBody, "deductible", "copay", "gap", "out-of-pocket", "supplement", "alongside") ? null : "Did not explain what gap the coverage fills",
      contains(checkBody, "not replace", "supplement", "alongside", "additional", "optional") ? null : "Did not clarify how this fits alongside primary coverage or optional family choice",
      notContains(checkBody, "you must", "don't miss", "act now", "limited time") ? null : "Used high-pressure language",
      contains(checkBody, "optional", "family-driven", "no pressure", "without any pressure", "happy to help", "if you", "feel free") ? null : "Did not leave the door open without pressure",
    ].filter(Boolean),
    REMOVAL_DEMAND: () => [
      notContains(checkBody, "hey ,", "yeah,", "super sorry", "my bad") ? null : "Casual/defensive tone — support must be formal",
      contains(checkBody, "understand", "apologize", "sorry", "frustration", "appreciate") ? null : "Did not acknowledge frustration",
      notContains(checkBody, "actually if you", "before you decide", "you might want to reconsider", "just one more") ? null : "Attempted to re-sell to someone demanding removal",
      contains(checkBody, "remov", "opt out", "unsubscribe", "no further", "mailing list", "stop") ? null : "Did not confirm removal/opt-out",
      notContains(checkBody, "don't miss out", "limited time", "before you go") ? null : "High-pressure close on a removal request",
      contains(checkRec, "recommended_guide=none") || contains(checkRec, "include_link=no") ? null : "Recommended a guide/link to someone demanding removal",
    ].filter(Boolean),
  }[scType]?.() || [];
  const totalChecks = 6;

  // Step 5: Build paged content — matches real card formats exactly
  const pages = [];

  const aflacProofLinkForScenario = aflacProofLinkForConversation({ contact_email: sc.email, coach_id: sc.coach_id || "" }) || DEFAULT_AFLAC_PROOF_URL;

  // ── Page 1: Conversation/Instantly first view ───────────────
  if (scType === "OUTREACH_COACH_INTEREST") {
    const coachLastName = String(sc.name || "Coach").trim().split(/\s+/).filter(Boolean).slice(-1)[0] || "Coach";
    const outboundSeed = `Hey Coach ${escT(coachLastName)} — I'm with NIL Wealth Strategies. We help student athletes at all levels really understand financial risks, how NIL income is taxed, and how to plan for injury-related expenses — things that usually aren't explained in a clear or practical way.

  I'm a former D1 athlete, and during my college career I went through three surgeries, so I saw firsthand how quickly out-of-pocket costs can stack up after an injury. Because of that, we prioritize high school athletes specifically for injury expense coverage, since parents are often the ones left dealing with those gaps that primary insurance doesn't fully cover on its own.`;
    pages.push([
      `📤 INSTANTLY OUTBOUND`,
      `--`,
      `${escT(sc.name)}`,
      `From (Outreach): ${escT(OUTREACH_FROM_EMAIL || "noreply@mynilwealthstrategies.com")}`,
      `Thread Summary: 1 msgs • Last: outbound • just now`,
      ``,
      `Outbound Message`,
      testTrunc(outboundSeed, 700),
      ``,
      `Ref: Campaign ${escT(sc.campaign_id || "—")}`,
      ``,
      `--`,
      `ID: ${convId}`,
      `Updated: ${dateStr}, ${ts}`,
      `💬 Messages: 1`,
      `🔵 Fresh`,
    ].join("\n"));
  } else {
    pages.push([
      `💬 CONVERSATION`,
      `--`,
      `ID: ${convId} • ${lane}`,
      `Identity: ${escT(sc.name)}`,
      ``,
      `Role: ${roleStr}`,
      ``,
      `Status: 📝 Needs Reply`,
      `Coach: ${scType === "OUTREACH_COACH_INTEREST" ? escT(sc.name) : "—"}`,
      `Contact: ${escT(sc.email)}`,
      ``,
      `📧 Subject: ${escT(sc.subject)}`,
      ``,
      `Preview: Open Thread for full inbound body`,
      ``,
      `--`,
      `Updated: ${dateStr}, ${ts}`,
      `💬 Messages: 1`,
      `🔵 Fresh`,
      `CC: Off`,
    ].join("\n"));
  }

  // ── Page 2: Thread view (inbound message) ─────────────────────
  pages.push([
    `🧵 ${escT(sc.subject)}`,
    `${lane}`,
    `💬 Messages: 1`,
    `Page 1/1`,
    ``,
    `📥 Inbound · ${escT(sc.email)}`,
    ``,
    escT(sc.message),
    ``,
    `🕐 ${dateStr}, ${ts}`,
    `🧪 SIMULATED THREAD`,
  ].join("\n"));

  if (scType !== "OUTREACH_COACH_INTEREST") {
    v1 = ensureAflacOption3(v1, { contact_email: sc.email, coach_id: sc.coach_id || "" });
    v2 = ensureAflacOption3(v2, { contact_email: sc.email, coach_id: sc.coach_id || "" });
    v3 = ensureAflacOption3(v3, { contact_email: sc.email, coach_id: sc.coach_id || "" });
  }

  // ── Single Draft Page: button-switch V1/V2/V3 (no separate pages) ─
  const draftPageIndex = {};
  draftPageIndex.drafts = pages.length;
  const draftBodies = { v1, v2, v3 };
  const draftSubjects = { v1: v1subj, v2: v2subj, v3: v3subj };
  const selectedDraftVersion = "v1";
  pages.push(buildTestDraftPage({ convId, selectedDraftVersion, draftBodies, draftSubjects }));

  // ── Page 4 (Coach Interest): CC Support ──────────────────────
  if (scType === "OUTREACH_COACH_INTEREST" && (ccBridge || ccSupport)) {
    pages.push([
      `📌 CC SUPPORT`,
      `--`,
      `${convId} · 🏈 Programs`,
      `Coach: ${escT(sc.name)}`,
      ``,
      `Bridge (outreach → coach):`,
      `──`,
      testTrunc(escT(ccBridge), 320),
      ``,
      `Support (forwarded to families):`,
      `──`,
      escT(ccSupport),
      ``,
      `🧪 SIMULATED CC`,
    ].join("\n"));
  }



  // ── Last page: Test results ───────────────────────────────────
  const passed = totalChecks - failures.length;
  pages.push(failures.length === 0
    ? [`📊 TEST RESULTS`, `--`, `${convId} · ${lane}`, ``, `✅ All ${totalChecks} checks passed`, ``, `Scenario: ${scType}`].join("\n")
    : [`📊 TEST RESULTS`, `--`, `${convId} · ${lane}`, ``, `⚠️ ${passed}/${totalChecks} checks passed — ${failures.length} failure${failures.length > 1 ? "s" : ""}:`, ``, ...failures.map(f => `❌ ${escT(f)}`), ``, `Scenario: ${scType}`].join("\n")
  );

  return { convId, scType, pages, draftPageIndex, selectedDraftVersion, draftBodies, draftSubjects, aflacProofLinkForScenario };
}

// Build test dashboard card ─────────────────────────────────
function buildTestDashboard() {
  const ts = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const text = [
    `🧪 AI TEST DASHBOARD`,
    `--`,
    `Select a scenario to run a fresh live test.`,
    `Each run generates a new random person, school,`,
    `sport, and message — then tests the live AI.`,
    ``,
    `1️⃣  Outreach — Coach Interest`,
    `2️⃣  Support — Parent Question`,
    `3️⃣  Support — Insurance Objection`,
    `4️⃣  Support — Removal Demand`,
    ``,
    `--`,
    `🕐 ${ts}`,
  ].join("\n");
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("1️⃣ Coach Interest",      "TEST:run:OUTREACH_COACH_INTEREST")],
    [Markup.button.callback("2️⃣ Parent Question",     "TEST:run:PARENT_BASIC_QUESTION")],
    [Markup.button.callback("3️⃣ Insurance Objection", "TEST:run:OBJECTION_INSURANCE")],
    [Markup.button.callback("4️⃣ Removal Demand",      "TEST:run:REMOVAL_DEMAND")],
  ]);
  return { text, kb };
}

// /test command ─────────────────────────────────────────────
bot.command("test", safeCommand(async (ctx) => {
  if (!(await requireAdminOrNotify(ctx, "test_command"))) return;
  if (!OPENAI_API_KEY) { await ctx.reply("❌ OPENAI_API_KEY not configured.").catch(() => {}); return; }
  const { text, kb } = buildTestDashboard();
  await ctx.reply(text, { ...kb, parse_mode: "HTML" }).catch(() => {});
}));

// Run scenario — generates, caches pages, shows page 0 ──────
bot.action(/^TEST:run:(.+)$/, safeAction(async (ctx) => {
  if (!isAdmin(ctx)) return;
  fastAnswerCbQuery(ctx);
  const scType = ctx.match[1];
  const validTypes = ["OUTREACH_COACH_INTEREST", "PARENT_BASIC_QUESTION", "OBJECTION_INSURANCE", "REMOVAL_DEMAND"];
  if (!validTypes.includes(scType)) return;

  const typeLabel = { OUTREACH_COACH_INTEREST: "Coach Interest", PARENT_BASIC_QUESTION: "Parent Question", OBJECTION_INSURANCE: "Insurance Objection", REMOVAL_DEMAND: "Removal Demand" }[scType];

  await smartRender(ctx, `⏳ Running — ${typeLabel}\n--\nGenerating scenario + calling AI…\nThis takes ~10–15 seconds.`, Markup.inlineKeyboard([[Markup.button.callback("⏳ Please wait…", "TEST:noop")]])).catch(() => {});

  try {
    const result = await runTestScenario(scType);
    testScenarioCache.set(result.convId, result);
    // Keep cache lean — evict oldest if over 30 entries
    if (testScenarioCache.size > 30) {
      const firstKey = testScenarioCache.keys().next().value;
      testScenarioCache.delete(firstKey);
    }
    const { pages, convId } = result;
    const pageNum = 0;
    const pageText = `${pages[pageNum]}\n\nPage ${pageNum + 1}/${pages.length}`;
    await smartRender(ctx, pageText, testPageKb(scType, convId, pageNum, pages.length)).catch(() => {});
  } catch (err) {
    const eb = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await smartRender(ctx, `❌ ${typeLabel} failed\n--\n${eb(String(err.message || "unknown error").slice(0, 200))}`, Markup.inlineKeyboard([[Markup.button.callback("🔄 Retry", `TEST:run:${scType}`), Markup.button.callback("⬅ All Scenarios", "TEST:back")]])).catch(() => {});
  }
}));

// Page navigation — reads from cache ────────────────────────
bot.action(/^TEST:page:([^:]+):(\d+)$/, safeAction(async (ctx) => {
  if (!isAdmin(ctx)) return;
  fastAnswerCbQuery(ctx);
  const convId = ctx.match[1];
  const pageIdx = Number(ctx.match[2]);
  const cached = testScenarioCache.get(convId);
  if (!cached) {
    await smartRender(ctx, `⚠️ Session expired — please re-run the test.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ All Scenarios", "TEST:back")]])).catch(() => {});
    return;
  }
  const { scType, pages } = cached;
  const clampedIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
  const pageText = `${pages[clampedIdx]}\n\nPage ${clampedIdx + 1}/${pages.length}`;
  await smartRender(ctx, pageText, testPageKb(scType, convId, clampedIdx, pages.length)).catch(() => {});
}));

bot.action(/^TEST:draft:([^:]+):(v[123])$/, safeAction(async (ctx) => {
  if (!isAdmin(ctx)) return;
  fastAnswerCbQuery(ctx);
  const convId = ctx.match[1];
  const version = ctx.match[2];
  const cached = testScenarioCache.get(convId);
  if (!cached) {
    await smartRender(ctx, `⚠️ Session expired — please re-run the test.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ All Scenarios", "TEST:back")]])).catch(() => {});
    return;
  }
  const idx = cached?.draftPageIndex?.drafts;
  if (typeof idx !== "number") {
    await smartRender(ctx, `⚠️ Draft view unavailable — please re-run the test.`, Markup.inlineKeyboard([[Markup.button.callback("⬅ All Scenarios", "TEST:back")]])).catch(() => {});
    return;
  }
  cached.selectedDraftVersion = version;
  cached.pages[idx] = buildTestDraftPage(cached);
  testScenarioCache.set(convId, cached);
  const { scType, pages } = cached;
  const pageText = `${pages[idx]}\n\nPage ${idx + 1}/${pages.length}`;
  await smartRender(ctx, pageText, testPageKb(scType, convId, idx, pages.length)).catch(() => {});
}));

// Return to test dashboard ──────────────────────────────────
bot.action("TEST:back", safeAction(async (ctx) => {
  if (!isAdmin(ctx)) return;
  fastAnswerCbQuery(ctx);
  const { text, kb } = buildTestDashboard();
  await smartRender(ctx, text, { ...kb, parse_mode: "HTML" }).catch(() => {});
}));

bot.action("TEST:noop", safeAction(async (ctx) => {
  fastAnswerCbQuery(ctx);
}));

bot.command("diag", safeCommand(async (ctx) => {
const userId = String(ctx.from?.id || "");
const chatId = String(ctx.chat?.id || "");
const adminAllowed = isAdmin(ctx);
const filterSource = getAdminFilter(ctx);
const roleFilter = getAdminRoleFilter(ctx);
const diag = [
  "🧪 Dashboard Diagnostics",
  `User ID: ${userId || "unknown"}`,
  `Chat ID: ${chatId || "unknown"}`,
  `Admin Allowed: ${adminAllowed ? "yes" : "no"}`,
  `Configured Admin IDs: ${ADMIN_IDS.length}`,
  `Bot Enabled: ${ENABLE_TELEGRAM_BOT ? "yes" : "no"}`,
  `Bot Active: ${TELEGRAM_BOT_ACTIVE ? "yes" : "no"}`,
  `Bot Disabled Reason: ${TELEGRAM_BOT_DISABLED_REASON || "none"}`,
  `Live Refresh: ${ENABLE_TELEGRAM_LIVE_REFRESH ? "yes" : "no"}`,
  `Filter: ${filterSource}`,
  `Role Filter: ${roleFilter}`,
  `Build: ${String(BUILD_VERSION)}`,
].join("\n");
await ctx.reply(diag).catch(() => {});
}));

bot.action("DASH:back", safeAction(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "dash_back_action"))) return;
const filterSource = getAdminFilter(ctx);
await trackPerf(`handler.dashboard.back.${filterSource}`, async () => {
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
});
}));

bot.action("DASH:refresh", safeAction(async (ctx) => {
if (!(await requireAdminOrNotify(ctx, "dash_refresh_action"))) return;
const filterSource = getAdminFilter(ctx);
await trackPerf(`handler.dashboard.refresh.${filterSource}`, async () => {
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
});
}));

bot.action("HEALTH:open", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const wd = await runDataWatchdog({ forceSchema: true });
await smartRender(ctx, buildWatchdogCardText(wd), watchdogKeyboard());
}));

bot.action("HEALTH:refresh", safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const wd = await runDataWatchdog({ forceSchema: true });
await smartRender(ctx, buildWatchdogCardText(wd), watchdogKeyboard());
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
setAdminRoleFilter(ctx, "all");
const roleFilter = "all";
const msg = await trackPerf(`handler.allq.open.${filterSource}.${roleFilter}`, async () => smartRender(
ctx,
await allQueuesText(filterSource, roleFilter),
allQueuesKeyboard(filterSource)
));
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
const roleFilter = getAdminRoleFilter(ctx) || "all";
try {
if (viewKey === "website_submissions") {
const pageSize = 1;
// Get total count + page of data
const { count: totalCount, error: countErr } = await trackPerf("view.website_submissions.count", () => ops()
.from("submissions")
.select("submission_id", { count: "exact", head: true }));
if (countErr) {
logError("VIEW:website_submissions count", countErr);
return smartRender(
ctx,
buildLoadWarning("submission queue count", countErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "ALLQ:open")]])
);
}
const safeTotalCount = totalCount || 0;
const totalPages = Math.max(1, Math.ceil(safeTotalCount / pageSize));
const safePage = Number.isFinite(page) && page > 0 ? page : 1;
const currentPage = Math.min(safePage, totalPages);
const offset = (currentPage - 1) * pageSize;
  
const subs = await trackPerf("view.website_submissions.list", () => sbListSubmissions({ limit: pageSize, offset }));
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

const pageInfo = `Page ${currentPage}/${totalPages} (${safeTotalCount} total)`;
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
if (currentPage !== totalPages) {
navRow.push(Markup.button.callback("⏩ Last", `VIEW:website_submissions:${totalPages}`));
}
if (navRow.length > 0) kb.push(navRow);
kb.push([Markup.button.callback("⬅️ Back", "ALLQ:open")]);
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
const pageSize = 1;
const safePage = Number.isFinite(page) && page > 0 ? page : 1;
const totalCount = viewKey === "urgent"
  ? await sbCountUrgentCombined({ source: filterSource, role: roleFilter })
  : viewKey === "forwarded"
  ? await sbCountForwardedCombined({ source: filterSource })
  : await sbCountConversations({ pipeline: viewKey, source: filterSource, role: roleFilter });
const totalPages = Math.max(1, Math.ceil((Number(totalCount) || 0) / pageSize));
const currentPage = Math.min(safePage, totalPages);
const offset = (currentPage - 1) * pageSize;

// Handle urgent with auto-escalation logic
const rows = viewKey === "urgent"
? await sbListUrgentCombined({ source: filterSource, role: roleFilter, limit: pageSize, offset })
: viewKey === "forwarded"
? await sbListForwardedCombined({ source: filterSource, limit: pageSize, offset })
: await sbListConversations({ pipeline: viewKey, source: filterSource, role: roleFilter, limit: pageSize, offset });
await showConversationList(ctx, viewKey, rows, filterSource, roleFilter, {
  currentPage,
  totalPages,
  totalCount: Number(totalCount) || 0,
});
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
const { text, msgCount, isInstantlyInbound, hasInstantlyCard, currentView } = await buildConversationCard(conv);
const kb = conversationCardKeyboard(conv, msgCount, { isInstantlyInbound, hasInstantlyCard, currentView });
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

bot.action(/^CARDVIEW:([^:]+):(instantly|conversation)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const requestedView = ctx.match[2];
const conv = await sbGetConversationById(convId);
if (!conv) {
await ctx.reply("❌ Conversation not found.");
return;
}
const { text, msgCount, isInstantlyInbound, hasInstantlyCard, currentView } = await buildConversationCard(conv, {
displayMode: requestedView,
});
const kb = conversationCardKeyboard(conv, msgCount, { isInstantlyInbound, hasInstantlyCard, currentView });
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
const { text, msgCount, isInstantlyInbound, hasInstantlyCard, currentView } = await buildConversationCard(mirror);
const kb = conversationCardKeyboard(mirror, msgCount, { isInstantlyInbound, hasInstantlyCard, currentView });
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
// 🧵 THREAD VIEW (single-message pagination)
// ==========================================================
//
// Requires existing helpers:
// - shorten(str, n)
// - isAdmin(ctx)
// - headerLine(...)
// - laneLabel(...), sourceSafe(...)
// - sbGetConversationById(convId)
const THREAD_ORDER = "oldest_first"; // "newest_first" | "oldest_first"
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
const safeOffset = Math.max(0, Number(offset || 0));
const headerBase =
`${headerLine("thread", "full")}\n` +
`${conv.subject || "Thread"}\n` +
`${laneLabel(sourceSafe(conv.source))}`;
const isInstantlyThread = isInstantlySource(conv);
let total = 0;
let msgs = [];
let body = "(No messages yet)";
let pageIndex = 0;
let totalPages = 0;
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
return THREAD_ORDER === "newest_first" ? bt - at : at - bt;
});
total = timeline.length;
if (total > 0) {
  pageIndex = Math.min(safeOffset, total - 1);
  totalPages = total;
  body = formatInstantlyTimelineLine(timeline[pageIndex], conv, {
    supportFromEmail: SUPPORT_FROM_EMAIL,
    outreachFromEmail: OUTREACH_FROM_EMAIL,
  });
}
} else {
total = await sbCountMessages(convId);
if (total > 0) {
  pageIndex = Math.min(safeOffset, total - 1);
  const dbOffset = THREAD_ORDER === "newest_first"
    ? pageIndex
    : Math.max(0, total - 1 - pageIndex);
  msgs = await sbListMessages(convId, { offset: dbOffset, limit }).catch(() => []);
  const msg = msgs?.[0] || null;
  body = msg ? formatMessageLineFull(msg, conv, {
    supportFromEmail: SUPPORT_FROM_EMAIL,
    outreachFromEmail: OUTREACH_FROM_EMAIL,
  }) : "(No messages yet)";
  totalPages = total;
}
}
const pageLabel = total > 0 ? `Page ${pageIndex + 1}/${totalPages}` : "Page 0/0";
const header = `${headerBase}\n💬 Messages: ${total}\n${pageLabel}`;
// Pagination controls
const prevOffset = Math.max(0, pageIndex - 1);
const nextOffset = pageIndex + 1;
const hasPrev = pageIndex > 0;
const hasNext = nextOffset < total;
const firstOffset = 0;
const lastOffset = total > 0 ? total - 1 : 0;
const kbRows = [];
// Simple nav row: First / Prev / Next / Last
const paging = [];
if (total > 0 && pageIndex !== firstOffset) paging.push(Markup.button.callback("⏮ First", `THREAD:${convId}:${firstOffset}`));
if (hasPrev) paging.push(Markup.button.callback("◀ Prev", `THREAD:${convId}:${prevOffset}`));
if (hasNext) paging.push(Markup.button.callback("Next ▶", `THREAD:${convId}:${nextOffset}`));
if (total > 0 && pageIndex !== lastOffset) paging.push(Markup.button.callback("Last ⏭", `THREAD:${convId}:${lastOffset}`));
if (paging.length) kbRows.push(paging);
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
latestOffset: computeLatestOffset(total, limit),
};
}
// ---------- THREAD VIEW (paged) ----------
bot.action(/^THREAD:(.+):(\d+)$/, safeAction(async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const offset = Number(ctx.match[2] || 0);
const limit = 1;
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
// ---------- LOOP IN SUPPORT ----------
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
function buildThreadingContext(conv) {
  const gmailThreadId = conv?.gmail_thread_id || null;
  const messageIdHeader = conv?.message_id_header || null;
  const inReplyTo = conv?.in_reply_to || null;
  const references = conv?.references || null;
  const replyAnchor = inReplyTo || messageIdHeader || null;
  return {
    gmail_thread_id: gmailThreadId,
    message_id_header: messageIdHeader,
    in_reply_to: inReplyTo,
    references: references,
    reply_anchor: replyAnchor,
    threading: {
      gmail_thread_id: gmailThreadId,
      in_reply_to: inReplyTo,
      references: references,
      reply_anchor: replyAnchor,
    },
  };
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
  const threadingContext = buildThreadingContext(conv);
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
    ...threadingContext,
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
[Markup.button.callback("✅ Confirm Loop in Support", `CCCONFIRM:${convId}:${bridgeDraft}:${supportDraft}`)],
[Markup.button.callback("⬅ Back to Conversation", `OPENCARD:${convId}`)]
]);
}

async function renderCCCard(ctx, convId, bridgeDraft = 2, supportDraft = 2) {
const drafts = ccDraftsCache.get(convId);
if (!drafts) {
return smartRender(ctx, "❌ Loop in Support drafts not found. Click Regenerate.", ccKeyboard(convId, bridgeDraft, supportDraft));
}
let text = `📌 Loop in Support\nConversation: ${idShort(convId)}\n\n`;
text += `This will:\n• Send bridge message from outreach to contact\n• Send forwardable support message from ${SUPPORT_FROM_EMAIL}\n• Create + link the Support mirror thread\n\n`;
text += `Support draft includes explicit parent-group forwarding language so parents can reply directly to that CC thread.\n\n`;
text += `Threading is preserved using Gmail thread headers and thread id when available.\n\n`;
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
    "📌 Loop in Support is only available for program lane conversations.",
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
`📌 Loop in Support\nConversation: ${idShort(convId)}\n\n⏳ Generating bridge & support drafts with ChatGPT...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
try {
const generated = await withTimeout(
generateCCDrafts(conv),
15000,
"Loop in Support draft generation timed out"
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
return smartRender(ctx, `❌ Failed to generate Loop in Support drafts: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
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
return smartRender(ctx, "❌ Loop in Support drafts not found. Go back and regenerate.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
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
`📌 Loop in Support\nConversation: ${idShort(convId)}\n\n⏳ Regenerating bridge & support drafts with ChatGPT...`,
Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]])
);
try {
const generated = await withTimeout(
generateCCDrafts(conv),
15000,
"Loop in Support draft generation timed out"
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
return smartRender(ctx, `❌ Failed to generate Loop in Support drafts: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
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
return smartRender(ctx, "📌 Loop in Support is only available for program lane conversations.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (!drafts) {
return smartRender(ctx, "❌ Loop in Support drafts expired. Re-open Loop in Support and regenerate if needed.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const bridgeMessage = drafts.bridge?.[`v${bridgeDraft}`] || null;
const supportMessage = drafts.support?.[`v${supportDraft}`] || null;
if (!bridgeMessage || !supportMessage) {
return smartRender(ctx, "❌ Selected Loop in Support draft content is missing. Re-open Loop in Support and try again.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const recentCcSent = await sbGetRecentCcSupportSent(convId, 24);
if (recentCcSent) {
const sentAt = tFmtDateTimeShort(recentCcSent.created_at);
return smartRender(
ctx,
`⚠ Loop in Support was already sent for this conversation today.\nLast send: ${sentAt}\n\nSend again only if you intend to override duplicate protection.`,
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
`📌 Loop in Support queued.\n🔒 Sending lane locked to Support (was Outreach).\nMirror thread will appear when ingested.\n\n${cardText}` : 
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
return smartRender(ctx, "📌 Loop in Support is only available for program lane conversations.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]]));
}
if (!drafts) {
return smartRender(ctx, "❌ Loop in Support drafts expired. Re-open Loop in Support and regenerate if needed.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
}
const bridgeMessage = drafts.bridge?.[`v${bridgeDraft}`] || null;
const supportMessage = drafts.support?.[`v${supportDraft}`] || null;
if (!bridgeMessage || !supportMessage) {
return smartRender(ctx, "❌ Selected Loop in Support draft content is missing. Re-open Loop in Support and try again.", Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", `CC:${convId}`)]]));
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
? `📌 Loop in Support override queued.\n\n${cardText}`
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

const handoff = roleFilter === "all"
  ? (handoffRaw || [])
  : (handoffRaw || []).filter((c) => conversationRoleForDisplay(c) === roleFilter);

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
handoff.forEach(c => allItems.push({ type: "convo", tier: "handoff", item: c }));
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
lines.push(`‼ ${urgent.length} · 📌 ${handoff.length} · 📝 ${needs.length} · 📱 ${calls.length} · 📚 ${followups.length}`);
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
        handoff: "📌 NEEDS LOOP — AI Ready (Instantly)",
        urgent: "‼ URGENT (Overdue > 24h)",
        needs: "📝 NEEDS REPLY",
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
      const baseLine = tConvoLine(entry.item, itemNum);
      const prefixByTier = { handoff: "📌", urgent: "‼", needs: "📝" };
      const lineWithTierPrefix = baseLine.replace(/^(\d+\))\s+•\s/, `$1 ${prefixByTier[entry.tier] || "•"} `);
      if (entry.item?.needs_support_handoff === true && !entry.item?.cc_support_suggested) {
        const reason = entry.item?.handoff_detected_reason ? `\n Reason: ${entry.item.handoff_detected_reason}` : "";
        lines.push(`${lineWithTierPrefix}\n 🤖 AI Ready for Loop in Support${reason}`);
      } else {
        lines.push(lineWithTierPrefix);
      }
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
    navRow.push(Markup.button.callback("◀ Prev", `TRIAGE:all:${safePage - 1}`));
  }
  navRow.push(Markup.button.callback(`· ${safePage}/${totalPages} ·`, `TRIAGE:all:${safePage}`));
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback("Next ▶", `TRIAGE:all:${safePage + 1}`));
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
    const row = [Markup.button.callback(tConvoBtnLabelTriage(entry.item), `OPENCARD:${entry.item.id}`)];
    const needsLoop = entry.item?.needs_support_handoff === true && !entry.item?.cc_support_suggested && isProgramLaneConversation(entry.item);
    if (needsLoop) {
      row.push(Markup.button.callback("📌 Needs Loop", `CC:${entry.item.id}`));
    }
    kb.push(row);
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
    navRow.push(Markup.button.callback("◀ Prev", `HANDOFF:${safePage - 1}`));
  }
  navRow.push(Markup.button.callback(`· ${safePage}/${totalPages} ·`, `HANDOFF:${safePage}`));
  if (safePage < totalPages) {
    navRow.push(Markup.button.callback("Next ▶", `HANDOFF:${safePage + 1}`));
  }
  kb.push(navRow);
}

pageItems.forEach((conv) => {
  kb.push([Markup.button.callback(tConvoBtnLabelTriage(conv), `OPENCARD:${conv.id}`)]);
});

kb.push([Markup.button.callback("⬅ Queues", "ALLQ:open")]);
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
await ctx.reply("⚠ Draft editing is disabled for Instantly-managed conversations. Use Loop in Support from the conversation card.");
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
[Markup.button.callback("📱 Calls", "CALLS:hub"), Markup.button.callback("🗂 Queues", "ALLQ:open")],
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
Clicks: ${metrics.totalClicks || 0}
  (Avg ${avg(metrics.totalClicks)}${perLabel})

NILWS Website Opens: ${metrics.websiteOpens || metrics.nilwsWebsiteOpens || 0}
  (Avg ${avg(metrics.websiteOpens || metrics.nilwsWebsiteOpens)}${perLabel})

Parent Guide Clicks: ${metrics.parentGuideClicks || 0}
  (Avg ${avg(metrics.parentGuideClicks)}${perLabel})

Supplemental Health Guide Clicks: ${metrics.supplementalHealthGuideClicks || 0}
  (Avg ${avg(metrics.supplementalHealthGuideClicks)}${perLabel})

Risk Awareness Guide Clicks: ${metrics.riskAwarenessGuideClicks || 0}
  (Avg ${avg(metrics.riskAwarenessGuideClicks)}${perLabel})

Tax Education Guide Clicks: ${metrics.taxEducationGuideClicks || 0}
  (Avg ${avg(metrics.taxEducationGuideClicks)}${perLabel})

Enroll Portal Clicks: ${metrics.enrollPortalClicks || 0}
  (Avg ${avg(metrics.enrollPortalClicks)}${perLabel})

eApp Visits: ${metrics.eappVisits || 0}
  (Avg ${avg(metrics.eappVisits)}${perLabel})

Calls Answered: ${metrics.callsAnswered || 0}
  (Avg ${avg(metrics.callsAnswered)}${perLabel})
--`.trim();

// Add best week/month for year view
if (window === "year" && metrics.bestWeek && metrics.bestMonth) {
const bestWeek = `🏆 Best Week: ${metrics.bestWeek.label || "—"} (Clicks ${metrics.bestWeek.totalClicks || 0})`;
const bestMonth = `⭐ Best Month: ${metrics.bestMonth.label || "—"} (Clicks ${metrics.bestMonth.totalClicks || 0})`;
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
const { count: totalCount, error: allClientsErr } = await trackPerf(`clients.list.${bucket}.count`, () => ops()
.from("people")
.select("client_id", { count: "exact", head: true }));
if (allClientsErr) {
logError("CLIENTS:list count", allClientsErr);
return smartRender(
ctx,
buildLoadWarning("client counts", allClientsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Clients", "CLIENTS:open")]])
);
}
const safeTotalCount = totalCount || 0;
const totalPages = Math.max(1, Math.ceil(safeTotalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const rows = await trackPerf(`clients.list.${bucket}.rows`, () => sbListClients({ bucket, limit: pageSize, offset }));
const title =
bucket === "needs_reply" ? "📝 Clients · Awaiting Reply"
: bucket === "active" ? "💬 Clients · Active"
: bucket === "completed" ? "✅ Clients · Completed"
: bucket === "new_month" ? "🆕 Clients · New This Month"
: bucket === "recent" ? "🕘 Clients · Recent"
: "📜 Clients · History";
const endItem = Math.min(offset + rows.length, safeTotalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${safeTotalCount}`;
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
navRow.push(Markup.button.callback("◀ Prev", `CLIENTS:list:${bucket}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶", `CLIENTS:list:${bucket}:${currentPage + 1}`));
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
const { count: totalCount, error: allThreadsErr } = await trackPerf(`client.threads.${clientId}.count`, () => ops()
.from("conversations")
.select("id", { count: "exact", head: true }));
if (allThreadsErr) {
logError("CLIENT:threads count", allThreadsErr);
return smartRender(
ctx,
buildLoadWarning("thread counts", allThreadsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]])
);
}
const safeTotalCount = totalCount || 0;
const totalPages = Math.max(1, Math.ceil(safeTotalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const threads = await trackPerf(`client.threads.${clientId}.rows`, () => sbListClientThreads(clientId, pageSize, offset));
const title = `🧵 Threads · ${idShort(clientId)}`;
const endItem = Math.min(offset + threads.length, safeTotalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${safeTotalCount}`;
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
navRow.push(Markup.button.callback("◀ Prev", `CLIENT:threads:${clientId}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶", `CLIENT:threads:${clientId}:${currentPage + 1}`));
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
const { count: totalCount, error: allSubsErr } = await trackPerf(`client.subs.${clientId}.count`, () => ops()
.from("submissions")
.select("submission_id", { count: "exact", head: true }));
if (allSubsErr) {
logError("CLIENT:subs count", allSubsErr);
return smartRender(
ctx,
buildLoadWarning("submission counts", allSubsErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]])
);
}
const safeTotalCount = totalCount || 0;
const totalPages = Math.max(1, Math.ceil(safeTotalCount / pageSize));
const currentPage = Math.min(page, totalPages);

const subs = await trackPerf(`client.subs.${clientId}.rows`, () => sbListClientSubmissions(clientId, pageSize, offset));
const title = `🧾 Submissions · ${idShort(clientId)}`;
const endItem = Math.min(offset + subs.length, safeTotalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${safeTotalCount}`;
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
navRow.push(Markup.button.callback("◀ Prev", `CLIENT:subs:${clientId}:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶", `CLIENT:subs:${clientId}:${currentPage + 1}`));
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
const { count: totalCount, error: countErr } = await trackPerf("calls.hub.count", () => ops()
.from("calls")
.select("id", { count: "exact", head: true }));
if (countErr) {
logError("CALLS:hub count", countErr);
return smartRender(
ctx,
buildLoadWarning("call counts", countErr),
Markup.inlineKeyboard([[Markup.button.callback("⬅ Dashboard", "DASH:back")]])
);
}
const safeTotalCount = totalCount || 0;
const totalPages = Math.max(1, Math.ceil(safeTotalCount / pageSize));
const currentPage = Math.min(page, totalPages);
  
const calls = await trackPerf("calls.hub.rows", () => sbListCalls({ limit: pageSize, offset }));
const endItem = Math.min(offset + calls.length, safeTotalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${safeTotalCount}`;
const body = calls.length ? calls.map(callSummaryLine).join("\n") + "\n──────────────────────" : "No calls found.";
// Just navigation buttons, no individual open buttons
const kb = [];
  
// Pagination buttons
const navRow = [];
if (currentPage > 1) {
navRow.push(Markup.button.callback("◀ Prev", `CALLS:hub:${currentPage - 1}`));
}
if (currentPage < totalPages) {
navRow.push(Markup.button.callback("Next ▶", `CALLS:hub:${currentPage + 1}`));
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
const recentMessages = await sbListMessages(conv.id, { offset: 0, limit: 6 });
const recentThreadContext = (recentMessages || [])
  .slice()
  .reverse()
  .map((m) => {
    const dir = String(m?.direction || "").toLowerCase() === "inbound" ? "inbound" : "outbound";
    const ts = String(m?.created_at || "").trim();
    const text = String(m?.body || m?.preview || "").replace(/\s+/g, " ").trim().slice(0, 320);
    return text ? `${dir}${ts ? ` @ ${ts}` : ""}: ${text}` : null;
  })
  .filter(Boolean);
const isPrograms = sourceSafe(conv.source) === "programs";
const prompt = {
contact_email: conv.contact_email || "",
subject: conv.subject || "",
preview: conv.preview || "",
latest_inbound: inbound?.body || inbound?.preview || "",
recent_thread_context: recentThreadContext,
coach_name: conv.coach_name || "",
source: conv.source || "support",
followup_due_at: conv.followup_next_action_at || conv.next_action_at || null,
};
const programsSystemPrompt = "You write thorough, human outreach replies for coach conversations. The sender is personal, mission-driven, and sounds like a real person, not a sales rep. Hard tone rule: outreach should be conversational and relationship-building while still professional. No corporate polish, no stiff formal greetings, no structured paragraphs, and no slangy hype language. Insurance mention rule: do not name any insurer except Aflac. If carrier credibility is mentioned, use this fact pattern: Aflac holds an AM Best financial strength rating of A+ (Superior), and coaches including Deion Sanders, Nick Saban, and Dawn Staley have publicly endorsed Aflac's mission of protecting families. HARD VOCABULARY RULE: use plain everyday words anyone would use in a normal conversation. No big words, no jargon. If a term must be used, explain what it means right away. Return JSON with v1,v2,v3 each containing subject and body."; 
const supportSystemPrompt = "You write thorough, structured support replies. Hard tone rule: support must be professional — clear, organized, and complete sentences. Not casual slang, not text-message style. Warm and easy to read. Fully answer every sender question before offering a next step. HARD SCOPE RULE: only answer what the sender asked in this thread, and do not add unrelated details or extra topics that were not asked. Keep the focus on supplemental health coverage first, with risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist. Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them. If tax is asked, include a clear explanation of 1099 reporting, taxable income basics, and practical next steps like tracking expenses and planning estimated taxes. If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills. Insurance mention rule: do not name any insurer except Aflac. Mention extra carrier credibility details only when credibility is explicitly asked. HARD VOCABULARY RULE: use plain everyday words that any parent can read easily. No big words, no industry jargon, no corporate language. If a term must be used, explain what it means right away. Return JSON with v1,v2,v3 each containing subject and body.";
const programsStyleVariant = [
  "A: longer complete answer in two paragraphs with direct clarity",
  "B: relationship-first tone with full question coverage and practical detail",
  "C: thorough coach-to-coach explanation with clear examples and next steps",
  "D: plain-language detailed response with complete context and full coverage",
  "E: low-pressure but fully developed response with specific options",
][Math.floor(Math.random() * 5)];
const programsUserPrompt = `Create 3 follow-up reply drafts for this Programs conversation:
${JSON.stringify(prompt)}

Rules:
- This is a manual reply in an ongoing outreach thread after the coach already answered
- Outreach tone should feel personal, human, and relationship-building while still professional
- Sound credible, experienced, and coach-to-coach
- Keep phrasing fluent and natural; avoid forced wording
- Fully answer the coach's actual question before suggesting any next step
- If the inbound asks multiple questions, answer each one clearly and efficiently
- If you use a greeting, use "Coach [LastName]" only
- Do not use first name only, and do not use full name in greeting
- If introducing this to families is relevant, include this simple line: "I can send a message you can forward, and you can review it before it is sent."
- If parent-group help is relevant, mention it only after the direct answer is clear and frame it as an easy follow-up resource
- INTRO TEMPLATE HARD RULE: use this base intro meaning and tone at the start of each draft, then create unique phrasing per version without changing the core facts: "Hey Coach [LastName] — I'm with NIL Wealth Strategies. We help student athletes at all levels really understand financial risks, how NIL income is taxed, and how to plan for injury-related expenses — things that usually aren't explained in a clear or practical way. I'm a former D1 athlete, and during my college career I went through three surgeries, so I saw firsthand how quickly out-of-pocket costs can stack up after an injury. Because of that, we prioritize high school athletes specifically for injury expense coverage, since parents are often the ones left dealing with those gaps that primary insurance doesn't fully cover on its own."
- INTRO STRUCTURE HARD RULE: paragraph one must be this intro (exact wording or a very close variation) and must keep all meaning and facts intact
- Keep these intro facts mandatory in every version: financial risk + NIL tax education + injury expense planning + former D1 + three surgeries + high school family gap context
- V2 is the quality bar for tone: warm, natural, relationship-focused, and easy to read
- Make V1 sound very close to that same warm V2 tone, but slightly more direct
- Make V3 sound close to that same warm V2 tone too, while being complete and professional
- Keep all words plain and simple — no big words, no jargon, use words anyone would use talking to a friend
- HARD VOCABULARY RULE: if a complex word is needed, explain what it means right away. Never write for someone to have to look something up
- Keep punctuation light no hype and no repeated exclamation points
- If the inbound message is a smooth/open reply answer directly and keep momentum
- If the inbound message is an objection acknowledge first reduce pressure then offer an easy next step
- Do not suggest calls meetings or calendar invites unless the inbound explicitly asks for that
- If no explicit meeting request exists the next step should be a simple reply or short forwardable resource
- Hard rule: never frame this as extra workload for the coach or staff
- If workload concern appears, state clearly the coach only forwards the message and support handles parent questions
- Explain this helps protect players by giving families clear accident and hospital-indemnity coverage education
- If discussing high school fit, explain this service is prioritized for high school athletes because parents often handle cost gaps on their own
- If discussing medical costs, explain that primary insurance usually requires deductibles, copays, and coinsurance to be paid before full medical expense coverage kicks in
- Hard memory rule: use only the facts in this thread payload
- Do not pull from any other client, coach, parent, campaign, dashboard metric, or prior conversation outside this thread
- HARD SCOPE RULE: only answer what is asked in this thread and do not add unneeded info
- Optional continuity rule: use recent_thread_context only when it helps answer the latest inbound clearly; if not needed, answer directly and do not force continuity references
- LENGTH HARD RULE: each version must be a complete, longer answer and should normally be 170-280 words unless the inbound explicitly asks for a short response
- Build each version in at least two paragraphs: paragraph one is intro context, paragraph two fully answers the coach's question(s) with specifics and then gives the next step
- Fully answer every point in the message — no word limit, write as much as needed
- Include one clear next step
- The next step sentence must explicitly include one of these phrases: "let me know", "reply", "share", or "send"
- After answering, include practical next steps by offering 2-3 simple options or inviting a direct reply to continue the conversation
- HARD UNIQUENESS RULE: not one full sentence should repeat across V1, V2, V3. Different openers, different sentence flow, different phrasing throughout, different CTA
- Never reuse the same opener across V1 V2 V3
- DIVERSITY REQUIREMENT: Each version must approach the answer from a completely different angle:
  - V1: Lead with acknowledgment/context, then direct answer, then actionable next
  - V2: Lead with the core answer immediately, then supporting details, then relationship-building close
  - V3: Lead with a question or challenge they face, then solution, then practical options
- Each version must use completely different vocabulary and sentence structure from the others
- Avoid repeating any words or phrases from prior versions - treat each as a fresh composition
- Vary sentence length dramatically: V1 varied, V2 emphasis on short/medium, V3 mix of short and longer
- Do not mention AI
- Do not invent specific counts (athletes, clients, families, teams, enrollments) unless explicitly provided
- Do not name any insurer except Aflac
- Style variant for this generation: ${programsStyleVariant}
- Avoid generic phrases like "valuable insights," "numerous teams," "unforeseen circumstances," or "navigate this complex topic"
Return: {"v1":{"subject":"...","body":"..."},"v2":{...},"v3":{...}}`;
const supportUserPrompt = `Create 3 reply drafts for this inbound conversation:\n${JSON.stringify(prompt)}\n\nRules:\n- Hard memory rule: use only the facts in this thread payload\n- Do not pull from any other client, coach, parent, campaign, dashboard metric, or prior conversation outside this thread\n- HARD SCOPE RULE: only answer the questions asked in this thread and do not add unneeded info or unrelated topics\n- Optional continuity rule: use recent_thread_context only when it helps answer the latest inbound clearly; if not needed, answer directly and do not force continuity references\n- HARD TONE RULE: support tone must be professional — clear, structured, complete sentences, warm and easy to read. No casual slang or conversational shorthand.\n- STYLE EXAMPLE FOR PARENT SUPPORT EMAILS (tone model only, do not copy verbatim): \"We are sharing this to help families better understand injury expense coverage for student-athletes. When an injury happens, primary insurance does not always cover everything, and families are often left to handle those extra costs on their own. Because of that, this is especially important for high school and youth athletes and their families. To help with this, supplemental health coverage is available. It works alongside your primary insurance and pays you directly if your child gets injured. The money can be used however you need - whether that is medical bills, travel, time off work, or other out-of-pocket expenses. The goal is to help you feel more prepared and avoid added financial stress during recovery. In addition to that, families also have access to simple guidance to better understand financial risks and NIL income tax education - areas that are not often taught but can become important as athletes move forward.\"\n- Keep the same required facts and answer content as before; this example is only for tone, clarity, and flow\n- Fully answer every sender question or concern before offering a next step\n- Keep the focus on supplemental health coverage first, then risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist\n- Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them\n- If tax is asked, include a clear explanation of 1099 reporting, taxable income basics, and practical next steps like tracking expenses and planning estimated taxes\n- If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills\n- If the sender says they already have coverage, explicitly explain this does not replace their existing plan and they still may not have accident insurance or hospital indemnity, and explain why those benefits matter\n- If the sender is skeptical or raises an objection, explicitly acknowledge the concern near the start in plain wording (for example: I understand your concern, or That is a fair question)\n- For objection replies, include an explicit no-pressure door-open line near the end (for example: No pressure, and if helpful we are happy to answer questions)\n- If the sender asks to stop contact or be removed, confirm removal clearly and do not push a guide\n- V1 answer-first and thorough — open directly with the full answer, cover every part of the question in depth, professional tone\n- V2 warm and thorough — open with empathy or acknowledgment first, then give the same complete answer with a relationship-focused tone\n- V3 organized and thorough — open from a completely different angle than V1 and V2, give the full answer in a different structural order, every question still fully covered\n- HARD UNIQUENESS RULE: not one sentence should repeat across V1, V2, V3. Different openers, different sentence flow, different phrasing throughout, different closing CTA\n- Each version must go deep on every question asked — do not skip or skim anything\n- HARD VOCABULARY RULE: use plain everyday words that any parent can read easily. No big words, no jargon, no corporate language. Do not use words like therefore or however. If a term must be used, explain what it means right away\n- Fully answer every point in the message — no word limit, write as much as needed\n- Keep the answer complete but avoid unnecessary filler and repetition\n- No greeting line at the start\n- Include one clear next step\n- After answering, include practical next steps by offering 2-3 simple options or inviting a direct reply to continue the conversation\n- Do not mention AI\n- Do not invent specific counts (athletes, clients, families, teams, enrollments) unless the count is explicitly provided in the prompt\n- Avoid generic filler or vague corporate language\nReturn: {\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}}`;
const res = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${OPENAI_API_KEY}`,
},
body: JSON.stringify({
model: "gpt-4o-mini",
temperature: isPrograms ? 0.95 : 0.7,
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
const drafts = promoteV3ToV1(parsed || {});
for (const k of ["v1", "v2", "v3"]) {
  if (drafts?.[k]?.subject) drafts[k].subject = normalizeMessageSpacing(drafts[k].subject);
  if (drafts?.[k]?.body) drafts[k].body = normalizeMessageSpacing(drafts[k].body);
}
if (isPrograms) {
  return drafts;
}
for (const k of ["v1", "v2", "v3"]) {
  if (drafts?.[k]?.body) {
    drafts[k].body = ensureAflacOption3(drafts[k].body, conv);
  }
}
return drafts;
}

async function generateCCDrafts(conv) {
if (!OPENAI_API_KEY) {
throw new Error("Missing OPENAI_API_KEY");
}
const parentGuideLink = parentGuideLinkForConversation(conv);
const officialWebsiteLink = officialWebsiteLinkForConversation(conv);
const prompt = {
contact_email: conv.contact_email || "",
subject: conv.subject || "",
preview: conv.preview || "",
coach_name: conv.coach_name || "",
source: conv.source || "outreach",
parent_guide_link: parentGuideLink,
official_website_link: officialWebsiteLink,
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
{ role: "system", content: "You write CC bridge and support messages. HARD TONE RULES: Bridge drafts should be conversational, and professional (not stiff, not slangy). Each bridge draft must explicitly tell the coach that the note below is what they can forward to the parent group. Include this simple line when relevant: I can send a message you can forward, and you can review it before it is sent. Do not repeat the coach's name in the bridge body. Never frame this as extra coach workload; clearly state the coach only forwards and support handles parent questions. Support drafts must be professional — clear, complete sentences, structured, warm and easy to read, written to be forwarded to parents. Support drafts are fully self-contained so a parent who has never heard of this program gets complete context. Support drafts must explicitly tell parents they can respond to this message with questions, explain what this email is about, and include a compelling, credible reason to click the parent guide link. HARD SCOPE RULE: only include information needed to answer this thread and do not add unrelated detail. HARD TEMPLATE RULE: V1 support must follow the required parent-forward message wording and section order exactly, and V2/V3 must be close variations of that same message with the same facts. Do not add any lines after the final sign-off line. Keep the focus on supplemental health coverage first, with risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist. Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them. Insurance mention rule: do not name any insurer except Aflac. If carrier credibility is mentioned, include: Aflac holds an AM Best financial strength rating of A+ (Superior), and coaches including Deion Sanders, Nick Saban, and Dawn Staley have publicly endorsed Aflac's mission of protecting families. HARD VOCABULARY RULE: use plain everyday words that any parent can read easily. No big words, no jargon, no corporate language. Do not use words like therefore or however. If a term must be used, explain what it means right away. Return JSON with bridge (v1-v3) and support (v1-v3) drafts, each with subject and body." },
{ role: "user", content: `Create CC drafts for this conversation:\n${JSON.stringify(prompt)}\n\nCreate 6 drafts total:\n\nBridge messages (sent from outreach to coach contact):\n- V1: Short/Direct (\"Looping in our support team...\")\n- V2: Warm/Personal (build relationship, mention parents will receive helpful info)\n- V3: Ultra-brief (executive style)\n- Bridge drafts should sound like a real person, not a support ticket\n- Each bridge draft must make clear that the note below is what the coach can forward to the parent group\n- Do not repeat the coach's name in the bridge body\n\nSupport messages (forwarded from ${SUPPORT_FROM_EMAIL} — parents are the final reader):\n- These are written assuming the coach will forward this email to their parent group\n- Parents reading this have no prior context — give them enough to understand what this is about\n- HARD TEMPLATE RULE: V1 support must use the required parent-forward message structure and facts exactly, including greeting, three core paragraphs, resource lines, credibility line, role-clarity paragraph, response line, thank-you line, and final sign-off "Best regards,\nThe NIL Wealth Strategies Team"\n- V2 and V3 must be unique variations of that same message while preserving the same facts and section order\n- Do not add any lines after "The NIL Wealth Strategies Team"\n- REQUIRED in every support draft:\n  1. Context opener: 1-2 sentences explaining what this email is and why they're receiving it\n  2. What this program provides for high school athletes and their families (supplemental health, risk education, tax education)\n  3. A clear line telling parents: \"You can respond to this message with any questions — we're happy to help.\"\n  4. A compelling, specific reason to click the parent guide — explain what families will actually find there and why it helps them review the option without pressure\n  5. MANDATORY LINKS with no exceptions:\n     - Parent Guide link on its own line: ${parentGuideLink}\n     - Official Website link on its own line: ${officialWebsiteLink}\n  6. Include role clarity in fluent wording: coaches do not sell, explain in detail, or enroll insurance; coaches do not handle money or paperwork; families review options and enroll directly with Aflac; Wealth Strategies provides education and support only\n  7. Include optional pace language in fluent wording: coverage is optional and families can move at their own pace\n  8. Build the message in this order: context, what families need to know, role clarity, guide value, response line\n- V1: Professional/Detailed — full context, all required elements, structured, answer-first flow\n- V2: Warm/Encouraging — open with empathy, parent-first tone, all required elements, different flow from V1\n- V3: Organized/Thorough — open from a different angle than V1 and V2, lead with the guide CTA, all required elements still covered\n\nGlobal rules:\n- HARD UNIQUENESS RULE: not one sentence should repeat across V1, V2, V3. Different openers, different flow, different phrasing throughout\n- Each version must fully cover all required elements — do not skip anything\n- HARD VOCABULARY RULE: use plain everyday words. No big words, no jargon, no corporate language. Do not use words like therefore or however. If a term must be used, explain what it means right away\n- Do not invent specific counts (athletes, clients, families, teams, enrollments) unless the count is explicitly provided in the prompt\n- Fully answer every point in the message — no word limit, write as much as needed\n- After answering, include practical next steps by offering 2-3 simple options or inviting a direct reply to continue the conversation\n- Avoid generic corporate filler\n- Never use the words NIL or Name, Image, and Likeness unless it was explicitly in the inbound message\nReturn: {\"bridge\":{\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}},\"support\":{\"v1\":{...},\"v2\":{...},\"v3\":{...}}}` }
]
})
});
if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
const json = await res.json();
const content = json?.choices?.[0]?.message?.content;
if (!content) throw new Error("No CC draft content from OpenAI");
const parsed = JSON.parse(content);
parsed.bridge = promoteV3ToV1(parsed?.bridge || {});
parsed.support = promoteV3ToV1(parsed?.support || {});
for (const key of ["v1", "v2", "v3"]) {
  const draft = parsed?.support?.[key];
  if (!draft || typeof draft.body !== "string") continue;
  const body = stripLeadingGreetingLine(String(draft.body || "").trim());
  const escapedGuideLink = parentGuideLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutGuideBlock = body
    .replace(new RegExp(`\\n*Learn more in the Parent Guide:\\n${escapedGuideLink}\\n*`, "g"), "\n")
    .replace(new RegExp(escapedGuideLink, "g"), "")
    .replace(/NIL Wealth Strategies/gi, "Wealth Strategies")
    .replace(/Name,\s*Image,\s*and\s*Likeness/gi, "")
    .replace(/\bNIL\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const hasRespondLine = /respond to this message/i.test(withoutGuideBlock);
  const hasCoachBoundary = /coaches? do not sell|coaches? do not handle money|enroll directly with aflac|education and support only/i.test(withoutGuideBlock);
  const hasOptionalPace = /optional|own pace|at their own pace|at your own pace/i.test(withoutGuideBlock);

  const roleClarity = [
    "Coaches do not sell, explain, or enroll insurance.",
    "Coaches do not handle money or paperwork.",
    "Families review coverage and enroll directly with Aflac.",
    "NIL Wealth Strategies provides education and support only.",
    "Coverage is optional, and families can review at their own pace.",
  ].join("\n");

  let nextBody = withoutGuideBlock;
  if (!hasCoachBoundary || !hasOptionalPace) {
    nextBody = `${nextBody}

${roleClarity}`.trim();
  }
  if (!hasRespondLine) {
    nextBody = `${nextBody}

You can respond to this message with any questions — we're happy to help.`.trim();
  }
  nextBody = `${nextBody}

Learn more in the Parent Guide:
${parentGuideLink}`.trim();
  const escapedWebsiteLink = officialWebsiteLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasWebsiteLink = new RegExp(escapedWebsiteLink, "i").test(nextBody);
  if (!hasWebsiteLink) {
    nextBody = `${nextBody}

Official Wealth Strategies Website:
${officialWebsiteLink}`.trim();
  }
  const aflacOption3Link = aflacProofLinkForConversation(conv) || DEFAULT_AFLAC_PROOF_URL;
  const privacySafeSupportByVersion = {
    v1: [
      "Dear parents,",
      "We're sharing this to help families better understand injury expense coverage for student-athletes. When an injury happens, primary insurance doesn't always cover everything, and families are often left to handle those extra costs on their own. Because of that, this is especially important for high school and youth athletes and their families.",
      "To help with this, supplemental health coverage is available. It works alongside your primary insurance and pays you directly if your child gets injured. The money can be used however you need - whether that's medical bills, travel, time off work, or other out-of-pocket expenses. The goal is to help you feel more prepared and avoid added financial stress during recovery.",
      "In addition to that, families also have access to simple guidance to better understand financial risks and NIL income tax education - areas that aren't often taught but can become important as athletes move forward. For detailed information, please check out the following resources:",
      `- Learn more in the Parent Guide: ${parentGuideLink}`,
      `- Official Wealth Strategies Website: ${officialWebsiteLink}`,
      `- To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury: ${aflacOption3Link}`,
      "Backed by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders.",
      "Please note that coaches do not sell, explain, or enroll insurance. Coaches do not handle money or paperwork. Families review coverage and enroll directly with Aflac. NIL Wealth Strategies provides education and support only.",
      "You can respond to this message with any questions — we're happy to help.",
      "Thank you for your attention and support in ensuring our athletes are well-protected.",
      "Best regards,\nThe NIL Wealth Strategies Team",
    ].join("\n\n"),
    v2: [
      "Dear parents,",
      "We're sharing this so families can clearly understand injury expense coverage for student-athletes. When an injury happens, primary insurance does not always cover every cost, and families can end up carrying extra expenses themselves. This matters most for high school and youth athletes and their families.",
      "Supplemental health coverage is available to help with that gap. It works alongside your primary insurance and pays you directly if your child gets injured. Those funds can be used for medical bills, travel, time off work, or other out-of-pocket costs, so families can feel more prepared during recovery.",
      "Families also have access to simple guidance on financial risks and NIL income tax education - topics that are often not explained early but can become important as athletes move forward. For detailed information, please check out the following resources:",
      `- Learn more in the Parent Guide: ${parentGuideLink}`,
      `- Official Wealth Strategies Website: ${officialWebsiteLink}`,
      `- To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury: ${aflacOption3Link}`,
      "Backed by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders.",
      "Please note that coaches do not sell, explain, or enroll insurance. Coaches do not handle money or paperwork. Families review coverage and enroll directly with Aflac. NIL Wealth Strategies provides education and support only.",
      "You can respond to this message with any questions — we're happy to help.",
      "Thank you for your attention and support in ensuring our athletes are well-protected.",
      "Best regards,\nThe NIL Wealth Strategies Team",
    ].join("\n\n"),
    v3: [
      "Dear parents,",
      "We're sharing this to help families review injury expense coverage for student-athletes in a practical way. Primary insurance can leave gaps after an injury, and families are often left covering extra costs on their own. That is why this is especially important for high school and youth athletes and their families.",
      "Supplemental health coverage is one way to help close those gaps. It works with your primary insurance and pays you directly if your child gets injured. Families can use that money for medical bills, travel, missed work time, and other out-of-pocket expenses, which helps reduce financial stress during recovery.",
      "Alongside coverage education, families can also access simple guidance on financial risks and NIL income tax education - areas that are often not taught clearly but can become important over time. For detailed information, please check out the following resources:",
      `- Learn more in the Parent Guide: ${parentGuideLink}`,
      `- Official Wealth Strategies Website: ${officialWebsiteLink}`,
      `- To see this in a real-world example of how coverage works and the amount of benefit payout you may receive from an injury: ${aflacOption3Link}`,
      "Backed by Aflac, AM Best A+ (Superior), with 80 years in supplemental health and trusted by coaches including Nick Saban, Dawn Staley, and Deion Sanders.",
      "Please note that coaches do not sell, explain, or enroll insurance. Coaches do not handle money or paperwork. Families review coverage and enroll directly with Aflac. NIL Wealth Strategies provides education and support only.",
      "You can respond to this message with any questions — we're happy to help.",
      "Thank you for your attention and support in ensuring our athletes are well-protected.",
      "Best regards,\nThe NIL Wealth Strategies Team",
    ].join("\n\n"),
  };
  nextBody = privacySafeSupportByVersion[key] || nextBody;
  draft.body = ensureAflacOption3(nextBody, conv);
}
return parsed;
}

// CC drafts cache (in-memory, per conversation)
const ccDraftsCache = new Map();

function draftsKeyboard(convId, selectedVersion = 1) {
const tag = (v) => selectedVersion === v ? " ✅" : "";
return Markup.inlineKeyboard([
[Markup.button.callback(`View V1${tag(1)}`, `DRAFTS:view:${convId}:1`), Markup.button.callback(`View V2${tag(2)}`, `DRAFTS:view:${convId}:2`), Markup.button.callback(`View V3${tag(3)}`, `DRAFTS:view:${convId}:3`)],
[Markup.button.callback("✏️ Edit Selected", `DRAFTS:edit:${convId}`), Markup.button.callback("♻️ Regenerate", `DRAFTS:regen:${convId}`)],
[Markup.button.callback("📤 Send (Support)", `CONFIRMSEND:${convId}:${selectedVersion}:support`), Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]
]);
}

async function renderDraftsCard(ctx, convId, note = "") {
const drafts = await sbListConversationDrafts(convId);
const selected = drafts.find((d) => d.selected) || drafts[0] || null;
let text = `✍️ Reply Drafts (V1/V2/V3)\nConversation: ${idShort(convId)}\n`;
if (note) text += `\n${note}\n`;
if (!drafts.length) {
text += "\nNo drafts yet. Tap Regenerate.";
return smartRender(ctx, text, draftsKeyboard(convId, 1));
}
if (selected) {
text += `\n✅ Selected: V${selected.version}`;
text += `\n📧 Subject: ${selected.subject || "—"}\n`;
text += `\n📝 Body:\n${selected.body || "(empty)"}\n`;
}
for (const d of drafts) {
if (selected && d.version === selected.version) continue;
text += `\n▫️ V${d.version} Preview\nSubject: ${d.subject || "—"}\n${shorten(d.body || "", 180)}\n`;
}
return smartRender(ctx, text, draftsKeyboard(convId, selected?.version || 1));
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
await sbSelectConversationDraft(convId, version);
await renderDraftsCard(ctx, convId, `Viewing V${version}`);
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
await renderDraftsCard(ctx, convId, `✅ Selected V${version}`);
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
const threadingContext = buildThreadingContext(conv);
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
body: rewriteOutboundTrackedLinks(bodyOverride ?? "", conv),
cc_support: !!ccSupport,
send_as: sendAs,
from_email: fromEmail,
// threading support
...threadingContext,
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
`⚠ ${actionLabel} is disabled for Instantly-managed conversations.\n\nUse 📌 Loop in Support from the conversation card.`,
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
const isFollowupPipeline = String(conv.pipeline || "").toLowerCase() === "followups";
// Follow-up due items can still be sent as outreach unless the conversation is truly support-lane.
const isLockedToSupport = isSupport || (isCCd && !isFollowupPipeline);

// If locked to one mode, skip the choice
if (isLockedToSupport) {
// Support mode only
await smartRender(
ctx,
`📤 Send Draft (Support)\n\nSend lane is locked to Support.\n\n${isSupport ? "This is a Support conversation." : "Loop in Support has been enabled."}`,
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
const followupHint = isFollowupPipeline
? "\n\nTimed follow-up: outreach remains available for continuity."
: "";
await smartRender(ctx, `📤 Send Draft\n\nChoose sending lane:\n\n(Outreach selected by default. Use Support only if CC is enabled manually.)${followupHint}`, kb);
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
const userId = String(meta.user_id || chatId);
liveCards.set(msg.message_id, {
...meta,
chat_id: chatId,
user_id: userId,
added_at: Date.now(),
});
markAdminActivity({
  userId,
  chatId,
  cardType: meta.type || null,
  messageId: msg.message_id,
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

// Fast path: if no targeted refresh was queued, skip periodic sweep work.
if (!force && refreshQueue.size === 0) return;

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
setInterval(() => {
runDataWatchdog().catch(() => {});
}, WATCHDOG_INTERVAL_MS);
setInterval(() => {
runIdleDashboardResetSweep().catch(() => {});
}, ADMIN_IDLE_DASHBOARD_CHECK_MS);
setTimeout(() => {
runOutboxSenderTick().catch(() => {});
}, 1500);
setTimeout(() => {
runDataWatchdog({ forceSchema: true }).catch(() => {});
}, 2500);
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
if (!verifyOpsIngestAuth(req)) {
return res.status(401).json({ ok: false });
}
const b = req.body || {};
const nowIso = new Date().toISOString();
// ---- normalize canonical envelope ----
const schema_version = b.schema_version || "5.3";
let event_type = String(b.event_type || "unknown.event");
const source = String(b.source || "unknown");
const direction = String(b.direction || "inbound");
const trace_id = String(b.trace_id || uuidv4());
let idempotency_key = b.idempotency_key ? String(b.idempotency_key) : null;
const entity_type = b.entity_type ? String(b.entity_type) : null;
const entity_id = b.entity_id ? String(b.entity_id) : null;
const submission_id =
b.submission_id ||
b.payload?.submission_id ||
b.payload?.submissionId ||
null;
const client_email = b.client?.email || b.client_email || null;
const client_phone_e164 = b.client?.phone_e164 || b.client_phone_e164 || null;

let payload = b.payload || b;

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
  idempotency_key = deriveInstantlyReplyIdempotencyKey({ leadId: idemLeadId, timestamp: idemTs });
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
});
// if deduped, do NOT re-run state upserts
if (inserted?.deduped) {
return res.json({ ok: true, deduped: true });
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
  const outreach_from_email = normalizeEmail(
    payload?.outreach_from_email ||
    payload?.from_email ||
    b.outreach_from_email ||
    b.from_email ||
    OUTREACH_FROM_EMAIL ||
    ""
  ) || null;
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
            from_email: lead_email,
            to_email: outreach_from_email,
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
            from_email: outreach_from_email,
            to_email: lead_email,
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
        ? Markup.inlineKeyboard([[Markup.button.callback("📌 Loop in Support", `CC:${conversationId}`)]])
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
  const email_body = safeStr(payload?.email_body || payload?.emailBody || b.email_body || b.emailBody || "");
  const outreach_from_email = normalizeEmail(
    payload?.outreach_from_email ||
    payload?.from_email ||
    b.outreach_from_email ||
    b.from_email ||
    OUTREACH_FROM_EMAIL ||
    ""
  ) || null;
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
      try {
        const outboundMsg = {
          conversation_id: conversationId,
          direction: "outbound",
          from_email: outreach_from_email,
          to_email: lead_email,
          subject: safeStr(email_subject) || "Instantly Outreach",
          body: email_body || `Outreach sent from ${outreach_from_email || "configured outreach sender"}.`,
          preview: shorten(email_body || safeStr(email_subject) || "Outreach sent", 200),
          sender: "instantly_ai",
          source_ref: lead_id || null,
          created_at: sentTsIso,
        };
        const { error: outMsgErr } = await ops().from("messages").insert(outboundMsg);
        if (outMsgErr && isMissingColumnError(outMsgErr)) {
          const fallbackOutboundMsg = { ...outboundMsg };
          delete fallbackOutboundMsg.sender;
          delete fallbackOutboundMsg.source_ref;
          const { error: fallbackOutErr } = await ops().from("messages").insert(fallbackOutboundMsg);
          if (fallbackOutErr) throw fallbackOutErr;
        } else if (outMsgErr) {
          throw outMsgErr;
        }
      } catch (outMsgErr) {
        logError("instantly_email_sent.insert_outbound_message", outMsgErr);
      }

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
// CC SUPPORT ACTIVATION (programmatic — e.g., from n8n automation or external trigger)
// Sets cc_support_suggested=true so the Telegram card reflects CC has been activated
// without requiring the admin to manually tap the button.
if (event_type === EVENT_TYPES.CC_SUPPORT_ACTIVATED) {
  if (entity_id) {
    const { error: ccActErr } = await ops()
      .from("conversations")
      .update({
        cc_support_suggested: true,
        needs_support_handoff: false,
        needs_support_handoff_at: null,
        updated_at: nowIso,
      })
      .eq("id", entity_id);
    if (ccActErr && !isMissingColumnError(ccActErr)) {
      console.warn("cc_support.activated update error:", ccActErr.message);
    }
    refreshQueue.add(makeCardKey("conversation", entity_id));
    refreshQueue.add("triage:all");
    refreshQueue.add("dashboard:all");
    refreshQueue.add("allq:all");
  } else {
    console.warn("cc_support.activated missing entity_id — flag not set");
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

    const parseTrackingParams = (rawLink, queryObj = {}, bodyObj = {}) => {
      const out = {
        coach_id: null,
        campaign_id: null,
        actor_id: null,
        actor_type: null,
        person_id: null,
        person_email: null,
        person_key: null,
        person_key_source: null,
        guide_key: null,
      };
      const readFromSearch = (sp) => {
        out.coach_id = sp.get("coach_id") || sp.get("coachId") || sp.get("cid") || out.coach_id;
        out.campaign_id = sp.get("campaign_id") || sp.get("campaignId") || sp.get("camp") || out.campaign_id;
        out.actor_id = sp.get("actor_id") || sp.get("actorId") || sp.get("aid") || out.actor_id;
        out.actor_type = sp.get("actor_type") || sp.get("actorType") || sp.get("at") || out.actor_type;
        out.person_id = sp.get("person_id") || sp.get("personId") || sp.get("pid") || out.person_id;
        out.person_email = sp.get("person_email") || sp.get("personEmail") || sp.get("pe") || out.person_email;
        out.person_key = sp.get("person_key") || sp.get("personKey") || sp.get("pk") || out.person_key;
        out.person_key_source = sp.get("person_key_source") || sp.get("personKeySource") || sp.get("pks") || out.person_key_source;
        out.guide_key = sp.get("guide_key") || sp.get("guideKey") || sp.get("g") || out.guide_key;
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
      out.actor_id = out.actor_id || q.actor_id || q.actorId || null;
      out.actor_type = out.actor_type || q.actor_type || q.actorType || null;
      out.person_id = out.person_id || q.person_id || q.personId || null;
      out.person_email = out.person_email || q.person_email || q.personEmail || null;
      out.person_key = out.person_key || q.person_key || q.personKey || null;
      out.person_key_source = out.person_key_source || q.person_key_source || q.personKeySource || null;
      out.guide_key = out.guide_key || q.guide_key || q.guideKey || null;

      const b = bodyObj || {};
      out.coach_id = out.coach_id || b.coach_id || b.coachId || null;
      out.campaign_id = out.campaign_id || b.campaign_id || b.campaignId || null;
      out.actor_id = out.actor_id || b.actor_id || b.actorId || null;
      out.actor_type = out.actor_type || b.actor_type || b.actorType || null;
      out.person_id = out.person_id || b.person_id || b.personId || null;
      out.person_email = out.person_email || b.person_email || b.personEmail || null;
      out.person_key = out.person_key || b.person_key || b.personKey || null;
      out.person_key_source = out.person_key_source || b.person_key_source || b.personKeySource || null;
      out.guide_key = out.guide_key || b.guide_key || b.guideKey || null;

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

    const tracking = parseTrackingParams(link, req.query || {}, req.body || {});
    const resolvedCoachId = tracking.coach_id || coach_id || null;
    const resolvedCampaignId = tracking.campaign_id || req.body?.campaign_id || req.body?.campaignId || null;
    const normalizedKind = String(kind || "").trim();
    const resolvedGuideKey = normalizeGuideKey(tracking.guide_key || normalizedKind);
    const metaActorType = meta?.actor_type || meta?.actorType || null;
    const metaActorId = meta?.actor_id || meta?.actorId || null;
    const resolvedActorType = String(tracking.actor_type || metaActorType || "").trim().toLowerCase() || null;
    const resolvedActorId = String(tracking.actor_id || metaActorId || "").trim() || null;
    const personEmail = normalizeEmail(tracking.person_email || meta?.person_email || meta?.personEmail || "");
    const personId = String(tracking.person_id || meta?.person_id || meta?.personId || "").trim() || null;
    const incomingPersonKey = String(tracking.person_key || meta?.person_key || meta?.personKey || "").trim() || null;
    const personKeySource = String(tracking.person_key_source || meta?.person_key_source || meta?.personKeySource || "").trim().toLowerCase() || "";

    const personSeed = incomingPersonKey
      ? null
      : (personId
        ? `person_id:${personId}`
        : (personEmail
          ? `person_email:${personEmail}`
          : (resolvedActorId && !isCoachLikeActorType(resolvedActorType)
            ? `actor_id:${resolvedActorId}`
            : null)));
    const resolvedPersonKey = incomingPersonKey || (personSeed
      ? crypto.createHash("sha256").update(personSeed).digest("hex")
      : null);
    const isCoachSelfClick = Boolean(
      resolvedCoachId &&
      resolvedActorId &&
      isCoachLikeActorType(resolvedActorType) &&
      String(resolvedCoachId) === String(resolvedActorId)
    );
    const isCoachActor = isCoachLikeActorType(resolvedActorType);
    const dedupeKey = (resolvedCoachId && resolvedGuideKey && resolvedPersonKey)
      ? crypto.createHash("sha256").update(`${resolvedCoachId}|${resolvedGuideKey}|${resolvedPersonKey}`).digest("hex")
      : null;
    const hasExplicitRecipientIdentity = Boolean(
      personId ||
      personEmail ||
      (incomingPersonKey && personKeySource === "query")
    );

    const referrer = req.header("referer") || req.header("referrer") || meta?.referrer || req.body?.referrer || "";
    const clickSource = inferClickSource(referrer);
    const uaLower = String(meta?.ua || req.header("user-agent") || "").toLowerCase();
    const purposeLower = String(req.header("purpose") || req.header("sec-purpose") || meta?.purpose || "").toLowerCase();
    const xMoz = String(req.header("x-moz") || "").toLowerCase();
    const isBotTraffic = Boolean(
      meta?.is_bot_traffic === true ||
      uaLower.includes("bot") ||
      uaLower.includes("spider") ||
      uaLower.includes("crawler") ||
      uaLower.includes("facebookexternalhit") ||
      uaLower.includes("slackbot") ||
      purposeLower.includes("prefetch") ||
      purposeLower.includes("preview") ||
      xMoz.includes("prefetch")
    );

    const bodyTs = req.body?.ts || null;
    const bodySource = req.body?.source || "cloudflare";
    const bodyValue = req.body?.value != null ? Number(req.body.value) : 1;

    let forwardedUnique = false;
    let forwardedDedupeState = "not_applicable";
    if (dedupeKey && !isCoachSelfClick && !isCoachActor && resolvedGuideKey && !isBotTraffic && hasExplicitRecipientIdentity) {
      const registryRow = {
        dedupe_key: dedupeKey,
        tracking_code: dedupeKey,
        coach_id: resolvedCoachId,
        guide_key: resolvedGuideKey,
        person_key: resolvedPersonKey,
        actor_type: resolvedActorType,
        actor_id: resolvedActorId,
        is_coach_self_click: isCoachSelfClick,
        campaign_id: resolvedCampaignId,
        source: bodySource,
        link: link ?? null,
        first_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const { error: registryErr } = await ops().from("click_link_registry").insert(registryRow);
      if (registryErr?.code === "23505" || String(registryErr?.message || "").toLowerCase().includes("duplicate")) {
        forwardedUnique = false;
        forwardedDedupeState = "duplicate";
      } else if (registryErr && isMissingColumnError(registryErr)) {
        forwardedDedupeState = "schema_missing";
      } else if (registryErr) {
        console.error("[click_link_registry insert error]", registryErr.message);
        forwardedDedupeState = "error";
      } else {
        forwardedUnique = true;
        forwardedDedupeState = "inserted";
      }
    } else if (isBotTraffic) {
      forwardedDedupeState = "ignored_bot";
    } else if (isCoachActor) {
      forwardedDedupeState = "ignored_coach_actor";
    } else if (!hasExplicitRecipientIdentity) {
      forwardedDedupeState = "ignored_weak_identity";
    }

    // Insert into schema `nil`
    const clickRow = {
      coach_id: resolvedCoachId ?? null,
      campaign_id: resolvedCampaignId ?? null,
      click_source: clickSource,
      click_type: kind,
      kind,
      event_type: kind,
      source: bodySource,
      value: bodyValue,
      event_time: bodyTs ? new Date(bodyTs).toISOString() : new Date().toISOString(),
      link: link ?? null,
      guide_key: resolvedGuideKey || null,
      person_key: resolvedPersonKey || null,
      actor_type: resolvedActorType || null,
      actor_id: resolvedActorId || null,
      is_coach_self_click: isCoachSelfClick,
      dedupe_key: dedupeKey,
      is_unique_forwarded: forwardedUnique,
      meta: {
        ...(meta ?? {}),
        is_bot_traffic: isBotTraffic,
        person_key_source: personKeySource || null,
        has_explicit_recipient_identity: hasExplicitRecipientIdentity,
      },
    };

    let { error } = await supabase
      .schema("nil")
      .from("click_events")
      .insert([clickRow]);

    if (error && isMissingColumnError(error)) {
      const legacyRow = {
        coach_id: resolvedCoachId ?? null,
        campaign_id: resolvedCampaignId ?? null,
        click_source: clickSource,
        click_type: kind,
        kind,
        event_type: kind,
        source: bodySource,
        value: bodyValue,
        event_time: bodyTs ? new Date(bodyTs).toISOString() : new Date().toISOString(),
        link: link ?? null,
        meta: meta ?? {},
      };
      const retry = await supabase
        .schema("nil")
        .from("click_events")
        .insert([legacyRow]);
      error = retry.error;
    }

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
      guide_key: resolvedGuideKey || null,
      actor_type: resolvedActorType,
      actor_id: resolvedActorId,
      person_key: resolvedPersonKey,
      dedupe_key: dedupeKey,
      forwarded_unique: forwardedUnique,
      forwarded_dedupe_state: forwardedDedupeState,
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

    // Update claimed rows to 'sending' — increment attempt_count per-row
    // (Supabase JS v2 does not support SQL expressions in .update(), so we use JS arithmetic)
    if (claimableRows.length > 0) {
      for (const row of claimableRows) {
        const { error: updateError } = await ops()
          .from("n8n_outbox")
          .update({
            status: "sending",
            attempt_count: (row.attempt_count || 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq("outbox_id", row.outbox_id);
        if (updateError) throw updateError;
      }
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

// ---------- DEBUG: TEST SCENARIO RUNNER ----------
// Runs the same scenario generator used by /test and returns pages for verification.
app.post("/debug/test-scenario", async (req, res) => {
  try {
    const secret = req.header("x-nil-secret");
    if (!secret || secret !== BASE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: "OPENAI_API_KEY not configured" });
    }

    const requestedType = String(req.body?.scenarioType || req.body?.scenario_type || "OUTREACH_COACH_INTEREST").trim();
    const validTypes = ["OUTREACH_COACH_INTEREST", "PARENT_BASIC_QUESTION", "OBJECTION_INSURANCE", "REMOVAL_DEMAND"];
    const scType = validTypes.includes(requestedType) ? requestedType : "OUTREACH_COACH_INTEREST";

    const result = await runTestScenario(scType);
    testScenarioCache.set(result.convId, result);
    if (testScenarioCache.size > 30) {
      const firstKey = testScenarioCache.keys().next().value;
      testScenarioCache.delete(firstKey);
    }

    return res.status(200).json({
      ok: true,
      scenario_type: scType,
      conv_id: result.convId,
      page_count: result.pages.length,
      draft_page_index: result.draftPageIndex,
      pages: result.pages,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ---------- HEALTH ----------
async function buildFirmReadinessReport() {
  const criticalFailures = [];
  const warnings = [];
  const schemaChecks = [];

  const requireConfigured = (value, name) => {
    if (!value) criticalFailures.push(`${name} missing`);
  };

  requireConfigured(SUPABASE_URL, "SUPABASE_URL");
  requireConfigured(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  if (ENABLE_TELEGRAM_BOT) requireConfigured(BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
  requireConfigured(BASE_WEBHOOK_SECRET, "BASE_WEBHOOK_SECRET");
  requireConfigured(OPS_WEBHOOK_HMAC_SECRET, "OPS_WEBHOOK_HMAC_SECRET");
  requireConfigured(CC_SUPPORT_WEBHOOK_URL, "CC_SUPPORT_WEBHOOK_URL");
  requireConfigured(HANDOFF_WEBHOOK_URL, "HANDOFF_WEBHOOK_URL");

  if (!FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY) {
    criticalFailures.push("FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY must be true");
  }
  if (!ADMIN_IDS.length) {
    criticalFailures.push("ADMIN_TELEGRAM_IDS must include at least one admin user");
  }

  if (!OPENAI_API_KEY) warnings.push("OPENAI_API_KEY missing (draft generation disabled)");
  if (!MAKE_SEND_WEBHOOK_URL) warnings.push("MAKE_SEND_WEBHOOK_URL missing (send workflow fallback inactive)");
  if (!OUTREACH_FROM_EMAIL) warnings.push("OUTREACH_FROM_EMAIL missing");
  if (FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY && !CLICK_TRACKER_BASE_URL) {
    warnings.push("CLICK_TRACKER_BASE_URL missing (strict forwarded identity may not be enforced in outbound links)");
  }

  const runSchemaCheck = async (name, queryFactory, critical = true) => {
    try {
      const { error } = await queryFactory();
      if (error) throw error;
      schemaChecks.push({ name, ok: true });
    } catch (err) {
      const msg = String(err?.message || err || "unknown");
      schemaChecks.push({ name, ok: false, error: msg });
      if (critical) criticalFailures.push(`schema check failed: ${name}`);
      else warnings.push(`schema check degraded: ${name}`);
    }
  };

  await runSchemaCheck("ops_events_contract", () =>
    ops().from("ops_events").select("id, event_type, idempotency_key").limit(1)
  );
  await runSchemaCheck("conversation_handoff_columns", () =>
    ops()
      .from("conversations")
      .select("id, pipeline, needs_support_handoff, needs_support_handoff_at, handoff_detected_reason, cc_support_suggested")
      .limit(1)
  );
  await runSchemaCheck("click_registry_contract", () =>
    ops().from("click_link_registry").select("id, dedupe_key, coach_id, guide_key, person_key").limit(1)
  );
  await runSchemaCheck("click_events_forwarded_columns", () =>
    ops().from("click_events").select("id, dedupe_key, is_unique_forwarded, person_key, actor_type, actor_id").limit(1)
  );

  const ok = criticalFailures.length === 0;
  return {
    ok,
    grade: ok ? "firm-ready" : "not-ready",
    critical_failures: criticalFailures,
    warnings,
    controls: {
      forwarded_strict_identity: FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY,
      click_tracker_base_configured: !!CLICK_TRACKER_BASE_URL,
      ops_hmac_enabled: !!OPS_WEBHOOK_HMAC_SECRET,
      base_secret_enabled: !!BASE_WEBHOOK_SECRET,
      watchdog_admin_notify: WATCHDOG_NOTIFY_ADMINS,
      watchdog_alert_only_warn: WATCHDOG_ALERT_ONLY_WARN,
      admin_idle_reset_hours: ADMIN_IDLE_DASHBOARD_RESET_HOURS,
    },
    schema_checks: schemaChecks,
    checked_at: new Date().toISOString(),
  };
}

app.get("/health", async (_req, res) => {
  const warnings = [];
  if (!MAKE_SEND_WEBHOOK_URL) warnings.push("MAKE_SEND_WEBHOOK_URL missing");
  if (!CC_SUPPORT_WEBHOOK_URL) warnings.push("CC_SUPPORT_WEBHOOK_URL missing");
  if (!HANDOFF_WEBHOOK_URL) warnings.push("HANDOFF_WEBHOOK_URL missing");
  if (!OPENAI_API_KEY) warnings.push("OPENAI_API_KEY missing");
  if (!SUPPORT_FROM_EMAIL) warnings.push("SUPPORT_FROM_EMAIL missing");
  if (!OUTREACH_FROM_EMAIL) warnings.push("OUTREACH_FROM_EMAIL missing");
  if (FORWARDED_REQUIRE_EXPLICIT_RECIPIENT_IDENTITY && !CLICK_TRACKER_BASE_URL) {
    warnings.push("CLICK_TRACKER_BASE_URL missing");
  }
  const wd = await runDataWatchdog();
  const workflowIssues = (wd?.workflows?.checks || [])
    .filter((wf) => wf.status === "warn" || wf.status === "degraded" || wf.status === "unknown" || (wf.issues || []).length)
    .slice(0, 8)
    .map((wf) => ({
      id: wf.id,
      status: wf.status,
      detail: wf.detail,
      issues: Array.isArray(wf.issues) ? wf.issues.slice(0, 3).map((issue) => issue.summary) : [],
    }));
  const operationsIssues = (wd?.operationsRisk?.checks || [])
    .filter((check) => check.status === "warn" || check.status === "degraded" || check.status === "unknown")
    .slice(0, 8)
    .map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.summary,
    }));

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
      click_tracker_base_configured: !!CLICK_TRACKER_BASE_URL,
    },
    features: {
      telegram_bot_enabled: ENABLE_TELEGRAM_BOT,
      telegram_bot_active: TELEGRAM_BOT_ACTIVE,
      live_refresh_enabled: ENABLE_TELEGRAM_LIVE_REFRESH,
    },
    watchdog: {
      overall: wd?.overallStatus || "unknown",
      workflows: wd?.workflows?.overall || "unknown",
      operationsRisk: wd?.operationsRisk?.overall || "unknown",
      schema: wd?.schema?.overall || "unknown",
      workflowIssues,
      operationsIssues,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", (_req, res) => {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!BASE_WEBHOOK_SECRET && !OPS_WEBHOOK_HMAC_SECRET) {
    missing.push("BASE_WEBHOOK_SECRET or OPS_WEBHOOK_HMAC_SECRET");
  }
  if (!BOT_TOKEN && ENABLE_TELEGRAM_BOT) missing.push("TELEGRAM_BOT_TOKEN");

  if (missing.length > 0) {
    return res.status(503).json({ ok: false, missing });
  }

  return res.json({ ok: true, missing: [] });
});

app.get("/ready/firm", async (_req, res) => {
  const report = await buildFirmReadinessReport();
  if (!report.ok) {
    return res.status(503).json(report);
  }
  return res.json(report);
});

// ---------- START ----------
const server = app.listen(PORT, "0.0.0.0", () => {
console.log(`Webhook server listening on 0.0.0.0:${PORT}`);
console.log(`${CODE_VERSION} · Build ${BUILD_VERSION}`);
if (!N8N_BASE_URL) {
  console.warn("[STARTUP] N8N_BASE_URL is missing. Watchdog n8n checks will fail.");
}
if (!N8N_API_KEY) {
  console.warn("[STARTUP] N8N_API_KEY is missing/empty. Watchdog n8n checks will return HTTP 401.");
} else {
  console.log(`[STARTUP] N8N watchdog auth enabled (N8N_BASE_URL=${N8N_BASE_URL})`);
}
});
if (TELEGRAM_BOT_ACTIVE) {
// ==========================================================
// CRITICAL: GLOBAL TELEGRAM BOT PROTECTION MIDDLEWARE
// ==========================================================
// This middleware AUTOMATICALLY handles callback queries and adds timeout protection
// for ALL bot actions and commands, preventing timeouts and freezes

bot.use(async (ctx, next) => {
if (isAdmin(ctx)) {
  markAdminActivity({
    userId: String(ctx.from?.id || ""),
    chatId: ctx.chat?.id ?? ctx.from?.id,
  });
}
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
});

// Global error handler for bot actions/commands
bot.catch((err, ctx) => {
if (!ctx) {
  console.error("[BOT ERROR] No context:", err?.message || String(err));
  return;
}
console.error(`[BOT ERROR] Update ${ctx?.update?.update_id || "unknown"}:`, err);
logError("bot.middleware", err);
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
} else {
ctx.reply("❌ An error occurred. Try /dashboard to refresh.").catch(() => {});
}
} catch (_) {}
});

let botLaunchRetryCount = 0;
let botLaunchRetryTimer = null;
let botLaunching = false;

function botLaunchBackoffMs(attempt) {
  if (attempt <= 1) return 2000;
  if (attempt <= 3) return 5000;
  if (attempt <= 8) return 10000;
  return 15000;
}

async function startBotLaunchLoop() {
  if (botLaunching) return;
  botLaunching = true;
  try {
    // Ensure polling mode isn't blocked by stale webhook configuration.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    await bot.launch();
    const me = await bot.telegram.getMe().catch(() => null);
    botLaunchRetryCount = 0;
    if (botLaunchRetryTimer) {
      clearTimeout(botLaunchRetryTimer);
      botLaunchRetryTimer = null;
    }
    if (me?.username) {
      console.log(`[INFO] Telegram bot connected as @${me.username} (${me.id})`);
    } else {
      console.log("[INFO] Telegram bot connected");
    }
  } catch (err) {
    const msg = String(err?.description || err?.message || "");
    const code = Number(err?.response?.error_code || err?.error_code || 0);
    const is409 = code === 409 || msg.includes("Conflict") || msg.includes("other getUpdates request");
    botLaunchRetryCount += 1;
    const waitMs = botLaunchBackoffMs(botLaunchRetryCount);
    const waitSec = Math.round(waitMs / 1000);

    if (is409) {
      console.warn(`[WARN] Telegram launch conflict (409). Retrying in ${waitSec}s (attempt ${botLaunchRetryCount})`);
      if (botLaunchRetryCount >= 3) {
        console.warn("[WARN] Another process is polling this same Telegram bot token. Ensure only one bot instance is running.");
      }
    } else {
      logError("bot.launch", err);
      console.warn(`[WARN] Telegram launch failed. Retrying in ${waitSec}s (attempt ${botLaunchRetryCount})`);
    }

    if (botLaunchRetryTimer) clearTimeout(botLaunchRetryTimer);
    botLaunchRetryTimer = setTimeout(() => {
      startBotLaunchLoop().catch(() => {});
    }, waitMs);
  } finally {
    botLaunching = false;
  }
}

startBotLaunchLoop().catch((err) => {
  logError("startBotLaunchLoop", err);
});
console.log(`Bot running: ${CODE_VERSION}`);
console.log(`✅ Global protection middleware active`);
} else {
console.log(`Telegram bot launch disabled (${TELEGRAM_BOT_DISABLED_REASON || "unknown reason"})`);
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[INFO] Received ${signal}. Starting graceful shutdown...`);

  try {
    if (TELEGRAM_BOT_ACTIVE) {
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

