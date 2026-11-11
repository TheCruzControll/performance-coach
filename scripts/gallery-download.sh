#!/usr/bin/env bash
# Download a Screen gallery run's PNGs and contact sheet (.github/workflows/screen-gallery.yml):
#   scripts/gallery-download.sh <run id> <dir>
# `gh run download` fetches the `screen-gallery` artifact and unzips it into <dir>, which must be
# empty or new. Then open <dir>/index.html. Start a run with `gh workflow run screen-gallery.yml`.
set -euo pipefail

usage='usage: scripts/gallery-download.sh <run id> <dir>'
run_id="${1:?$usage}"
dir="${2:?$usage}"

if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
  echo "gallery-download: '$run_id' is not a run id (a number: gh run list --workflow screen-gallery.yml)" >&2
  exit 2
fi
if [[ -e "$dir" && -n "$(ls -A "$dir")" ]]; then
  echo "gallery-download: $dir is not empty; pick a new directory" >&2
  exit 2
fi

mkdir -p "$dir"
gh run download "$run_id" --name screen-gallery --dir "$dir"
shots=$(find "$dir" -name '*.png' | wc -l | tr -d ' ')
echo "gallery-download: ${shots} screens in ${dir}; open ${dir}/index.html"
