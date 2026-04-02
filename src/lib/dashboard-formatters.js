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
  const totalClicks =
    metrics.totalClicks ||
    ((metrics.websiteOpens || metrics.nilwsWebsiteOpens || 0) +
      (metrics.parentGuideClicks || metrics.programLinkOpens || 0) +
      (metrics.supplementalHealthGuideClicks || 0) +
      (metrics.riskAwarenessGuideClicks || 0) +
      (metrics.taxEducationGuideClicks || 0) +
      (metrics.enrollPortalClicks || metrics.enrollClicks || 0) +
      (metrics.eappVisits || 0));
  return `📊 METRICS
Total Clicks: ${totalClicks}
Total NILWS Website Opens: ${metrics.websiteOpens || metrics.nilwsWebsiteOpens || 0}
Total Parent Guide Opens: ${metrics.programLinkOpens || 0}
Total Supplemental Health Guide Clicks: ${metrics.supplementalHealthGuideClicks || 0}
Total Risk Awareness Guide Clicks: ${metrics.riskAwarenessGuideClicks || 0}
Total Tax Education Guide Clicks: ${metrics.taxEducationGuideClicks || 0}
Total Enroll Portal Visits: ${metrics.enrollClicks || 0}
Total eApp Visits: ${metrics.eappVisits || 0}
Total Threads: ${metrics.threadsCreated || 0}
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
    .map((mon) => `${mon} ${String(n(pick(mon).enrollClicks)).padStart(2, " ")}`)
    .join("  ");
  const bestWeek = d.bestWeek
    ? `🏆 Best Week: ${d.bestWeek.label || "—"} (Enroll ${n(d.bestWeek.enrollClicks)}, Threads ${n(d.bestWeek.threads)})`
    : "🏆 Best Week: —";
  const bestMonth = d.bestMonth
    ? `⭐ Best Month: ${d.bestMonth.label || "—"} (Enroll ${n(d.bestMonth.enrollClicks)}, Threads ${n(d.bestMonth.threads)})`
    : "⭐ Best Month: —";
  const bestMonthEver = d.bestMonthEver
    ? `👑 Best Month Ever: ${d.bestMonthEver.label || "—"} (Enroll ${n(d.bestMonthEver.enrollClicks)}, Threads ${n(d.bestMonthEver.threads)})`
    : "👑 Best Month Ever: —";
  const t = d.trend || {};
  return (
    `🎉 YEAR SUMMARY • ${filterSource || "all"}
--
TOTALS

` +
    `• Clicks: ${n(d.totalClicks)} (Avg ${avg(d.totalClicks)}/mo)\n` +
    `• NILWS Website Opens: ${n(d.websiteOpens || d.nilwsWebsiteOpens)} (Avg ${avg(d.websiteOpens || d.nilwsWebsiteOpens)}/mo)\n` +
    `• Parent Guides Opened: ${n(d.programLinkOpens)} (Avg ${avg(d.programLinkOpens)}/mo)\n` +
    `• Supplemental Health Guide Clicks: ${n(d.supplementalHealthGuideClicks)} (Avg ${avg(d.supplementalHealthGuideClicks)}/mo)\n` +
    `• Risk Awareness Guide Clicks: ${n(d.riskAwarenessGuideClicks)} (Avg ${avg(d.riskAwarenessGuideClicks)}/mo)\n` +
    `• Tax Education Guide Clicks: ${n(d.taxEducationGuideClicks)} (Avg ${avg(d.taxEducationGuideClicks)}/mo)\n` +
    `• Enroll Clicks: ${n(d.enrollClicks)} (Avg ${avg(d.enrollClicks)}/mo)\n` +
    `• eApp Visits: ${n(d.eappVisits)} (Avg ${avg(d.eappVisits)}/mo)\n` +
    `• Threads (Replies): ${n(d.threadsCreated)} (Avg ${avg(d.threadsCreated)}/mo)\n` +
    `• Calls Answered: ${n(d.callsAnswered)} (Avg ${avg(d.callsAnswered)}/mo)\n\n` +
    `--
  MONTHLY BREAKDOWN (Clicks)\n\n` +
    `${monthLine}\n\n` +
    `--
HIGHLIGHTS\n\n` +
    `${bestWeek}\n` +
    `${bestMonth}\n` +
    `${bestMonthEver}\n\n` +
    `--
TRENDS (vs last month)\n\n` +
    `• Clicks: ${trendEmoji(t.totalClicks)}\n` +
    `• NILWS Website Opens: ${trendEmoji(t.websiteOpens)}\n` +
    `• Parent Guides: ${trendEmoji(t.opens)}\n` +
    `• Supplemental Health: ${trendEmoji(t.supplementalHealthGuideClicks)}\n` +
    `• Risk Awareness: ${trendEmoji(t.riskAwarenessGuideClicks)}\n` +
    `• Tax Education: ${trendEmoji(t.taxEducationGuideClicks)}\n` +
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
