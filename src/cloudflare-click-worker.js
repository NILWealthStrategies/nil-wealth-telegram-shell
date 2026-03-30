/**
 * NIL Wealth Cloudflare Worker click tracker + redirector.
 *
 * Required env vars (new preferred):
 * - BOT_METRIC_WEBHOOK_URL (full webhook URL, e.g. https://host/webhook/metric)
 * - BASE_WEBHOOK_SECRET
 * - PARENT_GUIDE_URL
 * - SUPPLEMENTAL_HEALTH_GUIDE_URL
 * - RISK_AWARENESS_GUIDE_URL
 * - TAX_EDUCATION_GUIDE_URL
 * - ENROLL_URL
 * - EAPP_URL
 *
 * Legacy-compatible env vars (optional):
 * - TRACKING_WEBHOOK_BASE (base URL; worker appends /webhook/metric)
 * - BASE_WEBHOOK_SECRET (legacy alias, same value)
 * - DRY_RUN="1"
 * - FALLBACK_URL
 */
const ROUTES = {
  "parent-guide": {
    targetEnv: "PARENT_GUIDE_URL",
    defaultUrl: "https://parentsguide.mynilwealthstrategies.com",
    kind: "parent_guide_click"
  },
  "supplemental-health-guide": {
    targetEnv: "SUPPLEMENTAL_HEALTH_GUIDE_URL",
    defaultUrl: "https://supplementalhealth.mynilwealthstrategies.com",
    kind: "supplemental_health_guide_click",
    legacyKind: "sh_click"
  },
  "risk-awareness-guide": {
    targetEnv: "RISK_AWARENESS_GUIDE_URL",
    defaultUrl: "https://riskawareness.mynilwealthstrategies.com",
    kind: "risk_awareness_guide_click",
    legacyKind: "risk_awareness_click"
  },
  "tax-education-guide": {
    targetEnv: "TAX_EDUCATION_GUIDE_URL",
    defaultUrl: "https://taxeducation.mynilwealthstrategies.com",
    kind: "tax_education_guide_click",
    legacyKind: "tax_education_click"
  },
  enroll: {
    targetEnv: "ENROLL_URL",
    defaultUrl: "https://enrollment.mynilwealthstrategies.com",
    kind: "enroll_click"
  },
  eapp: {
    targetEnv: "EAPP_URL",
    defaultUrl: "https://enrollment.mynilwealthstrategies.com",
    kind: "eapp_visit",
    legacyKind: "eapp_click"
  }
};

const ALIASES = {
  parentguide: "parent-guide",
  "parents-guide": "parent-guide",
  parentsguide: "parent-guide",
  "parents-guidebook": "parent-guide",
  "parent-guide": "parent-guide",
  supplementalhealth: "supplemental-health-guide",
  "supplemental-health": "supplemental-health-guide",
  "supplemental-health-guide": "supplemental-health-guide",
  riskawareness: "risk-awareness-guide",
  "risk-awareness": "risk-awareness-guide",
  "risk-awareness-guide": "risk-awareness-guide",
  taxeducation: "tax-education-guide",
  "tax-education": "tax-education-guide",
  "tax-education-guide": "tax-education-guide",
  enroll: "enroll",
  enrollment: "enroll",
  "enrollment-page": "enroll",
  eapp: "eapp"
};

function normalizePath(pathname) {
  return String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function parseKey(rawPath) {
  if (!rawPath) return { key: "", actorId: null };
  let key = rawPath.startsWith("go/") ? rawPath.slice(3) : rawPath;
  let actorId = null;

  const dashPos = key.lastIndexOf("-");
  if (dashPos !== -1) {
    const left = key.slice(0, dashPos).trim();
    const right = key.slice(dashPos + 1).trim();
    if (ALIASES[left]) {
      key = left;
      actorId = right || null;
    }
  }

  return { key, actorId };
}

function resolveWebhookUrl(env) {
  const direct = String(env?.BOT_METRIC_WEBHOOK_URL || "").trim();
  if (direct) return direct;
  const base = String(env?.TRACKING_WEBHOOK_BASE || "").trim().replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}/webhook/metric`;
}

function cleanHeaders(request) {
  return {
    cf_country: request.headers.get("cf-ipcountry") || request.cf?.country || "unknown",
    cf_colo: request.cf?.colo || "",
    referrer: request.headers.get("referer") || "direct",
    ua: request.headers.get("user-agent") || "unknown"
  };
}

async function postMetric(env, payload) {
  const webhookUrl = resolveWebhookUrl(env);
  const secret = String(env?.BASE_WEBHOOK_SECRET || "").trim();

  if (!webhookUrl) {
    console.error("Missing webhook URL: BOT_METRIC_WEBHOOK_URL or TRACKING_WEBHOOK_BASE");
    return;
  }

  const headers = { "content-type": "application/json" };
  if (secret) {
    headers["x-webhook-secret"] = secret;
    headers["x-nil-secret"] = secret;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("Metric webhook non-200", {
        status: resp.status,
        body: body.slice(0, 500),
        kind: payload.kind
      });
    }
  } catch (err) {
    console.error("Metric webhook request failed", {
      kind: payload.kind,
      error: String(err)
    });
  }
}

function redirectOr404(env, badKey) {
  const fallback = String(env?.FALLBACK_URL || "").trim();
  if (fallback) return Response.redirect(fallback, 302);
  return new Response(`Not found: ${badKey || "(root)"}`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rawPath = normalizePath(url.pathname);
    if (!rawPath) return redirectOr404(env, "");

    const { key, actorId } = parseKey(rawPath);
    const canonicalKey = ALIASES[key];
    if (!canonicalKey || !ROUTES[canonicalKey]) return redirectOr404(env, key);

    const route = ROUTES[canonicalKey];
    const destination = String(env?.[route.targetEnv] || route.defaultUrl || "").trim();
    if (!destination) {
      console.error("Missing destination for route", canonicalKey, route.targetEnv);
      return new Response("Route not configured", { status: 500 });
    }

    const isCoach = Boolean(actorId);
    const actor = actorId || "support";
    const nowIso = new Date().toISOString();

    const payload = {
      coach_id: isCoach ? actor : null,
      kind: route.kind,
      link: url.toString(),
      value: 1,
      ts: nowIso,
      source: "cloudflare",
      meta: {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        link_key: key,
        canonical_key: canonicalKey,
        destination,
        actor_id: actor,
        actor_type: isCoach ? "coach_or_program" : "support",
        legacy_kind: route.legacyKind || route.kind,
        ...cleanHeaders(request),
        ts: nowIso
      }
    };

    if (String(env?.DRY_RUN || "") !== "1") {
      ctx.waitUntil(postMetric(env, payload));
    }

    return Response.redirect(destination, 302);
  }
};
