"use strict";

const {
  conversationIdentityText,
  conversationRoleForDisplay,
  extractCampaignId,
  idShort,
  isInstantlySource,
  roleConflictBadge,
  roleLabel,
  safeStr,
  shorten,
  sourceSafe,
} = require("./core-utils");
const { tFmtDateTimeShort } = require("./format-utils");
const {
  laneLabel,
  slaBadge,
  urgentCountdown,
} = require("./view-utils");

function convoSummaryLine(conv, urgentAfterMinutes) {
  const lane = laneLabel(sourceSafe(conv.source));
  const sla = slaBadge(conv.updated_at, urgentAfterMinutes);
  const until = urgentCountdown(conv.updated_at, urgentAfterMinutes);
  const subj = shorten(conv.subject || "(no subject)", 50);
  const prev = shorten(conv.preview || "", 70);
  const identity = conversationIdentityText(conv);
  const contact = conv.contact_email || conv.coach_email || "—";
  const pipeline = conv.pipeline || "—";

  return `─────
• ${identity} • ${lane} • ID: ${idShort(conv.id)}
  📧 ${subj}
  ${prev}
  👤 ${contact} • Pipeline: ${pipeline}
  ${sla} • ${until}`;
}

function formatMessageLineFull(m) {
  const dir = m.direction === "outbound" ? "➡ OUT" : "⬅ IN";
  const from = m.from_email ? `From: ${m.from_email}\n` : "";
  const to = m.to_email ? `To: ${m.to_email}\n` : "";
  const subj = m.subject ? `Subject: ${m.subject}\n` : "";
  const body = shorten(m.body || m.preview || "", 1200);
  const ts = m.created_at || "";
  return `${dir}\n${from}${to}${subj}${body}\n${ts}`;
}

function formatInstantlyTimelineLine(item, conv) {
  const ts = item?.created_at || "";
  if (item?.timeline_type === "event" && item?.event_type === "cc_support_sent") {
    return `SYSTEM — CC SUPPORT SENT\n${ts}`;
  }

  const msg = item || {};
  const body = shorten(msg.body || msg.preview || "", 1200);
  const coachEmail = msg.from_email || conv?.contact_email || "—";
  const label = (() => {
    if (String(msg.sender || "").toLowerCase() === "instantly_ai") return "AI AGENT";
    if (msg.direction === "inbound") return `COACH (${coachEmail})`;
    return "SYSTEM";
  })();
  return `${label}\n${body}\n${ts}`;
}

function threadDebugBlock(conv) {
  const tk = conv?.thread_key ? `ThreadKey: ${conv.thread_key}\n` : "";
  const gt = conv?.gmail_thread_id ? `GmailThreadID: ${conv.gmail_thread_id}\n` : "";
  const mid = conv?.message_id_header ? `Message-ID: ${shorten(conv.message_id_header, 80)}\n` : "";
  const irt = conv?.in_reply_to ? `In-Reply-To: ${shorten(conv.in_reply_to, 80)}\n` : "";
  const refs = conv?.references ? `Refs: ${shorten(conv.references, 120)}\n` : "";
  const from = conv?.inbound_from_email ? `InboundFrom: ${conv.inbound_from_email}\n` : "";
  return (tk || gt || mid || irt || refs || from)
    ? `\n🧷 Threading\n${tk}${gt}${mid}${irt}${refs}${from}`.trimEnd()
    : "";
}

function buildConversationCardText(conv, { msgCount, latestMessage, instantlyThreadSummary, urgentAfterMinutes }) {
  const lane = laneLabel(sourceSafe(conv.source));
  const sla = slaBadge(conv.updated_at, urgentAfterMinutes);
  const until = urgentCountdown(conv.updated_at, urgentAfterMinutes);
  const ccOn = conv.cc_support_suggested === true;
  const gmail = conv.gmail_url ? `\n  Gmail: ${conv.gmail_url}` : "";
  const pipelineRaw = conv.pipeline || "—";
  const pipelineLabel = (() => {
    switch (pipelineRaw) {
      case "urgent":
        return "‼️ Urgent";
      case "needs_reply":
        return "📝 Needs Reply";
      case "active":
        return "💬 Active";
      case "completed":
        return "✅ Completed";
      case "forwarded":
        return "➡️ Forwarded";
      default:
        return pipelineRaw;
    }
  })();
  const coach = conv.coach_name || "—";
  const contact = conv.contact_email || "—";
  const subj = conv.subject || "—";
  const prev = shorten(conv.preview || "", 400);
  const identity = conversationIdentityText(conv);
  const roleInfo = (() => {
    const r = conversationRoleForDisplay(conv);
    let info = `Role: ${roleLabel(r)}`;
    const conflictBadge = roleConflictBadge(conv);
    if (conflictBadge) {
      info += `\n  ${conflictBadge}`;
    }
    return info;
  })();
  const handoffBadge = (conv.needs_support_handoff === true && !conv.cc_support_suggested)
    ? `🚨 HANDOFF DETECTED${conv.handoff_detected_reason ? ` — ${conv.handoff_detected_reason}` : ""}\nTap "📌 Loop in Support" to take over from Instantly.\n--\n`
    : "";
  const isInstantlyInbound = isInstantlySource(conv) && latestMessage?.direction === "inbound";

  if (isInstantlyInbound) {
    const ownerLine = conv.coach_name || conv.contact_email || "—";
    const rawReply = safeStr(latestMessage?.body || latestMessage?.preview || conv.preview || "");
    const isLong = rawReply.length > 300;
    const replyPreview = isLong ? `${rawReply.slice(0, 300).trimEnd()}…` : rawReply || "—";
    const campaignId = extractCampaignId(conv, latestMessage);
    const text = `💬 INSTANTLY REPLY
--
${ownerLine}
${instantlyThreadSummary ? `${instantlyThreadSummary}\n` : ""}

Reply
${replyPreview}${isLong ? "\n(Read more in Thread)" : ""}

Ref: Campaign ${campaignId}

--
ID: ${idShort(conv.id)}
Updated: ${tFmtDateTimeShort(conv.updated_at)}
💬 Messages: ${msgCount}
${sla} • ${until}`;
    return { text, isInstantlyInbound: true };
  }

  const text = `💬 CONVERSATION
--
${handoffBadge}ID: ${idShort(conv.id)} • ${lane}
Identity: ${identity}
${instantlyThreadSummary ? `${instantlyThreadSummary}\n` : ""}
${roleInfo}

Status: ${pipelineLabel}
Coach: ${coach}
Contact: ${contact}

📧 Subject: ${subj}

Preview: ${prev}

--
Updated: ${tFmtDateTimeShort(conv.updated_at)}
💬 Messages: ${msgCount}
${sla} • ${until}
CC: ${ccOn ? "📇 Enabled" : "Off"}${gmail}`;
  return { text, isInstantlyInbound: false };
}

module.exports = {
  buildConversationCardText,
  convoSummaryLine,
  formatInstantlyTimelineLine,
  formatMessageLineFull,
  threadDebugBlock,
};
