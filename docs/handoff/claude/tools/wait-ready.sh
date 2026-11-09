#!/bin/bash
# Re-run steward-plan every 3 minutes; exit (printing the plan) when a PR is READY, a PR's CI failed
# or a PR conflicts. PRs listed in wait-ignore.txt (one number per line, being fixed) are skipped.
S=/tmp/pc-scratch
N=/tmp/pc-scratch
cd $S
while true; do
  touch -h /tmp/pc-scratch /tmp/pc-wt 2>/dev/null  # keep /tmp's purge off the scratch symlink
  rd=$(bash $S/bin/refresh-dirty.sh 2>&1); [ -n "$rd" ] && echo "$rd" >>$S/refresh.log
  c=$(grep "^CONFLICT" <<<"$rd" | grep -vwFf $N/wait-ignore.txt); [ -n "$c" ] && { echo "$c"; exit 0; }
  [ -n "$rd" ] && sleep 60
  out=$(REPO_DIR=/Users/nikocruz/dev/performance-coach timeout 150 $S/bin/steward-plan 2>&1)
  ign=$(sed 's/^/^(ACTION [a-z]+ |#)/; s/$/ /' $N/wait-ignore.txt 2>/dev/null | paste -sd'|' -)
  f=$out; [ -n "$ign" ] && f=$(grep -vE "$ign" <<<"$out")
  # One merge per pass, gated by steward-plan (CI green, Sol line, clean, fresh) and the docs guard.
  m=$(grep -m1 -E '^ACTION merge ' <<<"$f")
  if [ -n "$m" ]; then
    set -- $m; r=$(bash $S/bin/merge-pr.sh "$3" "$4" 2>&1); echo "$(date -u +%H:%M) #$3 $r" >>$S/merge.log
    grep -q '^merged' <<<"$r" || { echo "$m"; echo "$r"; exit 0; }
    sleep 120; continue
  fi
  u=$(grep -m1 -E '^ACTION update ' <<<"$f")
  if [ -n "$u" ]; then
    set -- $u; b=$(gh pr view "$3" -R TheCruzControll/performance-coach --json headRefName -q .headRefName)
    r=$(bash $S/bin/update-branch.sh "$b" 2>&1) || { echo "$u"; echo "$r"; exit 0; }
    echo "$(date -u +%H:%M) updated #$3 $b" >>$S/merge.log; sleep 60; continue
  fi
  if grep -qE '^ACTION|READY|^#[0-9]+ ci (failure|failed|error|cancelled|timed_out)' <<<"$f"; then
    echo "$out"; exit 0
  fi
  sleep 180
done
