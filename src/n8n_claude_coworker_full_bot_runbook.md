# Full Bot n8n + Claude Coworker Runbook

This runbook is for operating the whole bot workflow surface, not just click tracking.
It is aligned to current bot payloads and endpoints in `index.js`.

## 1) Required environment variables

Set these in Render (bot service) and in n8n where applicable:

- `BASE_WEBHOOK_SECRET`
- `MAKE_SEND_WEBHOOK_URL`
- `CC_SUPPORT_WEBHOOK_URL`
- `SUPPORT_FROM_EMAIL`
- `OUTREACH_FROM_EMAIL`

Rules:

- `BASE_WEBHOOK_SECRET` must be identical between bot and n8n callers.
- If outreach mode is used, `OUTREACH_FROM_EMAIL` (or conversation-level `outreach_from_email`) must be configured.

## 2) Workflow map (full bot)

### Workflow A: Submission Outbox Worker

Purpose: process `nil.n8n_outbox` rows created by `/api/submissions`.

1. HTTP GET claim:
   - Endpoint: `/api/nil-outbox/claim?limit=10`
   - Header: `x-nil-secret: BASE_WEBHOOK_SECRET`
2. For each returned row, run downstream submission delivery logic.
3. HTTP POST result:
   - Endpoint: `/api/nil-outbox/result`
   - Header: `x-nil-secret: BASE_WEBHOOK_SECRET`
   - Body requirements:
     - `submission_id`
     - `status`: `sent` or `failed`
     - `success`: boolean
     - If success=true, include `message_id`
     - If success=false, include `error` (or `last_error`)

Notes:

- Bot enforces payload consistency and will reject mismatches.
- Retry/dead-letter lifecycle is handled in bot + table fields (`retry_count`, `dead_at`, `last_error`).

### Workflow B: Message Send Webhook (MAKE_SEND_WEBHOOK_URL)

Purpose: send operator-approved outbound messages.

Incoming event:

- `event_type`: `outbox.email.send_requested`
- `schema_version`: `5.3`

Critical fields to honor:

- `trace_id`
- `idempotency_key`
- `conversation_id`
- `thread_key`
- `contact_email`
- `subject`
- `body`
- `send_as` (`support` or `outreach`)
- `from_email`
- `cc_support`
- Threading continuity fields:
  - `gmail_thread_id`
  - `message_id_header`
  - `in_reply_to`
  - `references`
  - `reply_anchor`

Required behavior:

- Idempotency: use `idempotency_key` to prevent duplicate provider sends.
- Threading: pass thread headers/thread id through provider call when available.
- Return deterministic success/failure result to webhook caller.

### Workflow C: Loop in Support Webhook (CC_SUPPORT_WEBHOOK_URL)

Purpose: handle operator-confirmed support loop package.

Incoming event:

- `event_type`: `cc_support.requested`
- `schema_version`: `5.3`

Critical fields:

- `trace_id`
- `idempotency_key`
- `conversation_id`
- `thread_key`
- `contact_email`
- `bridge_draft`, `support_draft`
- `bridge_message.subject`, `bridge_message.body`
- `support_message.subject`, `support_message.body`
- `mirror_conversation_id`
- Threading continuity fields:
  - `gmail_thread_id`
  - `message_id_header`
  - `in_reply_to`
  - `references`
  - `reply_anchor`

Required behavior:

- Idempotency lock by `idempotency_key`.
- Send bridge message and support-forward message using provided drafts.
- Preserve thread continuity on both sends where possible.
- Return clear success/failure response body.

## 3) Claude coworker operating checklist

Use this checklist each deploy:

1. Run SQL setup/audit script: `nil_full_setup_and_audit.sql`.
2. Confirm strict audit passes (relations + runtime columns).
3. Verify outbox worker path:
   - Claim endpoint returns rows or empty list with `ok=true`.
   - Result endpoint accepts valid payloads.
