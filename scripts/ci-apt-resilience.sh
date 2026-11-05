#!/usr/bin/env bash
# CI only: make apt ride out slow or stalled Ubuntu mirrors on GitHub runners.
# - A stalled download times out after 30 s and is retried (up to 5 times) instead of hanging.
# - A second apt-get waits for the dpkg lock instead of failing at once.
set -euo pipefail
sudo tee /etc/apt/apt.conf.d/90-ci-resilience >/dev/null <<'CONF'
Acquire::Retries "5";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
DPkg::Lock::Timeout "300";
CONF
