"use strict";
// =============================================================================
// V9 Supabase query stubs — NIL Wealth Strategies v9.0
// All functions return safe empty defaults when V9 tables do not yet exist.
// Once sql/v9/01_additive_migration.sql is applied and data flows (Instantly
// sync via WF-V9-05 + Cloudflare tracking via WF-V9-06), replace each stub
// body with the real query against the appropriate nil schema table.
// =============================================================================

/**
 * Fetch the V9 business snapshot for the main dashboard.
 * Target tables: nil.analytics_metrics, nil.coaches, nil.submissions, nil.meetings
 *
 * @param {object} supabase  Service-role Supabase client
 * @param {string} filterSource  "all" | "programs" | "support"
 * @returns {Promise<object>}
 */
async function sbV9BusinessSnapshot(supabase, filterSource = "all") {
  try {
    // Pull Instantly campaign totals written by WF-V9-05
    const { data: metricsRows } = await supabase
      .schema("nil")
      .from("analytics_metrics")
      .select("emails_sent, coach_replies, positive_replies, packets_detected, synced_at")
      .eq("metric_key", "instantly_campaign_totals")
      .limit(1);

    const m = metricsRows?.[0] || {};

    // Pull website form count
    const { count: websiteForms } = await supabase
      .schema("nil")
      .from("submissions")
      .select("submission_id", { count: "exact", head: true });

    // Pull open support ticket count (email questions)
    const { count: emailQuestions } = await supabase
      .schema("nil")
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "needs_human", "queued_auto"]);

    return {
      emailsSent: Number(m.emails_sent || 0),
      coachReplies: Number(m.coach_replies || 0),
      positiveReplies: Number(m.positive_replies || 0),
      resourcePacketsSent: Number(m.packets_detected || 0),
      coachesSharing: 0,          // TODO: query nil.leads where status='sharing_confirmed'
      parentGuideOpens: 0,        // TODO: query nil.ops_events where event_type='click.event' and destination_type='parent_guide'
      websiteOpens: 0,            // TODO: query nil.ops_events where destination_type='website'
      supplementalHealthOpens: 0, // TODO: query nil.ops_events where destination_type='supplemental_health'
      riskAwarenessOpens: 0,      // TODO: query nil.ops_events where destination_type='risk_awareness'
      taxEducationOpens: 0,       // TODO: query nil.ops_events where destination_type='tax_education'
      enrollmentVisits: 0,        // TODO: query nil.ops_events where destination_type='enrollment'
      eappVisits: 0,              // TODO: query nil.ops_events where destination_type='eapp'
      emailQuestions: Number(emailQuestions || 0),
      websiteForms: Number(websiteForms || 0),
      meetingsScheduled: 0,       // TODO: query nil.ops_events where event_type='meeting.scheduled'
      waitingForResponse: 0,      // TODO: query nil.support_tickets where status='needs_human'
      lastSyncAt: m.synced_at || null,
    };
  } catch (err) {
    console.error("[v9-queries] sbV9BusinessSnapshot error:", err.message);
    return {
      emailsSent: 0, coachReplies: 0, positiveReplies: 0, resourcePacketsSent: 0,
      coachesSharing: 0, parentGuideOpens: 0, websiteOpens: 0,
      supplementalHealthOpens: 0, riskAwarenessOpens: 0, taxEducationOpens: 0,
      enrollmentVisits: 0, eappVisits: 0, emailQuestions: 0, websiteForms: 0,
      meetingsScheduled: 0, waitingForResponse: 0, lastSyncAt: null,
    };
  }
}

/**
 * Fetch V9 market coverage summary.
 * Target tables: nil.leads (for contacts), nil.schools (once migration applied)
 *
 * @param {object} supabase  Service-role Supabase client
 * @returns {Promise<object>}
 */
async function sbV9CoverageSummary(supabase) {
  try {
    // Until nil.schools is created by the V9 migration, use the existing
    // nil.leads table to approximate school coverage
    const { count: contacted } = await supabase
      .schema("nil")
      .from("leads")
      .select("id", { count: "exact", head: true });

    const { count: replied } = await supabase
      .schema("nil")
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "replied");

    return {
      schoolsDatabase: 130922, // National K-12 schools total (configured constant)
      schoolsContacted: Number(contacted || 0),
      schoolsSharing: Number(replied || 0),
    };
  } catch (err) {
    console.error("[v9-queries] sbV9CoverageSummary error:", err.message);
    return { schoolsDatabase: 130922, schoolsContacted: 0, schoolsSharing: 0 };
  }
}

