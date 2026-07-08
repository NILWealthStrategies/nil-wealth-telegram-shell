#!/bin/zsh
set -u

# Usage:
#   /bin/zsh scripts/check_n8n_api_auth.sh
#   N8N_BASE=https://your.n8n.cloud N8N_API_KEY=xxx /bin/zsh scripts/check_n8n_api_auth.sh
#   /bin/zsh scripts/check_n8n_api_auth.sh https://your.n8n.cloud xxx

N8N_BASE="${1:-${N8N_BASE:-https://nilwealthstrategies.app.n8n.cloud}}"
N8N_API_KEY_ARG="${2:-}"
N8N_API_KEY="${N8N_API_KEY_ARG:-${N8N_API_KEY:-}}"

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
DATE_BIN="$(find_bin date /bin/date /usr/bin/date)"
CAT_BIN="$(find_bin cat /bin/cat /usr/bin/cat)"
RM_BIN="$(find_bin rm /bin/rm /usr/bin/rm)"

if [[ -z "$CURL_BIN" || -z "$DATE_BIN" || -z "$CAT_BIN" || -z "$RM_BIN" ]]; then
  echo "Missing required tools (curl/date/cat/rm)."
  exit 1
fi

echo "n8n API Auth Check"
echo "Timestamp: $($DATE_BIN -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "N8N_BASE=$N8N_BASE"

tmp="/tmp/n8n_auth_check_$$"
code_health="$($CURL_BIN -sS -L --max-time 15 -o "$tmp" -w '%{http_code}' "$N8N_BASE/healthz" || true)"
body_health=""
if [[ -f "$tmp" ]]; then
  body_health="$($CAT_BIN "$tmp")"
  $RM_BIN -f "$tmp"
fi

echo "healthz: HTTP $code_health"
if [[ "$code_health" != "200" ]]; then
  echo "FAIL: n8n is not reachable/alive."
  exit 2
fi

if [[ -z "$N8N_API_KEY" ]]; then
  echo "WARN: No N8N_API_KEY provided. Only uptime checked."
  echo "Tip: pass key as env var or second arg to validate auth."
  exit 1
fi

code_auth="$($CURL_BIN -sS -L --max-time 20 -o "$tmp" -w '%{http_code}' -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_BASE/rest/workflows?limit=1" || true)"
body_auth=""
if [[ -f "$tmp" ]]; then
  body_auth="$($CAT_BIN "$tmp")"
  $RM_BIN -f "$tmp"
fi

echo "rest/workflows: HTTP $code_auth"

if [[ "$code_auth" == "200" ]]; then
  echo "PASS: n8n API key is valid for workflow reads."
  exit 0
fi

if [[ "$code_auth" == "401" || "$code_auth" == "403" ]]; then
  echo "FAIL: n8n API key invalid or lacks permission."
  exit 2
fi

echo "FAIL: unexpected response from n8n API."
echo "Body preview: ${body_auth[1,180]}"
exit 2
