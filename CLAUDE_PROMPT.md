# NIL Wealth n8n Workflow Prompt (V6.0)

Use this exact prompt with Claude to generate production-ready n8n workflows for the live NIL Wealth bot runtime.

## Critical Guardrails

- This is a live production system.
- Do not redesign the bot architecture.
- Do not invent new event names unless explicitly requested.
- Do not silently downgrade outreach sends to support sends.
- Return explicit non-2xx failures when required routing or config is missing.
- Keep all DB writes in Supabase schema `nil`.

## Live Runtime Facts (Source of Truth)

- Runtime file: `src/index.js`
- Runtime version: `Index.js V6.0`
- Bot stack: Node.js + Telegraf + Express + Supabase + webhook-based automations
- Core ingress endpoint for state sync: `POST /ops/ingest`
- Health endpoints: `GET /health`, `GET /ready`

## Required Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BASE_WEBHOOK_SECRET`
- `MAKE_SEND_WEBHOOK_URL`
- `CC_SUPPORT_WEBHOOK_URL`
- `SUPPORT_FROM_EMAIL`
- `OUTREACH_FROM_EMAIL`

## Auth and Security Contract

For all n8n -> bot calls:

- Send header `x-nil-secret: <BASE_WEBHOOK_SECRET>`
- Use idempotency keys on all side-effect operations
- Pass `trace_id` on all events
- Never treat missing webhook URL/config as success

## Canonical Event Envelope for `/ops/ingest`

```json
{
  "schema_version": "5.3",
  "event_type": "conversation.updated",
  "source": "n8n",
  "direction": "inbound",
  "trace_id": "uuid",
  "idempotency_key": "stable-key",
  "entity_type": "conversation",
  "entity_id": "uuid",
  "submission_id": null,
  "payload": {}
}
```

## Workflow Contracts You Must Implement

### 1) Send Executor (`MAKE_SEND_WEBHOOK_URL`)

Trigger payload from bot includes:

```json
{
  "schema_version": "5.3",
  "event_type": "outbox.email.send_requested",
  "source": "telegram",
  "direction": "outbound",
  "trace_id": "uuid",
  "idempotency_key": "stable-hash",
  "conversation_id": "uuid",
  "thread_key": "thread-key",
  "contact_email": "recipient@example.com",
  "subject": "...",
  "body": "...",
  "cc_support": false,
  "send_as": "support|outreach",
  "from_email": "sender@example.com",
  "gmail_thread_id": null,
  "message_id_header": null,
  "in_reply_to": null,
  "references": null,
  "mirror_conversation_id": null,
  "use_draft": 1
}
```

Required behavior:

1. Route by `send_as`.
2. `send_as="support"` must use support lane/mailbox.
3. `send_as="outreach"` must use outreach lane/sender only.
4. Never fallback outreach -> support.
5. If outreach sender/routing unavailable, return non-2xx with machine-readable error.
6. Emit `/ops/ingest` events for send outcomes: `outbox.email.sent` or `outbox.email.failed`.

### 2) CC Support Executor (`CC_SUPPORT_WEBHOOK_URL`)

Trigger payload from bot includes:

```json
{
  "schema_version": "5.3",
  "event_type": "cc_support.requested",
  "source": "telegram",
  "direction": "outbound",
  "trace_id": "uuid",
  "idempotency_key": "sha256(cc_support|conversation_id)",
  "entity_type": "conversation",
  "entity_id": "uuid",
  "conversation_id": "uuid",
  "thread_key": "thread-key",
  "coach_id": "uuid|null",
  "coach_name": "...",
  "contact_email": "recipient@example.com",
  "bridge_draft": 2,
  "support_draft": 2,
  "bridge_message": { "subject": "...", "body": "..." },
  "support_message": { "subject": "...", "body": "..." },
  "gmail_thread_id": null,
  "message_id_header": null,
  "in_reply_to": null,
  "references": null,
  "mirror_conversation_id": null,
  "payload": {
    "lane_source": "programs",
    "subject": "...",
    "cc_support_suggested": true
  }
}
```

Required behavior:

1. Deduplicate by `idempotency_key`.
2. Send bridge message through outreach lane using `bridge_message` exactly.
3. Send support-forward message through support mailbox using `support_message` exactly.
4. Create or link support mirror conversation.
5. Maintain mirror links in `conversations.mirror_conversation_id` and `nil.card_mirrors`.
6. Emit `conversation.updated` and send outcome events to `/ops/ingest`.
7. Return non-2xx on failure so Telegram never shows false success.

### 3) Handoff Detection Workflow

Trigger: outbound outreach message events from Instantly/provider.

Match phrases (case-insensitive), including:

- `looping in support`
- `loop in support`
- `connecting you with`
- `have support reach out`
- `support team will`

On match:

1. Resolve conversation by `thread_key` first, fallback `contact_email`.
2. POST to `/ops/ingest` with:

```json
{
  "schema_version": "5.3",
  "event_type": "outreach.handoff_detected",
  "source": "instantly",
  "direction": "inbound",
  "entity_type": "conversation",
  "entity_id": "uuid",
  "trace_id": "uuid",
  "idempotency_key": "handoff|<provider-event-id>",
  "payload": {
    "reason": "looping in support",
    "detected_phrase": "full matched sentence",
    "trigger": "outbound_message_contains"
  }
}
```

No match: no-op.

### 4) Identity Linker Workflow

Purpose: unify same-email threads.

Required behavior:

1. Normalize email.
2. Find sibling conversations by email.
3. Pick canonical (prefer `source='programs'`, then most recently updated).
4. Link siblings via `mirror_conversation_id`.
5. Upsert `nil.card_mirrors` pairs.
6. Emit `conversation.updated` for canonical record.

### 5) Mirror Reconciler Workflow

Purpose: repair one-way/broken mirrors.

Required behavior:

1. Scan conversations with `mirror_conversation_id` not null.
2. Verify partner exists and backlink consistency.
3. Repair partner backlink if missing.
4. Upsert forward and reverse rows in `nil.card_mirrors`.
5. Clear stale mirror references when partner missing.
6. Emit `conversation.updated` events for repaired conversations.

## Required Reliability Behavior

- Every webhook step has timeout + retry with capped attempts.
- Every failure path logs structured error with `trace_id`, `idempotency_key`, `entity_id`.
- Use dead-letter table/queue for exhausted retries.
- Never swallow errors silently.

## Required Deliverables from Claude

For each workflow:

1. Node-by-node design.
2. Importable n8n JSON.
3. Env var list.
4. Idempotency strategy.
5. Retry/failure/dead-letter strategy.
6. Test payloads.
7. Expected DB deltas.
8. Expected `/ops/ingest` events emitted.

## Output Format Required from Claude

- Return valid n8n JSON for each workflow.
- Keep credentials as n8n credential references, not inline secrets.
- Include a short deployment checklist at the end.

## Final Instruction to Claude

Generate production-ready workflows that conform exactly to this prompt and do not break existing bot contracts in `src/index.js` `V6.0`.
