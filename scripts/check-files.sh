#!/usr/bin/env bash
# Type-check only the TypeScript files given, and what they import: the narrow form of `pnpm check`
# that agents can afford on this machine. Other files (.svelte, .md, tests of other kinds) are
# skipped; svelte-check still runs them in CI.
#   pnpm check:files src/lib/a.ts tests/integration/b.test.ts
set -euo pipefail

files=()
for f in "$@"; do
	case "$f" in
		*.ts) files+=("\"$f\"") ;;
	esac
done
if [ ${#files[@]} -eq 0 ]; then
	echo "check:files: no .ts files given, nothing to check"
	exit 0
fi

svelte-kit sync >/dev/null
config=".tsconfig.check-files.$$.json"
trap 'rm -f "$config"' EXIT
list=$(
	IFS=,
	echo "${files[*]}"
)
printf '{"extends":"./tsconfig.json","include":["src/app.d.ts",%s]}\n' "$list" >"$config"
tsc --noEmit -p "$config"
echo "check:files: ${#files[@]} file(s) and their imports type-check"
