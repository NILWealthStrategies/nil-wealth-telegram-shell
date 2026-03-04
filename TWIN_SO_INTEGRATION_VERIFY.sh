#!/bin/bash

# ============================================================================
# TWIN.SO INTEGRATION VERIFICATION SCRIPT
# ============================================================================
# Purpose: Validate that Twin.so has successfully integrated with the
#          Nil-Wealth Telegram Bot backend
#
# Usage: 
#   1. Set environment variables:
#      export BOT_URL="https://your-bot-domain.com"
#      export BOT_SECRET="your-base-webhook-secret"
#
#   2. Run this script:
#      bash TWIN_SO_INTEGRATION_VERIFY.sh
#
#   3. Check output for [PASS] or [FAIL] on each test
#      - All tests should show [PASS] before deploying to production
#
# Requirements:
#   - curl (for HTTP requests)
#   - jq (for JSON parsing)
#   - psql (for database queries, optional)
# ============================================================================

set -e

# Color codes for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# ============================================================================
# CONFIGURATION
# ============================================================================

BOT_URL="${BOT_URL:-http://localhost:3000}"
BOT_SECRET="${BOT_SECRET:-}"

# Database credentials (if you want to run DB tests)
DB_HOST="${SUPABASE_HOST:-}"
DB_USER="${SUPABASE_USER:-postgres}"
DB_PASS="${SUPABASE_PASSWORD:-}"
DB_NAME="${SUPABASE_DB:-postgres}"

TIMESTAMP=$(date +"%Y-%m-%dT%H:%M:%S.000Z")
SUBMISSION_ID=""
BATCH_ID=""
CLAIM_ID=""

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

log_test() {
  local test_name="$1"
  echo -e "\n${BLUE}▶ TEST: ${test_name}${NC}"
}

log_pass() {
  local message="$1"
  echo -e "${GREEN}[PASS]${NC} ${message}"
  ((TESTS_PASSED++))
}

log_fail() {
  local message="$1"
  echo -e "${RED}[FAIL]${NC} ${message}"
  ((TESTS_FAILED++))
}

log_info() {
  local message="$1"
  echo -e "${YELLOW}[INFO]${NC} ${message}"
}

check_requirements() {
  echo -e "\n${BLUE}=== CHECKING REQUIREMENTS ===${NC}"
  
  if ! command -v curl &> /dev/null; then
    log_fail "curl not found. Install: brew install curl"
    exit 1
  fi
  log_pass "curl found"
  
  if ! command -v jq &> /dev/null; then
    log_fail "jq not found. Install: brew install jq"
    exit 1
  fi
  log_pass "jq found"
  
  if [ -z "$BOT_URL" ]; then
    log_fail "BOT_URL not set. Set: export BOT_URL=https://..."
    exit 1
  fi
  log_pass "BOT_URL set: $BOT_URL"
  
  if [ -z "$BOT_SECRET" ]; then
    log_fail "BOT_SECRET not set. Set: export BOT_SECRET=..."
    exit 1
  fi
  log_pass "BOT_SECRET set: [redacted]"
}

test_http() {
  ((TESTS_RUN++))
  local method="$1"
  local endpoint="$2"
  local data="$3"
  local description="$4"
  
  log_test "$description"
  
  local url="${BOT_URL}${endpoint}"
  local response
  local http_code
  
  if [ -z "$data" ]; then
    response=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "x-nil-secret: $BOT_SECRET" \
      "$url")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -H "x-nil-secret: $BOT_SECRET" \
      -d "$data" \
      "$url")
  fi
  
  http_code=$(echo "$response" | tail -n 1)
  body=$(echo "$response" | sed '$d')
  
  echo "Response HTTP $http_code:"
  echo "$body" | jq '.' 2>/dev/null || echo "$body"
  
  echo "$http_code|$body"
}

# ============================================================================
# TEST SUITE
# ============================================================================

test_1_auth_rejection() {
  ((TESTS_RUN++))
  log_test "Authentication: Request without secret should fail"
  
  local response=$(curl -s -w "\n%{http_code}" -X GET \
    "http://localhost:3000/api/nil-outbox/claim?limit=1")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "401" ]; then
    log_pass "Correctly rejected request without x-nil-secret header"
  else
    log_fail "Expected HTTP 401, got $http_code (should reject missing secret)"
  fi
}

test_2_auth_acceptance() {
  ((TESTS_RUN++))
  log_test "Authentication: Request with correct secret should succeed"
  
  local response=$(curl -s -w "\n%{http_code}" -X GET \
    -H "x-nil-secret: $BOT_SECRET" \
    "${BOT_URL}/api/nil-outbox/claim?limit=1")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "200" ]; then
    log_pass "Correctly accepted request with valid secret"
  else
    log_fail "Expected HTTP 200, got $http_code"
  fi
}

