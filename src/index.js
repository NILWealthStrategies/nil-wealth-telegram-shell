"use strict";
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
// ---------- VERSION ----------
const CODE_VERSION =
"Index.js V5.5";
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
// policy knobs (same as v5.1)
const URGENT_AFTER_MINUTES = Number(process.env.URGENT_AFTER_MINUTES ||
180);
const URGENT_COOLDOWN_HOURS =
Number(process.env.URGENT_COOLDOWN_HOURS || 72);

const COMPLETE_AFTER_HOURS = Number(process.env.COMPLETE_AFTER_HOURS ||
48);
const SUPPORT_FROM_EMAIL =
process.env.SUPPORT_FROM_EMAIL || "support@mynilwealthstrategies.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || SUPPORT_FROM_EMAIL;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS || 7000);
// live cards
const LIVE_CARD_TTL_MINUTES = Number(process.env.LIVE_CARD_TTL_MINUTES || 360);
const REFRESH_MIN_INTERVAL_MS = 1200;
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
app.use(express.json({ limit: "2mb" }));
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
auth: { persistSession: false },
});
const ops = () => supabase.schema("nil");
// ---------- IN-MEMORY FILTER STORAGE ----------
const userFilters = new Map(); // userId -> filter value ("all" | "programs" | "support")
const userRoleFilters = new Map(); // userId -> role filter ("all" | "parent" | "athlete" | "coach" | "trainer" | "other")
const draftEditState = new Map(); // userId -> { convId, version }
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
function safeStr(v) {
if (v === null || v === undefined) return "";
return String(v);
}
function shorten(s, n = 160) {
if (!s) return "";
const t = String(s).replace(/\s+/g, " ").trim();
return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
function idShort(id) {
const s = safeStr(id);
return s.length <= 8 ? s : s.slice(0, 8);
}
function sourceSafe(src) {
return src === "support" ? "support" : "programs";
}
// ---------- ROLE HELPERS ----------
const ROLE_LABELS = {
parent: "Parent",
athlete: "Athlete",
coach: "Coach",
trainer: "Trainer",
other: "Other",
};
const ROLE_VALUES = new Set(Object.keys(ROLE_LABELS));
function normalizeRole(value) {
if (!value) return null;
const v = String(value).trim().toLowerCase();
return ROLE_VALUES.has(v) ? v : null;
}
function roleLabel(role) {
const r = normalizeRole(role) || "parent";
return ROLE_LABELS[r] || "Parent";
}
function roleTag(role) {
return `[${roleLabel(role)}]`;
}
function roleFilterLabel(role) {
return role === "all" ? "All Roles" : roleLabel(role);
}
function normalizeEmail(email) {
if (!email) return null;
return String(email).trim().toLowerCase();
}
function conversationRoleForDisplay(conv) {
const explicit = normalizeRole(conv?.role);
if (explicit) return explicit;
const kind = String(conv?.conversation_kind || "").toLowerCase();
if (kind === "outreach") return "coach";
const hasCoach = !!(conv?.coach_name || conv?.coach_full_name);
const hasContact = !!(conv?.contact_name || conv?.contact_email || conv?.client_full_name);
if (hasCoach && !hasContact) return "coach";
return "parent";
}
function conversationIdentityText(conv) {
const name =
conv?.contact_name ||
conv?.client_full_name ||
conv?.contact_email ||
conv?.coach_name ||
conv?.coach_full_name ||
conv?.email ||
"—";
return `${roleTag(conversationRoleForDisplay(conv))} ${name}`;
}
// ---------- ROLE-AWARE LANE ROUTING ----------
function roleDefaultLane(role) {
const r = normalizeRole(role) || "parent";
switch (r) {
case "coach":
case "trainer":
return "outreach";
case "other":
return "triage";
case "parent":
case "athlete":
case null:
default:
return "support";
}
}
function roleConflictBadge(conv) {
const conflict = conv?.role_pending;
const confidence = conv?.role_confidence;
if (conflict && confidence === "low") {
return `⚠️ Conflict: [${roleLabel(conflict)}] pending`;
}
return null;
}
// ---------- NEXT ACTION TYPE DEFAULTS ----------
function roleDefaultNextAction(role, intentAnswer) {
const r = normalizeRole(role) || "parent";
const i = String(intentAnswer || "").trim().toLowerCase();
if (r === "parent" && ["my athlete", "family coverage", "myself"].includes(i)) {
return "send_sh_page";
}
if (r === "athlete" && i === "have my parent contacted") {
return "parent_contact_request";
}
if ((r === "coach" || r === "trainer") && i === "share this with my athletes/clients") {
return "send_parent_guide_to_program";
}
if (r === "other") {
return "manual_review";
}
return null;
}
/**

* ✅ v5.3 FIX: standardize lane emoji here (single source of truth).
* This replaces the prior invisible-char " Support" issue.
*/
function laneLabel(source) {
return source === "support" ? "󰼡 Support" : "🏈 Programs";
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
if (stack && process.env.NODE_ENV !== "production") {
console.error(stack);
}
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
// ---------- EMAIL/SMS OUTBOX (v5.4) ----------
async function queueEmailDraft({
to,
subject,
html,
threadKey = null,
clientId = null,
cardKey = null,
cc = null,
bcc = null,
traceId = null,
}) {
// v5.4: Queue email to outbox table (safe if table doesn't exist)
const payload = {
to,
subject,
html,
cc,
bcc,
thread_key: threadKey,
client_id: clientId,
card_key: cardKey,
trace_id: traceId || newTraceId(),
status: "queued",
queued_at: new Date().toISOString(),
};
// Insert to nil.email_outbox
try {
const { data, error } = await ops()
.from("email_outbox")
.insert(payload)
.select("*")
.maybeSingle();
if (error) throw error;
return data;
} catch (err) {
logError("queueEmailDraft", err);
return null;
}
}
async function queueSmsDraft({ to, text, clientId = null, cardKey = null, traceId = null }) {
// v5.4: Queue SMS to outbox table (safe if table doesn't exist)
const payload = {
to,
text,
client_id: clientId,
card_key: cardKey,
trace_id: traceId || newTraceId(),
status: "queued",
queued_at: new Date().toISOString(),
};
// Insert to nil.sms_outbox
try {
const { data, error } = await ops()
.from("sms_outbox")
.insert(payload)
.select("*")
.maybeSingle();
if (error) throw error;
return data;
} catch (err) {
logError("queueSmsDraft", err);
return null;
}
}
function parseDelimitedList(raw) {
if (!raw) return [];
if (Array.isArray(raw)) return raw.filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
return String(raw)
.split(",")
.map((s) => s.trim())
.filter(Boolean);
}
async function sendEmailViaSendGrid(row) {
if (!SENDGRID_API_KEY) throw new Error("Missing SENDGRID_API_KEY");
const to = parseDelimitedList(row.to);
if (!to.length) throw new Error("email_outbox row missing to");

const payload = {
personalizations: [
{
to: to.map((email) => ({ email })),
cc: parseDelimitedList(row.cc).map((email) => ({ email })),
bcc: parseDelimitedList(row.bcc).map((email) => ({ email })),
},
],
from: { email: SENDGRID_FROM_EMAIL },
subject: String(row.subject || ""),
content: [{ type: "text/html", value: String(row.html || "") }],
};

const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
method: "POST",
headers: {
"content-type": "application/json",
authorization: `Bearer ${SENDGRID_API_KEY}`,
},
body: JSON.stringify(payload),
});
if (!resp.ok) {
const text = await resp.text().catch(() => "");
throw new Error(`SendGrid error ${resp.status}: ${text || "unknown"}`);
}
return resp.headers.get("x-message-id") || uuidv4();
}
async function sendSmsViaTwilio(row) {
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
throw new Error("Missing Twilio credentials or TWILIO_FROM_NUMBER");
}
if (!row.to) throw new Error("sms_outbox row missing to");

