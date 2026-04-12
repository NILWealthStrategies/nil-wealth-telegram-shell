# Support Knowledge Auto Sync

This repo now includes an automatic sync runner for support knowledge updates.

## What It Does

Each sync cycle:
1. Republishes live WF02 + WF03 support prompt knowledge from local JSON files.
2. Optionally applies Supabase SQL seeds for both support knowledge tables.

The runner uses:
- `scripts/patch_wf02_wf03_support_knowledge_live.js`
- `sql/support_knowledge_base_seed.sql`
- `sql/support_knowledge_faq_seed.sql`

## Commands

- One-time sync:

```bash
npm run support:autosync:once
```

- Continuous scheduled sync:

```bash
npm run support:autosync
```

## Environment Variables

- `N8N_API_KEY`
  - Required to patch live n8n workflows unless fallback key is present in local patch script.

- `N8N_BASE_URL`
  - Optional. Defaults to `https://nilwealthstrategies.app.n8n.cloud`.

- `SUPPORT_SYNC_CRON`
  - Optional cron expression. Default is every 6 hours:
  - `0 */6 * * *`

- `SUPPORT_SYNC_RUN_ON_START`
  - Optional (`true` or `false`). Default `true`.
  - When true, runs one sync immediately when process starts.

- `SUPABASE_DB_URL`
  - Optional Postgres connection string.
  - If set and `psql` exists, both support SQL seeds are applied each cycle.

## Examples

Run every 2 hours:

```bash
SUPPORT_SYNC_CRON="0 */2 * * *" npm run support:autosync
```

Run every day at 2:15 AM UTC:

```bash
SUPPORT_SYNC_CRON="15 2 * * *" npm run support:autosync
```

Skip immediate run at startup:

```bash
SUPPORT_SYNC_RUN_ON_START=false npm run support:autosync
```

Apply DB seeds automatically each cycle:

```bash
SUPABASE_DB_URL="postgresql://..." npm run support:autosync
```

## Recommended Deployment Pattern

Run `npm run support:autosync` as a separate always-on worker process so it stays active and executes on schedule.
