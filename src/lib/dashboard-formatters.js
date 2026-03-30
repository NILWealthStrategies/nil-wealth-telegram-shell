"use strict";

const {
  formatCappedQueueLabel,
  headerLine,
} = require("./view-utils");

function watchdogStatusLabel(status) {
  if (status === "ok") return "Healthy";
  if (status === "degraded") return "Monitor";
  if (status === "warn") return "Action Required";
  return "Unknown";
}

function buildOpsHealthText(summary) {
  const cfg = summary?.config || {};
  const rt = summary?.runtime || {};
  const wd = summary?.watchdog || {};
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

Watchdog
Last Run: ${wd.lastRunAt || "never"}
Overall: ${watchdogStatusLabel(wd.overallStatus)}
Freshness: ${watchdogStatusLabel(wd.freshness?.overall)}
Reconciliation: ${watchdogStatusLabel(wd.reconciliation?.overall)}
Schema Contract: ${watchdogStatusLabel(wd.schema?.overall)}
Schema Coverage: ${wd.schema?.coveredCount ?? 0}/${wd.schema?.expectedCount ?? 0}
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
      ? "Programs lane shows Instantly threads and support handoff queue."
      : "Tap a queue below to open it.";
  return `${headerLine("all_queues", filterLabel)}
${laneHint}`;
}

function buildDashboardMetricsText(metrics = {}) {
  return `📊 METRICS
Total Clicks: ${metrics.totalClicks || 0}
Total Parent Guide Clicks: ${metrics.parentGuideClicks || 0}
Total Supplemental Health Guide Clicks: ${metrics.supplementalHealthGuideClicks || 0}
Total Risk Awareness Guide Clicks: ${metrics.riskAwarenessGuideClicks || 0}
Total Tax Education Guide Clicks: ${metrics.taxEducationGuideClicks || 0}
Total Enroll Portal Clicks: ${metrics.enrollPortalClicks || 0}
Total eApp Visits: ${metrics.eappVisits || 0}
Total Calls Answered: ${metrics.callsAnswered || 0}`;
}

function deriveDeliveryHealth(delivery = {}) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const processed = n(delivery.processedEvents);
  const deadEvent = n(delivery.deadLetterEvents);
  const deadQueue = n(delivery.deadLetters);
  const emailFailed = n(delivery.emailFailed);
  const smsFailed = n(delivery.smsFailed);
  const failureSignals = deadEvent + deadQueue + emailFailed + smsFailed;

  if (processed === 0 && failureSignals === 0) {
    return { emoji: "🟡", label: "Monitor", note: "No recent processing activity yet" };
  }

  const deadRate = processed > 0 ? (deadEvent + deadQueue) / processed : 1;
  if (deadRate >= 0.25 || deadEvent + deadQueue >= 25 || emailFailed + smsFailed >= 20) {
    return { emoji: "🔴", label: "Action Required", note: "High failure/dead-letter pressure" };
  }

  if (deadRate >= 0.08 || deadEvent + deadQueue >= 8 || emailFailed + smsFailed >= 8) {
    return { emoji: "🟡", label: "Monitor", note: "Some delivery failures detected" };
  }

  return { emoji: "🟢", label: "Healthy", note: "Processed high, dead letters low" };
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
  opsDelivery,
}) {
  const staleBlock = staleWarning ? `${staleWarning}\n` : "";
  const d = opsDelivery || {};
  const health = deriveDeliveryHealth(d);
  return `🏠 NIL WEALTH OPS DASHBOARD
${codeVersion} • Build: ${String(buildVersion).slice(0, 8)}

📅 Today: ${today}
⏰ NY Time: ${time}
🧮 Filter: ${filterLabel}
${staleBlock}
🗂 QUEUES
${capped.handoffCount?.displayCount > 0 ? `${formatCappedQueueLabel("📌 Loop in Support", capped.handoffCount)}\n` : ""}${formatCappedQueueLabel("‼️ Urgent", capped.urgentCount)}
${formatCappedQueueLabel("📝 Needs Reply", capped.needsReplyCount)}
${formatCappedQueueLabel("⏳ Waiting", capped.waitingCount)}
${formatCappedQueueLabel("💬 Active", capped.activeCount)}
${formatCappedQueueLabel("🧵 Threads", capped.threadsCount)}
${formatCappedQueueLabel("📨 Forwarded", capped.forwardedCount)}
${formatCappedQueueLabel("🧾 Submissions", capped.submissionsCount)}
${formatCappedQueueLabel("📚 Follow-Ups", capped.followCount)}
${formatCappedQueueLabel("📱 Calls", capped.callsCount)}
${formatCappedQueueLabel("✅ Completed", capped.completedCount)}

${buildDashboardMetricsText(metrics)}

🚚 DELIVERY HEALTH
Overall: ${health.emoji} ${health.label}
Signal: ${health.note}
Email Outbox Pending: ${d.emailPending == null ? "n/a" : d.emailPending}
Email Outbox Failed: ${d.emailFailed == null ? "n/a" : d.emailFailed}
SMS Outbox Pending: ${d.smsPending == null ? "n/a" : d.smsPending}
SMS Outbox Failed: ${d.smsFailed == null ? "n/a" : d.smsFailed}
Processed Events: ${d.processedEvents == null ? "n/a" : d.processedEvents}
Dead Letter Events: ${d.deadLetterEvents == null ? "n/a" : d.deadLetterEvents}
Dead Letters: ${d.deadLetters == null ? "n/a" : d.deadLetters}
Open Support Tickets: ${d.supportTicketsOpen == null ? "n/a" : d.supportTicketsOpen}

Use buttons below.`;
}

