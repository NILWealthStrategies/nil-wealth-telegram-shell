const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.env.N8N_BASE_URL || 'https://nilwealthstrategies.app.n8n.cloud';

function resolveKey() {
  if (String(process.env.N8N_API_KEY || '').trim()) return String(process.env.N8N_API_KEY).trim();
  const fallbackScript = path.join(__dirname, 'patch_wf04_v23_live.js');
  if (!fs.existsSync(fallbackScript)) return '';
  const src = fs.readFileSync(fallbackScript, 'utf8');
  const m = src.match(/N8N_API_KEY\s*\|\|\s*'([^']+)'/);
  return m ? String(m[1] || '').trim() : '';
}

const KEY = resolveKey();
const WF02_ID = 'U21Tv3PDwmHrVHpJ';
const WF03_ID = '8VGrCBq2xsKQadfM';

if (!KEY) {
  console.error('Missing N8N_API_KEY and no fallback key found');
  process.exit(1);
}

function apiGet(url) {
  return JSON.parse(
    execSync(`curl -sS '${url}' -H "X-N8N-API-KEY: ${KEY}"`, {
      encoding: 'utf8',
      maxBuffer: 80 * 1024 * 1024,
    })
  );
}

function apiPut(url, payload) {
  const body = JSON.stringify(payload).replace(/'/g, "'\\''");
  return JSON.parse(
    execSync(
      `curl -sS -X PUT '${url}' -H "X-N8N-API-KEY: ${KEY}" -H 'Content-Type: application/json' --data '${body}'`,
      { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 }
    )
  );
}

function loadWorkflow(id) {
  const raw = apiGet(`${BASE}/api/v1/workflows/${id}`);
  return raw.data || raw;
}

function saveBackup(id, wf) {
  const dir = path.join(process.cwd(), '.n8n-live-backups', 'support-knowledge-20260411');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-before.json`);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
}

function persistWorkflow(id, wf) {
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: {},
  };
  const raw = apiPut(`${BASE}/api/v1/workflows/${id}`, payload);
  return raw.data || raw;
}

function setNodeParameters(wf, nodeName, updater) {
  const node = (wf.nodes || []).find((n) => n.name === nodeName);
  if (!node) throw new Error(`Node not found: ${nodeName}`);
  node.parameters = node.parameters || {};
  updater(node.parameters, node);
}

function upsertCodeNode(wf, nodeName, jsCode, position) {
  wf.nodes = wf.nodes || [];
  let node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) {
    node = {
      id: crypto.randomUUID(),
      name: nodeName,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: position || [0, 0],
      parameters: {},
    };
    wf.nodes.push(node);
  }
  node.parameters = node.parameters || {};
  node.parameters.jsCode = jsCode;
  if (position) node.position = position;
}

function rerouteMainOutput(wf, fromNode, outputIndex, targetNode) {
  wf.connections = wf.connections || {};
  wf.connections[fromNode] = wf.connections[fromNode] || {};
  wf.connections[fromNode].main = wf.connections[fromNode].main || [];
  wf.connections[fromNode].main[outputIndex] = [{ node: targetNode, type: 'main', index: 0 }];
}

function setMainOutput(wf, fromNode, toNode) {
  wf.connections = wf.connections || {};
  wf.connections[fromNode] = wf.connections[fromNode] || {};
  wf.connections[fromNode].main = [[{ node: toNode, type: 'main', index: 0 }]];
}

const SUPPORT_KB_PATH = path.join(process.cwd(), 'src', 'support-knowledge-base.json');
const SUPPORT_FAQ_PATH = path.join(process.cwd(), 'src', 'support-knowledge-faq.json');

function loadSupportKnowledge() {
  if (!fs.existsSync(SUPPORT_KB_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SUPPORT_KB_PATH, 'utf8'));
    if (!parsed || !Array.isArray(parsed.sources)) return null;
    return parsed;
  } catch (error) {
    console.warn('Failed to parse support knowledge base JSON, using fallback facts only.');
    return null;
  }
}

function renderSupportKnowledgeBlock(kb) {
  if (!kb || !Array.isArray(kb.sources) || kb.sources.length === 0) {
    return [
      'Approved source corpus:',
      '- Wealth Strategies is education-first around supplemental health, risk awareness, and tax education for high school athletes and families.',
      '- Supplemental coverage is designed to supplement major medical and is not a replacement.',
      '- Tax and risk material is educational and not individualized tax/legal/medical advice.',
      '- Approved links: parent, supplemental health, risk awareness, tax education, and main site.',
    ].join('\n');
  }

  const lines = ['Approved source corpus (website + guides):'];
  for (const source of kb.sources) {
    const title = String(source.title || source.key || 'Knowledge Source').trim();
    const url = String(source.url || '').trim();
    lines.push(`- ${title}${url ? ` (${url})` : ''}`);

    const facts = Array.isArray(source.facts) ? source.facts : [];
    for (const fact of facts) {
      const cleanFact = String(fact || '').trim();
      if (cleanFact) lines.push(`  - ${cleanFact}`);
    }

    const guardrails = Array.isArray(source.guardrails) ? source.guardrails : [];
    if (guardrails.length) {
      lines.push('  - Source guardrails:');
      for (const guardrail of guardrails) {
        const cleanGuardrail = String(guardrail || '').trim();
        if (cleanGuardrail) lines.push(`    - ${cleanGuardrail}`);
      }
    }
  }

  const linkMap = kb.link_map && typeof kb.link_map === 'object' ? kb.link_map : {};
  const linkEntries = Object.entries(linkMap)
    .map(([key, value]) => `- ${key}: ${value}`)
    .filter(Boolean);
  if (linkEntries.length) {
    lines.push('Approved public links by type:');
    lines.push(...linkEntries);
  }

  return lines.join('\n');
}

const supportKnowledge = loadSupportKnowledge();
const supportKnowledgeBlock = renderSupportKnowledgeBlock(supportKnowledge);

function loadSupportFaq() {
  if (!fs.existsSync(SUPPORT_FAQ_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(SUPPORT_FAQ_PATH, 'utf8'));
    if (!parsed || !Array.isArray(parsed.faq)) return null;
    return parsed;
  } catch (error) {
    console.warn('Failed to parse support FAQ JSON, skipping FAQ block.');
    return null;
  }
}

function renderFaqBlock(faqDoc) {
  if (!faqDoc || !Array.isArray(faqDoc.faq) || faqDoc.faq.length === 0) {
    return 'FAQ corpus: unavailable.';
  }
  const lines = ['Expanded FAQ corpus (website + guides):'];
  for (const item of faqDoc.faq) {
    const q = String(item.question || '').trim();
    const a = String(item.answer || '').trim();
    const s = String(item.source_key || '').trim();
    if (!q || !a) continue;
    lines.push(`- Q: ${q}`);
    lines.push(`  A: ${a}${s ? ` (source: ${s})` : ''}`);
  }
  return lines.join('\n');
}

const supportFaq = loadSupportFaq();
const supportFaqBlock = renderFaqBlock(supportFaq);

const wf02Prompt = String.raw`={{ "Draft a Wealth Strategies support reply using the source-backed support framework below.\n\nInbound sender: " + $("[GMAIL] Parse Support Email").first().json.from_name + " <" + $("[GMAIL] Parse Support Email").first().json.from_email + ">\nSubject: " + $("[GMAIL] Parse Support Email").first().json.subject + "\nMessage:\n" + $("[GMAIL] Parse Support Email").first().json.body_text + "\n\nLIVE WEBSITE SNAPSHOT (fetched this run):\n" + ($("[GMAIL] Build Live Support Snapshot").first().json.live_support_snapshot || "Live snapshot unavailable; use approved corpus below.") + "\n\nReturn two versions plus a recommendation block." }}`;

const liveSnapshotCode = `const inputItems = $input.all();
const SOURCES = [
  { key: 'main-site', url: 'https://mynilwealthstrategies.com/' },
  { key: 'parent-guide', url: 'https://parentsguide.mynilwealthstrategies.com/' },
  { key: 'supplemental-health-guide', url: 'https://supplementalhealth.mynilwealthstrategies.com/' },
  { key: 'risk-awareness-guide', url: 'https://riskawareness.mynilwealthstrategies.com/' },
  { key: 'tax-education-guide', url: 'https://taxeducation.mynilwealthstrategies.com/' },
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\\s+/g, ' ')
    .trim();
}

function trimSentenceSafe(text, maxLen) {
  const clean = String(text || '').trim();
  if (!clean || clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const punct = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (punct > 120 ? cut.slice(0, punct + 1) : cut).trim();
}

async function fetchSnippet(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(source.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'NIL-Wealth-Workflow/1.0 (+support snapshot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      return { key: source.key, url: source.url, ok: false, note: 'HTTP ' + response.status };
    }
    const html = await response.text();
    const text = trimSentenceSafe(stripHtml(html), 800);
    return { key: source.key, url: source.url, ok: true, snippet: text || 'No readable text found.' };
  } catch (error) {
    return { key: source.key, url: source.url, ok: false, note: String(error && error.message ? error.message : error) };
  } finally {
    clearTimeout(timeout);
  }
}

const settled = await Promise.all(SOURCES.map((source) => fetchSnippet(source)));
const lines = [];
lines.push('Fresh website snippets (fetched at runtime):');
for (const item of settled) {
  lines.push('- ' + item.key + ' (' + item.url + ')');
  if (item.ok) {
    lines.push('  - snippet: ' + item.snippet);
  } else {
    lines.push('  - unavailable: ' + item.note);
  }
}

const live_support_snapshot = lines.join('\\n').slice(0, 7000);
return inputItems.map((item) => ({
  json: {
    ...item.json,
    live_support_snapshot,
    live_support_snapshot_fetched_at: new Date().toISOString(),
  },
}));`;

const wf02System = `You are Wealth Strategies' support specialist. You draft clear, source-backed replies for athletes, parents, and coaches.

HARD TONE RULE: Support replies must be FORMAL — professional, complete sentences, organized, warm but polished. Never casual, never slang, never text-message style.

Use only the source corpus below and the inbound email. If the message asks for something not covered here, say Wealth Strategies can clarify directly. Do not invent statistics, client counts, pricing, underwriting approvals, guarantees, or school endorsements.

Hard framing rules:
- Default framing must be high school athletes and their families.
- Keep the focus on supplemental health coverage first, with risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist.
- Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them.
- If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills.
- If asked about tax, answer briefly but fully with source-backed basics: 1099 reporting, taxable income basics, and practical next steps such as tracking expenses and planning estimated taxes.

Insurance naming rule:
- Do not name any insurer except Aflac.
- Mention extra carrier credibility details only when credibility is explicitly asked.

${supportKnowledgeBlock}

${supportFaqBlock}

Guide recommendation rules:
- Recommend parent-guide when the sender sounds like a coach or parent asking for something forwardable to a family.
- Recommend supplemental-health-guide when the sender asks what the coverage is, how it works, what it pays, or whether it replaces health insurance.
- Recommend risk-awareness-guide when the sender is asking broader high-school athlete risk-management questions.
- Recommend tax-education-guide when the sender asks about tax basics, 1099s, deductions, or estimated payments.
- If no guide is truly helpful, recommend no link.

Output format:
Your entire response must match this exact structure and use these exact uppercase headers:
NO_LINK_VERSION:
<reply body only, under 205 words>

LINK_VERSION:
<same answer, but naturally references the guide and includes exactly one plain public link from the approved list if a guide is genuinely helpful>

RECOMMENDATION:
include_link=yes|no
recommended_guide=parent-guide|supplemental-health-guide|risk-awareness-guide|tax-education-guide|none

Style rules:
- Warm, direct, and human.
- Prefer warm, natural, relationship-focused wording over stiff or overly executive phrasing.
- Specific to the sender's actual question.
- Fully answer the sender's actual question or concern before suggesting any next step.
- Answer fully but briefly using the approved source corpus and FAQ facts.
- Use simple vocabulary that is easy to understand.
- No greeting line and no sign-off.
- No bullet lists unless the question clearly needs a short list.
- Never mention internal systems, tracking, campaigns, or bots.
- If the message is for coach-to-parent forwarding, clearly state in fluent wording: coaches do not sell, explain in detail, or enroll insurance; coaches do not handle money or paperwork; families review options and enroll directly with Aflac; Wealth Strategies provides education and support only; coverage is optional and families can move at their own pace.`;

const wf03ParseCode = `const raw = $input.first().json.body || $input.first().json;
const b = typeof raw === 'string' ? JSON.parse(raw) : raw;
if (!b.conversation_id) throw new Error('400: missing conversation_id');
if (!b.bridge_message || !b.bridge_message.body) throw new Error('400: missing bridge_message.body');
if (!b.support_message || !b.support_message.body) throw new Error('400: missing support_message.body');
return [{ json: {
  schema_version:        b.schema_version || '5.3',
  event_type:            b.event_type     || 'cc_support.requested',
  trace_id:              b.trace_id       || '',
  idempotency_key:       b.idempotency_key || ('cc_support|' + b.conversation_id),
  conversation_id:       b.conversation_id,
  entity_id:             b.entity_id      || b.conversation_id,
  thread_key:            b.thread_key     || '',
  coach_id:              b.coach_id       || null,
  coach_name:            b.coach_name     || '',
  contact_name:          b.contact_name   || b.coach_name || '',
  contact_email:         b.contact_email  || '',
  bridge_subject:        (b.bridge_message||{}).subject  || b.payload?.subject || '',
  bridge_body:           (b.bridge_message||{}).body     || '',
  support_subject:       (b.support_message||{}).subject || b.payload?.subject || '',
  support_body:          (b.support_message||{}).body    || '',
  coach_message:         b.coach_message  || (b.support_message||{}).body || '',
  conversation_history:  b.conversation_history || b.thread_history || '',
  situation_type:        b.situation_type || '',
  gmail_thread_id:       b.gmail_thread_id    || null,
  message_id_header:     b.message_id_header  || null,
  in_reply_to:           b.in_reply_to        || null,
  reply_anchor:          b.reply_anchor       || null,
  references:            b.references         || null,
  compose_mode:          b.compose_mode       || false,
  mirror_conversation_id: b.mirror_conversation_id || null,
  lane_source:           (b.payload||{}).lane_source || 'programs',
  person_id:             b.person_id      || null,
  campaign_id:           b.campaign_id    || null,
  contact_phone:         b.contact_phone  || b.phone || null,
  guide_type:            b.guide_type     || 'supplemental-health-guide'
}}];`;

const wf03Prompt = String.raw`={{ "Compose a forwardable Wealth Strategies support email.\nSituation type: " + ($("[CC] Parse CC Payload").first().json.situation_type || "answer_question") + "\nCoach/contact name: " + ($("[CC] Parse CC Payload").first().json.contact_name || $("[CC] Parse CC Payload").first().json.coach_name || "Coach") + "\nContact email: " + ($("[CC] Parse CC Payload").first().json.contact_email || "") + "\nGuide type: " + ($("[CC] Parse CC Payload").first().json.guide_type || "supplemental-health-guide") + "\nCoach message: " + ($("[CC] Parse CC Payload").first().json.coach_message || $("[CC] Parse CC Payload").first().json.support_body || "(no message provided)") + "\nConversation history: " + ($("[CC] Parse CC Payload").first().json.conversation_history || "No prior history") + "\n\nLIVE WEBSITE SNAPSHOT (fetched this run):\n" + ($("[CC] Build Live Support Snapshot").first().json.live_support_snapshot || "Live snapshot unavailable; use approved corpus below.") }}`;

const wf03System = `You are Wealth Strategies' support specialist writing a real support email that may be forwarded from a coach to a parent or athlete.

HARD TONE RULE: Support emails must be FORMAL — professional, complete sentences, structured, warm but polished. Never casual, never slang. The email will be read by parents who have never heard of this program, so it must be clear and credible.

REQUIRED in every CC support email:
1. Context opener: 1-2 sentences explaining what this email is and why parents are receiving it (e.g., their coach forwarded it)
2. What this program provides with priority order: supplemental health coverage first, then risk awareness education and tax guidance from an enrolled agent and multi-licensed insurance specialist
3. A clear line: "You can respond to this message with any questions — we're happy to help."
4. A compelling, specific reason to click the parent guide. Explain what families will actually find there and why it helps them review the option without pressure. Do NOT paste a raw URL — the workflow appends the tracked link after your text. Instead write: "I included the Parent Guide below" or "I added the resource below."
5. Include role clarity in fluent wording: coaches do not sell, explain in detail, or enroll insurance; coaches do not handle money or paperwork; families review options and enroll directly with Aflac; Wealth Strategies provides education and support only.
6. Include optional pace language in fluent wording: coverage is optional and families can move at their own pace.
7. Never use placeholder tokens such as [Link], [Guide], [Parent Guide], TBD, or angle-bracket placeholders.
8. Never use square brackets in the reply body for any reason.

Use only the source corpus below plus the inbound message. If the question goes beyond the corpus, say Wealth Strategies can clarify directly instead of making something up.

Hard framing rules:
- Default framing must be high school athletes and their families.
- Supplemental health responses must be framed as high-school-family education by default.
- Never use the words NIL or Name, Image, and Likeness unless the sender explicitly asks about them.
- If asked what supplemental health is, clearly explain accident insurance and hospital indemnity: accident insurance pays cash benefits for covered accidental injuries and related care, and hospital indemnity pays cash benefits for covered hospital admissions or stays to help with out-of-pocket costs and related bills.
- If asked about tax, answer briefly but fully with source-backed basics: 1099 reporting, taxable income basics, and practical next steps such as tracking expenses and planning estimated taxes.

Insurance naming rule:
- Do not name any insurer except Aflac.
- Mention extra carrier credibility details only when credibility is explicitly asked.

${supportKnowledgeBlock}

${supportFaqBlock}

Reply rules:
- Write in first person as Wealth Strategies support.
- Keep it concise, warm, and forwardable.
- Prefer warm, natural, relationship-focused wording over stiff or overly executive phrasing.
- Use simple vocabulary that is easy to understand.
- Under 205 words.
- No subject line, no greeting line, no signature.
- Do not start the email body with Hi, Hello, Hey, Dear, or any salutation.
- Use simple comfortable wording; avoid big words and corporate jargon.
- Keep punctuation light and natural; avoid hype punctuation and repeated exclamation points.
- Keep the message clearly different from prior variants in opening and phrasing.
- Answer fully but briefly using the approved source corpus and FAQ facts.
- Never invent counts, social proof, pricing, underwriting approvals, or school partnerships.
- If a link would help, refer to it naturally but do not paste a raw URL in the body. The workflow appends the tracked link after your text.
- Never use placeholder tokens such as [Link], [Guide], [Parent Guide], TBD, or angle-bracket placeholders.
- Never use square brackets in the reply body for any reason.
- If a guide is relevant, say things like "I included the Parent Guide below" or "I added the supplemental health guide below".
- If the coach is forwarding to a parent, acknowledge that the note is easy to pass along.
- Build the message in this order: context, what families need to know, role clarity, guide value, response line.
- When mentioning the Parent Guide, explain what families will find there so the reason to click feels credible and professional.
- The final line before the workflow-appended tracked link should introduce the Parent Guide, so the actual link appears at the very bottom.
- If multiple variants are generated over time, keep each response clearly unique in opener, sentence flow, phrasing, and CTA wording.
- Include the exact line: "You can respond to this message with any questions — we're happy to help."
- If the concern is an objection, respond empathetically and leave the door open without pressure.
- Do not suggest a call, meeting, or calendar step unless the sender explicitly asks for a call/meeting.

Return only the email body text.`;

const wf03BuildTrackingLinkCode = `// Resolve coach_id from whichever path executed
let coach_id = "";

if ($input.first().json.coach_id) {
  coach_id = $input.first().json.coach_id;
}

if (!coach_id && Array.isArray($input.first().json)) {
  coach_id = ($input.first().json[0] || {}).coach_id || "";
}

if (!coach_id) {
  try { coach_id = $("[CC] Generate New Coach ID").first().json.coach_id || ""; } catch (e) {}
}

const pk_node = $("[CC] Compute Person Key").first().json;
const person_key = pk_node.person_key || "";
const parse = $("[CC] Parse CC Payload").first().json;
const campaign_id = parse.campaign_id || "";
const guide_type = parse.guide_type || "supplemental-health-guide";

if (!person_key) throw new Error("PERSON_KEY_MISSING: person_key must be set before building tracking link");

const guideMeta = {
  "parent-guide": {
    label: "Parent Guide",
    public_url: "https://parentsguide.mynilwealthstrategies.com/",
    intro: "Parent Guide:"
  },
  "supplemental-health-guide": {
    label: "Supplemental Health Guide",
    public_url: "https://supplementalhealth.mynilwealthstrategies.com/",
    intro: "Supplemental Health Guide:"
  },
  "risk-awareness-guide": {
    label: "Risk Awareness Guide",
    public_url: "https://riskawareness.mynilwealthstrategies.com/",
    intro: "Risk Awareness Guide:"
  },
  "tax-education-guide": {
    label: "Tax Education Guide",
    public_url: "https://taxeducation.mynilwealthstrategies.com/",
    intro: "Tax Education Guide:"
  }
}[guide_type] || {
  label: "Wealth Strategies Guide",
  public_url: "https://mynilwealthstrategies.com/",
  intro: "Helpful guide:"
};

const basePath = "/" + guide_type + (coach_id ? "-" + coach_id : "");
const baseUrl = "https://mynilwealthstrategies.com" + basePath;
const query = [
  "person_key=" + encodeURIComponent(person_key),
  campaign_id ? "campaign_id=" + encodeURIComponent(campaign_id) : null,
  "coach_id=" + encodeURIComponent(coach_id || "support")
].filter(Boolean).join("&");

const tracking_url = baseUrl + "?" + query;
const qa_url = tracking_url + "&coach_self_click=1";
const original_body = ($("[CC] AI: Compose Email Body").first().json.output || parse.support_body || "").trim();
const newline = String.fromCharCode(10);
const support_body_no_link = original_body
  .split(newline)
  .filter((line) => {
    const normalizedLine = String(line || '').trim().toLowerCase();
    return !(normalizedLine.startsWith('[') && normalizedLine.endsWith(']') && normalizedLine.includes('link'));
  })
  .join(newline)
  .trim();
const support_body_with_link = (support_body_no_link
  ? support_body_no_link + "\\n\\n───────────────────────────\\n" + guideMeta.intro + "\\n" + tracking_url
  : guideMeta.intro + "\\n" + tracking_url);

console.log(JSON.stringify({
  event: "tracking_link_built",
  conversation_id: parse.conversation_id,
  coach_id,
  guide_type,
  campaign_id: campaign_id || null,
  identity_source: pk_node.identity_source,
  person_key_prefix: person_key.slice(0, 8)
}));

return [{ json: {
  ...parse,
  coach_id,
  person_key,
  campaign_id: campaign_id || null,
  guide_type,
  guide_label: guideMeta.label,
  display_url: guideMeta.public_url,
  tracking_url,
  qa_url,
  support_body_no_link,
  support_body_with_link,
  support_body: support_body_with_link
} }];`;

function patchWf02(wf) {
  upsertCodeNode(
    wf,
    '[GMAIL] Build Live Support Snapshot',
    liveSnapshotCode,
    [3360, 1152]
  );

  rerouteMainOutput(wf, '[GMAIL] Emit message.ingested', 0, '[GMAIL] Build Live Support Snapshot');
  setMainOutput(wf, '[GMAIL] Build Live Support Snapshot', '[GMAIL] AI: Draft Support Reply');

  setNodeParameters(wf, '[GMAIL] AI: Draft Support Reply', (parameters) => {
    parameters.text = wf02Prompt;
    parameters.options = parameters.options || {};
    parameters.options.systemMessage = wf02System;
  });
}

function patchWf03(wf) {
  upsertCodeNode(
    wf,
    '[CC] Build Live Support Snapshot',
    liveSnapshotCode,
    [-544, 1152]
  );

  rerouteMainOutput(wf, '[CC] Already Sent?', 0, '[CC] Build Live Support Snapshot');
  setMainOutput(wf, '[CC] Build Live Support Snapshot', '[CC] AI: Compose Email Body');

  setNodeParameters(wf, '[CC] Parse CC Payload', (parameters) => {
    parameters.jsCode = wf03ParseCode;
  });
  setNodeParameters(wf, '[CC] AI: Compose Email Body', (parameters) => {
    parameters.text = wf03Prompt;
    parameters.options = parameters.options || {};
    parameters.options.systemMessage = wf03System;
  });
  setNodeParameters(wf, '[CC] Build Tracking Link', (parameters) => {
    parameters.jsCode = wf03BuildTrackingLinkCode;
  setNodeParameters(wf, '[CC] Lookup Coach Record', (parameters) => {
    parameters.useCustomSchema = true;
    parameters.schema = 'nil';
    parameters.operation = 'getAll';
    parameters.tableId = 'coaches';
    parameters.limit = 1;
    parameters.filters = {
      conditions: [
        {
          keyName: 'coach_id',
          condition: 'eq',
          keyValue: "={{ $('[CC] Parse CC Payload').first().json.coach_id }}",
        },
      ],
    };
  });
  });
  const lookupCoachNode = (wf.nodes || []).find((node) => node.name === '[CC] Lookup Coach Record');
  if (lookupCoachNode) {
    lookupCoachNode.alwaysOutputData = true;
  }
  setNodeParameters(wf, '[CC] Coach Registered?', (parameters) => {
    parameters.conditions = {
      options: {
        caseSensitive: false,
        leftValue: '',
        typeValidation: 'strict',
      },
      conditions: [
        {
          id: 'nil9073',
          leftValue: '={{ Array.isArray($json) ? $json.length : 0 }}',
          rightValue: 0,
          operator: {
            type: 'number',
            operation: 'equals',
          },
        },
      ],
      combinator: 'and',
    };
    parameters.options = {};
  });
}

const wf02 = loadWorkflow(WF02_ID);
const wf03 = loadWorkflow(WF03_ID);
saveBackup(WF02_ID, wf02);
saveBackup(WF03_ID, wf03);
patchWf02(wf02);
patchWf03(wf03);
const updated02 = persistWorkflow(WF02_ID, wf02);
const updated03 = persistWorkflow(WF03_ID, wf03);
console.log(JSON.stringify({
  ok: true,
  updated: [
    { workflowId: WF02_ID, updatedAt: updated02.updatedAt || null, active: updated02.active },
    { workflowId: WF03_ID, updatedAt: updated03.updatedAt || null, active: updated03.active },
  ]
}, null, 2));
