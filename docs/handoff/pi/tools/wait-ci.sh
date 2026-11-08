#!/usr/bin/env bash
# Wait for a PR's required CI checks: poll every 3 minutes for up to 60 minutes.
#
#   wait-ci.sh <pr> [head-sha]
#
# Exit 0 when every required check passed (or was skipped), 1 as soon as one failed or was
# cancelled, 2 when some were still pending at the deadline. The last line is the required checks
# as JSON (name, bucket, link). No checks yet (CI not started) counts as pending, and so does a PR
# whose head is not yet head-sha (GitHub can report the previous push's checks for a moment).
set -u
pr="${1:?usage: wait-ci.sh <pr> [head-sha]}"
want="${2:-}"
interval="${WAIT_CI_INTERVAL:-180}"
max="${WAIT_CI_MAX:-3600}"
waited=0
# The E2E aggregate check only appears after its legs finish, so wait for every required name.
REQUIRED='["Lint & type-check","Unit & integration tests","Build (Vercel + Node) & budgets","E2E (iPhone viewport · Chromium + WebKit)","Lighthouse (mobile)"]'
while :; do
  json=$(gh pr checks "$pr" -R TheCruzControll/performance-coach --required --json name,bucket,link 2>/dev/null)
  [ -n "$json" ] || json='[]'
  if [ -n "$want" ]; then
    head=$(gh pr view "$pr" -R TheCruzControll/performance-coach --json headRefOid -q .headRefOid 2>/dev/null)
    [[ "$head" == "$want"* ]] || json='[]'
  fi
  state=$(jq -r --argjson req "$REQUIRED" 'if length == 0 then "pending"
    elif any(.[]; .bucket == "fail" or .bucket == "cancel") then "red"
    elif any(.[]; .bucket == "pending") then "pending"
    elif ($req - map(.name) | length) > 0 then "pending"
    else "green" end' <<<"$json" 2>/dev/null || echo pending)
  echo "$(date -u +%H:%M:%S) PR #$pr: $state ($(jq -r 'map(.bucket) | group_by(.) | map("\(.[0]) \(length)") | join(", ")' <<<"$json" 2>/dev/null))"
  case $state in
    green) echo "$json"; exit 0 ;;
    red) echo "$json"; exit 1 ;;
  esac
  if [ "$waited" -ge "$max" ]; then echo "$json"; exit 2; fi
  sleep "$interval"
  waited=$((waited + interval))
done
