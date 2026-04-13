# WF02/WF03 Integration Verification & Real-Message Testing

**Last Updated:** April 13, 2026  
**Commit:** c09fe82  
**Status:** ✅ 31/31 Scenario Tests Passing

---

## INTEGRATION ARCHITECTURE

### Actual Message Flow (Not Theoretical)

```
┌─────────────────────────────────────────────────────────────┐
│  INCOMING MESSAGE                                           │
│  (Gmail, Telegram, Website Form)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  WF02 — Gmail Support Watch                                 │
│                                                             │
│  1. Polls Gmail inbox                                        │
│  2. Deduplicates by thread/message ID                        │
│  3. Stores in Supabase conversations table                   │
│  4. Marks as inbound message                                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  TELEGRAM BOT (index.js)                                    │
│                                                             │
│  - Admin views conversation card in `/DASH`                 │
│  - Clicks "📋 View Latest Inbound"                           │
│  - Bot renders conversation with action buttons             │
│  - Admin clicks "✍️ Generate Drafts"                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  DRAFT GENERATION (index.js)                                │
│                                                             │
│  Function: generateConversationDrafts(conv)                 │
│  - Fetches recent thread context (last 6 messages)          │
│  - Calls OpenAI with systemPrompt + userPrompt              │
│  - Applies system prompt based on source (support/programs) │
│  - Applies diversity requirement (V1/V2/V3 unique)          │
│  - Stores 3 drafts in conversations_drafts table            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  DRAFT SELECTION & REVIEW (Telegram Bot)                    │
│                                                             │
│  - Admin views V1/V2/V3 side-by-side                        │
│  - Can edit selected draft before sending                   │
│  - Can regenerate if not satisfied                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  SEND ACTION (index.js → Outbox)                            │
│                                                             │
│  - Admin clicks "Send"                                      │
│  - Validates payload against schema                         │
│  - Posts to nil-outbox with send request                    │
│  - Marks conversation as "replied"                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  WF03 — Send Executor + CC Support                          │
│                                                             │
│  1. Polls outbox for pending sends                          │
│  2. Generates CC drafts if cc_support=true                  │
│  3. Sends bridge to coach (if applicable)                   │
│  4. Enqueues parent-forward for coach relay                 │
│  5. Updates outbox with send status                         │
└──────────────────────────────────────────────────────────────┘
```

---

## WF02 VERIFICATION CHECKLIST

### ✅ Configuration & Setup
- [ ] Gmail inbox is configured with OAuth credentials
- [ ] Webhook URL for WF02 is active and responding
- [ ] Supabase connection configured in n8n
- [ ] Table: `nil.conversations` exists
- [ ] Table: `nil.messages` exists

### ✅ Inbound Message Capture
Test with a real Gmail to the monitored inbox:

```bash
# Send test email to monitored Gmail
# Subject: "Test Coach Question"
# Body: "Hey, wanted to ask about your program"

# Verify in Supabase:
SELECT * FROM nil.conversations 
WHERE contact_email = 'test@example.com' 
ORDER BY created_at DESC LIMIT 1;

SELECT * FROM nil.messages 
WHERE conversation_id = '<id>' 
ORDER BY created_at DESC LIMIT 1;
```

### ✅ Thread Deduplication
- Message should appear in one conversation only
- If same email thread continues, messages should append
- `thread_key` should match across all messages in thread

### ✅ Metadata Extraction
Verify the following are correctly extracted:
- `contact_email` ✓
- `coach_name` ✓
- `subject` ✓
- `preview` ✓
- `source` (support/programs/other) ✓
- `direction` (inbound) ✓
- `created_at` ✓

---

## DRAFT GENERATION VERIFICATION CHECKLIST

### ✅ Real-Message Testing Protocol

#### Test 1: Support Email (Parent Question)
1. Send real email: "Is this supplemental coverage optional?"
2. Wait for WF02 to ingest (typically < 60 seconds)
3. Open admin dashboard in Telegram bot
4. Find conversation and click "Generate Drafts"
5. Verify all 3 drafts appear in V1/V2/V3

**Expected Outcomes:**
- V1: Direct answer first, then rationale, then next step
- V2: Empathy/acknowledgment first, then answer
- V3: Lead with what matters, then mechanics
- **CRITICAL:** Zero sentence repetition across V1/V2/V3
- All 3 are > 100 words, < 300 words

#### Test 2: Coach Follow-Up (Programs)
1. Send email as coach: "What does this look like for a group of 50+?"
2. Wait for ingest
3. Click "Generate Drafts"
4. Verify all 3 include intro facts:
   - Financial risk + NIL tax education
   - Former D1 + three surgeries
   - High school family gap context

**Expected Outcomes:**
- All 3 have same intro meaning, completely different wording
- V1: Short sentences, direct
- V2: Medium sentences, relationship-focused
- V3: Mix of sentence lengths, complete
- No sentence overlap

#### Test 3: Objection/Resistance
1. Send email: "We already have insurance and don't need this"
2. Generate drafts
3. Verify V1/V2/V3 all acknowledge objection

