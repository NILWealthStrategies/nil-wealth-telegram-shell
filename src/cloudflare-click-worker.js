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

function parseCookies(cookieHeader) {
  const raw = String(cookieHeader || "").trim();
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.split("=");
    const key = String(k || "").trim();
    if (!key) continue;
    const val = rest.join("=").trim();
    out[key] = decodeURIComponent(val || "");
  }
  return out;
}

function makePersonCookieValue() {
  const raw = String(crypto.randomUUID ? crypto.randomUUID() : Date.now()).replace(/-/g, "");
  return raw.slice(0, 48);
}

function parseBool(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function detectBotLikeTraffic(request) {
  const ua = String(request.headers.get("user-agent") || "").toLowerCase();
  const purpose = String(request.headers.get("purpose") || request.headers.get("sec-purpose") || "").toLowerCase();
  const xPurpose = String(request.headers.get("x-purpose") || "").toLowerCase();
  const xMoz = String(request.headers.get("x-moz") || "").toLowerCase();
  const secMode = String(request.headers.get("sec-fetch-mode") || "").toLowerCase();
  const method = String(request.method || "GET").toUpperCase();

  const uaBot = [
    "bot", "spider", "crawler", "slurp", "bingpreview", "facebookexternalhit", "twitterbot",
    "linkedinbot", "whatsapp", "telegrambot", "discordbot", "slackbot", "google-read-aloud"
  ].some((sig) => ua.includes(sig));
  const prefetch = purpose.includes("prefetch") || purpose.includes("preview") || xPurpose.includes("preview") || xMoz.includes("prefetch");
  const headLike = method === "HEAD" || (secMode === "no-cors" && method !== "GET");

  return uaBot || prefetch || headLike;
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
    const coachIdFromPath = actorId || null;
    const actorTypeFromQuery = String(url.searchParams.get("actor_type") || "").trim().toLowerCase();
    const actorIdFromQuery = String(url.searchParams.get("actor_id") || url.searchParams.get("actorId") || "").trim() || null;
    const explicitCoachSelfClick = parseBool(url.searchParams.get("coach_self_click") || url.searchParams.get("self_click") || url.searchParams.get("internal_test"));

    const cookies = parseCookies(request.headers.get("cookie"));
    const cookiePersonKey = String(cookies.nil_person_key || "").trim() || null;

    const personId = String(url.searchParams.get("person_id") || url.searchParams.get("personId") || "").trim() || null;
    const personEmail = String(url.searchParams.get("person_email") || url.searchParams.get("personEmail") || "").trim() || null;
    const personKeyFromQuery = String(url.searchParams.get("person_key") || url.searchParams.get("personKey") || "").trim() || null;
    const personKey = personKeyFromQuery || cookiePersonKey || makePersonCookieValue();
    const personKeySource = personKeyFromQuery ? "query" : (cookiePersonKey ? "cookie" : "generated");

    // Default coach-id links without recipient identity to coach; only treat as parent when recipient identity is present.
    const hasRecipientIdentity = Boolean(personId || personEmail || personKeyFromQuery);
    const actorType = explicitCoachSelfClick
      ? "coach"
      : (actorTypeFromQuery || (isCoach ? (hasRecipientIdentity ? "parent" : "coach") : "support"));
    const actorIsCoachLike = actorType.includes("coach") || actorType.includes("program");
    const actor = actorIdFromQuery || (actorIsCoachLike ? (coachIdFromPath || "support") : personKey);
    const isBotLike = detectBotLikeTraffic(request);
    const nowIso = new Date().toISOString();

    const payload = {
      coach_id: coachIdFromPath,
      guide_key: canonicalKey,
      actor_id: actor,
      actor_type: actorType,
      person_id: personId,
      person_email: personEmail,
      person_key: personKey,
      person_key_source: personKeySource,
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
        coach_id: coachIdFromPath,
        actor_id: actor,
        actor_type: actorType,
        person_id: personId,
        person_email: personEmail,
        person_key: personKey,
        person_key_source: personKeySource,
        is_coach_self_click: explicitCoachSelfClick,
        is_bot_traffic: isBotLike,
        legacy_kind: route.legacyKind || route.kind,
        ...cleanHeaders(request),
        ts: nowIso
      }
    };

    if (String(env?.DRY_RUN || "") !== "1" && !isBotLike) {
      ctx.waitUntil(postMetric(env, payload));
    }

    const resp = Response.redirect(destination, 302);
    if (!isBotLike && !cookiePersonKey && personKey && String(env?.DRY_RUN || "") !== "1") {
      resp.headers.append(
        "set-cookie",
        `nil_person_key=${encodeURIComponent(personKey)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`
      );
    }
    return resp;
  }
};
