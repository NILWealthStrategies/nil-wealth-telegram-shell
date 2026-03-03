# N8N Workflow Setup - Simple

## Goal
**n8n claims emails/SMS from outbox queue → sends them → reports back to bot API**

Using: `https://nil-ops-bot.render.com` (the Express bot)

---

## Workflow: 4 Simple Steps

### Step 1: Trigger (Schedule)
- **Node Type**: Cron
- **Expression**: `*/30 * * * * *` (every 30 seconds)

---

### Step 2: Claim Messages
- **Node Type**: HTTP Request
- **Method**: GET
- **URL**: `https://nil-ops-bot.render.com/api/nil-outbox/claim?limit=10`
- **Headers Tab**:
  - Key: `x-nil-secret`
  - Value: `{{ $env.NIL_SECRET }}`
- **Authentication**: None
- **Response Format**: JSON

**Output**: List of emails/SMS to send

---

### Step 3: Send (Loop)
- **Node Type**: Loop Over Items
- **Input**: `{{ steps.step2.data.items }}`

**Inside the loop - Add ONE of these:**

#### Option A: SendGrid (Email)
- **Node Type**: SendGrid
- **To**: `{{ $item.payload.client.email }}`
- **Subject**: `Coverage Options for {{ $item.payload.client.first_name }}`
- **HTML**: 
```html
<p>Hi {{ $item.payload.client.first_name }},</p>
<p>Your coverage options are ready.</p>
```
- **API Key**: `{{ $env.SENDGRID_API_KEY }}`

#### Option B: Twilio (SMS)
- **Node Type**: Twilio
- **To**: `{{ $item.payload.client.phone }}`
- **Body**: `Hi {{ $item.payload.client.first_name }}, your coverage options are ready.`
- **Account SID**: `{{ $env.TWILIO_ACCOUNT_SID }}`
- **Auth Token**: `{{ $env.TWILIO_AUTH_TOKEN }}`
- **From**: `{{ $env.TWILIO_FROM_NUMBER }}`

---

### Step 4: Report Result Back
- **Node Type**: HTTP Request
- **Method**: POST
- **URL**: `https://nil-ops-bot.render.com/api/nil-outbox/result`
- **Headers Tab**:
  - Key: `x-nil-secret`
  - Value: `{{ $env.NIL_SECRET }}`
  - Key: `Content-Type`
  - Value: `application/json`
- **Body** (JSON):
```json
{
  "submission_id": "{{ $item.submission_id }}",
  "status": "sent",
  "last_error": null
}
```

**If SendGrid/Twilio fails**, catch error:
```json
{
  "submission_id": "{{ $item.submission_id }}",
  "status": "failed",
  "last_error": "{{ $error.message }}"
}
```

---

## N8N Environment Variables

Go to **Settings** → **Environment** → Add:

```
NIL_SECRET = <your-BASE_WEBHOOK_SECRET>
SENDGRID_API_KEY = <your-sendgrid-key>
TWILIO_ACCOUNT_SID = <your-twilio-sid>
TWILIO_AUTH_TOKEN = <your-twilio-token>
TWILIO_FROM_NUMBER = <your-twilio-phone>
```

---

## Test It

1. **Create a test submission** via `POST /api/submissions`:
```bash
curl -X POST https://nil-ops-bot.render.com/api/submissions \
  -H "x-nil-secret: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "phone": "+14045551234",
    "state": "GA",
    "role": "parent",
    "coverage_accident": true,
    "coverage_hospital_indemnity": false
  }'
```

2. **Manually trigger n8n workflow** (play button)

3. **Check n8n execution logs** - should see:
   - ✅ GET /claim returned items
   - ✅ SendGrid/Twilio sent
   - ✅ POST /result returned `ok: true`

---

## Workflow JSON (Copy/Paste into n8n)

If you want to import directly, here's the JSON structure:

```json
{
  "nodes": [
    {
      "parameters": {
        "expression": "0 */5 * * * *"
      },
      "name": "Trigger (Every 5 min)",
      "type": "n8n-nodes-base.cron",
      "typeVersion": 1,
      "position": [250, 300]
    },
    {
      "parameters": {
        "url": "https://nil-ops-bot.render.com/api/nil-outbox/claim?limit=10",
        "method": "GET",
        "headers": {
          "x-nil-secret": "={{ $env.NIL_SECRET }}"
        },
        "responseFormat": "json"
      },
      "name": "Claim Messages",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.1,
      "position": [450, 300]
    },
    {
      "parameters": {
        "loopOver": "={{ steps.step2.data.items }}"
      },
      "name": "Loop Over Items",
      "type": "n8n-nodes-base.loop",
      "typeVersion": 1,
      "position": [650, 300]
    },
    {
      "parameters": {
        "url": "https://nil-ops-bot.render.com/api/nil-outbox/result",
        "method": "POST",
        "headers": {
          "x-nil-secret": "={{ $env.NIL_SECRET }}",
          "Content-Type": "application/json"
        },
        "bodyParametersJson": "={\n  \"submission_id\": \"{{ $item.submission_id }}\",\n  \"status\": \"sent\",\n  \"last_error\": null\n}",
        "responseFormat": "json"
      },
      "name": "Report Result",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.1,
      "position": [850, 300]
    }
  ],
  "connections": {
    "Trigger (Every 5 min)": {
      "main": [
        [
          {
            "node": "Claim Messages",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Claim Messages": {
      "main": [
        [
          {
            "node": "Loop Over Items",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Loop Over Items": {
      "main": [
        [
          {
            "node": "Report Result",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```

---

## Done!

That's it. Every 30 seconds:
1. n8n asks bot: "Any emails to send?"
2. Bot returns queued messages
3. n8n sends them via SendGrid/Twilio
4. n8n tells bot: "Sent ✅"
5. Bot updates database

**No complexity. Just HTTP requests.**
