"use strict";

const { idShort } = require("./core-utils");
const { fmtWhen, parseIsoOrNull, tFmtDateTimeShort } = require("./format-utils");

const CALL_NEEDS_ACTION_MINUTES = 15;

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
  const name = c.client_name || "—";
  return `──────────────────────
📱 ${name} • ID: ${idShort(c.id)}
  Status: ${status} • Role: ${role}
  📧 ${email}
  📞 ${phone}
  🕐 Scheduled: ${when}`;
}

function buildCallCardTextHTML(c) {
  const status = callStatusLabel(c);
  const esc = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const rawEmail = c.client_email || c.email || "";
  const emailLine = rawEmail
    ? `<a href="mailto:${esc(rawEmail)}">${esc(rawEmail)}</a>`
    : "—";
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
`📱 <b>CALL</b>
--
ID: ${esc(idShort(c.id))}

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

--
<b>Linked</b>
Conversation: ${convId}`
  );
}

module.exports = {
  CALL_NEEDS_ACTION_MINUTES,
  buildCallCardTextHTML,
  callNeedsAction,
  callStatusLabel,
  callSummaryLine,
};