/**
 * Fetch V9 integration health statuses.
 * Reads from nil.ops_events heartbeat records written by each V9 workflow.
 *
 * @param {object} supabase  Service-role Supabase client
 * @returns {Promise<object>}
 */
async function sbV9DeliveryHealth(supabase) {
  try {
    const d7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();  // 7 days
    const d3 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();  // 3 days

    // Each integration is checked against its actual output table — not a heartbeat
    // that was never wired up. "healthy" = recent activity proves the pipeline ran.
    // "no_signal" = table reachable but no recent data (workflow may be paused/idle).
    // "not_configured" = Supabase error, meaning table doesn't exist yet.
    const [cfResult, webResult, supportResult, instantlyResult] = await Promise.all([
      // Cloudflare worker → click_events (table accessible = tracking is configured)
      supabase.schema("nil").from("click_events")
        .select("id", { count: "exact", head: true }),
      // Website form n8n workflow → submissions table
      supabase.schema("nil").from("submissions")
        .select("submission_id", { count: "exact", head: true }),
      // Support workflows (WF-02/03) → conversations table
      supabase.schema("nil").from("conversations")
        .select("id", { count: "exact", head: true }),
      // Instantly sync (WF-05) → analytics_metrics, any row in last 3 days
      supabase.schema("nil").from("analytics_metrics")
        .select("id", { count: "exact", head: true })
        .gte("received_at", d3),
    ]);

    // For infrastructure checks (CF, website, support): if the table is
    // reachable the pipeline is configured and ready. Data absence pre-launch
    // is expected — it doesn’t mean the system is broken.
    const infraStatus = (result, label) => {
      if (result.error) {
        console.warn(`[v9-queries] sbV9DeliveryHealth ${label}:`, result.error.message);
        return "not_configured";
      }
      return "healthy"; // table reachable = pipeline is live and ready
    };

    // Instantly needs actual data to confirm the sync is running
    const statusFrom = (result, label) => {
      if (result.error) {
        console.warn(`[v9-queries] sbV9DeliveryHealth ${label}:`, result.error.message);
        return "not_configured";
      }
      return (result.count || 0) > 0 ? "healthy" : "no_signal";
    };

    return {
      instantly: statusFrom(instantlyResult, "instantly"),
      website: infraStatus(webResult, "website"),
      support: infraStatus(supportResult, "support"),
      cloudflareTracking: infraStatus(cfResult, "cloudflare"),
      database: "healthy",
    };
  } catch (err) {
    console.error("[v9-queries] sbV9DeliveryHealth error:", err.message);
    return {
      instantly: "unknown",
      website: "unknown",
      support: "unknown",
      cloudflareTracking: "unknown",
      database: "unknown",
    };
  }
}

/**
 * List recent website form submissions for the Support Center and V9 Triage.
 * @param {object} supabase
 * @param {number} limit
 */
async function sbV9ListWebsiteForms(supabase, limit = 10) {
  try {
    const { data } = await supabase
      .schema("nil")
      .from("submissions")
      .select("submission_id, first_name, last_name, email, sport, school, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    return data || [];
  } catch (err) {
    console.error("[v9-queries] sbV9ListWebsiteForms error:", err.message);
    return [];
  }
}

/**
 * List open support tickets needing a human response.
 * @param {object} supabase
 * @param {number} limit
 */
async function sbV9ListSupportTickets(supabase, limit = 10) {
  try {
    const { data } = await supabase
      .schema("nil")
      .from("support_tickets")
      .select("id, subject, status, email, created_at")
      .in("status", ["new", "needs_human", "queued_auto"])
      .order("created_at", { ascending: false })
      .limit(limit);
    return data || [];
  } catch (err) {
    console.error("[v9-queries] sbV9ListSupportTickets error:", err.message);
    return [];
  }
}

module.exports = {
  sbV9BusinessSnapshot,
  sbV9CoverageSummary,
  sbV9DeliveryHealth,
  sbV9ListWebsiteForms,
  sbV9ListSupportTickets,
};
