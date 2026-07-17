"use strict";

const { roleFilterLabel } = require("./core-utils");
const {
  formatCappedQueueLabel,
  headerLine,
} = require("./view-utils");

function buildOpsHealthText(summary) {
  const cfg = summary?.config || {};
  const rt = summary?.runtime || {};
  const wd = summary?.watchdog || {};
  const workflowIssues = (wd?.workflows?.checks || [])
    .filter((wf) => wf.status === "warn" || wf.status === "degraded" || wf.status === "unknown" || (wf.issues || []).length)
    .slice(0, 5)
    .map((wf) => {
      const issueText = Array.isArray(wf.issues) && wf.issues.length
        ? wf.issues.slice(0, 2).map((issue) => issue.summary).join(" | ")
        : (wf.detail || "needs review");
      return `${wf.id}: ${issueText}`;
    });
  const opsIssues = (wd?.operationsRisk?.checks || [])
    .filter((check) => check.status === "warn" || check.status === "degraded" || check.status === "unknown")
    .slice(0, 5)
    .map((check) => check.summary || `${check.name}: needs review`);
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
CLICK_TRACKER_BASE_URL: ${b(cfg.click_tracker_base_configured)}

Runtime
Last Outbox Tick: ${rt.last_outbox_tick_at || "never"}
Dead Letter Backlog: ${rt.dead_letter_backlog == null ? "n/a" : rt.dead_letter_backlog}
Pending Handoffs: ${rt.pending_handoff_conversations == null ? "n/a" : rt.pending_handoff_conversations}

Watchdog
Overall: ${wd?.overallStatus || "unknown"}
Workflow Health: ${wd?.workflows?.overall || "unknown"}
Operations Risk: ${wd?.operationsRisk?.overall || "unknown"}
Workflow Issues: ${workflowIssues.length ? workflowIssues.join("; ") : "none"}
Ops Issues: ${opsIssues.length ? opsIssues.join("; ") : "none"}
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
Total SH Guide Clicks: ${metrics.supplementalHealthGuideClicks || 0}
🎰 Risk Awareness Guide Clicks: ${metrics.riskAwarenessGuideClicks || 0}
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
    return { emoji: "🟢", label: "Healthy", note: "No data yet (clean baseline)" };
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
  globalSchoolsCoverage,
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

${buildSchoolsDatabaseSummary(globalSchoolsCoverage)}

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

// =====================================================
// SCHOOLS DATABASE SUMMARY FORMATTER
// =====================================================
function buildSchoolsDatabaseSummary(schoolsData = {}) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  const total = n(schoolsData.total);
  const reached = n(schoolsData.reached);
  const coverage = total > 0 ? Math.round((reached / total) * 100 * 10) / 10 : 0;

  const bar = (() => {
    const filled = Math.round(coverage / 10);
    const empty = 10 - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  })();

  return `🎯 MARKET COVERAGE
Schools Database: ${reached}/${total}
Reached: ${reached} Schools
Coverage: ${bar} ${coverage}%`;
}

// =====================================================
// STATE COVERAGE WITH RESPONSES FORMATTER
// =====================================================
function buildStateCoverageWithResponses(statesData = []) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  if (!Array.isArray(statesData) || statesData.length === 0) {
    return `🎯 STATE COVERAGE
--
No states with outreach yet.
--`;
  }

  const stateLines = statesData
    .map((state) => {
      const st = (state.state || "??").toUpperCase();
      const schoolsInState = n(state.schoolsInState);
      const schoolsContacted = n(state.schoolsContacted);
      const schoolsResponded = n(state.schoolsResponded);
      const coachesContacted = n(state.coachesContacted);
      const coachesResponded = n(state.coachesResponded);
      const counties = n(state.countiesReached);

      const schoolContactPct = schoolsInState > 0
        ? Math.round((schoolsContacted / schoolsInState) * 1000) / 10
        : 0;
      const schoolResponsePct = schoolsContacted > 0
        ? Math.round((schoolsResponded / schoolsContacted) * 100)
        : 0;
      const coachResponsePct = coachesContacted > 0
        ? Math.round((coachesResponded / coachesContacted) * 100)
        : 0;

      const schoolContactBar = (() => {
        const filled = Math.round(schoolContactPct / 10);
        const empty = 10 - filled;
        return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
      })();

      const schoolResponseBar = (() => {
        const filled = Math.round(schoolResponsePct / 10);
        const empty = 10 - filled;
        return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
      })();

      const coachResponseBar = (() => {
        const filled = Math.round(coachResponsePct / 10);
        const empty = 10 - filled;
        return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
      })();

      return (
        `${st}\n` +
        `  Schools: ${schoolsContacted}/${schoolsInState} ${schoolContactBar} ${schoolContactPct}%\n` +
        `  Schools Responded: ${schoolsResponded}/${schoolsContacted} ${schoolResponseBar} ${schoolResponsePct}%\n` +
        `  Coaches Contacted: ${coachesContacted}\n` +
        `  Coaches Responded: ${coachesResponded}/${coachesContacted} ${coachResponseBar} ${coachResponsePct}%\n` +
        `  Counties: ${counties}`
      );
    })
    .join("\n\n");

  const totalStates = statesData.length;
  const totalSchoolsContacted = statesData.reduce((sum, s) => sum + n(s.schoolsContacted), 0);
  const totalSchoolsResponded = statesData.reduce((sum, s) => sum + n(s.schoolsResponded), 0);
  const totalCoachesContacted = statesData.reduce((sum, s) => sum + n(s.coachesContacted), 0);
  const totalCoachesResponded = statesData.reduce((sum, s) => sum + n(s.coachesResponded), 0);

  return (
    `🎯 STATE COVERAGE\n` +
    `--\n` +
    `${totalStates} Active States\n\n` +
    `Schools: ${totalSchoolsContacted} Contacted • ${totalSchoolsResponded} Responded\n` +
    `Coaches: ${totalCoachesContacted} Contacted • ${totalCoachesResponded} Responded\n\n` +
    `--\n\n` +
    `${stateLines}\n\n` +
    `--`
  );
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
    `• SH Guide Clicks: ${n(d.supplementalHealthGuideClicks)} (Avg ${avg(d.supplementalHealthGuideClicks)}/mo)\n` +
    `• 🎰 Risk Awareness Guide Clicks: ${n(d.riskAwarenessGuideClicks)} (Avg ${avg(d.riskAwarenessGuideClicks)}/mo)\n` +
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
    `• SH Guide: ${trendEmoji(t.supplementalHealthGuideClicks)}\n` +
    `• 🎰 Risk Awareness: ${trendEmoji(t.riskAwarenessGuideClicks)}\n` +
    `• Tax Education: ${trendEmoji(t.taxEducationGuideClicks)}\n` +
    `• Enroll Clicks: ${trendEmoji(t.enrollClicks)}\n` +
    `• eApp Visits: ${trendEmoji(t.eappVisits)}\n` +
    `• Threads (Replies): ${trendEmoji(t.threads)}\n` +
    `• Calls Answered: ${trendEmoji(t.callsAnswered)}\n` +
    `--`
  );
}