test_3_submission_create() {
  ((TESTS_RUN++))
  log_test "Submission Intake: POST /api/submissions with valid lead"
  
  local idempotency_key=$(uuidgen | tr '[:upper:]' '[:lower:]')
  local payload=$(cat <<EOF
{
  "idempotency_key": "$idempotency_key",
  "first_name": "Test",
  "last_name": "Lead",
  "email": "test.lead.$((RANDOM))@example.com",
  "phone": "+14045551234",
  "state": "GA",
  "role": "parent",
  "coverage_accident": true,
  "coverage_hospital_indemnity": false
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/api/submissions")
  
  local http_code=$(echo "$response" | tail -n 1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    local ok=$(echo "$body" | jq -r '.ok' 2>/dev/null)
    if [ "$ok" = "true" ]; then
      SUBMISSION_ID=$(echo "$body" | jq -r '.submission_id' 2>/dev/null)
      log_pass "Submission created: $SUBMISSION_ID"
    else
      log_fail "Response not ok: $body"
    fi
  else
    log_fail "Expected HTTP 200, got $http_code: $body"
  fi
}

test_4_submission_duplicate() {
  ((TESTS_RUN++))
  log_test "Submission Intake: Duplicate idempotency_key should return 409"
  
  local payload=$(cat <<EOF
{
  "idempotency_key": "$SUBMISSION_ID",
  "first_name": "Duplicate",
  "last_name": "Test",
  "email": "duplicate@example.com",
  "phone": "+14045551235",
  "state": "FL",
  "role": "athlete",
  "coverage_accident": false,
  "coverage_hospital_indemnity": true
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/api/submissions")
  
  local http_code=$(echo "$response" | tail -n 1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "409" ]; then
    log_pass "Correctly rejected duplicate idempotency_key with HTTP 409"
  else
    # Some implementations might return 200 with existing_submission_id
    if [ "$http_code" = "200" ]; then
      local existing=$(echo "$body" | jq -r '.existing_submission_id' 2>/dev/null)
      if [ ! -z "$existing" ]; then
        log_pass "Returned existing submission instead (also acceptable): $existing"
      else
        log_fail "Expected 409 or existing_submission_id, got HTTP $http_code"
      fi
    else
      log_fail "Expected HTTP 409 or 200 with existing_submission_id, got $http_code"
    fi
  fi
}

test_5_submission_missing_field() {
  ((TESTS_RUN++))
  log_test "Submission Intake: Missing required field should return 400"
  
  local payload='{"first_name": "John"}'
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/api/submissions")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "400" ]; then
    log_pass "Correctly rejected incomplete submission with HTTP 400"
  else
    log_fail "Expected HTTP 400, got $http_code"
  fi
}

test_6_outbox_claim_empty() {
  ((TESTS_RUN++))
  log_test "Outbox Claim: GET /api/nil-outbox/claim (may return empty if processing)"
  
  local response=$(curl -s -w "\n%{http_code}" -X GET \
    -H "x-nil-secret: $BOT_SECRET" \
    "${BOT_URL}/api/nil-outbox/claim?limit=5")
  
  local http_code=$(echo "$response" | tail -n 1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    local count=$(echo "$body" | jq '.count' 2>/dev/null)
    log_pass "Claim endpoint returned HTTP 200 with $count items"
    
    if [ "$count" -gt 0 ]; then
      BATCH_ID=$(echo "$body" | jq -r '.batch_id' 2>/dev/null)
      CLAIM_ID=$(echo "$body" | jq -r '.items[0].claim_id' 2>/dev/null)
      log_info "Got batch_id=$BATCH_ID, claim_id=$CLAIM_ID"
    fi
  else
    log_fail "Expected HTTP 200, got $http_code"
  fi
}

test_7_outbox_result() {
  ((TESTS_RUN++))
  log_test "Outbox Result: POST /api/nil-outbox/result with mock batch"
  
  if [ -z "$BATCH_ID" ] || [ "$BATCH_ID" = "null" ]; then
    log_info "Skipping (no batch_id from claim test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "results": [
    {
      "claim_id": "$CLAIM_ID",
      "submission_id": "$SUBMISSION_ID",
      "status": "completed",
      "result": {
        "workflow_executed": "Test Workflow",
        "email_sent": true,
        "note": "Integration test submission"
      }
    }
  ]
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/api/nil-outbox/result/${BATCH_ID}")
  
  local http_code=$(echo "$response" | tail -n 1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    log_pass "Result accepted (HTTP 200)"
  else
    log_fail "Expected HTTP 200, got $http_code: $body"
  fi
}

test_8_event_webhook_email() {
  ((TESTS_RUN++))
  log_test "Event Webhook: POST /ops/ingest with email.sent event"
  
  if [ -z "$SUBMISSION_ID" ]; then
    log_info "Skipping (no submission_id from earlier test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "event_type": "outbox.email.sent",
  "submission_id": "$SUBMISSION_ID",
  "timestamp": "$TIMESTAMP",
  "metadata": {
    "email": "test@example.com",
    "subject": "Your coverage options",
    "body": "Here are your options..."
  }
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/ops/ingest")
  
  local http_code=$(echo "$response" | tail -n 1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    log_pass "Event accepted (HTTP 200)"
  else
    log_fail "Expected HTTP 200, got $http_code: $body"
  fi
}

test_9_event_webhook_call() {
  ((TESTS_RUN++))
  log_test "Event Webhook: POST /ops/ingest with call.attempted event"
  
  if [ -z "$SUBMISSION_ID" ]; then
    log_info "Skipping (no submission_id from earlier test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "event_type": "call.attempted",
  "submission_id": "$SUBMISSION_ID",
  "timestamp": "$TIMESTAMP",
  "metadata": {
    "phone": "+14045551234",
    "outcome": "answered",
    "duration_seconds": 300
  }
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/ops/ingest")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "200" ]; then
    log_pass "Call event accepted (HTTP 200)"
  else
    log_fail "Expected HTTP 200, got $http_code"
  fi
}

test_10_event_webhook_reply() {
  ((TESTS_RUN++))
  log_test "Event Webhook: POST /ops/ingest with submission.replied event"
  
  if [ -z "$SUBMISSION_ID" ]; then
    log_info "Skipping (no submission_id from earlier test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "event_type": "submission.replied",
  "submission_id": "$SUBMISSION_ID",
  "timestamp": "$TIMESTAMP",
  "metadata": {
    "reply_from": "test@example.com",
    "body": "Yes, I'm interested!"
  }
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/ops/ingest")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "200" ]; then
    log_pass "Reply event accepted (HTTP 200)"
  else
    log_fail "Expected HTTP 200, got $http_code"
  fi
}

test_11_metric_webhook() {
  ((TESTS_RUN++))
  log_test "Metric Webhook: POST /webhook/metric with enroll_click"
  
  if [ -z "$SUBMISSION_ID" ]; then
    log_info "Skipping (no submission_id from earlier test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "event_type": "metric.enroll_click",
  "submission_id": "$SUBMISSION_ID",
  "timestamp": "$TIMESTAMP",
  "metric_type": "enroll_click"
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/webhook/metric")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "200" ]; then
    log_pass "Metric event accepted (HTTP 200)"
  else
    log_fail "Expected HTTP 200, got $http_code"
  fi
}

test_12_invalid_event_type() {
  ((TESTS_RUN++))
  log_test "Event Webhook: Invalid event_type should return 400"
  
  if [ -z "$SUBMISSION_ID" ]; then
    log_info "Skipping (no submission_id from earlier test)"
    return
  fi
  
  local payload=$(cat <<EOF
{
  "event_type": "invalid.event.type",
  "submission_id": "$SUBMISSION_ID",
  "timestamp": "$TIMESTAMP"
}
EOF
  )
  
  local response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "x-nil-secret: $BOT_SECRET" \
    -d "$payload" \
    "${BOT_URL}/ops/ingest")
  
  local http_code=$(echo "$response" | tail -n 1)
  
  if [ "$http_code" = "400" ]; then
    log_pass "Correctly rejected invalid event_type with HTTP 400"
  else
    log_fail "Expected HTTP 400, got $http_code"
  fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
  echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║        TWIN.SO INTEGRATION VERIFICATION TEST SUITE              ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  check_requirements
  
  echo -e "\n${BLUE}=== RUNNING INTEGRATION TESTS ===${NC}"
  
  test_1_auth_rejection
  test_2_auth_acceptance
  test_3_submission_create
  test_4_submission_duplicate
  test_5_submission_missing_field
  test_6_outbox_claim_empty
  test_7_outbox_result
  test_8_event_webhook_email
  test_9_event_webhook_call
  test_10_event_webhook_reply
  test_11_metric_webhook
  test_12_invalid_event_type
  
  # Summary
  echo -e "\n${BLUE}=== TEST SUMMARY ===${NC}"
  echo "Total tests run: $TESTS_RUN"
  echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
  echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
  
  if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "\n${GREEN}✓ ALL TESTS PASSED - Ready for production${NC}\n"
    exit 0
  else
    echo -e "\n${RED}✗ FAILURES DETECTED - Review logs above${NC}\n"
    exit 1
  fi
}

main "$@"
