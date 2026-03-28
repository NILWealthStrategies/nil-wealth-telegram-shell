"use strict";

const { roleFilterLabel } = require("./core-utils");
const {
  formatCappedQueueLabel,
  headerLine,
} = require("./view-utils");

function buildOpsHealthText(summary) {
  const cfg = summary?.config || {};
  const rt = summary?.runtime || {};
  const b = (v) => (v ? "yes" : "no");
  return `🩺 OPS HEALTH
--
Config
MAKE_SEND_WEBHOOK_URL: ${b(cfg.make_send_webhook_configured)}
CC_SUPPORT_WEBHOOK_URL: ${b(cfg.cc_support_webhook_configured)}
HANDOFF_WEBHOOK_URL: ${b(cfg.handoff_webhook_configured)}
OPENAI_API_KEY: ${b(cfg.openai_api_key_configured)}
SUPPORT_FROM_EMAIL: ${b(cfg.support_from_email_configured)}
OUTREACH_FROM_EMAIL: ${b(cfg.outreach_from_email_configured)}

Runtime
Last Outbox Tick: ${rt.last_outbox_tick_at || "never"}
Dead Letter Backlog: ${rt.dead_letter_backlog == null ? "n/a" : rt.dead_letter_backlog}
Pending Handoffs: ${rt.pending_handoff_conversations == null ? "n/a" : rt.pending_handoff_conversations}
--`;
}

function allQueuesText(filterSource = "all", roleFilter = "all") {
  const filterLabel =
    filterSource === "support"
      ? "🧑‍🧒 Support"
      : filterSource === "programs"
        ? "🏈 Programs"
        : "🌐 All";
  const laneHint =
    filterSource === "programs"
      ? "Programs lane shows Instantly threads, handoffs, follow-ups, pools, and client activity."
      : "Tap a queue below to open it.";
  return `${headerLine("all_queues", filterLabel)} · ${roleFilterLabel(roleFilter)}
${laneHint}`;
}

function buildDashboardMetricsText(metrics = {}) {
  return `📊 METRICS
Total Parent Guide Opens: ${metrics.programLinkOpens || 0}
Total Coverage Exploration: ${metrics.coverageExploration || 0}
Total Enroll Portal Visits: ${metrics.enrollClicks || 0}
Total eApp Visits: ${metrics.eappVisits || 0}
Total Threads: ${metrics.threadsCreated || 0}
Total Calls Answered: ${metrics.callsAnswered || 0}`;
}

function buildDashboardText({
  codeVersion,
  buildVersion,
  today,
  time,
  filterLabel,
  staleWarning,
  capped,
  metrics,
}) {
  const staleBlock = staleWarning ? `${staleWarning}\n` : "";
  return `🏠 NIL WEALTH OPS DASHBOARD
${codeVersion} • Build: ${String(buildVersion).slice(0, 8)}

📅 Today: ${today}
⏰ NY Time: ${time}
🧮 Filter: ${filterLabel}
${staleBlock}
🗂 ALL QUEUES
${capped.handoffCount?.displayCount > 0 ? `${formatCappedQueueLabel("📌 Loop in Support", capped.handoffCount)}\n` : ""}${formatCappedQueueLabel("‼️ Urgent", capped.urgentCount)}
${formatCappedQueueLabel("📝 Needs Reply", capped.needsReplyCount)}
${formatCappedQueueLabel("⏳ Waiting", capped.waitingCount)}
${formatCappedQueueLabel("💬 Active", capped.activeCount)}
${formatCappedQueueLabel("📨 Forwarded", capped.forwardedCount)}
${formatCappedQueueLabel("🧾 Submissions", capped.submissionsCount)}
${formatCappedQueueLabel("📚 Follow-Ups", capped.followCount)}
${formatCappedQueueLabel("📱 Calls", capped.callsCount)}
${formatCappedQueueLabel("✅ Completed", capped.completedCount)}

${buildDashboardMetricsText(metrics)}

Use buttons below.`;
}

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
    `🎉 YEAR SUMMARY • ${filterSource}
--
TOTALS

` +
    `• Total Parent Guides Opened: ${n(y.programLinkOpens)} (Avg ${avg(y.programLinkOpens)}/mo)\n` +
    `• Coverage Exploration: ${n(y.coverageExploration)} (Avg ${avg(y.coverageExploration)}/mo)\n` +
    `• Enroll Clicks: ${n(y.enrollClicks)} (Avg ${avg(y.enrollClicks)}/mo)\n` +
    `• eApp Visits: ${n(y.eappVisits)} (Avg ${avg(y.eappVisits)}/mo)\n` +
    `• Threads (Replies): ${n(y.threadsCreated)} (Avg ${avg(y.threadsCreated)}/mo)\n` +
    `• Calls Answered: ${n(y.callsAnswered)} (Avg ${avg(y.callsAnswered)}/mo)\n\n` +
    `--
MONTHLY BREAKDOWN (Total Clicks)\n\n` +
    `${monthLine}\n\n` +
    `--
HIGHLIGHTS\n\n` +
    `${bestWeek}\n` +
    `${bestMonth}\n` +
    `${bestMonthEver}\n\n` +
    `--
TRENDS (vs last month)\n\n` +
    `• Parent Guides: ${trendEmoji(t.opens)}\n` +
    `• Exploration: ${trendEmoji(t.exploration)}\n` +
    `• Enroll Clicks: ${trendEmoji(t.enrollClicks)}\n` +
    `• eApp Visits: ${trendEmoji(t.eappVisits)}\n` +
    `• Threads (Replies): ${trendEmoji(t.threads)}\n` +
    `• Calls Answered: ${trendEmoji(t.callsAnswered)}\n` +
    `--`
  );
}

module.exports = {
  allQueuesText,
  buildDashboardMetricsText,
  buildDashboardText,
  buildOpsHealthText,
  buildYearSummaryText,
};
