#!/bin/bash
# sol-line.sh <pr> <rounds> <effort>: record a Sol approval in the PR body (replacing a
# "Sol review pending" line, else before the attribution line) and un-ignore the PR in the watcher.
set -euo pipefail
S=/Users/franciscruz/playground/pc-scratch; n=$1; f=$S/pr-bodies/pr-$n.md
gh pr view "$n" -R TheCruzControll/performance-coach --json body -q .body >"$f"
python3 - "$f" "Reviewed with sol-review: $2 rounds with GPT-6.1 Sol on $3. Sol verdict: approved" <<'EOF'
import sys
p, line = sys.argv[1], sys.argv[2]
s = open(p).read()
if 'Sol verdict: approved' in s: sys.exit()
attr = 'Created with Claude Opus 5.5 in pi.'
s = s.replace('Sol review pending', line) if 'Sol review pending' in s else s.replace(attr, line + '\n\n' + attr) if attr in s else s.rstrip() + '\n\n' + line + '\n'
open(p, 'w').write(s)
EOF
gh pr edit "$n" -R TheCruzControll/performance-coach --body-file "$f" >/dev/null
sed -i '' "/^$n\$/d" $S/wait-ignore.txt
grep -c 'Sol verdict: approved' "$f"
