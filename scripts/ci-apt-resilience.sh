#!/usr/bin/env bash
# CI only: make apt ride out slow or stalled Ubuntu mirrors on GitHub runners.
# - A stalled download times out after 30 s and is retried (up to 5 times) instead of hanging.
# - A second apt-get waits for the dpkg lock instead of failing at once.
# - With a directory argument, downloaded packages are kept there (instead of deleted after
#   install) so actions/cache can carry them to the next run: a mirror that trickles at
#   ~50 KB/s then costs one run, not every run. Run `ci-apt-resilience.sh --release <dir>`
#   after installing to make the directory readable for the cache save.
set -euo pipefail

if [[ "${1:-}" == "--release" ]]; then
  archives="${2:?usage: ci-apt-resilience.sh --release <dir>}"
  sudo rm -rf "${archives}/partial" "${archives}/lock"
  sudo chown -R "$(id -u):$(id -g)" "${archives}"
  exit 0
fi

archives="${1:-}"
{
  echo 'Acquire::Retries "5";'
  echo 'Acquire::http::Timeout "30";'
  echo 'Acquire::https::Timeout "30";'
  echo 'DPkg::Lock::Timeout "300";'
  if [[ -n "${archives}" ]]; then
    echo "Dir::Cache::Archives \"${archives}/\";"
    echo 'APT::Keep-Downloaded-Packages "true";'
    echo 'Binary::apt-get::APT::Keep-Downloaded-Packages "true";'
  fi
} | sudo tee /etc/apt/apt.conf.d/90-ci-resilience >/dev/null

if [[ -n "${archives}" ]]; then
  sudo mkdir -p "${archives}/partial"
fi