// =====================================================
// V9 DASHBOARD FORMATTER  (gated by V9_DASHBOARD_ENABLED)
// Exact approved wording from V9.0 Engineering Manual §3
// =====================================================
function buildDashboardTextV9({
  codeVersion,
  buildVersion,
  today,
  time,
  filterLabel,
  lastSyncLabel,
  snapshot,
  coverage,
  deliveryHealth,
}) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const s = snapshot || {};
  const cov = coverage || {};
  const dh = deliveryHealth || {};

  const dbTotal = n(cov.schoolsDatabase);
  const contacted = n(cov.schoolsContacted);
  const pct = dbTotal > 0 ? Math.min(100, (contacted / dbTotal) * 100) : 0;
  const pctStr = Number.isInteger(pct) ? `${pct}` : pct.toFixed(1);
  const filled = Math.round(pct / 10);
  const coverageBar = `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pctStr}%`;

  const he = (status) =>
    status === 'healthy' ? '🟢' : status === 'degraded' ? '🟡' : status === 'failed' ? '🔴' : '⚪';
  const hl = (status, label) =>
    `${he(status)} ${label} ${status === 'healthy' ? 'Healthy' : status === 'degraded' ? 'Degraded' : 'Unknown'}`;

  return `🏠 NIL WEALTH OPS DASHBOARD
${codeVersion} • Build: ${String(buildVersion).slice(0, 8)}

📅 Today: ${today}
🕐 NY Time: ${time}
🌎 Filter: ${filterLabel}

📷 BUSINESS SNAPSHOT

📧 Emails Sent: ${n(s.emailsSent)}
💬 Coach Replies: ${n(s.coachReplies)}
👍 Positive Replies: ${n(s.positiveReplies)}
📦 Resource Packets Sent: ${n(s.resourcePacketsSent)}
🤝 Coaches Sharing: ${n(s.coachesSharing)}

📘 Parent Guide Opens: ${n(s.parentGuideOpens)}
🌐 NILWS Website Opens: ${n(s.websiteOpens)}
🏥 SH Guide Opens: ${n(s.supplementalHealthOpens)}
🎰 Risk Awareness Guide Opens: ${n(s.riskAwarenessOpens)}
💰 Tax Education Guide Opens: ${n(s.taxEducationOpens)}
📝 Enrollment Portal Visits: ${n(s.enrollmentVisits)}
📱 eApp Visits: ${n(s.eappVisits)}

📧 Questions: ${n(s.emailQuestions)}
📋 Website Forms: ${n(s.websiteForms)}
📞 Meetings Scheduled: ${n(s.meetingsScheduled)}
⏳ Waiting for Response: ${n(s.waitingForResponse)}

🎯 MARKET COVERAGE

🏫 Schools Database: ${n(cov.schoolsDatabase)}
📬 Schools Contacted: ${n(cov.schoolsContacted)}
🤝 Schools Sharing: ${n(cov.schoolsSharing)}
${coverageBar}

🚚 DELIVERY HEALTH

${hl(dh.instantly, 'Instantly')}
${hl(dh.website, 'Website')}
${hl(dh.support, 'Support')}
${hl(dh.cloudflareTracking, 'Cloudflare Tracking')}
${hl(dh.database, 'Database')}

Use buttons below.`;
}

module.exports = {
  allQueuesText,
  buildDashboardMetricsText,
  buildDashboardText,
  buildDashboardTextV9,
  buildSchoolsDatabaseSummary,
  buildStateCoverageWithResponses,
  buildOpsHealthText,
  buildYearSummaryText,
};