function buildYearSummaryText(y, filterSource) {
  const d = y && typeof y === "object" ? y : {};
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const avg = (total) => Math.round(n(total) / 12);
  const trendEmoji = (v) =>
    v === "up" ? "📈 Up-Trend" : v === "down" ? "📉 Down-Trend" : "➖ Flat";
  const months = Array.isArray(d.monthlyBreakdown) ? d.monthlyBreakdown : [];
  const byLabel = new Map(
    months.map((m) => [String(m.label || m.month || "").toLowerCase(), m])
  );
  const order = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pick = (mon) => byLabel.get(mon.toLowerCase()) || {};
  const monthLine = order
    .map((mon) => `${mon} ${String(n(pick(mon).totalClicks)).padStart(2, " ")}`)
    .join("  ");
  const bestWeek = d.bestWeek
    ? `🏆 Best Week: ${d.bestWeek.label || "—"} (Total Clicks ${n(d.bestWeek.totalClicks)})`
    : "🏆 Best Week: —";
  const bestMonth = d.bestMonth
    ? `⭐ Best Month: ${d.bestMonth.label || "—"} (Total Clicks ${n(d.bestMonth.totalClicks)})`
    : "⭐ Best Month: —";
  const bestMonthEver = d.bestMonthEver
    ? `👑 Best Month Ever: ${d.bestMonthEver.label || "—"} (Total Clicks ${n(d.bestMonthEver.totalClicks)})`
    : "👑 Best Month Ever: —";
  const t = d.trend || {};
  return (
    `🎉 YEAR SUMMARY • ${filterSource || "all"}
--
TOTALS

` +
  `• Total Clicks (All): ${n(d.totalClicks)} (Avg ${avg(d.totalClicks)}/mo)\n` +
    `• Total Parent Guide Clicks: ${n(d.parentGuideClicks)} (Avg ${avg(d.parentGuideClicks)}/mo)\n` +
    `• Total Supplemental Health Guide Clicks: ${n(d.supplementalHealthGuideClicks)} (Avg ${avg(d.supplementalHealthGuideClicks)}/mo)\n` +
    `• Total Risk Awareness Guide Clicks: ${n(d.riskAwarenessGuideClicks)} (Avg ${avg(d.riskAwarenessGuideClicks)}/mo)\n` +
    `• Total Tax Education Guide Clicks: ${n(d.taxEducationGuideClicks)} (Avg ${avg(d.taxEducationGuideClicks)}/mo)\n` +
    `• Total Enroll Portal Clicks: ${n(d.enrollPortalClicks)} (Avg ${avg(d.enrollPortalClicks)}/mo)\n` +
    `• eApp Visits: ${n(d.eappVisits)} (Avg ${avg(d.eappVisits)}/mo)\n` +
    `• Calls Answered: ${n(d.callsAnswered)} (Avg ${avg(d.callsAnswered)}/mo)\n\n` +
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
  `• Total Clicks: ${trendEmoji(t.totalClicks)}\n` +
    `• Parent Guide Clicks: ${trendEmoji(t.parentGuideClicks)}\n` +
    `• Supplemental Health Guide Clicks: ${trendEmoji(t.supplementalHealthGuideClicks)}\n` +
    `• Risk Awareness Guide Clicks: ${trendEmoji(t.riskAwarenessGuideClicks)}\n` +
    `• Tax Education Guide Clicks: ${trendEmoji(t.taxEducationGuideClicks)}\n` +
    `• Enroll Portal Clicks: ${trendEmoji(t.enrollPortalClicks)}\n` +
    `• eApp Visits: ${trendEmoji(t.eappVisits)}\n` +
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
