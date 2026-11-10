#!/usr/bin/env bash
# CI only: install the system packages Playwright's browsers need, from the actions/cache copy
# when it has them all, so a slow Ubuntu mirror cannot hold an E2E leg.
#
#   ci-playwright-deps.sh packages <browser>...       the packages, sorted, one per line
#   ci-playwright-deps.sh key <browser>...            cache key parts, for $GITHUB_OUTPUT
#   ci-playwright-deps.sh install <cache> <browser>... install them
#
# `playwright install-deps` always runs `apt-get update` first, and on bad days the runner's
# mirror stalled that for the whole 12-minute step while every package sat in the cache. So the
# cache holds apt's package lists as well as the downloaded packages (a private lists directory,
# leaving the system's alone): when every needed package is in it, apt installs from it with no
# network at all. Otherwise apt updates (Ubuntu's archive only: no backports, no translations)
# and downloads, each attempt bounded and retried, since killing a download is safe. dpkg itself
# runs once, with nothing left to fetch, and is never killed.
set -euo pipefail

PLAYWRIGHT="${PLAYWRIGHT:-pnpm exec playwright}"
UBUNTU_SOURCES="${APT_UBUNTU_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}"
ATTEMPTS="${APT_ATTEMPTS:-3}"
# Three attempts of each fit the step's 12 minutes with time left for dpkg (about 15 s).
UPDATE_SECONDS="${APT_UPDATE_SECONDS:-75}"
DOWNLOAD_SECONDS="${APT_DOWNLOAD_SECONDS:-110}"

# Playwright runs `sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends …"`
# for the browsers named; a stand-in sudo first on PATH prints that command instead.
packages() {
	local shim out list
	shim=$(mktemp -d)
	printf '#!/bin/sh\nprintf "%%s\\n" "$4"\n' >"${shim}/sudo"
	chmod +x "${shim}/sudo"
	out=$(PATH="${shim}:${PATH}" ${PLAYWRIGHT} install-deps "$@") || {
		rm -rf "${shim}"
		echo "::error::playwright install-deps $* failed" >&2
		return 1
	}
	rm -rf "${shim}"
	list=$(printf '%s\n' "${out}" |
		sed -n 's/.*apt-get install -y --no-install-recommends \(.*\)$/\1/p' |
		tr ' ' '\n' | grep -v '^$' | sort -u) || true
	if [[ -z "${list}" ]]; then
		echo "::error::no package list in playwright install-deps $* output: ${out}" >&2
		return 1
	fi
	printf '%s\n' "${list}"
}

sha() {
	if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi
}

key() {
	local list
	list=$(packages "$@")
	echo "packages=$(printf '%s\n' "${list}" | sha | cut -c1-16)"
	echo "image=${ImageVersion:-unknown}"
}

# retry <seconds> <what> <command>...: each attempt killed after <seconds>. Only for commands
# that never run dpkg (an update, a download), which leave nothing behind when killed.
retry() {
	local seconds=$1 what=$2 attempt
	shift 2
	for attempt in $(seq "${ATTEMPTS}"); do
		if sudo timeout -k 5 "${seconds}" "$@"; then
			return 0
		fi
		echo "::warning::${what}: attempt ${attempt} of ${ATTEMPTS} failed or stalled (${seconds} s)"
	done
	echo "::error::${what} failed ${ATTEMPTS} times"
	return 1
}

install() {
	local cache=$1 started list
	shift
	started=$(date +%s)
	list=$(packages "$@")
	local -a want opts
	want=(${list})
	sudo mkdir -p "${cache}/lists/partial" "${cache}/archives/partial" "${cache}/sources"
	opts=(
		-o "Dir::State::Lists=${cache}/lists"
		-o "Dir::Cache::Archives=${cache}/archives"
		-o Acquire::Languages=none
		-o Acquire::Retries=3
		-o Acquire::http::Timeout=20
		-o Acquire::https::Timeout=20
		-o DPkg::Lock::Timeout=300
		-o APT::Keep-Downloaded-Packages=true
		-o Binary::apt-get::APT::Keep-Downloaded-Packages=true
	)
	if [[ -f "${UBUNTU_SOURCES}" ]]; then
		sed -E -e '/^Suites:/ s/ [a-z]+-backports//g' -e '/^Types:/ s/ deb-src//g' \
			"${UBUNTU_SOURCES}" | sudo tee "${cache}/sources/ubuntu.sources" >/dev/null
		opts+=(-o Dir::Etc::SourceList=/dev/null -o "Dir::Etc::SourceParts=${cache}/sources")
	fi
	echo "${#want[@]} packages: ${want[*]}"

	if cached && dpkg_install; then
		echo "Installed from the cache: no apt-get update, no download."
	else
		echo "Not all in the cache: updating the lists and downloading the rest."
		retry "${UPDATE_SECONDS}" 'apt-get update' apt-get update --error-on=any "${opts[@]}"
		retry "${DOWNLOAD_SECONDS}" 'package download' \
			apt-get install -y --no-install-recommends --download-only "${opts[@]}" "${want[@]}"
		# Versions the fresh lists no longer offer would only grow the cache.
		sudo apt-get autoclean -qq "${opts[@]}"
		dpkg_install
	fi

	# Readable for the cache save, without apt's locks and half-downloaded files.
	sudo rm -rf "${cache}/lists/partial" "${cache}/lists/lock" \
		"${cache}/archives/partial" "${cache}/archives/lock"
	sudo chown -R "$(id -u):$(id -g)" "${cache}"
	echo "Playwright system packages ready in $(($(date +%s) - started)) s."
}

# The cached lists resolve every package to a cached .deb: there is nothing to fetch.
cached() {
	local uris
	[[ -n "$(find "${cache}/lists" -maxdepth 1 -type f ! -name lock -print -quit)" ]] || return 1
	uris=$(sudo apt-get install -y -qq --no-install-recommends --print-uris "${opts[@]}" "${want[@]}") ||
		return 1
	[[ -z "${uris}" ]]
}

# Never under a timeout: a killed dpkg leaves the system half-configured for every later run.
dpkg_install() {
	sudo apt-get install -y --no-install-recommends --no-download "${opts[@]}" "${want[@]}"
}

command=${1:-}
shift || true
case "${command}" in
packages) packages "$@" ;;
key) key "$@" ;;
install) install "$@" ;;
*)
	echo "usage: ci-playwright-deps.sh packages|key <browser>... | install <cache> <browser>..." >&2
	exit 2
	;;
esac
