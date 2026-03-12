# Claude Build Pack: Index.js Max-Capability n8n Workflows

Date: March 5, 2026

## Before the 3 new workflows: what else you need for max capability

Your `src/index.js` is strongest when these workflows are running together.

### Tier 1 (core, required)
1. Website submission intake → `POST /api/submissions`
2. Outbox dispatcher (claim/send/result) → `GET /api/nil-outbox/claim` + `POST /api/nil-outbox/result`
3. Reply/support ingest producer → `POST /ops/ingest` with `message.ingested` / `conversation.updated`
4. Analytics sync (opens/clicks/replies) → `POST /ops/ingest` with `metric.*`/`click.*`

### Tier 2 (the 3 you asked for)
5. Conversation Identity Linker (same-email unify)
6. Mirror Reconciler (bi-directional mirror integrity)
7. CC Support Executor (bridge + support send + mirror create/link)

### Tier 3 (max polish)
8. Role conflict resolver (`role_pending` approvals)
9. Dead-letter replayer for failed ops events
10. SLA escalator (`urgent` / followup reminders)
11. Daily digest + KPI push to Telegram

---

## Ground truth from your index.js (used by these workflows)

- CC outbound hook exists: `CC_SUPPORT_WEBHOOK_URL` called by bot with `event_type: "cc_support.requested"`
- Bot expects mirror to exist later and says: “Mirror thread will appear when ingested.”
- Bot refreshes cards on `/ops/ingest` events, especially:
  - `conversation.updated`
  - `message.ingested`
  - `outbox.email.*`
  - `metric.*` / `click.*`
- Mirror fields already used in UI:
  - `conversations.mirror_conversation_id`
  - `nil.card_mirrors`

---

## Workflow 1 — Conversation Identity Linker

### Purpose
Auto-link same-person threads when the same normalized email appears across submission/reply/support lanes.

### Trigger
- Webhook (recommended): `/n8n/identity-linker`
- Optional cron sweep every 10 minutes for missed records.

### Input payload (from your ingest producers)
```json
{
  "event_type": "message.ingested",
  "entity_type": "conversation",
  "entity_id": "<conversation_uuid>",
  "contact_email": "coach@example.com",
  "source": "programs",
  "trace_id": "uuid",
  "idempotency_key": "optional"
}
```

### Required logic
1. Normalize email (lowercase/trim).
2. Query `nil.conversations` where `contact_email ilike normalized` (exclude deleted if applicable).
3. Pick canonical conversation:
   - prefer `source='programs'` and most recently updated.
4. For each sibling conversation:
   - set `mirror_conversation_id` to canonical ID.
   - upsert row in `nil.card_mirrors`:
     - `card_key = conversation:<canonical_id>`
     - `mirror_card_key = conversation:<sibling_id>`
     - `relationship_type = 'identity_email_link'`
5. Emit ops event to bot:
   - `event_type: "conversation.updated"`
   - `entity_type: "conversation"`
   - `entity_id: <canonical_id>`
   - include payload of linked IDs.

### n8n node layout
1. Webhook Trigger
2. Code: Normalize email + guard
3. Supabase: Fetch candidates by email
4. Code: Select canonical + siblings
5. IF: siblings exist?
6. Loop: Update each sibling conversation
7. Loop: Upsert `card_mirrors`
8. HTTP: POST `/ops/ingest` (`conversation.updated`)
9. HTTP: Optional Telegram admin audit message

### Idempotency
Use key: `identity_link|<normalized_email>|<canonical_id>`
Store in `nil.ops_events.idempotency_key` via `/ops/ingest`.

### Success criteria
- Any new same-email conversation is attached to existing thread family.
- `OPENMIRROR` button works consistently.
- no duplicate mirror rows due to unique pair upsert.

---

## Workflow 2 — Mirror Reconciler

### Purpose
Keep mirror links consistent bi-directionally and repair broken mirror references.

### Trigger
- Cron every 15 minutes.
- Manual webhook for emergency repair: `/n8n/mirror-reconcile`.

### Required logic
1. Load all conversations where `mirror_conversation_id is not null`.
2. For each row A→B:
   - verify B exists.
   - verify B points back to A (if not, patch it).
3. Ensure `nil.card_mirrors` has both directions:
   - `conversation:A -> conversation:B`
   - `conversation:B -> conversation:A`
4. If B missing:
   - null A’s `mirror_conversation_id` (or recreate B if policy says so).
5. Emit `/ops/ingest` `conversation.updated` for every repaired item.

### n8n node layout
1. Schedule Trigger
2. Supabase: fetch mirrored conversations
3. Split in batches
4. Supabase: fetch partner conversation
5. IF: partner exists?
6. Supabase update: back-link fix
7. Supabase upsert: card_mirrors forward
8. Supabase upsert: card_mirrors reverse
9. HTTP `/ops/ingest` event
10. Aggregate + Telegram summary

