# NIL Wealth n8n Workflow Master Prompt (V6.0)

Use this prompt verbatim with Claude to generate production-ready n8n workflows for the live NIL Wealth Telegram bot runtime.

## Mission

Design and generate importable n8n workflows that integrate with `src/index.js` `Index.js V6.0` without breaking existing contracts.

## Non-Negotiable Guardrails

- This is a live production system.
- Do not redesign bot architecture.
- Do not invent incompatible event names.
- Never silently fallback outreach sends to support sends.
- Return explicit non-2xx responses for workflow failures.
- Use Supabase schema `nil` only.
- Keep secrets in n8n credentials/env vars, not hardcoded in JSON output.

## Runtime Contracts (Source of Truth)

- Runtime file: `src/index.js`
- Version: `Index.js V6.0`
- State sync endpoint: `POST /ops/ingest`
- Health endpoints: `GET /health`, `GET /ready`
- Send webhook source from bot: `MAKE_SEND_WEBHOOK_URL`
- CC webhook source from bot: `CC_SUPPORT_WEBHOOK_URL`

## Required Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BASE_WEBHOOK_SECRET`
- `MAKE_SEND_WEBHOOK_URL`
- `CC_SUPPORT_WEBHOOK_URL`
- `SUPPORT_FROM_EMAIL`
- `OUTREACH_FROM_EMAIL`
- Provider credentials (Gmail/SendGrid/Instantly/Twilio/etc) via n8n credential store

## Auth + Security Rules

For every n8n -> bot request:

- Include `x-nil-secret: <BASE_WEBHOOK_SECRET>`.
- Include deterministic `idempotency_key` for all side effects.
- Include `trace_id` for correlation.
- Validate input schema before DB write or provider call.

## Canonical `/ops/ingest` Event Envelope

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

## Bot-Outbound Webhook Payload Contracts

### A) Send Executor (`MAKE_SEND_WEBHOOK_URL`)

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
  "coach_id": "uuid|null",
  "coach_name": "...",
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

1. Route strictly by `send_as`.
2. `send_as=support` -> support mailbox/lane.
3. `send_as=outreach` -> outreach mailbox/lane only.
4. Never rewrite outreach to support.
5. If outreach routing unavailable, return non-2xx and machine-readable reason.
6. Emit result events to `/ops/ingest` (`outbox.email.sent` or `outbox.email.failed`).

### B) CC Support Executor (`CC_SUPPORT_WEBHOOK_URL`)

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
2. Send `bridge_message` exactly via outreach lane.
3. Send `support_message` exactly via support mailbox.
4. Create or link support mirror conversation.
5. Maintain mirror relationship in `conversations.mirror_conversation_id` and `nil.card_mirrors`.
6. Emit `conversation.updated` + send result events to `/ops/ingest`.
7. Return non-2xx on any partial/total failure.

### C) Handoff Detection Event to `/ops/ingest`

Trigger from outbound outreach messages. On match, emit:

```json
{
  "schema_version": "5.3",
  "event_type": "outreach.handoff_detected",
  "source": "instantly",
  "direction": "inbound",
  "entity_type": "conversation",
  "entity_id": "uuid",
  "trace_id": "uuid",
  "idempotency_key": "handoff|provider-event-id",
  "payload": {
    "reason": "looping in support",
    "detected_phrase": "full matched phrase",
    "trigger": "outbound_message_contains"
  }
}
```

Phrase matching should include:

- `looping in support`
- `loop in support`
- `connecting you with`
- `have support reach out`
- `support team will`

## Workflows to Generate

## Tier 1 (required first)

1. Send Executor (webhook)
2. CC Support Executor (webhook)
3. Handoff Detector (webhook/cron per provider)
4. Reply/Support Ingest Producer (inbound email/reply -> `message.ingested`/`conversation.updated`)
5. Outbox Dispatcher (`GET /api/nil-outbox/claim` + `POST /api/nil-outbox/result`)

## Tier 2 (high-value thread integrity)

6. Conversation Identity Linker
7. Mirror Reconciler
8. Role Conflict Resolver

## Tier 3 (ops resilience)

9. Dead-Letter Replayer
10. SLA Escalator
11. Analytics Sync (`metric.*`, `click.*`, `eapp.visit`)

## Required Behavior Across All Workflows

- Timeout on every external call.
- Retry with capped exponential backoff.
- Dead-letter on exhausted retries.
- Structured error logging with `trace_id`, `idempotency_key`, `entity_id`.
- Idempotent DB writes (`upsert` or conflict-safe operations).
- Never mark success before downstream side effects succeed.

## Required Deliverables Per Workflow

1. Workflow inventory row: name, trigger, auth, env vars, outputs.
2. Node-by-node design.
3. Importable n8n JSON.
4. Idempotency strategy.
5. Error/retry/dead-letter strategy.
6. Test payloads.
7. Expected DB row changes (before/after).
8. Expected `/ops/ingest` events emitted.

## Output Format

- Provide valid n8n JSON (import-ready).
- Use n8n credential references for secrets.
- Include a short deployment checklist and smoke test checklist.

## Final Instruction

Generate production-ready workflows that conform exactly to `src/index.js` `V6.0` contracts and avoid breaking existing bot behavior.
