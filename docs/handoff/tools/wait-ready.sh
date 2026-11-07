#!/bin/bash
# Re-run steward-plan every 3 minutes; exit (printing the plan) when a PR is READY, a PR's CI failed
# or a PR conflicts. PRs listed in wait-ignore.txt (one number per line, being fixed) are skipped.
S=<scratch>
N=<scratch>
cd $S
while true; do
  out=$(REPO_DIR=<repo> timeout 150 $S/bin/steward-plan 2>&1)
  ign=$(sed 's/^/^(ACTION [a-z]+ |#)/; s/$/ /' $N/wait-ignore.txt 2>/dev/null | paste -sd'|')
  f=$out; [ -n "$ign" ] && f=$(grep -vE "$ign" <<<"$out")
  if grep -qE '^ACTION|READY|ci (failure|failed|error|cancelled|timed_out)|CONFLICT' <<<"$f"; then
    echo "$out"; exit 0
  fi
  sleep 180
done