### Repair event payload to `/ops/ingest`
```json
{
  "schema_version": "5.3",
  "event_type": "conversation.updated",
  "source": "n8n",
  "direction": "inbound",
  "entity_type": "conversation",
  "entity_id": "<conversation_id>",
  "trace_id": "<uuid>",
  "idempotency_key": "mirror_repair|<conversation_id>|<partner_id>",
  "payload": {
    "repair_type": "mirror_backlink_sync",
    "partner_id": "<partner_id>"
  }
}
```

### Success criteria
- No one-way mirrors remain.
- `card_mirrors` reflects UI links in both directions.
- Missing partner references are repaired or safely removed.

---

## Workflow 3 — CC Support Executor

### Purpose
Execute what `index.js` already requests on CC confirm:
- send bridge message (outreach lane)
- send support-forward message (support inbox lane)
- create/link mirror support conversation
- report back via `/ops/ingest`

### Trigger
Webhook path expected by bot environment variable:
- `CC_SUPPORT_WEBHOOK_URL=https://<n8n-host>/webhook/cc-support-executor`

### Input payload (exact shape bot sends)
```json
{
  "schema_version": "5.3",
  "event_type": "cc_support.requested",
  "source": "telegram",
  "direction": "outbound",
  "trace_id": "uuid",
  "idempotency_key": "sha256(cc_support|conversation_id)",
  "entity_type": "conversation",
  "entity_id": "conversation_uuid",
  "conversation_id": "conversation_uuid",
  "thread_key": "thread_key",
  "contact_email": "coach@example.com",
  "bridge_draft": 2,
  "support_draft": 2,
  "mirror_conversation_id": null,
  "payload": {
    "lane_source": "programs",
    "subject": "...",
    "cc_support_suggested": true
  }
}
```

### Required logic
1. Dedup by `idempotency_key` (check `nil.ops_events`).
2. Fetch source conversation and selected drafts:
   - bridge draft kind `bridge`
   - support draft kind `support_forward`
3. Queue/send bridge email (outreach sender).
4. Create/find support mirror conversation:
   - source = `support`
   - same contact_email
   - set both `mirror_conversation_id` fields.
5. Queue/send support-forward email from `SUPPORT_FROM_EMAIL`.
6. Upsert `nil.card_mirrors` pair.
7. Mark source conversation:
   - `cc_support_enabled = true`
   - `cc_support_locked_at = now()`
8. Emit bot events via `/ops/ingest`:
   - `outbox.email.sent` (for each send)
   - `conversation.updated` (for source + mirror)
   - optional `message.ingested` for synthesized outbound entries.

### n8n node layout
1. Webhook Trigger
2. Supabase check dedupe
3. IF already processed → return 200 `already_processed`
4. Supabase fetch conversation
5. Supabase fetch selected drafts
6. Code compose bridge/support content
7. HTTP (provider) send bridge
8. Supabase upsert/find support mirror conversation
9. Supabase update mutual mirror_conversation_id
10. Supabase upsert card_mirrors (both directions)
11. HTTP send support-forward
12. Supabase update cc_support_enabled/locked
13. HTTP `/ops/ingest` emits
14. Respond success

### `/ops/ingest` completion events (minimum)
- Event A: `conversation.updated` for source
- Event B: `conversation.updated` for mirror
- Event C: `outbox.email.sent` with conversation IDs

### Success criteria
- Bot CC action results in two outbound sends.
- Mirror appears and opens via `OPENMIRROR`.
- Repeat clicks do not duplicate sends.

---

## Copy/paste prompt for Claude (single run to generate all 3)

```markdown
Build 3 n8n workflows for my NIL Wealth bot using these exact contracts:
1) Conversation Identity Linker
2) Mirror Reconciler
3) CC Support Executor

Constraints:
- Base system is Node/Telegraf app at src/index.js.
- Use Supabase schema nil.
- Must emit state refresh events to POST /ops/ingest.
- Must respect dedupe via idempotency_key.
- Must support mirror_conversation_id and nil.card_mirrors.
- CC workflow trigger payload is event_type=cc_support.requested from bot webhook.

Deliverables:
- Full node-by-node design for each workflow.
- Importable n8n JSON for each workflow.
- Environment variables list.
- Test payloads and expected DB row changes.
- Failure handling + retries + dead-letter strategy.
```

---

## Environment variables required for these 3

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BASE_WEBHOOK_SECRET`
- `OPS_INGEST_URL` (your `/ops/ingest` endpoint)
- `CC_SUPPORT_WEBHOOK_URL` (points to workflow 3 webhook)
- `SUPPORT_FROM_EMAIL`
- `OUTREACH_FROM_EMAIL` (if separate)
- Email provider creds (SendGrid/Gmail/etc)

---

## Validation checklist

1. Trigger CC in bot UI -> see both sends + mirror link.
2. Ingest same email reply twice -> linker remains idempotent.
3. Break one mirror manually -> reconciler repairs on next run.
4. Bot dashboard updates without restart (refresh from `/ops/ingest`).