**Expected Outcomes:**
- Opening line acknowledges concern in all 3
- V2 has soft, warm tone
- V3 has practical/solution-focused tone
- All explain gap-fill without pressure
- Door left open for questions

---

## PROMPT ACCURACY VERIFICATION

### System Prompt Check

In `src/index.js`, line ~8488:
```javascript
const programsSystemPrompt = "You write thorough, human outreach replies...";
const supportSystemPrompt = "You write thorough, structured support replies...";
```

✅ **Verification Commands:**
```bash
# Check programsSystemPrompt matches expected
grep -A 3 'const programsSystemPrompt' src/index.js | head -1

# Check supportSystemPrompt matches expected
grep -A 3 'const supportSystemPrompt' src/index.js | head -1

# Verify no corruption
npm run test:scenarios
```

### User Prompt Check

Verify the User Prompt contains all HARD rules:
- [ ] HARD UNIQUENESS RULE present
- [ ] DIVERSITY REQUIREMENT present (V1/V2/V3 different angles)
- [ ] HARD VOCABULARY RULE present
- [ ] HARD SCOPE RULE present
- [ ] HARD TEMPLATE RULE (for CC) present
- [ ] All tone/style requirements included

```bash
# Count occurrences of HARD rules in Programs prompt
grep -c 'HARD.*RULE' src/index.js
# Expected: 8+

# Verify diversity requirement is in support prompt
grep 'DIVERSITY REQUIREMENT.*V1.*V2.*V3' src/index.js | wc -l
# Expected: 1
```

---

## REAL-DATA TESTING SCENARIOS

### Runbook: Test Suite Execution

**Setup:**
```bash
# 1. Ensure test emails are ready
export TEST_COACH_EMAIL="testcoach@example.com"
export TEST_PARENT_EMAIL="testparent@example.com"
export TEST_OBJECTION_EMAIL="testobject@example.com"

# 2. Prepare test inboxes
# (Manually forward to: support@nilwealth.com)

# 3. Run scenario harness
npm run test:scenarios

# Expected: 31/31 passing
```

**Verification:**
- [ ] All 31 scenario checks pass
- [ ] No timeout errors from OpenAI API
- [ ] `DIVERSITY REQUIREMENT` message in output indicates diversity enforced
- [ ] No repetition flags in output
- [ ] All versions (V1/V2/V3) generated for each scenario

---

## WF03 CC & SEND VERIFICATION

### Bridge + Support Generation Flow

1. **Setup:** Retrieve a conversation with `source = 'programs'`
2. **Call:** Invoke `generateCCDrafts(conv)`
3. **Verify Output:**
   - Bridge drafts (V1/V2/V3) generated ✓
   - Support drafts (V1/V2/V3) generated ✓
   - Each has subject + body ✓

### Bridge Drafts Checklist
- [ ] V1 is short/direct ("Looping in...")
- [ ] V2 is warm/personal (relationship tone)
- [ ] V3 is ultra-brief (executive style)
- [ ] Each explicitly states note is forwardable
- [ ] Coach name NOT repeated in body

