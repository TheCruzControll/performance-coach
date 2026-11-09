#!/bin/bash
# merge-pr.sh <pr> <sha>: docs guard on the PR's branch, then merge at <sha> titled
# "Merge <PR title> (#N)" and log it in notes.md. Prints "merged" or why not.
set -uo pipefail
S=/tmp/pc-scratch; R=repos/TheCruzControll/performance-coach
n=$1; sha=$2
read -r branch title < <(gh pr view "$n" -R TheCruzControll/performance-coach --json headRefName,title -q '.headRefName+" "+.title')
out=$(bash $S/bin/docs-guard-check.sh "$branch" 2>&1 | grep -E 'Tests ')
echo "docs guard: $out"
grep -q failed <<<"$out" && { echo "not merged: docs guard failed"; exit 1; }
[ -n "$out" ] || { echo "not merged: docs guard did not run"; exit 1; }
gh api -X PUT "$R/pulls/$n/merge" -f sha="$sha" -f merge_method=merge -f commit_title="Merge $title (#$n)" --jq .merged >/dev/null || exit 1
echo "- $(date -u +%H:%M) UTC MERGED #$n $branch." >>$S/notes.md
echo merged