const body = new URLSearchParams({
To: String(row.to),
From: String(TWILIO_FROM_NUMBER),
Body: String(row.text || ""),
});
const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
const resp = await fetch(url, {
method: "POST",
headers: {
authorization: `Basic ${auth}`,
"content-type": "application/x-www-form-urlencoded",
},
body,
});
const json = await resp.json().catch(() => ({}));
if (!resp.ok || json?.error_message) {
throw new Error(`Twilio error ${resp.status}: ${json?.error_message || "unknown"}`);
}
return json?.sid || uuidv4();
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
let outboxWorkerRunning = false;
async function processEmailOutboxQueued(limit = 10) {
const { data, error } = await ops()
.from("email_outbox")
.select("id,to,subject,html,cc,bcc,status")
.eq("status", "queued")
.limit(limit);
if (error) throw error;
for (const row of data || []) {
try {
const providerMessageId = await sendEmailViaSendGrid(row);
const sentAt = new Date().toISOString();
const { error: updateError } = await ops()
.from("email_outbox")
.update({
status: "sent",
provider_message_id: providerMessageId,
sent_at: sentAt,
})
.eq("id", row.id)
.eq("status", "queued");
if (updateError) throw updateError;

await postOpsIngestEvent({
schema_version: "5.3",
event_type: "outbox.email.sent",
source: "ops",
direction: "inbound",
payload: {
outbox_id: row.id,
provider_message_id: providerMessageId,
},
});
} catch (err) {
logError("processEmailOutboxQueued", err);
}
}
}
async function processSmsOutboxQueued(limit = 10) {
const { data, error } = await ops()
.from("sms_outbox")
.select("id,to,text,status")
.eq("status", "queued")
.limit(limit);
if (error) throw error;
for (const row of data || []) {
try {
const providerMessageId = await sendSmsViaTwilio(row);
const sentAt = new Date().toISOString();
const { error: updateError } = await ops()
.from("sms_outbox")
.update({
status: "sent",
provider_message_id: providerMessageId,
sent_at: sentAt,
})
.eq("id", row.id)
.eq("status", "queued");
if (updateError) throw updateError;

await postOpsIngestEvent({
schema_version: "5.3",
event_type: "outbox.sms.sent",
source: "ops",
direction: "inbound",
payload: {
outbox_id: row.id,
provider_message_id: providerMessageId,
},
});
} catch (err) {
logError("processSmsOutboxQueued", err);
}
}
}
async function runOutboxSenderTick() {
if (outboxWorkerRunning) return;
outboxWorkerRunning = true;
try {
await processEmailOutboxQueued();
await processSmsOutboxQueued();
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
// ---------- SLA / URGENT ----------
function minsUntilUrgent(updatedAtIso) {
if (!updatedAtIso) return URGENT_AFTER_MINUTES;
const updated = new Date(updatedAtIso).getTime();
const now = Date.now();
const ageMins = Math.floor((now - updated) / 60000);
return URGENT_AFTER_MINUTES - ageMins;
}
function slaBadge(updatedAtIso) {

const m = minsUntilUrgent(updatedAtIso);
if (m <= 0) return "🔴 Overdue";
if (m <= 60) return "🟠 Due soon";
return "🟢 On track";
}
function urgentCountdown(updatedAtIso) {
const m = minsUntilUrgent(updatedAtIso);
const mmAbs = Math.abs(m);
const h = Math.floor(mmAbs / 60);
const mm = mmAbs % 60;
if (m <= 0) return `⏳ 0h 0m until Urgent`;
return `⏳ ${h}h ${mm}m until Urgent`;
}
// ---------- SMART SORTING (v5.4) ----------
// Sorts items by: 1) Due-now first, 2) Priority tier, 3) Most recent
function smartSortByPriority(rows = []) {
if (!Array.isArray(rows) || rows.length === 0) return rows;
return [...rows].sort((a, b) => {
const now = Date.now();
// Parse due dates
const aDue = a.next_action_at ? new Date(a.next_action_at).getTime() : Infinity;
const bDue = b.next_action_at ? new Date(b.next_action_at).getTime() : Infinity;
// Due-now items come first
const aDueNow = aDue <= now;
const bDueNow = bDue <= now;
if (aDueNow && !bDueNow) return -1;
if (bDueNow && !aDueNow) return 1;
// Priority tier (lower number = higher priority)
const aPri = typeof a.priority_tier === 'number' ? a.priority_tier : 9;
const bPri = typeof b.priority_tier === 'number' ? b.priority_tier : 9;
if (aPri !== bPri) return aPri - bPri;
// Most recent activity
const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
return bTime - aTime;
});
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
// ---------- LISTS ----------
async function sbListConversations({ pipeline, source = "all", role = "all", limit = 8 }) {
const buildQuery = (withRole) => {
  let q = ops()
    .from("conversations")
    .select(
      withRole
        ? 'id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at, cc_support_suggested, gmail_url, mirror_conversation_id, role, role_pending, role_confidence'
        : 'id, thread_key, source, pipeline, coach_id, coach_name, contact_email, subject, preview, updated_at, cc_support_suggested, gmail_url, mirror_conversation_id'
    )
    .order("updated_at", { ascending: false })
    .limit(limit * 2); // Fetch 2x limit for sorting
  if (pipeline) q = q.eq("pipeline", pipeline);
  if (source !== "all") q = q.eq("source", sourceSafe(source));
  if (withRole && role && role !== "all") q = q.eq("role", role);
  return q;
};
const result = await dbSelectFirst([
  () => buildQuery(true),
  () => buildQuery(false),
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
const buildQuery = (useNormalized) => {
let q = ops()
.from("conversations")
.select("id, role, role_pending, role_confidence, role_source, contact_email, normalized_email, source, conversation_kind, coach_name")
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
() => buildQuery(true),
() => buildQuery(false),
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
.select("id, direction, from_email, to_email, subject, body, preview, created_at")
.eq("conversation_id", conversation_id)
.order("created_at", { ascending: false })
.range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
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
  const { data, error } = await ops()
    .from("calls")
    .select(
      "id, client_name, scheduled_at, outcome, updated_at, created_at"
    )
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
if (error) throw new Error(error.message);
return data || [];
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
const { data: msg } = await ops()
.from("messages")
.select("is_test, conversation_id")
.eq("id", messageId)
.maybeSingle();
if (!msg) return;
if (msg.is_test === true) {
// Hard delete
await ops().from("messages").delete().eq("id", messageId);
} else {
// Soft delete
await ops().from("messages").update({ is_deleted: true }).eq("id", messageId);
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
const { data, error } = await ops()
.from("calls")
.select("id, client_name, client_email, best_phone, scheduled_at, reason, outcome, updated_at, created_at, conversation_id")
.eq("client_id", clientId)
.order("updated_at", { ascending: false })
.limit(limit);
if (error) throw new Error(error.message);
return data || [];
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
return msg.includes("column") && msg.includes("does not exist");
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
const { data: convs } = await ops()
.from("conversations")
.select("id, pipeline");
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

let q = ops()
.from("calls")
.select("*")
.order("scheduled_at", { ascending: true })
.limit(limit);

if (source !== "all") {
q = q.eq("source", sourceSafe(source));
}
// Get calls scheduled within window or missing outcome
q = q.or(`scheduled_at.gte.${windowStart},outcome.is.null`);
const { data, error } = await q;
if (error) {
console.log("sbListCallsTriage error:", error);
return [];
}
return data || [];
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
thread: "🧵 Thread (Full)",
metrics: "📊 Metrics",
year_summary: "🎉 Year Summary",
calls: "📱 Calls",
today: "📅 Today",
triage: "⚡️ Triage",
all_queues: "🗂 All Queues",
clients: "👥 Clients",
pools: "🌊 Pools",
};
return map[key] || key;
}
function headerLine(key, filterLabel = "all") {
return `${viewTitle(key)} · ${filterLabel}`;
}
// ---------- SMART RENDER (v5.3 SAFE) ----------
async function smartRender(ctx, text, keyboard) {
// stop Telegram spinner when this was a button click
try {
if (ctx.update?.callback_query?.id) {
await ctx.answerCbQuery().catch(() => {});
}
} catch (_) {}
// try edit-in-place first (clean UI)
if (ctx.update?.callback_query?.message) {
const m = ctx.update.callback_query.message;
try {
await bot.telegram.editMessageText(
m.chat.id,
m.message_id,
undefined,
text,

keyboard
);
return { mode: "edit", message_id: m.message_id, chat_id: m.chat.id };
} catch (err) {
const msg = String(err?.description || err?.message || "");
// harmless: already same content
if (msg.includes("message is not modified")) {
return { mode: "noop", message_id: m.message_id, chat_id: m.chat.id };
}
// fall through to reply
}
}
// fallback: new message
const msg = await ctx.reply(text, keyboard);
return { mode: "reply", message_id: msg?.message_id, chat_id: msg?.chat?.id };

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
    
    let text = `🎯 NIL LEADS DASHBOARD\n\n📊 Overview:\n`;
    text += `• Total Leads: ${analytics?.total_leads || 0}\n`;
    text += `• New Today: ${analytics?.leads_today || 0}\n`;
    text += `• With Email: ${statuses.ready + statuses.outreach_started + statuses.replied}\n\n`;
    text += `📈 Status: Ready ${statuses.ready} | Started ${statuses.outreach_started} | Replied ${statuses.replied}\n\n`;
    text += `🔥 Top 10 Leads:\n`;
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
    
    let text = `📊 EMAIL ANALYTICS\n\n📅 Today:\n`;
    text += `• Sent: ${analytics?.emails_sent_today || 0} | Opens: ${analytics?.opens_today || 0} | Clicks: ${analytics?.clicks_today || 0} | Replies: ${analytics?.replies_today || 0}\n\n`;
    text += `📈 All-Time:\n`;
    text += `• Sent: ${analytics?.total_emails_sent || 0} | Opens: ${analytics?.total_opens || 0} | Clicks: ${analytics?.total_clicks || 0} | Replies: ${analytics?.total_replies || 0}\n\n`;
    text += `💯 Rates: Open ${analytics?.open_rate_pct || 0}% | Click ${analytics?.click_rate_pct || 0}% | Reply ${analytics?.reply_rate_pct || 0}%\n`;
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

}
// ---------- DASHBOARD TEXT ----------
async function dashboardText(filterSource = "all") {
const { dayKey, time } = nyParts(new Date());
const filterLabel =
filterSource === "support" ? "🧑‍🧒 Support" : filterSource === "programs" ? "🏈 Programs" :
"🌐 All";
const counts = {
urgentCount: await sbCountConversations({ pipeline: "urgent", source: filterSource }),
needsReplyCount: await sbCountConversations({ pipeline: "needs_reply", source:
filterSource }),
waitingCount: await sbCountConversations({ pipeline: "actions_waiting", source: filterSource
}),
activeCount: await sbCountConversations({ pipeline: "active", source: filterSource }),
forwardedCount: await sbCountConversations({ pipeline: "forwarded", source: filterSource }),
followCount: await sbCountConversations({ pipeline: "followups", source: filterSource }),
completedCount: await sbCountConversations({ pipeline: "completed", source: filterSource }),
submissionsCount: await sbCountSubmissions(),
callsCount: await sbCountCalls(),
};
const m = await sbMetricSummary({ source: filterSource, window: "all" });
return `🏠 NIL Wealth Ops Dashboard

${CODE_VERSION} · Build: ${String(BUILD_VERSION).slice(0, 8)}

📅 Today: ${new Intl.DateTimeFormat("en-US",{ timeZone: "America/New_York" }).format(new Date())}
⏰ NY Time: ${time}

🧮 Filter: ${filterLabel}

🗂 All Queues:
‼️ Urgent: ${counts.urgentCount}
📝 Needs Reply: ${counts.needsReplyCount}
⏳ Waiting: ${counts.waitingCount}
💬 Active: ${counts.activeCount}
📨 Forwarded: ${counts.forwardedCount}
🧾 Submissions: ${counts.submissionsCount}
📚 Follow-Ups: ${counts.followCount}
📱 Calls: ${counts.callsCount}
✅ Completed: ${counts.completedCount}

📊 Metrics:
Total Parent Guide Opens: ${m.programLinkOpens}
Total Coverage Exploration: ${m.coverageExploration}
Total Enroll Portal Visits: ${m.enrollClicks}
Total eApp Visits: ${m.eappVisits}
Total Threads: ${m.threadsCreated}
Total Calls Answered: ${m.callsAnswered}

Use buttons below.`;
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
// ---------- ALL QUEUES TEXT ----------
async function allQueuesText(filterSource = "all", roleFilter = "all") {
const filterLabel =
filterSource === "support"
? "🧑‍🧒 Support"
: filterSource === "programs"
? "🏈 Programs"
: "🌐 All";
return `${headerLine("all_queues", filterLabel)} · ${roleFilterLabel(roleFilter)}
Tap a queue below to open it.`;
}
// ---------- ALL QUEUES KEYBOARD ----------
function allQueuesKeyboard() {
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
// ---------- SUMMARY LINE ----------
function convoSummaryLine(conv) {
const lane = laneLabel(sourceSafe(conv.source));
const sla = slaBadge(conv.updated_at);
const until = urgentCountdown(conv.updated_at);
const subj = shorten(conv.subject || "(no subject)", 60);
const prev = shorten(conv.preview || "", 80);
const identity = conversationIdentityText(conv);
return `• ${identity} · ${lane}
${subj}
${prev}
${sla} · ${until}`;
}
// ---------- SHOW LIST ----------
async function showConversationList(ctx, viewKey, rows, filterSource, roleFilter = "all") {
const filterLabel =
filterSource === "support"
? "🧑‍🧒 Support"
: filterSource === "programs"
? "🏈 Programs"
: "🌐 All";
const header = `${headerLine(viewKey, filterLabel)} · ${roleFilterLabel(roleFilter)}`;

const body =
rows.length
? rows.map(convoSummaryLine).join("\n\n")
: "No items.";
// buttons
const kb = rows.slice(0, 8).map((c) => [
Markup.button.callback("Open", `OPENCARD:${c.id}`),
// ✅ MUST match universal delete entity map
Markup.button.callback("🗑", `DELETECONFIRM:conversation:${c.id}`),
]);
kb.push([Markup.button.callback("⬅ Back", "ALLQ:open")]);
const msg = await smartRender(ctx,
`${header}\n\n${body}`,
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
const msgCount = await sbCountMessages(conv.id);
const lane = laneLabel(sourceSafe(conv.source));
const sla = slaBadge(conv.updated_at);
const until = urgentCountdown(conv.updated_at);
const ccOn = conv.cc_support_suggested === true;
const gmail = conv.gmail_url ? `\nGmail: ${conv.gmail_url}` : "";
const pipeline = conv.pipeline || "—";
const coach = conv.coach_name || "—";
const contact = conv.contact_email || "—";
const subj = conv.subject || "—";
const prev = shorten(conv.preview || "", 420);
const identity = conversationIdentityText(conv);
const roleInfo = (() => {
const r = normalizeRole(conv?.role) || "parent";
let info = `Role: ${roleLabel(r)}`;
const conflictBadge = roleConflictBadge(conv);
if (conflictBadge) {
info += `\n${conflictBadge}`;
}
return info;
})();
return `💬 Conversation · ${idShort(conv.id)} · ${lane}
Identity: ${identity}
${roleInfo}
Pipeline: ${pipeline}
Coach: ${coach}
Contact: ${contact}
Subject: ${subj}
Preview: ${prev}
Updated: ${tFmtDateTimeShort(conv.updated_at)}
💬 Messages: ${msgCount}
${sla} · ${until}
CC: ${ccOn ? "📇 Enabled" : "Off"}${gmail}`;
}
function conversationCardKeyboard(conv) {
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
return Markup.inlineKeyboard([
// row 1
[Markup.button.callback("🧵 Thread (Full)", `THREAD:${id}:0`)],
// row 2
[
Markup.button.callback(ccBtnLabel, `CC:${id}`),
Markup.button.callback("👥 People", `PEOPLE:${id}`),
],
// row 3 - role conflict if exists (mirror + delete)
[
...roleConflictRow,
...mirrorRow,
Markup.button.callback("🗑 Delete", `DELETECONFIRM:conversation:${id}`),
],
// row 4 - role management
[Markup.button.callback("🔧 Set Role", `SETROLE:${id}`)],
// row 5 - v1/v2/v3 reply drafting
[Markup.button.callback("✍️ Drafts V1/V2/V3", `DRAFTS:open:${id}`)],
// BIG action bottom
[Markup.button.callback("📤 Send Drafts", `SEND:${id}:1`)],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}
// ---------- SUBMISSION CARD ----------
function coverageLabel(payload) {
const a = payload?.coverage_accident === true;
const h = payload?.coverage_hospital_indemnity === true;
if (a && h) return "Accident + Hospital Indemnity";
if (a) return "Accident";
if (h) return "Hospital Indemnity";
return "—";
}
function emailStatusIcon(sent) {
return sent ? "✅" : "⏳";
}
function smsStatusIcon(sent) {
return sent ? "✅" : "⏳";
}
function buildSubmissionCard(sub) {
const p = sub.submission_payload || {};
const name = `${p.first_name || ""} ${p.last_name || ""}`.trim() || "—";
const role = sub.your_role || p.your_role || p.role || "parent";
const intent = sub.intent_answer || p.intent_answer || "—";
const heard = sub.how_heard_about || p.how_heard_about || "—";
const emailSent = sub.email_sent === true || sub.enrollment_email_sent === true;
const smsSent = sub.sms_sent === true || sub.enrollment_sms_sent === true;
return `🧾 Submission · ${idShort(sub.submission_id)}
Name: ${name}
Email: ${p.email || "—"}
Phone: ${p.phone_e164 || p.phone || "—"}
Athlete: ${p.athlete_name || "—"}
State: ${p.state || "—"}
Role: ${roleLabel(role)}
Intent: ${intent}
How Heard: ${heard}
Coverage: ${coverageLabel(p)}
Referral: ${p.referral_source || p.referral || "—"}

Sent Email: ${emailStatusIcon(emailSent)}
Sent SMS: ${smsStatusIcon(smsSent)}

Received: ${tFmtDateTimeShort(sub.created_at)}`;
}
function submissionKeyboard(sub) {
return Markup.inlineKeyboard([
[Markup.button.callback("🗑 Delete",
`DELETECONFIRM:submission:${sub.submission_id}`)],
[Markup.button.callback("⬅ Back", "VIEW:website_submissions")],
]);
}
// ---------- START / DASH ----------
bot.start(async (ctx) => {
if (!isAdmin(ctx)) return;
await ctx.reply("✅ NIL Wealth Ops Bot running.\nType /dashboard");
});
bot.command("dashboard", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await ctx.reply(await dashboardText(filterSource), dashboardKeyboardV50());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading dashboard: ${err.message}`);
}
});
bot.command("leads", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
await ctx.reply(await leadsText(), leadsKeyboard());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading leads: ${err.message}`);
}
});
bot.command("analytics", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
await ctx.reply(await analyticsText(), analyticsKeyboard());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading analytics: ${err.message}`);
}
});
bot.action("DASH:back", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading dashboard: ${err.message}`);
}
});
bot.action("DASH:refresh", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await dashboardText(filterSource), dashboardKeyboardV50());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error refreshing dashboard: ${err.message}`);
}
});
// ---------- FILTER ----------
bot.action(/^FILTER:(all|programs|support)$/, async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const v = ctx.match[1];
setAdminFilter(ctx, v);
await smartRender(ctx, await dashboardText(v), dashboardKeyboardV50());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error applying filter: ${err.message}`);
}
});
// ---------- ROLE FILTER ----------
bot.action(/^ROLEFILTER:(all|parent|athlete|coach|trainer|other)$/, async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const v = ctx.match[1];
setAdminRoleFilter(ctx, v);
const filterSource = getAdminFilter(ctx);
await smartRender(ctx, await allQueuesText(filterSource, v), allQueuesKeyboard());
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error applying role filter: ${err.message}`);
}
});
// ---------- ALL QUEUES ----------
bot.action("ALLQ:open", async (ctx) => {
try {
if (!isAdmin(ctx)) return;

const filterSource = getAdminFilter(ctx);
const roleFilter = getAdminRoleFilter(ctx);
const msg = await smartRender(
ctx,
await allQueuesText(filterSource, roleFilter),
allQueuesKeyboard()
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
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading queues: ${err.message}`);
}
});
// ---------- QUEUE VIEW ----------
bot.action(
  /^VIEW:(urgent|needs_reply|actions_waiting|active|followups|forwarded|website_submissions|completed):?(\d*)$/,
async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const viewKey = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const filterSource = getAdminFilter(ctx);
const roleFilter = getAdminRoleFilter(ctx);
if (viewKey === "website_submissions") {
const pageSize = 5;
const offset = (page - 1) * pageSize;
// Get total count + page of data
const { data: allSubs, error: countErr } = await ops()
.from("submissions")
.select("submission_id", { count: "exact", head: false });
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
const kb = subs.map((s, idx) => {
const p = s.submission_payload || {};
const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "—";
return [
Markup.button.callback(`Open • ${name} • ${idShort(s.submission_id)}`, `OPENCARD:sub:${s.submission_id}`),
Markup.button.callback("🗑", `DELETECONFIRM:submission:${s.submission_id}`),
];
});
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
const rows = await sbListConversations({ pipeline: viewKey, source: filterSource, role: roleFilter, limit: 8 });
await showConversationList(ctx, viewKey, rows, filterSource, roleFilter);
// If you want queue lists to live-refresh too, update showConversationList
// to return the sent message and register it there.
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading queue: ${err.message}`);
}
});
// ---------- OPENCARD (conversation + submission) ----------
bot.action(/^OPENCARD:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const raw = ctx.match[1];
// allow "sub:<id>" for submissions
if (raw.startsWith("sub:")) {
const sid = raw.slice(4);
const sub = await sbGetSubmission(sid);
if (!sub) return ctx.reply("Submission not found.");
const text = buildSubmissionCard(sub);

const kb = submissionKeyboard(sub);
const msg = await ctx.reply(text, kb);
// live refresh registration
registerLiveCard(msg, {
type: "submission",
card_key: `submission:${sid}`,
ref_id: sid,
});
return;
}
const conv = await sbGetConversationById(raw);
if (!conv) return ctx.reply("Conversation not found.");
const text = await buildConversationCard(conv);
const kb = conversationCardKeyboard(conv);
const msg = await ctx.reply(text, kb);
// live refresh registration
registerLiveCard(msg, {
type: "conversation",
card_key: `conversation:${conv.id}`,
ref_id: conv.id,
});
});
// ---------- CONFIRM ROLE (CONFLICT RESOLUTION) ----------
bot.action(/^CONFIRMROLE:([^:]+):(.+)$/, async (ctx) => {
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
const text = await buildConversationCard(updated);
const kb = conversationCardKeyboard(updated);
await smartRender(ctx, `✅ Role confirmed.\n\n${text}`, kb);
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error confirming role: ${err.message}`);
}
});