### Support Drafts Checklist  
- [ ] V1 follows exact template structure
- [ ] V2 is warm variation of V1
- [ ] V3 is organized variation of V1
- [ ] All required elements present in each:
  - [ ] Context opener
  - [ ] Program description (supplemental + risk + tax)
  - [ ] Role clarity (coaches don't enroll, etc.)
  - [ ] Links to guides
  - [ ] Response line (parents can reply with questions)
  - [ ] Aflac credibility line
  - [ ] Final signature: "Best regards, The NIL Wealth Strategies Team"
  - [ ] NO extra lines after signature
- [ ] Zero sentence repetition across V1/V2/V3

---

## PRODUCTION HEALTH MONITORING

### Daily Checklist

```bash
# 1. Check WF02 ingest rate
curl -s https://your-n8n-instance/api/executions \
  -H "Authorization: Bearer $N8N_API_KEY" \
  -H "X-N8N-ACTIVE-WORKFLOW: wf-gmail-support-watch" \
  | jq '.recent_runs | length'
# Expected: > 0 in last 24 hours

# 2. Check draft generation success rate
sqlite3 production.db "SELECT COUNT(*) as success FROM conversation_drafts WHERE created_at > datetime('now', '-1 day');"

# 3. Run scenario tests
npm run test:scenarios
# Expected: 31/31 always

# 4. Check error logs for OpenAI failures
grep -i "openai error\|api.*failed" logs/*.log | tail -20
```

### Weekly Audit

```bash
# 1. Verify prompt versions match repo
git log --oneline src/index.js | head -1

# 2. Check template compliance
sqlite3 production.db "SELECT * FROM conversation_drafts WHERE created_at > datetime('now', '-7 days') AND body LIKE '%Best regards, The NIL Wealth%' LIMIT 10;"

# 3. Verify no prompt injection attempts
grep -r "ignore.*instruction\|disregard.*prompt" conversations_*.log
```

---

## REAL-MESSAGE DATA FLOW EXAMPLES

### Example 1: Inbound Parent Question Flow

```
GMAIL → "Is coverage optional?"
  │
  └─→ WF02 ingests
      │
      └─→ Supabase: { contact_email: parent@gmail.com, source: support, body: "Is coverage optional?" }
          │
          └─→ Telegram Bot: Shows conversation
              │
              └─→ Admin clicks "Generate Drafts"
                  │
                  └─→ generateConversationDrafts(conv) called
                      │
                      ├─→ Recent context: [ inbound: "Is coverage optional?" ]
                      │
                      ├─→ System Prompt #2 (support)
                      │
                      ├─→ User Prompt: "Create 3 reply drafts..."
                      │
                      └─→ OpenAI Response (JSON):
                          {
                            "v1": { "subject": "Supplemental Coverage Explained", "body": "...direct answer..." },
                            "v2": { "subject": "Your Insurance Questions", "body": "...empathetic answer..." },
                            "v3": { "subject": "Understanding Your Options", "body": "...organized answer..." }
                          }
                      
                      └─→ Drafts stored in Supabase converstion_drafts
                          │
                          └─→ Admin reviews in Telegram
                              │
                              └─→ Clicks "Send (Support)"
                                  │
                                  └─→ Validates: subject + body + email valid ✓
                                      │
                                      └─→ POST to nil-outbox
                                          │
                                          └─→ WF03 polls outbox
                                              │
                                              └─→ Sends via Instantly API
                                                  │
                                                  └─→ Parent receives email
```

### Example 2: Coach Follow-Up with CC Flow

```
TELEGRAM → Coach says: "Can we loop in our assistant athletic director?"
  │
  └─→ generateCCDrafts(conv) called
      │
      ├─→ System Prompt #3 (CC)
      │
      ├─→ Generates bridge (V1/V2/V3)
      │   └─→ Bridge: tells coach what they'll forward
      │
      └─→ Generates support (V1/V2/V3)
          └─→ Support: what assistant athletic director receives
              
              └─→ Admin selects: Bridge V2 + Support V1
                  │
                  └─→ Admin clicks "Send (With CC Support)"
                      │
                      ├─→ Bridge sent to coach immediately
                      │   └─→ Coach receives: "Here's what we'll send to families..."
                      │
                      └─→ Support enqueued for coach relay
                          └─→ Coach forwards to athletic director / parent group
                              └─→ Parent group receives: "Dear parents, We're sharing this..."
```

---

## TROUBLESHOOTING REAL-WORLD ISSUES

### Issue: Draft Generation Timeout

**Symptom:** "⏳ Generating drafts, please wait..." stays longer than 30 seconds

**Root Cause:** Likely OpenAI API delay or token limit hit

**Fix:**
1. Check OpenAI API status
2. Verify `OPENAI_API_KEY` is valid
3. Check `recent_thread_context` is not too long
4. Try regenerating with recent context only (last 3 messages)

**Verification:**
```bash
# Test OpenAI directly
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json"
# Should return list of models
```

### Issue: Drafts Look Generic/Template-Like

**Symptom:** V1, V2, V3 all look very similar

**Root Cause:** Diversity requirement not enforced by model

**Fix:**
1. Verify DIVERSITY REQUIREMENT in user prompt
2. Check temperature is high enough (0.95 for programs, 0.7 for support)
3. Try regenerating
4. If consistent, increase temperature to 1.0

**Verification:**
```bash
# Check temperature in code
grep "temperature.*isPrograms" src/index.js
# Expected: "temperature: isPrograms ? 0.95 : 0.7"
```

### Issue: Support Drafts Missing Required Links

**Symptom:** Parent guide or website link missing from draft

**Root Cause:** `parentGuideLinkForConversation()` or `officialWebsiteLinkForConversation()` returned null

**Fix:**
1. Verify conversation has required metadata
2. Check Supabase has valid link configurations
3. Ensure `ensureAflacOption3()` is being called

**Verification:**
```javascript
// In Telegram bot debug:
const conv = await sbGetConversationById(convId);
console.log("Parent Guide:", parentGuideLinkForConversation(conv));
console.log("Official Website:", officialWebsiteLinkForConversation(conv));
```

---

## NEXT STEPS FOR VERIFICATION

1. **Execute Real-Message Tests**
   - [ ] Send 3 test emails (support question, coach follow-up, objection)
   - [ ] Verify WF02 ingests each within 60 seconds
   - [ ] Generate drafts for each
   - [ ] Verify diversity in V1/V2/V3
   - [ ] Send one draft and confirm delivery

2. **Validate End-to-End Flow**
   - [ ] Track 5 real conversations through full pipeline
   - [ ] Document any prompt variations needed
   - [ ] Capture screenshots of excellent draft examples
   - [ ] Identify any prompt improvements for next iteration

3. **Monitor Production**
   - [ ] Set up alerting for WF02 failures
   - [ ] Monitor OpenAI costs/usage
   - [ ] Track draft regeneration rate
   - [ ] Document response times (target: < 20 seconds)

---

*Last Verified: April 13, 2026 | Commit: c09fe82*
