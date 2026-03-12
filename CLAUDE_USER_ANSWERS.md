## USER ANSWERS TO CLARIFYING QUESTIONS

1) **Dedup State Storage**: Option A — Supabase table `nil.processed_events`
2) **Smart Reply Drafter Context**: Option B — Use stored data only (faster, simpler)
3) **Error Alerts**: Option C — Both Telegram & email for critical failures

---

Now generate the **5 MVP workflow import JSONs** (production-ready, valid n8n format):

1. Instant Submission (webhook)
2. Send Webhook (webhook)
3. Gmail Support Monitor (cron)
4. Calendly Confirmation Relay (cron)
5. Smart Reply Drafter (cron)

For each, output:
- Full n8n import JSON (valid, with all nodes, error branches, logging)
- Workflow inventory row
- Webhook setup (production URL, test curl, env var location)
- Copy/paste setup checklist

Then generate the 6 remaining workflows (Phase-2) with the same structure.

Output everything in valid n8n JSON format ready to import.