// ---------- SET ROLE (ADMIN) ----------
bot.action(/^SETROLE:(.+)$/, async (ctx) => {
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
[Markup.button.callback("⬅ Back", `OPENCARD:conversation:${convId}`)],
]);
await ctx.editMessageText(
`🔧 Select new role (currently: ${currentRole}):`,
kb
);
} catch (err) {
logError("SETROLE", err);
await ctx.reply(`❌ Error: ${err.message}`);
}
});

// ---------- ROLE SELECT (APPLY) ----------
bot.action(/^ROLESELECT:([^:]+):(.+)$/, async (ctx) => {
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
const text = await buildConversationCard(updated);
const kb = conversationCardKeyboard(updated);
await smartRender(ctx, `✅ Role set to ${roleLabel(selectedRole)}.\n\n${text}`, kb);
} catch (err) {
logError("ROLESELECT", err);
await ctx.reply(`❌ Error setting role: ${err.message}`);
}
});
// ---------- OPEN MIRROR ----------
bot.action(/^OPENMIRROR:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv?.mirror_conversation_id)
return ctx.reply("No mirror conversation found.");
const mirror = await sbGetConversationById(conv.mirror_conversation_id);
if (!mirror)
return ctx.reply("Mirror conversation not found.");

const text = await buildConversationCard(mirror);
const kb = conversationCardKeyboard(mirror);
const msg = await ctx.reply(text, kb);
// ✅ NEW — live refresh support
registerLiveCard(msg, {
type: "conversation",
card_key: `conversation:${mirror.id}`,
ref_id: mirror.id,
});
});
// ---------- MIRRORS LIST (v5.4) ----------
bot.action(/^MIRRORS:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const cardKey = ctx.match[1];
const mirrors = await getMirrors(cardKey);

if (!mirrors || mirrors.length === 0) {
const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", `OPENCARD:${cardKey}`)],
]);
return smartRender(ctx, `🪞 Mirrors\n\nNo linked cards found for:\n${cardKey}`, kb);
}

let text = `🪞 Mirrors\n\nLinked cards for: ${cardKey}\n\n`;
const buttons = [];

for (const m of mirrors.slice(0, 10)) {
const mk = m.mirror_card_key || m.card_key || "";
const label = m.label || m.title || mk || "Mirror";
text += `• ${shorten(label, 50)}\n  ${mk}\n\n`;
if (mk) {
buttons.push([Markup.button.callback(shorten(label, 28), `OPENCARD:${mk}`)]);
}
}

buttons.push([Markup.button.callback("🔄 Refresh", `MIRRORS:${cardKey}`)]);
buttons.push([Markup.button.callback("⬅ Back", `OPENCARD:${cardKey}`)]);

return smartRender(ctx, text, Markup.inlineKeyboard(buttons));
});
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
// - sbCountMessages(convId)
// - sbListMessages(convId, { offset, limit }) // must match THREAD_ORDER expectation
// - sbDeleteMessageById(messageId) // safe delete (hard only if is_test=true, else soft)
// - sbInsertOpsEvent({...})
// - registerLiveCard(msg, meta)
// - safeEditMessageText(chat_id, message_id, text, extra)
// - Markup
//
// IMPORTANT:
// Set THREAD_ORDER to match your sbListMessages ORDER BY.
// ==========================================================
const THREAD_ORDER = "newest_first"; // "newest_first" | "oldest_first"
// ---------- THREAD VIEW HELPERS ----------

function formatMessageLineFull(m) {
const dir = m.direction === "outbound" ? "➡ OUT" : "⬅ IN";
const from = m.from_email ? `From: ${m.from_email}\n` : "";
const to = m.to_email ? `To: ${m.to_email}\n` : "";
const subj = m.subject ? `Subject: ${m.subject}\n` : "";
const body = shorten(m.body || m.preview || "", 1200);
const ts = m.created_at || "";
return `${dir}\n${from}${to}${subj}${body}\n${ts}`;
}
function threadDebugBlock(conv) {
const tk = conv?.thread_key ? `ThreadKey: ${conv.thread_key}\n` : "";
const gt = conv?.gmail_thread_id ? `GmailThreadID: ${conv.gmail_thread_id}\n` : "";
const mid = conv?.message_id_header ? `Message-ID: ${shorten(conv.message_id_header,
80)}\n` : "";
const irt = conv?.in_reply_to ? `In-Reply-To: ${shorten(conv.in_reply_to, 80)}\n` : "";
const refs = conv?.references ? `Refs: ${shorten(conv.references, 120)}\n` : "";
const from = conv?.inbound_from_email ? `InboundFrom: ${conv.inbound_from_email}\n` : "";
return (tk || gt || mid || irt || refs || from)
? `\n🧷 Threading\n${tk}${gt}${mid}${irt}${refs}${from}`.trimEnd()
: "";
}
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
(total > 0 ? `Showing: ${shownFrom}-${shownTo}` : `Showing: 0-0`) +
`\n\n${threadDebugBlock(conv)}`;
const body = msgs?.length
? msgs.map(formatMessageLineFull).join("\n\n--------------------\n\n")
: "(No messages yet)";
// Pagination controls
const prevOffset = Math.max(0, offset - limit);
const nextOffset = offset + limit;
const hasPrev = offset > 0;
const hasNext = nextOffset < total;
// Latest jump
const latestOffset = computeLatestOffset(total, limit);
// Delete newest (test)
const newestMsgId = pickNewestMessageIdOnPage(msgs);
const kbRows = [];
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
// delete newest row (optional)
if (newestMsgId) {
kbRows.push([Markup.button.callback("🗑 Delete Newest (test)",
`THREADDEL:${convId}:${offset}:${newestMsgId}`)]);
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
newestMsgId,
};
}
// ---------- THREAD VIEW (paged) ----------
bot.action(/^THREAD:(.+):(\d+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const offset = Number(ctx.match[2] || 0);
const limit = 6;
const page = await buildThreadPage(convId, offset, limit);
if (!page.ok) return ctx.reply(page.error || "Thread not found.");
const msg = await ctx.reply(page.text, page.keyboard);
// ✅ Live refresh registration (stable card_key)
registerLiveCard(msg, {
type: "thread_view",
card_key: `thread:${convId}`, // stable key for targeted refresh
ref_id: `${convId}:${offset}`, // page info
conv_id: convId,
offset,

limit,
});
});
// ---------- THREAD DELETE NEWEST (TEST ONLY) ----------
bot.action(/^THREADDEL:(.+):(\d+):(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const offset = Number(ctx.match[2] || 0);
const messageId = ctx.match[3];
await ctx.reply(
`⚠ Delete newest message?\n\nMessageID: ${shorten(messageId, 18)}\n(Will hard-delete
only if is_test=true; otherwise soft-delete.)`,
Markup.inlineKeyboard([
[Markup.button.callback("✅ Yes Delete",
`THREADDELDO:${convId}:${offset}:${messageId}`)],
[Markup.button.callback("Cancel", `THREAD:${convId}:${offset}`)],
])
);
});
bot.action(/^THREADDELDO:(.+):(\d+):(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const offset = Number(ctx.match[2] || 0);
const messageId = ctx.match[3];
try {
await sbDeleteMessageById(messageId);
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "message.deleted",
source: "telegram",
direction: "inbound",
entity_type: "message",
entity_id: messageId,
payload: { convId, offset, messageId, reason: "thread_delete_newest" },
});
await ctx.reply("🗑 Deleted.");

// ✅ Refresh thread + parent card (stable key)
refreshQueue.add(`thread:${convId}`);
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});
} catch (e) {
await ctx.reply(`Delete failed: ${String(e.message || e)}`);
}
});
// ==========================================================
// REFRESH ENGINE ADDITION (paste into refreshLiveCards loop)
// Sample refresh handler for thread_view (removed to avoid parsing issues)
// ==========================================================
// ===============================
// 📇 CC SUPPORT (v5.3 OPS CLEAN)
// ===============================
//
// Replaces the old "toggle" behavior.
// New behavior:
// 1) CC button opens a confirm screen (shows what will happen)
// 2) Confirm triggers an outbound webhook to n8n/Make to:
// - send bridge message from outreach lane

