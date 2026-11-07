#!/bin/bash
# docs-guard-check.sh <branch>: merge origin/<branch> onto origin/main in a scratch worktree and run
# the docs guard (scripts/*docs*/adr/milestones tests, from #145). Exit non-zero on conflict or failure.
set -e
B=$1; R=<repo>; W=<scratch>/wt/dg-$$
cd $R; git fetch -q origin main "$B"
git worktree add -q --detach $W origin/main; trap "cd $R; git worktree remove --force $W" EXIT
cd $W; git merge -q --no-edit "origin/$B"; ln -s $R/node_modules node_modules
timeout 300 pnpm exec vitest run scripts/adr-index.test.ts scripts/docs-citations.test.ts scripts/docs-env.test.ts scripts/docs-prs.test.ts scripts/lib/docs-scan.test.ts scripts/milestones.test.ts scripts/layout-rules.test.ts scripts/reports.test.ts 2>&1 | tail -6
