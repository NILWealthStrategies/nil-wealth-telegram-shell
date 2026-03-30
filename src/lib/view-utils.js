"use strict";

function laneLabel(source) {
  return source === "support" ? "󰼡 Support" : "🏈 Programs";
}

function minsUntilUrgent(updatedAtIso, urgentAfterMinutes) {
  if (!updatedAtIso) return urgentAfterMinutes;
  const updated = new Date(updatedAtIso).getTime();
  const now = Date.now();
  const ageMins = Math.floor((now - updated) / 60000);
  return urgentAfterMinutes - ageMins;
}

function slaBadge(updatedAtIso, urgentAfterMinutes) {
  const m = minsUntilUrgent(updatedAtIso, urgentAfterMinutes);
  if (m <= 0) return "🔴 Overdue";
  if (m <= 60) return "🟠 Due soon";
  return "🟢 On track";
}

function urgentCountdown(updatedAtIso, urgentAfterMinutes) {
  const m = minsUntilUrgent(updatedAtIso, urgentAfterMinutes);
  const mmAbs = Math.abs(m);
  const h = Math.floor(mmAbs / 60);
  const mm = mmAbs % 60;
  if (m <= 0) return "‼️ Urgent now";
  return `⏳ ${h}h ${mm}m left`;
}

function smartSortByPriority(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  return [...rows].sort((a, b) => {
    const now = Date.now();
    const aDue = a.next_action_at ? new Date(a.next_action_at).getTime() : Infinity;
    const bDue = b.next_action_at ? new Date(b.next_action_at).getTime() : Infinity;
    const aDueNow = aDue <= now;
    const bDueNow = bDue <= now;
    if (aDueNow && !bDueNow) return -1;
    if (bDueNow && !aDueNow) return 1;

    const aPri = typeof a.priority_tier === "number" ? a.priority_tier : 9;
    const bPri = typeof b.priority_tier === "number" ? b.priority_tier : 9;
    if (aPri !== bPri) return aPri - bPri;

    const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return bTime - aTime;
  });
}

function viewTitle(key) {
  const map = {
    handoff: "📌 Loop in Support",
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

function sanitizeDisplayText(text) {
  if (typeof text !== "string") return text;
  let safe = text
    .replace(/═{6,}/g, "═════")
    .replace(/─{6,}/g, "─────");

  if (safe.includes("NIL WEALTH OPS DASHBOARD")) {
    safe = safe
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t !== "═════" && t !== "─────";
      })
      .join("\n");
  }
  return safe;
}

function capQueueCount(value, cap) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return { displayCount: 0, actualCount: 0, capped: false };
  }
  if (n > cap) {
    return { displayCount: cap, actualCount: n, capped: true };
  }
  return { displayCount: n, actualCount: n, capped: false };
}

function formatCappedQueueLabel(label, countObj) {
  if (!countObj?.capped) {
    return `${label}: ${countObj?.displayCount || 0}`;
  }
  return `${label}: ${countObj.displayCount} (showing ${countObj.displayCount} of ${countObj.actualCount})`;
}

module.exports = {
  capQueueCount,
  formatCappedQueueLabel,
  headerLine,
  laneLabel,
  sanitizeDisplayText,
  slaBadge,
  smartSortByPriority,
  urgentCountdown,
  viewTitle,
};