4. Verify send webhook path:
   - Receive one `outbox.email.send_requested` test payload.
   - Confirm idempotency handling and threading propagation.
5. Verify CC support path:
   - Receive one `cc_support.requested` payload.
   - Confirm bridge/support messages and thread continuity behavior.
6. Check SQL diagnostics sections:
   - outbox queue health
   - dead letters
   - threading continuity counts
   - n8n result consistency

## 4) Failure triage quick guide

- `401 Unauthorized` on outbox endpoints:
  - Secret mismatch: `x-nil-secret` vs `BASE_WEBHOOK_SECRET`.
- Sent status rejected by result endpoint:
  - Missing `success` boolean or missing `message_id`/`error` requirement.
- Duplicate sends:
  - n8n workflow did not enforce `idempotency_key`.
- Broken reply threading:
  - Provider call did not apply `gmail_thread_id` and/or RFC headers (`In-Reply-To`, `References`).

## 5) Cleanliness standard

A deployment is "clean" only when all are true:

- SQL strict audits pass.
- n8n outbox has no stale queued rows (over 30m unless expected backlog).
- No unexplained growth in `dead_letters`.
- CC support requests are idempotent and threaded.
- Outbound send requests are idempotent and threaded.

## 6) 5-minute pass/fail acceptance test (copy for coworker)

Run this in order and mark each check PASS or FAIL.

### Gate 1: Schema and bot contract

- Run `nil_full_setup_and_audit.sql` in Supabase.
- PASS if:
  - no exception is raised,
  - post-run diagnostics return result sets,
  - `n8n_outbox` diagnostics include `outbox_id` rows,
  - strict column contract section does not fail.

### Gate 2: Secret and endpoint auth

- Test one outbox endpoint with wrong secret.
- PASS if HTTP `401` is returned.
- Test with correct secret.
- PASS if response body returns `ok: true`.

### Gate 3: Outbox claim/result roundtrip

- Call `/api/nil-outbox/claim?limit=1`.
- If no rows returned, create one submission via `/api/submissions` and retry claim.
- POST `/api/nil-outbox/result` for that `submission_id` with:
  - `status`: `sent`
  - `success`: `true`
  - valid `message_id`
- PASS if:
  - result endpoint returns `ok: true`,
  - `nil.n8n_outbox.status` becomes `sent`,
  - `sent_at` is populated,
  - `nil.submissions.n8n_status` updates to `sent`.

### Gate 4: Send webhook contract

- Trigger one bot send action that emits `outbox.email.send_requested`.
- In n8n, confirm payload includes:
  - `trace_id`, `idempotency_key`
  - `conversation_id`, `thread_key`
  - `send_as`, `from_email`, `subject`, `body`
  - threading fields (`gmail_thread_id`, `in_reply_to`, `references`, `reply_anchor`)
- PASS if:
  - n8n receives payload,
  - provider send executes once for same `idempotency_key`,
  - no duplicate send is observed.

### Gate 5: CC support contract

- Trigger one Loop in Support action in Telegram.
- In n8n, confirm payload includes:
  - `event_type: cc_support.requested`
  - `bridge_message` and `support_message`
  - threading fields
  - `idempotency_key`
- PASS if:
  - bridge + support sends run once,
  - support threading is preserved when headers exist,
  - no duplicate for same `idempotency_key`.

### Gate 6: Diagnostics health thresholds

- Review SQL diagnostics:
  - `queued_over_30m`
  - `dead_letters_7d`
  - `missing_thread_context_recent_7d`
  - n8n sent/failed/dead consistency counts
- PASS guidance:
  - `queued_over_30m = 0` (or justified backlog),
  - failed/dead rows have error metadata,
  - sent rows have `sent_at`,
  - recent thread-context gaps are low/stable (legacy may remain in older bucket).

### Final release decision

- READY only if all six gates are PASS.
- NOT READY if any gate FAILS; fix that gate and re-run from Gate 1.
