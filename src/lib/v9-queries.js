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
    const staleThresholdMs = 3 * 60 * 60 * 1000; // 3 hours
    const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();

    const { data: heartbeats } = await supabase
      .schema("nil")
      .from("ops_events")
      .select("source, created_at")
      .eq("event_type", "n8n.heartbeat")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(20);

    const seen = new Set((heartbeats || []).map((h) => h.source));

    const status = (sources) =>
      sources.some((s) => seen.has(s)) ? "healthy" : "unknown";

    return {
      instantly: status(["wf_v9_05"]),
      website: status(["wf_v9_01"]),
      support: status(["wf_v9_02", "wf_v9_03"]),
      cloudflareTracking: status(["wf_v9_06"]),
      database: "healthy", // If we got this far, Supabase is up
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

module.exports = {
  sbV9BusinessSnapshot,
  sbV9CoverageSummary,
  sbV9DeliveryHealth,
};