// - send the forwardable support message from SUPPORT_FROM_EMAIL
// - create/link mirror thread (support-side conversation)
// 3) Bot writes OPS ledger event(s) and updates conversation flags
// 4) Bot queues refresh for the conversation card
//
// ENV expected:
// - CC_SUPPORT_WEBHOOK_URL (your n8n webhook that performs the CC workflow)
// - SUPPORT_FROM_EMAIL already exists
//
// Requires existing helpers:
// - isAdmin(ctx)
// - sbGetConversationById(id)
// - sbInsertOpsEvent({...})
// - makeCardKey(entityType, stableId) OR use `conversation:${id}`
// - refreshQueue.add(card_key) + refreshLiveCards(true)
// - buildConversationCard(conv) + conversationCardKeyboard(conv)
// - sourceSafe(...)
function makeTraceId() {
return uuidv4();
}
function makeCcIdempotencyKey(convId) {
// idempotent per conversation (prevents double-CC spam)
return crypto.createHash("sha256").update(`cc_support|${convId}`).digest("hex");
}
function isProgramLaneConversation(conv) {
// Adjust these lane/source values to match your exact schema.
// The rule you gave: CC support should only be from program side.
const s = sourceSafe(conv?.source);
return s === "programs";
}
async function requestCcSupportWorkflow(conv, { bridge_draft = 2, support_draft = 2 } = {}) {
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
// Draft choices (your UI will show “V2 selected” etc.)
bridge_draft: Number(bridge_draft),
support_draft: Number(support_draft),
// Threading fields for downstream correctness
gmail_thread_id: conv.gmail_thread_id || null,
message_id_header: conv.message_id_header || null,
in_reply_to: conv.in_reply_to || null,
references: conv.references || null,
// Mirror linking (downstream can create & return mirror id)
mirror_conversation_id: conv.mirror_conversation_id || null,
// All other context
payload: {
lane_source: sourceSafe(conv.source),
subject: conv.subject || "",
cc_support_suggested: true,
},
};
if (!process.env.CC_SUPPORT_WEBHOOK_URL) {
console.log("CC SUPPORT STUB (no CC_SUPPORT_WEBHOOK_URL):", payload);
return { ok: true, stub: true, trace_id, idempotency_key };
}
const res = await fetch(process.env.CC_SUPPORT_WEBHOOK_URL, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(payload),
});
return { ok: res.ok, status: res.status, trace_id, idempotency_key };

}
// -------------------------------
// 📇 CC button pressed (opens confirm screen)
// -------------------------------
bot.action(/^CC:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
// CC only allowed from program/outreach side (your rule)
if (!isProgramLaneConversation(conv)) {
  return ctx.reply(
    "📇 CC Support is only available from the Program/Outreach side (not Support lane)."
  );
}
// If already linked, treat as “open mirror” instead of re-CC
if (conv.mirror_conversation_id) {
return ctx.reply(
"🪞 Already linked to Support.\nOpening the mirror thread now…",
Markup.inlineKeyboard([[Markup.button.callback("🪞 Open Mirror",
`OPENMIRROR:${conv.id}`)]])
);
}
// Confirm screen (V2 default selected — you can change defaults)
const bridgeDraft = 2;
const supportDraft = 2;
const kb = Markup.inlineKeyboard([
[
Markup.button.callback("Bridge: V1", `CCPICK:${convId}:bridge:1:${supportDraft}`),
Markup.button.callback("Bridge: V2 ✅", `CCPICK:${convId}:bridge:2:${supportDraft}`),
Markup.button.callback("Bridge: V3", `CCPICK:${convId}:bridge:3:${supportDraft}`),
],
[
Markup.button.callback("Support: V1", `CCPICK:${convId}:support:${bridgeDraft}:1`),
Markup.button.callback("Support: V2 ✅", `CCPICK:${convId}:support:${bridgeDraft}:2`),
Markup.button.callback("Support: V3", `CCPICK:${convId}:support:${bridgeDraft}:3`),
],
[Markup.button.callback("✅ Confirm CC Support",
`CCDO:${convId}:${bridgeDraft}:${supportDraft}`)],

[Markup.button.callback("Cancel", `OPENCARD:${convId}`)],
]);
await ctx.reply(
`📇 CC Support\n\nThis will:\n• Send a short bridge message from outreach (\"I'm looping in
support…\")\n• Send the forwardable support message from ${SUPPORT_FROM_EMAIL}\n•
Create + link the Support mirror thread\n\nSelected:\n• Bridge Draft: V${bridgeDraft}\n• Support
Draft: V${supportDraft}`,
kb
);
});
// -------------------------------
// Optional picker (keeps it simple; re-opens confirm with updated selection)
// -------------------------------
bot.action(/^CCPICK:(.+):(bridge|support):(\d):(\d)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const which = ctx.match[2];
const a = Number(ctx.match[3]);
const b = Number(ctx.match[4]);
const bridgeDraft = which === "bridge" ? a : b;
const supportDraft = which === "support" ? b : a;
const kb = Markup.inlineKeyboard([
[
Markup.button.callback(`Bridge: V1${bridgeDraft === 1 ? " ✅" : ""}`,
`CCPICK:${convId}:bridge:1:${supportDraft}`),
Markup.button.callback(`Bridge: V2${bridgeDraft === 2 ? " ✅" : ""}`,
`CCPICK:${convId}:bridge:2:${supportDraft}`),
Markup.button.callback(`Bridge: V3${bridgeDraft === 3 ? " ✅" : ""}`,
`CCPICK:${convId}:bridge:3:${supportDraft}`),
],
[
Markup.button.callback(`Support: V1${supportDraft === 1 ? " ✅" : ""}`,
`CCPICK:${convId}:support:${bridgeDraft}:1`),
Markup.button.callback(`Support: V2${supportDraft === 2 ? " ✅" : ""}`,
`CCPICK:${convId}:support:${bridgeDraft}:2`),
Markup.button.callback(`Support: V3${supportDraft === 3 ? " ✅" : ""}`,
`CCPICK:${convId}:support:${bridgeDraft}:3`),
],

[Markup.button.callback("✅ Confirm CC Support",
`CCDO:${convId}:${bridgeDraft}:${supportDraft}`)],
[Markup.button.callback("Cancel", `OPENCARD:${convId}`)],
]);
await ctx.reply(
`📇 CC Support\n\nSelected:\n• Bridge Draft: V${bridgeDraft}\n• Support Draft:
V${supportDraft}\n\nConfirm to send both messages + create the Support mirror thread.`,
kb
);
});
// -------------------------------
// ✅ Final CC execution (fires webhook + writes OPS + refresh)
// -------------------------------
bot.action(/^CCDO:(.+):(\d):(\d)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const bridgeDraft = Number(ctx.match[2] || 2);
const supportDraft = Number(ctx.match[3] || 2);
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
if (!isProgramLaneConversation(conv)) {
return ctx.reply("📇 CC Support is only available from the Program/Outreach side.");
}
// Set suggested flag immediately (so UI reflects intent)
await ops()
.from("conversations")
.update({
cc_support_suggested: true,
updated_at: new Date().toISOString(),
})
.eq("id", convId);
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
});
// OPS ledger: dispatch
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "cc_support.dispatch_requested",
source: "telegram",
direction: "outbound",
entity_type: "conversation",
entity_id: convId,
trace_id: result.trace_id,
idempotency_key: result.idempotency_key,
payload: { bridgeDraft, supportDraft, result },
});
await ctx.reply(result.ok ? "📇 CC Support queued. Mirror thread will appear when ingested." :
`❌ CC failed (${result.status || "?"})`);
// Refresh the conversation card instantly
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});
});
// ==========================================================
// PEOPLE (v5.3 OPS + REFRESH + DELETE)
// ==========================================================
// NOTE: Requires these helpers to exist in your codebase:
// - sbGetConversationById(id)
// - sbGetPerson(id)
// - sbListPeopleByIdentity({ client_id, normalized_email, normalized_phone, limit })
// - sbListConversationsByPersonId(personId, limit) // for PERSONCONV
// - sbListSubmissionsByPersonId(personId, limit) // for PERSONSUB
// - idShort(str)

// - isAdmin(ctx)
// - registerLiveCard(msg, meta)
// - viewTitle(viewKey) OR remove it if you don’t use it
// - delete system routes: DELETECONFIRM:person:<id>
// ------------------------------
// PEOPLE LIST (from a conversation)
// ------------------------------
bot.action(/^PEOPLE:(.+)$/, async (ctx) => {
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
const header = `👥 People · ${idShort(convId)}\n${people.length} record(s)`;
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
? ` · Conf ${Number(p.identity_confidence_score).toFixed(2)}`
: "";
return `• ${name}\n ${email} · ${phone}\n Role: ${role}${conf}`;
})
.join("\n\n")
: "No people records.";
const kb = people.slice(0, 10).map((p) => [
Markup.button.callback(`Open ${p.name || "Person"}`, `PERSON:${p.id}`),

]);
kb.push([Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)]);
const msg = await ctx.reply(`${header}\n\n${body}`, Markup.inlineKeyboard(kb));
// Live refresh registration for this list
registerLiveCard(msg, {
type: "people_list",
card_key: `people:${convId}`,
ref_id: convId,
filterSource: conv.source || "all",
});
});
// ------------------------------
// PERSON DETAIL
// ------------------------------
bot.action(/^PERSON:(.+)$/, async (ctx) => {
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
const msg = await ctx.reply(text, kb);
// Live refresh registration for this person card
registerLiveCard(msg, {
type: "person",
card_key: `person:${p.id}`,
ref_id: p.id,
});
});
// ------------------------------
// PERSON → CONVERSATIONS
// ------------------------------
bot.action(/^PERSONCONV:(.+)$/, async (ctx) => {
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
const msg = await ctx.reply(`${header}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "person_convs",
card_key: `person_convs:${personId}`,
ref_id: personId,
});
});
// ------------------------------
// PERSON → SUBMISSIONS
// ------------------------------
bot.action(/^PERSONSUB:(.+)$/, async (ctx) => {
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
const msg = await ctx.reply(`${header}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "person_subs",
card_key: `person_subs:${personId}`,
ref_id: personId,
});
});
// ---------- SUBMISSION DETAIL CARD ----------
bot.action(/^SUB:(.+)$/, async (ctx) => {
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

const text = `🧾 Submission · ${idShort(submissionId)}\n\nSubmitter\n${name}\n${email}\n\nAthlete\n${athlete}\n\nDetails\nState: ${state}\nCoverage: ${cov}\n${coach}\n${pool}\n\nStatus\nSent Email: ${emailStatusIcon(emailSent)}\nSent SMS: ${smsStatusIcon(smsSent)}\n\nCreated: ${sub.created_at || "—"}`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", "ALLQ:open")],
]);

