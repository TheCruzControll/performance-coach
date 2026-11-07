#!/usr/bin/env bash
# Model-checks the offline workout sync (.pi/skills/verify-workout-sync/SKILL.md).
# Usage: verification/workout-sync/check.sh [baseline|finding|<mutant>...]
# With no argument it runs every check. Exit 0: every check ended as expected; 1: one did not;
# 2: every check ended as expected, but covered code changed since the skill's sync commit.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
skill="$repo/.pi/skills/verify-workout-sync/SKILL.md"
cache="$here/.cache"
mkdir -p "$cache"

TLA_URL=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
TLA_SHA=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JRE_TAG=jdk-21.0.13+9
JRE_VER=21.0.13_9

# Each check: name, then the MC.cfg lines it changes (split by ';'), then the result it must end with.
CHECKS=(
	"baseline||pass"
	"nolock|WebLocks = FALSE;MaxFaults = 1;MaxKeepalive = 0|pass"
	"finding|DiscardInFlight = TRUE|AppliedInOrder"
	"ackOnSend|MUTANT = \"ackOnSend\"|NothingLost"
	"claimOwnTx|MUTANT = \"claimOwnTx\"|NothingLost"
	"claimAfterApply|MUTANT = \"claimAfterApply\"|AppliedAtMostOnce"
	"skipWaitingHead|MUTANT = \"skipWaitingHead\"|AppliedInOrder"
	"blockedApplied|MUTANT = \"blockedApplied\"|AppliedInOrder"
	"retryContinues|MUTANT = \"retryContinues\"|AppliedInOrder"
	"fixKeepsParked|MUTANT = \"fixKeepsParked\"|EventuallySynced"
)

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

fetch() { # url sha file
	[[ -f $3 && $(sha256 "$3") == "$2" ]] && return
	curl -fsSL -o "$3.part" "$1"
	if [[ $(sha256 "$3.part") != "$2" ]]; then
		echo "checksum mismatch for $1" >&2
		rm -f "$3.part"
		exit 1
	fi
	mv "$3.part" "$3"
}

find_java() {
	if [[ -n ${JAVA:-} ]]; then echo "$JAVA"; return; fi
	if command -v java >/dev/null && java -version >/dev/null 2>&1; then echo java; return; fi
	local os arch sha
	case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) os=mac arch=aarch64 sha=225bab0a09491ef06835488cd942f5d2befa9a0410a2484f0c8bbcf7506ec09a ;;
	Darwin-x86_64) os=mac arch=x64 sha=c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89 ;;
	Linux-x86_64) os=linux arch=x64 sha=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd ;;
	Linux-aarch64) os=linux arch=aarch64 sha=b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c ;;
	*) echo "no Java on PATH and no pinned JRE for $(uname -sm); set JAVA" >&2; exit 1 ;;
	esac
	local home="$cache/jre/$JRE_TAG-jre"
	if [[ ! -d $home ]]; then
		local tgz="$cache/jre-$JRE_VER-$os-$arch.tar.gz"
		fetch "https://github.com/adoptium/temurin21-binaries/releases/download/${JRE_TAG/+/%2B}/OpenJDK21U-jre_${arch}_${os}_hotspot_$JRE_VER.tar.gz" "$sha" "$tgz"
		mkdir -p "$cache/jre"
		tar -xzf "$tgz" -C "$cache/jre"
	fi
	if [[ $os == mac ]]; then echo "$home/Contents/Home/bin/java"; else echo "$home/bin/java"; fi
}

fetch "$TLA_URL" "$TLA_SHA" "$cache/tla2tools.jar"
java=$(find_java)

# The result TLC ended with: pass, the violated invariant, EventuallySynced, or error.
result_of() {
	if grep -q "Model checking completed. No error has been found." "$1"; then echo pass
	elif grep -q "Error: Invariant .* is violated" "$1"; then grep -o "Invariant [A-Za-z]* is violated" "$1" | head -1 | cut -d' ' -f2
	elif grep -q "Error: Temporal properties were violated" "$1"; then echo EventuallySynced
	else echo error; fi
}

only=" $* "
failed=0
for check in "${CHECKS[@]}"; do
	IFS='|' read -r name change expect <<<"$check"
	kind=$name
	[[ $name == baseline || $name == nolock || $name == finding ]] || kind=mutant
	[[ $only == "  " || $only == *" $name "* ]] || continue
	dir="$cache/run/$name"
	rm -rf "$dir" && mkdir -p "$dir"
	cp "$here"/{WorkoutSync.tla,MC.tla} "$dir/"
	cp "$here/MC.cfg" "$dir/MC.cfg"
	IFS=';' read -ra lines <<<"$change"
	for line in ${lines[@]+"${lines[@]}"}; do
		key=${line%% =*}
		grep -q "^    $key = " "$dir/MC.cfg" || { echo "MC.cfg has no '$key ='" >&2; exit 1; }
		sed -i.bak "s|^    $key = .*|    $line|" "$dir/MC.cfg"
	done
	start=$SECONDS
	(cd "$dir" && "$java" -XX:+UseParallelGC -cp "$cache/tla2tools.jar" tlc2.TLC \
		-workers auto -cleanup -metadir "$dir/states" -config MC.cfg MC.tla >tlc.out 2>&1) || true
	got=$(result_of "$dir/tlc.out")
	states=$(grep -o "[0-9,]* distinct states found" "$dir/tlc.out" | tail -1 | cut -d' ' -f1)
	if [[ $got == "$expect" ]]; then verdict=ok; else verdict=UNEXPECTED; failed=1; fi
	printf '%-10s %-16s %-6s expected %-17s got %-17s %6s states %3ss  %s\n' \
		"$verdict" "$name" "$kind" "$expect" "$got" "${states:-?}" $((SECONDS - start)) "$dir/tlc.out"
done

((failed)) && exit 1

sync=$(grep -o 'Sync commit: `[0-9a-f]\{40\}`' "$skill" | grep -o '[0-9a-f]\{40\}')
covered=$(grep -o '`src/lib/[^`]*\.ts`' "$skill" | tr -d '`' | sort -u)
# shellcheck disable=SC2086 # the paths hold no spaces
stale=$(cd "$repo" && git diff --name-only "$sync" -- $covered)
if [[ -n $stale ]]; then
	printf 'STALE: covered code changed since sync commit %s:\n%s\n' "${sync:0:12}" "$stale"
	echo "A pass describes the code at the sync commit. Follow the skill's 'When the code changed'."
	exit 2
fi
echo "Covered code matches sync commit ${sync:0:12}."
