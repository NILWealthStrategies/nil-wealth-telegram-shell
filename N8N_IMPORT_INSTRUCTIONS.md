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
TELEGRAM_CHAT_ID = <your Telegram chat ID to receive notifications>
```

(Get SendGrid key from: https://app.sendgrid.com/settings/api_keys)
(Get Telegram Chat ID from: Send `/start` to @userinfobot in Telegram, it will show your Chat ID)

---

## Step 4: Connect SendGrid & Telegram

### SendGrid
1. In the workflow, click the **"Send Email via SendGrid"** node
2. In the credentials dropdown, select **+ Create New Credential**
3. Paste your SendGrid API key
4. Click **Save**

### Telegram
1. In the workflow, click the **"Notify Telegram - Success"** node
2. In the credentials dropdown, select **+ Create New Credential**
3. Paste your Telegram Bot Token (from @BotFather)
4. Click **Save**
5. Repeat for **"Notify Telegram - Error"** node

---

## Step 5: Run It

1. Click **"Test workflow"** (play button)
2. Should see:
   - ✅ Every 30 Seconds (triggers)
   - ✅ Claim Messages from Bot (gets list)
   - ✅ Loop Over Items (loops)
   - ✅ Send Email via SendGrid (sends)
   - ✅ Report Success to Bot (marks sent in DB)
   - ✅ Notify Telegram - Success (sends Telegram notification)

---

## Getting Telegram Credentials

### Telegram Bot Token
1. Open Telegram → Search for **@BotFather**
2. Send `/newbot`
3. Follow prompts to create a bot
4. Copy token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### Telegram Chat ID
1. Send `/start` to **@userinfobot** in Telegram
2. It will reply with your Chat ID (a number like `987654321`)
3. Copy this number into `TELEGRAM_CHAT_ID` env var

---

The workflow will now:
- Run every 30 seconds
- Claim pending emails from your bot
- Send them via SendGrid
- Tell bot they're sent
- Automatically retry if SendGrid fails

**No manual setup needed after this.**
