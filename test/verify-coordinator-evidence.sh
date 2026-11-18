#!/usr/bin/env bash
set -euo pipefail

root="${1:?usage: verify-coordinator-evidence.sh <downloaded-evidence-directory>}"
found=0
while IFS= read -r -d '' sums; do
  found=1
  (cd "$(dirname "$sums")" && sha256sum -c SHA256SUMS)
done < <(find "$root" -type f -name SHA256SUMS -print0)
if [[ "$found" != 1 ]]; then
  echo "No coordinator evidence checksum manifests found in $root" >&2
  exit 1
fi
