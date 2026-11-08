#!/bin/bash
# update-branch.sh <branch>: merge origin/main into origin/<branch> in a scratch worktree and push.
# Replaces GitHub's update-branch, which gh's token cannot do once main changes .github/workflows.
# Exits non-zero, pushing nothing, when the merge conflicts (that goes to a merge agent).
set -e
B=$1; R=/Users/franciscruz/playground/performance-coach; W=/Users/franciscruz/playground/pc-wt/ub-$$
cd $R; git fetch -q origin main "$B"
git worktree add -q --detach $W "origin/$B"; trap "cd $R; git worktree remove --force $W" EXIT
cd $W; git merge -q --no-edit -m "Merge main into $B" origin/main
git push -q origin "HEAD:$B"
git rev-parse --short HEAD
