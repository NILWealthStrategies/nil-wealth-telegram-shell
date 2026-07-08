#!/bin/zsh
set -u

BOT_BASE="${BOT_BASE:-https://nil-wealth-telegram-shell.onrender.com}"
N8N_BASE="${N8N_BASE:-https://nilwealthstrategies.app.n8n.cloud}"
CF_BASE="${CF_BASE:-https://access.mynilwealthstrategies.com}"
STRICT_WARN="${STRICT_WARN:-false}"
N8N_API_KEY="${N8N_API_KEY:-}"

find_bin() {
  local name="$1"
  shift
  local detected
  detected="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$detected" ]]; then
    echo "$detected"
    return 0
  fi
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo ""
}

CURL_BIN="$(find_bin curl /usr/bin/curl /opt/homebrew/bin/curl)"
SED_BIN="$(find_bin sed /usr/bin/sed /opt/homebrew/bin/sed)"
GREP_BIN="$(find_bin grep /usr/bin/grep /opt/homebrew/bin/grep)"
DATE_BIN="$(find_bin date /bin/date /usr/bin/date)"
CAT_BIN="$(find_bin cat /bin/cat /usr/bin/cat)"
RM_BIN="$(find_bin rm /bin/rm /usr/bin/rm)"
CUT_BIN="$(find_bin cut /usr/bin/cut /opt/homebrew/bin/cut)"

if [[ -z "$CURL_BIN" || -z "$SED_BIN" || -z "$GREP_BIN" || -z "$DATE_BIN" || -z "$CAT_BIN" || -z "$RM_BIN" || -z "$CUT_BIN" ]]; then
  echo "Missing required tools (curl/sed/grep/date/cat/rm/cut)."
  exit 1
fi

pass_count=0
warn_count=0
fail_count=0

check_url() {
  local label="$1"
  local url="$2"
  local expect_regex="$3"

  local tmp="/tmp/quick_audit_$$"
  local code
  code="$($CURL_BIN -sS -L --max-time 15 -o "$tmp" -w '%{http_code}' "$url" || true)"
  local body=""
  if [[ -f "$tmp" ]]; then
    body="$($CAT_BIN "$tmp")"
    $RM_BIN -f "$tmp"
  fi

  if [[ "$code" == "200" && ( -z "$expect_regex" || "$body" =~ $expect_regex ) ]]; then
    echo "PASS  $label ($code)"
    pass_count=$((pass_count + 1))
    return 0
  fi

  if [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "WARN  $label ($code) auth required"
    warn_count=$((warn_count + 1))
    return 0
  fi

  local preview
  preview="$(echo "$body" | $SED_BIN -E 's/[[:space:]]+/ /g' | $SED_BIN -n '1p' | $CUT_BIN -c1-120)"
  echo "FAIL  $label ($code) ${preview}"
  fail_count=$((fail_count + 1))
  return 0
}

echo "Quick Stack Audit"
echo "Timestamp: $($DATE_BIN -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "BOT_BASE=$BOT_BASE"
echo "N8N_BASE=$N8N_BASE"
echo "CF_BASE=$CF_BASE"
echo "---"

check_url "Bot /health" "$BOT_BASE/health" '"ok":true'
check_url "Bot /ready" "$BOT_BASE/ready" '"ok":true'
check_url "Bot /ready/firm" "$BOT_BASE/ready/firm" '"ok":true'
check_url "n8n /healthz" "$N8N_BASE/healthz" '"status":"ok"'
if [[ -n "$N8N_API_KEY" ]]; then
  tmp="/tmp/quick_audit_n8n_$$"
  code="$($CURL_BIN -sS -L --max-time 15 -o "$tmp" -w '%{http_code}' -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_BASE/rest/workflows?limit=1" || true)"
  body=""
  if [[ -f "$tmp" ]]; then
    body="$($CAT_BIN "$tmp")"
    $RM_BIN -f "$tmp"
  fi
  if [[ "$code" == "200" ]]; then
    echo "PASS  n8n /rest/workflows auth ($code)"
    pass_count=$((pass_count + 1))
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "WARN  n8n /rest/workflows auth ($code) key invalid/insufficient"
    warn_count=$((warn_count + 1))
  else
    preview="$(echo "$body" | $SED_BIN -E 's/[[:space:]]+/ /g' | $SED_BIN -n '1p' | $CUT_BIN -c1-120)"
    echo "FAIL  n8n /rest/workflows auth ($code) ${preview}"
    fail_count=$((fail_count + 1))
  fi
else
  check_url "n8n /rest/workflows" "$N8N_BASE/rest/workflows" ''
fi
check_url "Cloudflare /parent-guide" "$CF_BASE/parent-guide" ''
check_url "Cloudflare /supplemental-health-guide" "$CF_BASE/supplemental-health-guide" ''
check_url "Cloudflare /risk-awareness-guide" "$CF_BASE/risk-awareness-guide" ''
check_url "Cloudflare /tax-education-guide" "$CF_BASE/tax-education-guide" ''
check_url "Cloudflare /website" "$CF_BASE/website" ''

echo "---"
echo "Summary: PASS=$pass_count WARN=$warn_count FAIL=$fail_count"
echo "Exit semantics: 0=all clear (or warnings allowed), 1=warnings with STRICT_WARN=true, 2=hard failure"

if (( fail_count > 0 )); then
  exit 2
fi

if (( warn_count > 0 )); then
  if [[ "$STRICT_WARN" == "true" ]]; then
    exit 1
  fi
  exit 0
fi

exit 0
