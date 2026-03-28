"use strict";

const { roleTag, conversationRoleForDisplay, sourceSafe } = require("./core-utils");
const {
  tSafe,
  tShortProgram,
  tFmtMin,
  tFmtDateShort,
  tFmtTimeShort,
} = require("./format-utils");

const TRIAGE_CALL_WINDOW_HOURS = 48;

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
  if (tIsCoachThread(c) && coach) {
    const cleanCoachName = String(coach).replace(/^Coach\s+/i, '').trim() || coach;
    return `${tag} ${tSafe(cleanCoachName, 40)}`;
  }
  if (client) return `${tag} ${tSafe(client, 40)}`;
  if (coach) {
    const cleanCoachName = String(coach).replace(/^Coach\s+/i, '').trim() || coach;
    return `${tag} ${tSafe(cleanCoachName, 40)}`;
  }
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
  const msgBit = snippet ? `\n "${tSafe(snippet, 92)}"` : "";
  return `${idx}) ⏳ ${name}${programBit}${waitBit}${msgBit}`;
}

function tConvoBtnLabel(c) {
  const name = tDisplayName(c);
  const program = c.program_name || c.program || c.school || "";
  const progShort = program ? ` (${tSafe(program, 18)})` : "";
  return `Open · ${tSafe(name, 22)}${progShort}`;
}

function tConvoBtnLabelTriage(c) {
  const coach = c.coach_full_name || c.coach_name || null;
  const client = c.client_full_name || c.contact_name ||
    ((c.first_name || c.last_name) ? `${c.first_name || ""} ${c.last_name || ""}`.trim() : null);
  const sourceEmoji = sourceSafe(c.source) === "programs" ? "🏈" : "🧑‍🧒";
  let displayName;
  if (tIsCoachThread(c) && coach) {
    displayName = coach;
  } else if (client) {
    displayName = client;
  } else if (coach) {
    displayName = coach;
  } else {
    displayName = "—";
  }
  return `${sourceEmoji} ${tSafe(displayName, 24)}`;
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

function tCallScheduledAt(call) {
  return call?.scheduled_for || call?.scheduled_at || null;
}

function tCallName(call) {
  return tSafe(call.client_full_name || call.contact_name || call.name || "—", 40);
}

function tCallContext(call) {
  const state = call.state ? ` (${call.state})` : "";
  return `${tCallName(call)}${state}`;
}

function tCallTypeEmoji(call) {
  if (String(call.outcome || "").toLowerCase() === "rescheduled") return "📘";
  if (String(call.outcome || "").toLowerCase() === "no_answer") return "❌";
  if (String(call.status || "").toLowerCase() === "missed") return "❌";
  return "📱";
}

function tCallDueAt(call) {
  return call.next_action_at || call.due_at || tCallScheduledAt(call) || call.attempted_at || null;
}

function tCallSortKey(call) {
  const now = Date.now();
  const dueAt = tCallDueAt(call);
  const dueMs = dueAt ? new Date(dueAt).getTime() : Infinity;
  const scheduledIso = tCallScheduledAt(call);
  const scheduledMs = scheduledIso ? new Date(scheduledIso).getTime() : Infinity;
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
  if (emoji === "📘") {
    return (
      `${idx}) 📘 Rescheduled — ${who}\n` +
      ` Next Call: ${tFmtTimeShort(tCallScheduledAt(call))}`
    );
  }
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
  const sched = tCallScheduledAt(call) || call.due_at || null;
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
  const id = call.call_id || call.id;
  if (!id) return null;
  return `OPENCALL:${id}`;
}

module.exports = {
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
};
