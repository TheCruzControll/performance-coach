#!/bin/bash
# refresh-dirty.sh: for every open PR GitHub calls DIRTY whose merge with main is actually clean
# (stacked criss-cross history), merge main into it with update-branch.sh. Prints what it did, and
# "CONFLICT <n> <branch>" for real conflicts, which go to a merge agent.
S=/Users/franciscruz/playground/pc-scratch; R=/Users/franciscruz/playground/performance-coach
git -C $R fetch -q origin
gh pr list -R TheCruzControll/performance-coach --json number,headRefName,mergeStateStatus \
	-q '.[] | select(.mergeStateStatus=="DIRTY") | "\(.number) \(.headRefName)"' | while read -r n b; do
	if git -C $R merge-tree --write-tree origin/main "origin/$b" >/dev/null 2>&1; then
		echo "refreshed #$n $b $(bash $S/bin/update-branch.sh "$b" 2>&1 | tail -1)"
	else
		echo "CONFLICT $n $b"
	fi
done