const msg = await smartRender(ctx, text, kb);
registerLiveCard(msg, {
type: "submission",
card_key: `submission:${submissionId}`,
ref_id: submissionId,
});
});
// ---------- COACH DETAIL CARD ----------
bot.action(/^COACH:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const coachId = ctx.match[1];
const coach = await sbGetCoach(coachId);
if (!coach) return ctx.reply("Coach not found.");

const name = coach.coach_name || "—";
const program = coach.program || coach.school || "—";
const filterSource = getAdminFilter(ctx);
const convs = await sbListConversationsByCoach({ coach_id: coachId, source: filterSource, limit: 10 });

const text = `🧑‍🏫 Coach · ${name}\n\nProgram\n${program}\n\nActive Conversations\n${convs.length}\n\nCreated: ${coach.created_at || "—"}`;

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
});
// ---------- COACH CONVERSATIONS ----------
bot.action(/^COACH:convs:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const coachId = ctx.match[1];
const coach = await sbGetCoach(coachId);
if (!coach) return ctx.reply("Coach not found.");

const filterSource = getAdminFilter(ctx);
const convs = await sbListConversationsByCoach({ coach_id: coachId, source: filterSource, limit: 12 });

const title = `🧵 ${coach.coach_name || "Coach"}'s Conversations`;
const body = convs.length ? convs.map((c, i) => `${i+1}. ${c.subject || "(no subject)"}\n${c.preview || ""}`).join("\n\n") : "No conversations.";

const kb = convs.map((c) => [Markup.button.callback(`Open • ${idShort(c.id)}`, `OPENCARD:${c.id}`)]);
kb.push([Markup.button.callback("⬅ Back", `COACH:${coachId}`)]);

const msg = await smartRender(ctx, `${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "coach_convs",
card_key: `coach_convs:${coachId}`,
ref_id: coachId,
});
});
// ---------- CLIENTS SEARCH ----------
bot.action("CLIENTS:search", async (ctx) => {
if (!isAdmin(ctx)) return;

const text = `🔎 Search Clients\n\nSend a message with client name or email to search.\n\nExample:\njordan smith\njsmith@example.com`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back", "CLIENTS:open")],
]);

await smartRender(ctx, text, kb);
});
// ---------- FORMATTING HELPERS (v5.3) ----------
// Sample refresh handlers and helpers omitted to avoid parsing issues.
function tSafe(s, max = 92) {
const t = String(s || "").replace(/\s+/g, " ").trim();
if (!t) return "—";
return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function tShortProgram(p) {
const s = String(p || "—").trim();
return s.length > 44 ? s.slice(0, 41) + "…" : s;
}
function tFmtMin(m) {
const n = Number(m);
if (!Number.isFinite(n) || n < 0) return null;
if (n < 60) return `${Math.round(n)}m`;
const h = Math.floor(n / 60);
const r = n % 60;
return r ? `${h}h ${r}m` : `${h}h`;
}
function tFmtDateShort(dt) {
if (!dt) return "—";
try {
const d = new Date(dt);
if (isNaN(d.getTime())) return "—";

return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
} catch (_) {
return "—";
}
}
function tFmtTimeShort(dt) {
if (!dt) return "—";
try {
const d = new Date(dt);
if (isNaN(d.getTime())) return "—";
return d.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
} catch (_) {
return "—";
}
}
function tFmtDateTimeShort(dt) {
if (!dt) return "—";
try {
const d = new Date(dt);
if (isNaN(d.getTime())) return "—";
return d.toLocaleString("en-US", {
year: "numeric",
month: "short",
day: "2-digit",
hour: "numeric",
minute: "2-digit",
});
} catch (_) {
return "—";
}
}
// ---------- conversation triage helpers ----------
function tComputeWaitingMinutes(c) {
if (Number.isFinite(Number(c.waiting_minutes))) return Number(c.waiting_minutes);
const t =
c.last_inbound_at ? new Date(c.last_inbound_at).getTime()
: c.updated_at ? new Date(c.updated_at).getTime()
: null;
if (!t || !Number.isFinite(t)) return null;
return Math.max(0, Math.round((Date.now() - t) / 60000));
}
function tIsCoachThread(c) {
if (typeof c.is_coach_thread === "boolean") return c.is_coach_thread;
if (c.entity_type) return String(c.entity_type).toLowerCase() === "coach";
const hasCoach = !!(c.coach_full_name || c.coach_name);
const hasClient = !!(c.client_full_name || c.contact_name || c.first_name || c.last_name);
return hasCoach && !hasClient;
}
function tDisplayName(c) {
const coach = c.coach_full_name || c.coach_name || null;
const client =
c.client_full_name ||
c.contact_name ||
((c.first_name || c.last_name) ? `${c.first_name || ""} ${c.last_name || ""}`.trim() : null);

const tag = roleTag(conversationRoleForDisplay(c));
if (tIsCoachThread(c) && coach) return `${tag} Coach ${tSafe(coach, 40)}`;
if (client) return `${tag} ${tSafe(client, 40)}`;
if (coach) return `${tag} Coach ${tSafe(coach, 40)}`;
return `${tag} —`;
}
function tConvoLine(c, idx) {
const name = tDisplayName(c);
const program = c.program_name || c.program || c.school || "";
const snippet = c.last_message_snippet || c.inbound_snippet || c.snippet || "";
const waitingMin = tComputeWaitingMinutes(c);
const waiting = waitingMin != null ? tFmtMin(waitingMin) : null;
const programBit = program ? ` (${tShortProgram(program)})` : "";
const waitBit = waiting ? `\n Waiting: ${waiting}` : "";
const msgBit = snippet ? `\n “${tSafe(snippet, 92)}”` : "";
return `${idx}) ⏳ ${name}${programBit}${waitBit}${msgBit}`;
}
function tConvoBtnLabel(c) {
const name = tDisplayName(c);
const program = c.program_name || c.program || c.school || "";
const progShort = program ? ` (${tSafe(program, 18)})` : "";
return `Open · ${tSafe(name, 22)}${progShort}`;
}
// ---------- follow-up helpers ----------
function tFollowupLine(f, idx) {
const coach = tSafe(f.coach_full_name || f.coach_name || "—", 40);
const program = tShortProgram(f.program_name || f.program || f.school || "—");
const dueAt = f.due_at || f.followup_next_action_at || f.next_action_at;
const last = f.last_contact_at || f.last_contacted_at || null;
const reason = f.reason ? tSafe(f.reason, 84) : null;
const activityBit =
typeof f.guide_opens_year === "number" || typeof f.enroll_clicks_year === "number"
? `\n Activity: Guide ${f.guide_opens_year || 0} | Enroll ${f.enroll_clicks_year || 0}`
: "";
return (
`${idx}) 📚 Coach Follow-Up Due — Coach ${coach} (${program})\n` +
` Due: ${tFmtDateShort(dueAt)} | Last Contact: ${tFmtDateShort(last)}` +

(reason ? `\n Reason: ${reason}` : "") +
activityBit
);
}
function tFollowupBtnLabel(f) {
const coach = tSafe(f.coach_full_name || f.coach_name || "Coach", 22);
const program = f.program_name || f.program || f.school || "";
const progShort = program ? ` (${tSafe(program, 18)})` : "";
return `Open · Coach ${coach}${progShort}`;
}
function tFollowupTargetAction(f) {
const convId = f.coach_comm_conversation_id || f.conversation_id || null;
if (convId) return `OPENCARD:${convId}`;
if (f.coach_id) return `COACH:${f.coach_id}`;
return null;
}
// ---------- calls helpers ----------
const TRIAGE_CALL_WINDOW_HOURS = 48; // shows rescheduled calls within next 48h
function tCallName(call) {
// always full name
return tSafe(call.client_full_name || call.contact_name || call.name || "—", 40);
}
function tCallContext(call) {
const state = call.state ? ` (${call.state})` : "";
return `${tCallName(call)}${state}`;
}
function tCallTypeEmoji(call) {
// call.outcome can be: null | "answered" | "rescheduled" | "no_answer" | "canceled"
// call.status can be: "missed" etc. We normalize to your desired emojis in the line text.
if (String(call.outcome || "").toLowerCase() === "rescheduled") return "📘";
if (String(call.outcome || "").toLowerCase() === "no_answer") return "❌";
if (String(call.status || "").toLowerCase() === "missed") return "❌";
return "📱";
}
function tCallDueAt(call) {
// Prefer next_action_at for follow-ups/outcome-needed; else scheduled_at
return call.next_action_at || call.due_at || call.scheduled_at || call.attempted_at || null;

}
function tCallSortKey(call) {
// due-now first, then earlier dueAt, then earlier scheduledAt
const now = Date.now();
const dueAt = tCallDueAt(call);
const dueMs = dueAt ? new Date(dueAt).getTime() : Infinity;
// "dueNow" if dueMs <= now OR (outcome missing and scheduled_at <= now)
const scheduledMs = call.scheduled_at ? new Date(call.scheduled_at).getTime() : Infinity;
const outcomeMissing = call.outcome == null;
const dueNow = (Number.isFinite(dueMs) && dueMs <= now) || (outcomeMissing &&
Number.isFinite(scheduledMs) && scheduledMs <= now);
return {
dueNow: dueNow ? 0 : 1,
dueMs: Number.isFinite(dueMs) ? dueMs : Infinity,
schedMs: Number.isFinite(scheduledMs) ? scheduledMs : Infinity,
};
}
function tCallLine(call, idx) {
const emoji = tCallTypeEmoji(call);
const who = tCallContext(call);
const outcome = call.outcome ? String(call.outcome).toLowerCase() : null;
const status = call.status ? String(call.status).toLowerCase() : null;
// Rescheduled
if (emoji === "📘") {
return (
`${idx}) 📘 Rescheduled — ${who}\n` +
` Next Call: ${tFmtTimeShort(call.scheduled_at)}`
);
}
// No Answer / Missed -> follow-up due
if (emoji === "❌") {
const attempted = call.attempted_at || call.updated_at || null;
const followupDue = call.next_action_at || null;
return (
`${idx}) ❌ No Answer — ${who}\n` +

` Attempted: ${tFmtMin(call.waiting_minutes || call.minutes_since_attempt || 0) ||
tFmtTimeShort(attempted)} ago\n` +
` Follow-Up Due: ${tFmtDateShort(followupDue)}`
);
}
// Scheduled / Outcome Missing
const sched = call.scheduled_at || call.due_at || null;
return (
`${idx}) 📱 Scheduled Call — ${who}\n` +
` Time: ${tFmtTimeShort(sched)}\n` +
` Status: Outcome Needed`
);
}
function tCallBtnLabel(call) {
const who = tCallContext(call);
return `Open · ${tSafe(who, 28)} (Call)`;
}
function tCallOpenAction(call) {
// adjust if your bot uses CALL:<id> or OPENCARD:<id>
const id = call.call_id || call.id;
if (!id) return null;
return `OPENCALL:${id}`;
}
// ===============================
// TRIAGE HANDLER
// ===============================
bot.action("TRIAGE:open", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx) || "all";
const roleFilter = getAdminRoleFilter(ctx) || "all";
// Conversations
const urgentRaw = await sbListConversations({ pipeline: "urgent", source: filterSource, role: roleFilter, limit: 24
});
const needsRaw = await sbListConversations({ pipeline: "needs_reply", source: filterSource, role: roleFilter,
limit: 48 });
// Calls (triage-focused list; your function should return ONLY relevant items)
// Expected to include:
// - outcome missing (scheduled_at <= now)

// - missed/no_answer follow-up due (next_action_at <= now)
// - rescheduled calls within next TRIAGE_CALL_WINDOW_HOURS
const callsRaw = await sbListCallsTriage({ source: filterSource, limit: 24, windowHours:
TRIAGE_CALL_WINDOW_HOURS });
// Coach follow-ups (due only)
const followupsRaw = await sbListCoachFollowupsDueNow({ source: filterSource, limit: 24 });
// ---- Deduplicate conversations by id (urgent wins) ----
const seen = new Set();
const urgent = [];
for (const c of urgentRaw || []) {
if (!c?.id) continue;
if (seen.has(c.id)) continue;
seen.add(c.id);
urgent.push(c);
}
const needs = [];
for (const c of needsRaw || []) {
if (!c?.id) continue;
if (seen.has(c.id)) continue;
seen.add(c.id);
needs.push(c);
}
// ---- Smart sorting ----
// urgent + needs: longest waiting first
const waitSort = (a, b) => (tComputeWaitingMinutes(b) || 0) - (tComputeWaitingMinutes(a) || 0);
urgent.sort(waitSort);
needs.sort(waitSort);
// calls: due-now first, then earliest due, then earliest scheduled
const calls = (callsRaw || []).slice().sort((a, b) => {
const ak = tCallSortKey(a);
const bk = tCallSortKey(b);
if (ak.dueNow !== bk.dueNow) return ak.dueNow - bk.dueNow;
if (ak.dueMs !== bk.dueMs) return ak.dueMs - bk.dueMs;
return ak.schedMs - bk.schedMs;
});
// follow-ups: soonest due first
const followups = (followupsRaw || []).slice().sort((a, b) => {
const ad = a.due_at || a.followup_next_action_at || a.next_action_at;
const bd = b.due_at || b.followup_next_action_at || b.next_action_at;

const at = ad ? new Date(ad).getTime() : Infinity;
const bt = bd ? new Date(bd).getTime() : Infinity;
return at - bt;
});
// ---- Build message text ----
const lines = [];
const title = (typeof viewTitle === "function") ? viewTitle("triage") : "⚡ Triage";
lines.push(`${title} · ${filterSource} · ${roleFilterLabel(roleFilter)}`);
let hasAny = false;
if (urgent.length) {
hasAny = true;
lines.push(`\n‼ Urgent`);
urgent.slice(0, 4).forEach((c, i) => lines.push(tConvoLine(c, i + 1)));
lines.push("──────────────");
}
if (calls.length) {
hasAny = true;
lines.push(`\n📱 Calls (Due)`);
calls.slice(0, 6).forEach((call, i) => lines.push(tCallLine(call, i + 1)));
lines.push("──────────────");
}
if (needs.length) {
hasAny = true;
lines.push(`\n⏳ Needs Reply`);
needs.slice(0, 6).forEach((c, i) => lines.push(tConvoLine(c, i + 1)));
lines.push("──────────────");
}
if (followups.length) {
hasAny = true;
lines.push(`\n📚 Coach Follow-Ups (Due)`);
followups.slice(0, 6).forEach((f, i) => lines.push(tFollowupLine(f, i + 1)));
}
if (!hasAny) {
lines.push(`\nNo due-now items.`);
}
// ---- Buttons (labeled; urgent first, then calls, then needs, then follow-ups) ----

const kb = [];
urgent.slice(0, 4).forEach((c) => {
kb.push([Markup.button.callback(tConvoBtnLabel(c), `OPENCARD:${c.id}`)]);
});
calls.slice(0, 6).forEach((call) => {
const action = tCallOpenAction(call);
if (action) kb.push([Markup.button.callback(tCallBtnLabel(call), action)]);
});
needs.slice(0, 6).forEach((c) => {
kb.push([Markup.button.callback(tConvoBtnLabel(c), `OPENCARD:${c.id}`)]);
});
followups.slice(0, 6).forEach((f) => {
const action = tFollowupTargetAction(f);
if (action) kb.push([Markup.button.callback(tFollowupBtnLabel(f), action)]);
});
kb.push([Markup.button.callback("⬅ Dashboard", "DASH:back")]);
const msg = await smartRender(ctx, lines.join("\n\n"), Markup.inlineKeyboard(kb));
// ✅ Register as live card for auto-refresh
registerLiveCard(msg, {
type: "triage",
card_key: `triage:${filterSource}`,
ref_id: filterSource,
});
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Error loading triage: ${err.message}`);
}
});
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
return SEARCH_STATE.get(chatId);
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
const { data } = await ops()
.from("conversations")
.select("id, subject, preview, updated_at, next_action_at, priority_tier, source, pipeline")
.or(`subject.ilike.%${q}%,preview.ilike.%${q}%,contact_email.ilike.%${q}%`)
.limit(15);
return (data || []).map(r => ({ ...r, entity_type: "conversation", card_key: `conversation:${r.id}` }));
},
// Submissions
async () => {
const { data } = await ops()
.from("submissions")
.select("submission_id, submission_payload, created_at")
.limit(15);
const filtered = (data || []).filter(s => {
const p = s.submission_payload || {};
const searchable = [p.first_name, p.last_name, p.email, p.phone, p.state].join(" ").toLowerCase();
return searchable.includes(q.toLowerCase());
});
return filtered.map(r => ({ ...r, entity_type: "submission", card_key: `submission:${r.submission_id}` }));
},
// People
async () => {
const { data } = await ops()
.from("people")
.select("id, name, email, role, created_at")
.or(`name.ilike.%${q}%,email.ilike.%${q}%`)
.limit(15);
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
bot.action("SEARCH:help", async (ctx) => {
if (!isAdmin(ctx)) return;

// v5.4: Activate search mode
const chatId = ctx.chat?.id;
if (chatId) setSearchMode(chatId, true);

const text =
`🔎 Search\n\nType your search query now:\n• Coach name\n• Client name or email\n• Submission ID\n• Phone number\n• Any keyword\n\nTip: Keep it simple - fewer words work better.\n\nOr use /search <text> anytime.`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("🕘 Recent", "SEARCH:recent")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
await smartRender(ctx, text, kb);
});
// ---------- SEARCH RECENT ----------
bot.action("SEARCH:recent", async (ctx) => {
if (!isAdmin(ctx)) return;

const text = `🕘 Recent Items\n\nRecent feature shows your last accessed conversations.\n\nTo access: Open any conversation from a queue view.`;

const kb = Markup.inlineKeyboard([
[Markup.button.callback("📱 Calls", "CALLS:hub")],
[Markup.button.callback("⚡️ Triage", "TRIAGE:open")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);

await smartRender(ctx, text, kb);
});
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
const { count, error } = await ops()
.from("v_triage_due_now")
.select("card_key", { count: "exact", head: true })
.eq("source", source === "all" ? "all" : source); // adjust if your view stores source differently
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

let q = ops()
.from("conversations")
.select("id, coach_id, coach_name, contact_email, source, pipeline, subject, preview, updated_at, created_at")
.eq("pipeline", "followups")
.lte("next_action_at", now)
.order("next_action_at", { ascending: true })
.limit(limit);

if (source !== "all") {
q = q.eq("source", sourceSafe(source));
}

const { data, error } = await q;
if (error) {
console.log("sbListCoachFollowupsDueNow error:", error);
return [];
}
return data || [];
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
bot.action("TODAY:open", async (ctx) => {
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
const [
triageDue,
callsToday,

needsReply,
followupsDue
] = await Promise.all([
sbCountTriageDueNow({ source: filterSource }).catch(() => 0),
sbCountCallsToday({ source: filterSource, dayStartISO, dayEndISO }).catch(() => 0),
sbCountNeedsReply({ source: filterSource }).catch(() => 0),
sbCountCoachFollowupsDueNow({ source: filterSource }).catch(() => 0),
]);
const text =
`📅 Today
${dayKey} · ${time}
⚡️ Triage Due: ${triageDue}
📱 Calls Today: ${callsToday}
⏳ Needs Reply: ${needsReply}
📚 Follow-Ups Due: ${followupsDue}`;
const kb = Markup.inlineKeyboard([
[Markup.button.callback("⚡️ Triage", "TRIAGE:open")],
[Markup.button.callback("📱 Calls", "CALLS:hub"), Markup.button.callback("🗂 All Queues",
"ALLQ:open")],
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
logError(ctx, err);
await ctx.reply(`❌ Error loading today: ${err.message}`);
}
});
// ---------- POOLS ----------
// ===============================
// POOLS (v5.3 FINAL — Refresh Enabled)
// ===============================
bot.action("POOLS:open", async (ctx) => {
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
lines.push(`🌊 Pools · ${filterSource}`);
const section = (title, list, builder) => {
if (!list.length) return;
lines.push(`\n${title}`);
list.slice(0,6).forEach((r,i)=>{
lines.push(builder(r,i));
});
lines.push("──────────────");
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
logError(ctx, err);
await ctx.reply(`❌ Error loading pools: ${err.message}`);
}
});
// ==========================================================
// METRICS CARD
// ==========================================================
async function showMetricsCard(ctx, window = "month") {
if (!isAdmin(ctx)) return;

const filterSource = getAdminFilter(ctx) || "all";
const metrics = await sbMetricSummary({ source: filterSource, window });

const titleMap = {
week: "📊 Metrics · Last 7 Days",
month: "📊 Metrics · Last 30 Days",
year: "📊 Metrics · This Year"
};
const title = titleMap[window] || titleMap.month;

// Calculate averages
const divisor = window === "week" ? 7 : window === "year" ? 365 : 30;
const perLabel = window === "year" ? "/mo" : "/day";
const avgDivisor = window === "year" ? 12 : divisor; // year shows per month average

const avg = (val) => Math.round((val || 0) / avgDivisor);

let body = `
Parent Guide Link Opens: ${metrics.programLinkOpens || 0} (Avg ${avg(metrics.programLinkOpens)}${perLabel})
Coverage Exploration: ${metrics.coverageExploration || 0} (Avg ${avg(metrics.coverageExploration)}${perLabel})
Enroll Portal Visits: ${metrics.enrollClicks || 0} (Avg ${avg(metrics.enrollClicks)}${perLabel})
eApp Visits: ${metrics.eappVisits || 0} (Avg ${avg(metrics.eappVisits)}${perLabel})
Threads Created (replies): ${metrics.threadsCreated || 0} (Avg ${avg(metrics.threadsCreated)}${perLabel})
Calls Answered: ${metrics.callsAnswered || 0} (Avg ${avg(metrics.callsAnswered)}${perLabel})
`.trim();

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
}

bot.action("METRICS:open", async (ctx) => {
return showMetricsCard(ctx, "month");
});

bot.action("METRICS:week", async (ctx) => {
return showMetricsCard(ctx, "week");
});

bot.action("METRICS:month", async (ctx) => {
return showMetricsCard(ctx, "month");
});

bot.action("METRICS:year", async (ctx) => {
return showMetricsCard(ctx, "year");
// ==========================================================
// LEADS & ANALYTICS
// ==========================================================
bot.action("LEADS:refresh", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
await smartRender(ctx, await leadsText(), leadsKeyboard());
} catch (err) {
logError(ctx, err);
await ctx.answerCbQuery(`Error: ${err.message}`);
}
});

bot.action(/^LEADS:filter:(.+)$/, async (ctx) => {
try {
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
} catch (err) {
logError(ctx, err);
await ctx.answerCbQuery(`Error: ${err.message}`);
}
});

bot.action("ANALYTICS:refresh", async (ctx) => {
try {
if (!isAdmin(ctx)) return;
await smartRender(ctx, await analyticsText(), analyticsKeyboard());
} catch (err) {
logError(ctx, err);
await ctx.answerCbQuery(`Error: ${err.message}`);
}
});

});
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
// Delete is handled by your universal delete system:
// - DELETECONFIRM:client:<client_id> (add client to ENTITY_MAP when you create table)
//
// ==========================================================
// ------------------------------
// CLIENTS HUB
// ------------------------------
bot.action("CLIENTS:open", async (ctx) => {
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
logError(ctx, err);
await ctx.reply(`❌ Error loading clients: ${err.message}`);
}
});
// ------------------------------
// CLIENTS LISTS
// buckets: needs_reply | active | completed | new_month | recent | history
// ------------------------------
bot.action(/^CLIENTS:list:(needs_reply|active|completed|new_month|recent|history):?(\d*)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const bucket = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count for this bucket
const { data: allClients } = await ops()
.from("people")
.select("client_id", { count: "exact", head: false });
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
const kb = (rows || []).map((c) => {
const nm = c.primary_name || c.name || "—";
return [Markup.button.callback(`Open • ${nm} • ${idShort(c.client_id)}`, `CLIENT:${c.client_id}`)];
});

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
});
// ------------------------------
// CLIENT CARD (includes 🌊 Pools)
// ------------------------------
bot.action(/^CLIENT:(.+)$/, async (ctx) => {
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
? `\n🌊 Pools\n` +
poolsArr.slice(0, 3).map((p) => {
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
`👥 Client · ${name}\n` +
`ClientID: ${c.client_id}\n` +
`Status: ${status}\n\n` +
`Primary: ${primaryRole}\n` +
`Last Activity: ${c.last_activity_at || "—"}\n` +
`Last Inbound: ${c.last_inbound_at || "—"}\n\n` +
`────────────────\n\n` +

`📬 Contact\n` +
`Email: ${email}\n` +
`Phone: ${phone}\n` +
`State: ${state}\n` +
`${poolsBlock ? `\n────────────────\n\n${poolsBlock}` : ""}\n` +
`────────────────\n\n` +
`📊 Activity\n` +
`Threads: ${c.threads_total || 0}  📝 Needs Reply: ${c.threads_needs_reply || 0}\n` +
`Submissions: ${c.submissions_total || 0}\n` +
`Calls Open: ${c.calls_open || 0}\n\n` +
`────────────────\n\n` +
`🧾 Coverage\n${covLine}\n\n` +
`────────────────\n\n` +
`🧠 Identity\nPeople Linked: ${c.people_count || 0}`;
const hasPools = poolsArr.length > 0;
const kbRows = [
[Markup.button.callback("🧵 Threads", `CLIENT:threads:${c.client_id}`),
Markup.button.callback("🧾 Submissions", `CLIENT:subs:${c.client_id}`)],
[Markup.button.callback("📱 Calls", `CLIENT:calls:${c.client_id}`), Markup.button.callback("👥 People", `CLIENT:people:${c.client_id}`)],
];
if (hasPools) kbRows.push([Markup.button.callback("🌊 Pools",
`CLIENT:pools:${c.client_id}`)]);
kbRows.push([Markup.button.callback("🔎 Search", "CLIENTS:search")]);
kbRows.push([Markup.button.callback("🗑 Delete", `DELETECONFIRM:client:${c.client_id}`)]);
kbRows.push([Markup.button.callback("⬅ Clients", "CLIENTS:open")]);
const msg = await ctx.reply(text, Markup.inlineKeyboard(kbRows));
registerLiveCard(msg, {
type: "client",
card_key: `client:${c.client_id}`,
ref_id: c.client_id,
});
});
// ------------------------------
// CLIENT → THREADS
// ------------------------------
bot.action(/^CLIENT:threads:(.+):?(\d*)$/, async (ctx) => {

if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count
const { data: allThreads } = await ops()
.from("conversations")
.select("id", { count: "exact", head: false });
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
: "No threads yet.\n\n(If they only submitted the website form, threads will appear when a reply comes in.)";
const kb = (threads || []).map((t) => [Markup.button.callback(`Open • ${idShort(t.id)}`,
`OPENCARD:${t.id}`)]);

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
});
// ------------------------------
// CLIENT → SUBMISSIONS
// ------------------------------
bot.action(/^CLIENT:subs:(.+):?(\d*)$/, async (ctx) => {
if (!isAdmin(ctx)) return;

const clientId = ctx.match[1];
const page = parseInt(ctx.match[2]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;

// Get total count
const { data: allSubs } = await ops()
.from("submissions")
.select("submission_id", { count: "exact", head: false });
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
const kb = (subs || []).map((s) => [Markup.button.callback(`Open • ${idShort(s.submission_id)}`,
`SUB:${s.submission_id}`)]);

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
});
// ------------------------------
// CLIENT → CALLS
// ------------------------------
bot.action(/^CLIENT:calls:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;

const clientId = ctx.match[1];
const calls = await sbListClientCalls(clientId, 10);
const title = `📱 Calls · ${idShort(clientId)}`;
const body = calls?.length
? calls.slice(0, 10).map((c) => {
const when = c.scheduled_for || "—";
const outcome = c.outcome || "—";
const reason = c.reason || "—";
const email = c.client_email || "—";
const phone = c.best_phone || c.client_phone_e164 || "—";
return `• ${when}\nReason: ${reason}\nEmail: ${email}\nPhone: ${phone}\nOutcome:
${outcome}`;
}).join("\n\n")
: "No calls found.";
const kb = (calls || []).slice(0, 10).map((c) => [Markup.button.callback("Open", `CALL:${c.id}`)]);
kb.push([Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]);
const msg = await ctx.reply(`${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_calls",
card_key: `client_calls:${clientId}`,
ref_id: clientId,
});
});
// ------------------------------
// CLIENT → PEOPLE
// ------------------------------
bot.action(/^CLIENT:people:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const people = await sbListPeopleForClient(clientId, 12);
const title = `👥 People · ${idShort(clientId)}\n${people?.length || 0} record(s)`;
const body = people?.length
? people.slice(0, 12).map((p) => {
const nm = p.name || "—";
const em = p.email || "—";

const ph = p.phone_e164 || "—";
const role = p.role || "—";
return `• ${nm}\n${em} · ${ph}\nRole: ${role}`;
}).join("\n\n")
: "No people found.";
const kb = (people || []).slice(0, 10).map((p) => [Markup.button.callback("Open",
`PERSON:${p.id}`)]);
kb.push([Markup.button.callback("⬅ Client", `CLIENT:${clientId}`)]);
const msg = await ctx.reply(`${title}\n\n${body}`, Markup.inlineKeyboard(kb));
registerLiveCard(msg, {
type: "client_people",
card_key: `client_people:${clientId}`,
ref_id: clientId,
});
});
// ------------------------------
// CLIENT → POOLS (optional screen)
// ------------------------------
bot.action(/^CLIENT:pools:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const clientId = ctx.match[1];
const c = await sbGetClientCard(clientId);
if (!c) return ctx.reply("Client not found.");
const poolsArr = Array.isArray(c.pools) ? c.pools : [];
const title = `🌊 Pools · ${c.primary_name || idShort(clientId)}`;
const body = poolsArr.length
? poolsArr.slice(0, 10).map((p) => {
const label = p.pool_label || "—";
const coachName = p.coach_name || "—";
const coachId = p.coach_id || "—";
return `• ${label}\nCoach: ${coachName}\nCoachID: ${coachId}`;
}).join("\n\n")
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
});
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
// `Email: ${email}\n` +
// `Phone: ${phone}\n` +
// `State: ${state}\n` +
// `${poolsBlock ? `\n────────────────\n\n${poolsBlock}` : ""}\n` +
// `────────────────\n\n` +
// `📊 Activity\n` +
// `Threads: ${c.threads_total || 0} ⏳ Needs Reply: ${c.threads_needs_reply || 0}\n` +
// `Submissions: ${c.submissions_total || 0}\n` +
// `Calls Open: ${c.calls_open || 0}\n\n` +
// `────────────────\n\n` +
// `🧾 Coverage\n${covLine}\n\n` +
// `────────────────\n\n` +
// `🧠 Identity\nPeople Linked: ${c.people_count || 0}`;
// const hasPools = poolsArr.length > 0;
// const kbRows = [
// [Markup.button.callback("🧵 Threads", `CLIENT:threads:${c.client_id}`),
// Markup.button.callback("🧾 Submissions", `CLIENT:subs:${c.client_id}`)],
// [Markup.button.callback("📱 Calls", `CLIENT:calls:${c.client_id}`),
// Markup.button.callback("👥 People", `CLIENT:people:${c.client_id}`)],
// ];
// if (hasPools) kbRows.push([Markup.button.callback("🌊 Pools",
// `CLIENT:pools:${c.client_id}`)]);
// kbRows.push([Markup.button.callback("🔎 Search", "CLIENTS:search")]);
// kbRows.push([Markup.button.callback("🗑 Delete",
// `DELETECONFIRM:client:${c.client_id}`)]);
// kbRows.push([Markup.button.callback("⬅ Clients", "CLIENTS:open")]);
// const msg = await ctx.reply(text, Markup.inlineKeyboard(kbRows));
// registerLiveCard(msg, {
// type: "client",
// card_key: `client:${c.client_id}`,
// ref_id: c.client_id,
// });
// }

// ---------- CALLS ----------
// ---------- CALLS (v5.3) — FINAL UPDATED BLOCK ----------
// Includes:
// ✅ Email clickable (mailto:)
// ✅ Phone clickable (tel:)
// ✅ Phone uses BEST PHONE (Calendly answer) and removes duplicate phone line
// elsewhere
// ✅ 🔴 Needs Action if >15 min past scheduled_for and no outcome
// ✅ Outcomes: answered | no_answer | reschedule | canceled | completed
// ✅ Live refresh registration for call cards (type="call")
// ✅ Targeted refreshQueue updates + refreshLiveCards(true)
//
// IMPORTANT:
// - Because call cards use HTML links, call card send/edit must use parse_mode: "HTML".
// - If your refreshLiveCards edits call cards, make sure it uses parse_mode: "HTML" too.
const CALL_NEEDS_ACTION_MINUTES = 15;
function parseIsoOrNull(v) {
const d = v ? new Date(v) : null;
return d && !isNaN(d.getTime()) ? d : null;
}
function fmtWhen(iso) {
const d = parseIsoOrNull(iso);
if (!d) return "—";
return d.toLocaleString();
}
function callNeedsAction(call) {
if (!call) return false;
if (call.outcome) return false;
const base = parseIsoOrNull(call.scheduled_for) || parseIsoOrNull(call.created_at);
if (!base) return false;
const dueAt = new Date(base.getTime() + CALL_NEEDS_ACTION_MINUTES * 60 * 1000);
return Date.now() > dueAt.getTime();
}
function callStatusLabel(call) {
if (!call) return "";
if (call.outcome === "answered") return "✅ Answered";

if (call.outcome === "completed") return "✅ Completed";
if (call.outcome === "no_answer") return "❌ No Answer";
if (call.outcome === "reschedule") return "📘 Rescheduled";
if (call.outcome === "canceled") return "🚫 Canceled";
if (callNeedsAction(call)) return "🔴 Needs Action";
return "Scheduled";
}
// Hub stays plain-text (simple, fast)
function callSummaryLine(c) {
const status = callStatusLabel(c);
const email = c.client_email || c.email || "—";
const phone =
c.best_phone ||
c.calendly_payload?.best_phone ||
c.client_phone_e164 ||
c.phone_e164 ||
"—";
const role = c.role || c.client_role || "—";
const when = fmtWhen(c.scheduled_for);
return `${status}\n${email} · ${phone}\nWhen: ${when} · Role: ${role}`;
}
// Call detail card uses HTML for tel:/mailto:
function buildCallCardTextHTML(c) {
const status = callStatusLabel(c);
const esc = (s) =>
String(s || "")
.replaceAll("&", "&amp;")
.replaceAll("<", "&lt;")
.replaceAll(">", "&gt;");
// Email (clickable)
const rawEmail = c.client_email || c.email || "";
const emailLine = rawEmail
? `<a href="mailto:${esc(rawEmail)}">${esc(rawEmail)}</a>`
: "—";
// Phone (BEST PHONE ONLY — clickable)
const rawPhone =
c.best_phone ||
c.calendly_payload?.best_phone ||
c.client_phone_e164 ||

c.phone_e164 ||
"";
const phoneLine = rawPhone
? `<a href="tel:${esc(rawPhone)}">${esc(rawPhone)}</a>`
: "—";
const role = esc(c.role || c.client_role || "—");
const when = esc(fmtWhen(c.scheduled_for));
const updatedAt = esc(tFmtDateTimeShort(c.updated_at || c.created_at));
// Calendly reasoning fields (flexible mapping)
const sportLevel = esc(
c.sport_level ||
c.sport ||
c.level ||
c.calendly_payload?.sport_level ||
"—"
);
const help = esc(
c.help_question ||
c.reason ||
c.calendly_payload?.q_help ||
c.calendly_payload?.reason ||
"—"
);
const notes = esc(c.notes || c.calendly_payload?.notes || "—");
const convId = c.conversation_id ? esc(idShort(c.conversation_id)) : "—";
return (
`📱 <b>Call</b> · ${esc(idShort(c.id))}
<b>Client</b>
Email: ${emailLine}
Phone: ${phoneLine}
Role: ${role}
<b>When</b>
Scheduled: ${when}
Status: <b>${esc(status)}</b>
Updated: ${updatedAt}
<b>Reason (Calendly)</b>

Sport/Level: ${sportLevel}
Help: ${help}
Notes: ${notes}
<b>Linked</b>
Conversation: ${convId}`
);
}
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
bot.action(/^CALLS:hub:?(\d*)$/, async (ctx) => {
try {
if (!isAdmin(ctx)) return;
const page = parseInt(ctx.match[1]) || 1;
const pageSize = 5;
const offset = (page - 1) * pageSize;
  
// Get total count
const { data: allCalls, error: countErr } = await ops()
.from("calls")
.select("id", { count: "exact", head: false });
const totalCount = allCalls?.length || 0;
const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
const currentPage = Math.min(page, totalPages);
  
const calls = await sbListCalls({ limit: pageSize, offset });
const endItem = Math.min(offset + calls.length, totalCount);
const pageInfo = `Page ${currentPage}/${totalPages} • Items ${endItem}/${totalCount}`;
const body = calls.length ? calls.map(callSummaryLine).join("\n\n") : "No calls found.";
const kb = calls.map((c, idx) => {
const name = c.client_name || "—";
return [Markup.button.callback(`Open • ${name} • ${idShort(c.id)}`, `CALL:${c.id}`)];
});
  
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
logError(ctx, err);
await ctx.reply(`❌ Error loading calls: ${err.message}`);
}
});
// -------- Open Call Card --------
bot.action(/^CALL:(.+)$/, async (ctx) => {
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
});
// -------- Set Outcome --------
bot.action(/^CALLSTATUS:(.+):(answered|no_answer|reschedule|canceled|completed)$/, async (ctx) => {
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
);
});
// ---------- METRICS: YEAR SUMMARY (v5.3) — FULL REPLACEMENT + LIVE REFRESH REGISTRATION ----------
// Includes:
// ✅ Calls Answered (no ✅ emoji in label)
// ✅ Monthly breakdown chart (Guide/Explr/Enroll/eApp/Threads/Calls) Jan..Dec
// ✅ Highlights (best week/month/month ever)
// ✅ Trends are MONTH-TO-MONTH momentum (last completed month vs previous month)

// ✅ Registers as a LIVE CARD so your global refresh engine can auto-refresh it
//
// NOTE: This registers the live card. For true auto-refresh, your refreshLiveCards()
// must include a branch to handle meta.type === "metrics_year" and re-render it.
// If you don't add that branch yet, the card will still display correctly; it just won't auto-update.
function buildYearSummaryText(y, filterSource) {
const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const avg = (total) => Math.round(n(total) / 12);
const trendEmoji = (v) =>
v === "up" ? "📈 Up-Trend" : v === "down" ? "📉 Down-Trend" : "➖ Flat";
const months = Array.isArray(y.monthlyBreakdown) ? y.monthlyBreakdown : [];
const byLabel = new Map(
months.map((m) => [String(m.label || m.month || "").toLowerCase(), m])
);
const order = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pick = (mon) => byLabel.get(mon.toLowerCase()) || {};
const monthLine = order
.map((mon) => `${mon} ${String(n(pick(mon).enrollClicks)).padStart(2, " ")}`)
.join("  ");
const bestWeek = y.bestWeek
? `🏆 Best Week: ${y.bestWeek.label || "—"} (Enroll ${n(y.bestWeek.enrollClicks)}, Threads ${n(y.bestWeek.threads)})`
: "🏆 Best Week: —";
const bestMonth = y.bestMonth
? `⭐ Best Month: ${y.bestMonth.label || "—"} (Enroll ${n(y.bestMonth.enrollClicks)}, Threads ${n(y.bestMonth.threads)})`
: "⭐ Best Month: —";
const bestMonthEver = y.bestMonthEver
? `👑 Best Month Ever: ${y.bestMonthEver.label || "—"} (Enroll ${n(y.bestMonthEver.enrollClicks)}, Threads ${n(y.bestMonthEver.threads)})`
: "👑 Best Month Ever: —";
const t = y.trend || {};
return (
`🎉 Year Summary · ${filterSource}\n\n` +
`Totals\n` +
`• Total Parent Guides Opened: ${n(y.programLinkOpens)} (Avg ${avg(y.programLinkOpens)}/mo)\n` +
`• Coverage Exploration: ${n(y.coverageExploration)} (Avg ${avg(y.coverageExploration)}/mo)\n` +
`• Enroll Clicks: ${n(y.enrollClicks)} (Avg ${avg(y.enrollClicks)}/mo)\n` +
`• eApp Visits: ${n(y.eappVisits)} (Avg ${avg(y.eappVisits)}/mo)\n` +
`• Threads (Replies): ${n(y.threadsCreated)} (Avg ${avg(y.threadsCreated)}/mo)\n` +
`• Calls Answered: ${n(y.callsAnswered)} (Avg ${avg(y.callsAnswered)}/mo)\n\n` +
`Monthly Breakdown (Total Clicks)\n` +
`${monthLine}\n\n` +
`Highlights\n` +
`${bestWeek}\n` +
`${bestMonth}\n` +
`${bestMonthEver}\n\n` +
`Trends (vs last month)\n` +
`• Parent Guides: ${trendEmoji(t.opens)}\n` +
`• Exploration: ${trendEmoji(t.exploration)}\n` +
`• Enroll Clicks: ${trendEmoji(t.enrollClicks)}\n` +
`• eApp Visits: ${trendEmoji(t.eappVisits)}\n` +
`• Threads (Replies): ${trendEmoji(t.threads)}\n` +
`• Calls Answered: ${trendEmoji(t.callsAnswered)}`
);
}
function yearSummaryKeyboard() {
return Markup.inlineKeyboard([
[Markup.button.callback("📊 Metrics", "METRICS:open")],
[Markup.button.callback("⬅ Dashboard", "DASH:back")],
]);
}
bot.action("METRICS:yearsummary", async (ctx) => {
if (!isAdmin(ctx)) return;
const filterSource = getAdminFilter(ctx);
const y = await sbMetricSummary({ source: filterSource, window: "year" });
const text = buildYearSummaryText(y, filterSource);
const msg = await smartRender(ctx, text, yearSummaryKeyboard());
// ✅ Live refresh registration (auto-updating card)
if (typeof registerLiveCard === "function") {
registerLiveCard(msg, {
type: "metrics_year",
ref_id: filterSource, // store filter source so refresh can re-fetch
card_key: `metrics_year:${filterSource}`,
});
}
return msg;
});
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
// outreach should use an outreach sender (recommended), fallback to inbound_from_email
// only if you truly want that behavior
// NOTE: using inbound_from_email as FROM can break DMARC unless you have verified
// sender / domain alignment
return conv?.outreach_from_email || OUTREACH_FROM_EMAIL ||
SUPPORT_FROM_EMAIL;
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
async function sbEnsureCcPackageDrafts(convId) {
// If you already generate these drafts elsewhere (n8n/AI), you can noop this.
// This stub just ensures "bridge" + "support_forward" exist.
// Implement however you want; simplest is:
// - if missing, insert a default V1 selected for each kind.
return true;
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
const prompt = {
contact_email: conv.contact_email || "",
subject: conv.subject || "",
preview: conv.preview || "",
latest_inbound: inbound?.body || inbound?.preview || "",
coach_name: conv.coach_name || "",
source: conv.source || "support",
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
{ role: "system", content: "You write concise professional support replies. Return JSON with v1,v2,v3 each containing subject and body." },
{ role: "user", content: `Create 3 reply drafts for this inbound conversation:\n${JSON.stringify(prompt)}\n\nRules:\n- V1 direct/helpful\n- V2 warm/relationship-focused\n- V3 concise/executive\n- Keep under 130 words\n- Include clear next step\n- Do not mention AI\nReturn: {\"v1\":{\"subject\":\"...\",\"body\":\"...\"},\"v2\":{...},\"v3\":{...}}` }
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

function draftsKeyboard(convId, selectedVersion = null) {
const tag = (v) => selectedVersion === v ? " ✅" : "";
return Markup.inlineKeyboard([
[Markup.button.callback(`Use V1${tag(1)}`, `DRAFTS:use:${convId}:1`), Markup.button.callback(`Use V2${tag(2)}`, `DRAFTS:use:${convId}:2`), Markup.button.callback(`Use V3${tag(3)}`, `DRAFTS:use:${convId}:3`)],
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

bot.action(/^DRAFTS:open:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const drafts = await sbListConversationDrafts(convId);
if (!drafts.length) {
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
const generated = await generateConversationDrafts(conv);
await sbSaveConversationDraftVersion(convId, 1, generated?.v1?.subject || conv.subject || "Re:", generated?.v1?.body || "", true);
await sbSaveConversationDraftVersion(convId, 2, generated?.v2?.subject || conv.subject || "Re:", generated?.v2?.body || "", false);
await sbSaveConversationDraftVersion(convId, 3, generated?.v3?.subject || conv.subject || "Re:", generated?.v3?.body || "", false);
}
await renderDraftsCard(ctx, convId);
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Draft error: ${err.message}`);
}
});

bot.action(/^DRAFTS:use:(.+):(1|2|3)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const version = Number(ctx.match[2]);
try {
await sbSelectConversationDraft(convId, version);
await renderDraftsCard(ctx, convId, `Selected V${version}`);
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Select draft failed: ${err.message}`);
}
});

bot.action(/^DRAFTS:regen:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
const generated = await generateConversationDrafts(conv);
await sbSaveConversationDraftVersion(convId, 1, generated?.v1?.subject || conv.subject || "Re:", generated?.v1?.body || "", true);
await sbSaveConversationDraftVersion(convId, 2, generated?.v2?.subject || conv.subject || "Re:", generated?.v2?.body || "", false);
await sbSaveConversationDraftVersion(convId, 3, generated?.v3?.subject || conv.subject || "Re:", generated?.v3?.body || "", false);
await renderDraftsCard(ctx, convId, "Regenerated drafts");
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Regenerate failed: ${err.message}`);
}
});

bot.action(/^DRAFTS:edit:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
try {
const selected = await sbGetSelectedDraftBody(convId, "conversation");
if (!selected) return ctx.reply("No selected draft. Choose V1/V2/V3 first.");
const userId = String(ctx.from?.id || "");
draftEditState.set(userId, { convId, version: Number(selected.version || 1) });
await ctx.reply(`✏️ Send your edited reply now.\n\nFormat:\nLine 1 = Subject\nBlank line\nThen body\n\nIf you send only text, it will replace body and keep subject.`);
} catch (err) {
logError(ctx, err);
await ctx.reply(`❌ Edit setup failed: ${err.message}`);
}
});
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
from_email: await resolveFromEmail(conv, sendAs),
// threading support
gmail_thread_id: conv.gmail_thread_id || null,
message_id_header: conv.message_id_header || null,
in_reply_to: conv.in_reply_to || null,
references: conv.references || null,
mirror_conversation_id: conv.mirror_conversation_id || null,
use_draft: Number(useDraft),
};
// local dev safety
if (!MAKE_SEND_WEBHOOK_URL) {
console.log("SEND STUB:", payload);
return { ok: true, stub: true, trace_id, idempotency_key };
}
const res = await fetch(MAKE_SEND_WEBHOOK_URL, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(payload),
});
return {
ok: res.ok,
status: res.status,
trace_id,
idempotency_key,
};
}

// ===============================
// SEND BUTTON PRESSED (single send)
// ===============================
bot.action(/^SEND:(.+):([01])$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
const kb = Markup.inlineKeyboard([
[Markup.button.callback("Confirm Support Send",
`CONFIRMSEND:${convId}:${useDraft}:support`)],
[Markup.button.callback("Confirm Outreach Send",
`CONFIRMSEND:${convId}:${useDraft}:outreach`)],
[Markup.button.callback("⬅ Back", `OPENCARD:${convId}`)],
]);
await ctx.reply(`📤 Send Draft ${useDraft ? "ON" : "OFF"}\n\nChoose send mode:`, kb);
});
// ===============================
// CONFIRM SEND SCREEN (single send)
// ===============================
bot.action(/^CONFIRMSEND:(.+):([01]):(support|outreach)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const mode = ctx.match[3];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
const kb = Markup.inlineKeyboard([
[Markup.button.callback("✅ Send Now", `DOSEND:${convId}:${useDraft}:${mode}`)],
[Markup.button.callback("Cancel", `OPENCARD:${convId}`)],
]);
await ctx.reply(`⚠ Confirm send?\nMode: ${mode}\nDraft: ${useDraft}`, kb);
});

// ===============================
// FINAL SEND EXECUTION (single send)
// ===============================
bot.action(/^DOSEND:(.+):([01]):(support|outreach)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const useDraft = Number(ctx.match[2]);
const mode = ctx.match[3];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
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
await ctx.reply(result.ok ? "✅ Send queued." : `❌ Send failed (${result.status || "?"})`);
// Instant refresh
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});

});
// ==========================================================
// CC SUPPORT PACKAGE (Bridge + Support Forward + SEND BOTH)
// ==========================================================
// Open package menu (only meaningful on PROGRAM/OUTREACH conversations)
bot.action(/^CCPACKAGE:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
// Optional guard: hide this for support threads
if (conv.conversation_kind === "support") {
return ctx.reply("CC Support Package is not available on support threads.");
}
// Ensure drafts exist (bridge + support_forward)
await sbEnsureCcPackageDrafts(convId);
const bridge = await sbGetSelectedDraftBody(convId, "bridge");
const support = await sbGetSelectedDraftBody(convId, "support_forward");
const kb = Markup.inlineKeyboard([
[Markup.button.callback("Open Bridge Draft", `CCOPEN:bridge:${convId}`)],
[Markup.button.callback("Open Support Forward Draft",
`CCOPEN:support_forward:${convId}`)],
[Markup.button.callback(`✅ SEND BOTH (Bridge V${bridge?.version || "?"} + Support
V${support?.version || "?"})`, `CCSEND:${convId}`)],
[Markup.button.callback("Cancel", `OPENCARD:${convId}`)],
]);
await ctx.reply(
`📇 CC Support Package\n\nThis will send:\n• Bridge message (Outreach → Coach)\n•
Support forward message (Support → Coach)\n\nReview drafts, then send both.`,
kb
);
});
// Open one of the CC drafts (you can route this to your existing OPENCARD builder if you treat
// these as draft cards)
bot.action(/^CCOPEN:(bridge|support_forward):(.+)$/, async (ctx) => {

if (!isAdmin(ctx)) return;
const kind = ctx.match[1];
const convId = ctx.match[2];
const d = await sbGetSelectedDraftBody(convId, kind);
if (!d) return ctx.reply("Draft not found.");
await ctx.reply(
`🧾 ${kind === "bridge" ? "Bridge Draft" : "Support Forward Draft"}\nSelected:
V${d.version}\n\nSubject:\n${d.subject || "—"}\n\nBody:\n${d.body || "—"}`,
Markup.inlineKeyboard([
[Markup.button.callback("⬅ Back to Package", `CCPACKAGE:${convId}`)]
])
);
});
// Final: send BOTH + link/lock support
bot.action(/^CCSEND:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
if (conv.conversation_kind === "support") {
return ctx.reply("CC Support Package is not available on support threads.");
}
const bridge = await sbGetSelectedDraftBody(convId, "bridge");
const support = await sbGetSelectedDraftBody(convId, "support_forward");
if (!bridge || !support) return ctx.reply("Missing bridge/support drafts.");
// Confirm screen (one final button)
const kb = Markup.inlineKeyboard([
[Markup.button.callback("✅ Send Both Now", `CCDOSEND:${convId}`)],
[Markup.button.callback("Cancel", `CCPACKAGE:${convId}`)],
]);
await ctx.reply(
`⚠ Confirm CC Package Send?\n\nBridge: Outreach → Coach
(V${bridge.version})\nSupport: Support → Coach (V${support.version})`,
kb
);

});
bot.action(/^CCDOSEND:(.+)$/, async (ctx) => {
if (!isAdmin(ctx)) return;
const convId = ctx.match[1];
const conv = await sbGetConversationById(convId);
if (!conv) return ctx.reply("Conversation not found.");
const bridge = await sbGetSelectedDraftBody(convId, "bridge");
const support = await sbGetSelectedDraftBody(convId, "support_forward");
if (!bridge || !support) return ctx.reply("Missing bridge/support drafts.");
// Send Bridge from OUTREACH identity
const r1 = await sendViaMake(conv, {
useDraft: Number(bridge.version || 1),
ccSupport: false, // bridge is just coach-facing
sendAs: "outreach",
subjectOverride: bridge.subject || conv.subject || "",
bodyOverride: bridge.body || "",
});
// Send Support Forward from SUPPORT identity
const r2 = await sendViaMake(conv, {
useDraft: Number(support.version || 1),
ccSupport: false, // support forward is the new operational thread anchor
sendAs: "support",
subjectOverride: support.subject || conv.subject || "",
bodyOverride: support.body || "",
});
// Link + lock
const nowIso = new Date().toISOString();
await ops()
.from("conversations")
.update({
cc_support_enabled: true,
cc_support_locked_at: nowIso,
// if you already have linked IDs, set them here too
// support_linked_conversation_id: conv.support_linked_conversation_id || <create/find support conversation id>
updated_at: nowIso,
})
.eq("id", convId);

// Ledger event
await sbInsertOpsEvent({
schema_version: "5.3",
event_type: "cc_support.package_sent",
source: "telegram",
direction: "outbound",
entity_type: "conversation",
entity_id: convId,
payload: {
bridge: { version: bridge.version, trace_id: r1.trace_id, ok: r1.ok, status: r1.status },
support: { version: support.version, trace_id: r2.trace_id, ok: r2.ok, status: r2.status },
},
});
await ctx.reply(
(r1.ok && r2.ok)
? "✅ Bridge queued.\n✅ Support forward queued.\n📎 Support linked + locked."
: `⚠ Package queued with issues.\nBridge ok=${r1.ok}\nSupport ok=${r2.ok}`
);
// Refresh everywhere
refreshQueue.add(`conversation:${convId}`);
refreshLiveCards(true).catch(() => {});
});
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
bot.action(/^DELETECONFIRM:([a-z_]+):(.+)$/, async (ctx) => {

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
);
});
// do delete
bot.action(/^DELETE:([a-z_]+):(.+)$/, async (ctx) => {
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
});

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
// QUEUE REFRESH (USE EVERYWHERE)
// ----------------------------------------------------------
function queueCardRefresh(card_key) {
if (!card_key) return;
refreshQueue.add(card_key);
}
// ----------------------------------------------------------
// CLEANUP OLD CARDS
// ----------------------------------------------------------
function cleanupLiveCards() {
const ttl = (LIVE_CARD_TTL_MINUTES || 60) * 60 * 1000;
const now = Date.now();

for (const [msgId, m] of liveCards.entries()) {
if (!m?.added_at || (now - m.added_at) > ttl) {
liveCards.delete(msgId);
}
}
}
// ----------------------------------------------------------
// SAFE EDIT
// ----------------------------------------------------------
async function safeEditMessageText(chat_id, message_id, text, extra) {
try {
await bot.telegram.editMessageText(chat_id, message_id, undefined, text, extra);
return true;
} catch (err) {
const msg = String(err?.description || err?.message || "");
if (msg.includes("message is not modified")) return true;
if (
msg.includes("message to edit not found") ||
msg.includes("MESSAGE_ID_INVALID") ||
msg.includes("chat not found") ||
msg.includes("Forbidden") ||
msg.includes("bot was blocked")
) {
liveCards.delete(message_id);
return false;
}
return false;
}
}
// ----------------------------------------------------------
// MAIN REFRESH LOOP
// ----------------------------------------------------------
async function refreshLiveCards(force = false) {
cleanupLiveCards();
const now = Date.now();
if (!force && now - lastRefreshMs < (REFRESH_MIN_INTERVAL_MS || 1500)) return;
lastRefreshMs = now;

const hasQueue = refreshQueue.size > 0;
for (const [msgId, meta] of liveCards.entries()) {
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
const conv = await sbGetConversationById(meta.ref_id);
if (!conv) continue;
await safeEditMessageText(
meta.chat_id,
msgId,
await buildConversationCard(conv),
conversationCardKeyboard(conv)
);
}
// ======================
// SUBMISSION
// ======================
else if (meta.type === "submission") {
const sub = await sbGetSubmission(meta.ref_id);
if (!sub) continue;
await safeEditMessageText(
meta.chat_id,
msgId,
buildSubmissionCard(sub),

submissionKeyboard(sub)
);
}
// ======================
// CALL CARD (NEW v5.3)
// ======================
else if (meta.type === "call") {
const call = await sbGetCall(meta.ref_id);
if (!call) continue;
const textHtml = buildCallCardTextHTML(call);
await safeEditMessageText(
meta.chat_id,
msgId,
textHtml,
{ parse_mode: "HTML", ...callKeyboard(call) }
);
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
const page = await buildThreadPage(convId, offset, limit);
if (page?.ok) {
await safeEditMessageText(meta.chat_id, msgId, page.text, page.keyboard);
}
}
// ======================
// POOLS / COACH CARD
// ======================
else if (meta.type === "coach") {
const coach = await sbGetCoach(meta.ref_id);
if (!coach) continue;
await safeEditMessageText(
meta.chat_id,
msgId,
await buildCoachCard(coach),
coachKeyboard(coach)
);
}
// ======================
// TRIAGE VIEW
// ======================
else if (meta.type === "triage") {
const filterSource = meta.filterSource || "all";
await safeEditMessageText(
meta.chat_id,
msgId,
await triageText(filterSource),

triageKeyboard(filterSource)
);
}
// ======================
// TODAY VIEW
// ======================
else if (meta.type === "today") {
await safeEditMessageText(
meta.chat_id,
msgId,
await todayText(),
todayKeyboard()
);
}
// ======================
// METRICS / SUMMARY
// ======================
else if (meta.type === "metrics") {
const filterSource = meta.filterSource || "all";
await safeEditMessageText(
meta.chat_id,
msgId,
await metricsText(filterSource),
metricsKeyboard()
);
}
// ======================
// METRICS YEAR SUMMARY
// ======================
else if (meta.type === "metrics_year") {
const filterSource = meta.ref_id || "all";
const y = await sbMetricSummary({ source: filterSource, window: "year" });
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
await safeEditMessageText(
meta.chat_id,
msgId,
await dashboardText(filterSource),
dashboardKeyboardV50()
);
}

} catch (_) {
// never crash loop
}
}
refreshQueue.clear();
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
if (!verifyOpsIngestAuth(req)) {
return res.status(401).json({ ok: false });
}
const b = req.body || {};
const nowIso = new Date().toISOString();
// ---- normalize canonical envelope ----
const schema_version = b.schema_version || "5.3";
const event_type = String(b.event_type || "unknown.event");
const source = String(b.source || "unknown");
const direction = String(b.direction || "inbound");
const trace_id = String(b.trace_id || uuidv4());
const idempotency_key = b.idempotency_key ? String(b.idempotency_key) : null;
const entity_type = b.entity_type ? String(b.entity_type) : null;
const entity_id = b.entity_id ? String(b.entity_id) : null;
const submission_id =
b.submission_id ||
b.payload?.submission_id ||
b.payload?.submissionId ||
null;
const client_email = b.client?.email || b.client_email || null;
const client_phone_e164 = b.client?.phone_e164 || b.client_phone_e164 || null;

const payload = b.payload || b;
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
// CONVERSATIONS / MESSAGES (inbound/outbound)
if (event_type === "conversation.updated" || event_type === "message.ingested") {
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

    if (!secret || secret !== process.env.BASE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { coach_id, kind, link, meta } = req.body || {};
    if (!kind) return res.status(400).json({ ok: false, error: "missing kind" });

    // Insert into schema `nil`
    const { error } = await supabase
      .schema("nil")
      .from("click_events")
      .insert([
        {
          coach_id: coach_id ?? null,
          kind,
          link: link ?? null,
          meta: meta ?? {},
        },
      ]);

    if (error) {
      console.error("[click_events insert error]", error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true });
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

    const { data: claimedRows, error } = await ops()
      .from("n8n_outbox")
      .select("outbox_id, submission_id, idempotency_key, payload, attempt_count")
      .eq("status", "queued")
      .order("next_attempt_at", { ascending: true })
      .limit(limit);

    if (error) throw error;

    // Update claimed rows to 'sending'
    if (claimedRows && claimedRows.length > 0) {
      const outboxIds = claimedRows.map((r) => r.outbox_id);
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
      rows: claimedRows || [],
      count: claimedRows?.length || 0,
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
    const { submission_id, status, last_error } = body;

    if (!submission_id || !["sent", "failed"].includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid submission_id or status",
      });
    }

    const now = new Date().toISOString();
    const updatePatch = {
      status,
      last_error: last_error || null,
    };

    if (status === "sent") {
      updatePatch.sent_at = now;
    }

    // Update outbox
    const { error: outboxError } = await ops()
      .from("n8n_outbox")
      .update(updatePatch)
      .eq("submission_id", submission_id);

    if (outboxError) throw outboxError;

    // Update submissions
    const submissionPatch = {
      n8n_status: status,
      n8n_last_error: last_error || null,
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
      status,
    });
  } catch (error) {
    console.error("[api/nil-outbox/result]", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Internal error",
    });
  }
});

// ---------- START ----------
app.listen(PORT, "0.0.0.0", () => {
console.log(`Webhook server listening on 0.0.0.0:${PORT}`);
console.log(`${CODE_VERSION} · Build ${BUILD_VERSION}`);
});
bot.launch().catch((err) => {
logError("bot.launch", err);
});
console.log(`Bot running: ${CODE_VERSION}`);

