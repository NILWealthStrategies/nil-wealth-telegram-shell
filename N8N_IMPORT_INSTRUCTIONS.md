# N8N: Copy & Paste Workflow Import

## Step 1: Get the JSON
Copy this entire JSON file content: [n8n-workflow-export.json](n8n-workflow-export.json)

Easiest: Open in raw view and copy all text.

---

## Step 2: Import into n8n

1. Go to **n8n.io** → **Workflows**
2. Click **"Create new" → "Import from file"** (or paste)
3. Paste the JSON from above
4. Click **"Import"**

---

## Step 3: Set Environment Variables

1. In n8n, click **Settings** (bottom left) → **Environment**
2. Add these variables:

```
NIL_SECRET = <your-SECRET from .env file>
SENDGRID_API_KEY = <your SendGrid API key>
```

(Get SendGrid key from: https://app.sendgrid.com/settings/api_keys)

---

## Step 4: Connect SendGrid

1. In the workflow, click the **"Send Email via SendGrid"** node
2. In the credentials dropdown, select **+ Create New Credential**
3. Paste your SendGrid API key
4. Click **Save**

---

## Step 5: Run It

1. Click **"Test workflow"** (play button)
2. Should see:
   - ✅ Every 30 Seconds (triggers)
   - ✅ Claim Messages from Bot (gets list)
   - ✅ Loop Over Items (loops)
   - ✅ Send Email via SendGrid (sends)
   - ✅ Report Success to Bot (marks sent in DB)

---

## Done!

The workflow will now:
- Run every 30 seconds
- Claim pending emails from your bot
- Send them via SendGrid
- Tell bot they're sent
- Automatically retry if SendGrid fails

**No manual setup needed after this.**
