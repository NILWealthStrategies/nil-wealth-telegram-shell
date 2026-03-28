"use strict";

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

function isInstantlySource(conv) {
  return String(conv?.source || "").trim().toLowerCase() === "instantly";
}

function isProgramLane(conv) {
  const lane = String(conv?.lane || "").trim().toLowerCase();
  if (lane) return lane === "program";
  return sourceSafe(conv?.source) === "programs";
}

function extractCampaignId(conv, inboundMessage = null) {
  const direct = conv?.campaign_id || conv?.campaignId || inboundMessage?.campaign_id || null;
  if (direct) return String(direct);
  const subject = String(conv?.subject || "");
  const match = subject.match(/Instantly\s+Reply\s*\(([^)]+)\)/i);
  return match?.[1] ? String(match[1]).trim() : "—";
}

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
  const hasClient = !!(conv?.contact_name || conv?.client_full_name || conv?.first_name || conv?.last_name);
  if (hasCoach && !hasClient) return "coach";
  if (hasCoach && conv?.contact_email && !conv?.contact_name && !conv?.client_full_name) return "coach";
  return "parent";
}

function conversationIdentityText(conv) {
  const coach = conv?.coach_name || conv?.coach_full_name || null;
  const client = conv?.contact_name || conv?.client_full_name || null;
  const email = conv?.contact_email || conv?.email || null;

  let name;
  if (client) {
    name = client;
  } else if (coach) {
    name = String(coach).replace(/^Coach\s+/i, "").trim() || coach;
  } else if (email) {
    name = email;
  } else {
    name = "—";
  }
  return `${roleTag(conversationRoleForDisplay(conv))} ${name}`;
}

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

module.exports = {
  conversationIdentityText,
  conversationRoleForDisplay,
  extractCampaignId,
  idShort,
  isInstantlySource,
  isProgramLane,
  normalizeEmail,
  normalizeRole,
  roleConflictBadge,
  roleDefaultLane,
  roleDefaultNextAction,
  roleFilterLabel,
  roleLabel,
  roleTag,
  safeStr,
  shorten,
  sourceSafe,
};
