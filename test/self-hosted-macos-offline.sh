#!/usr/bin/env bash
set -euo pipefail

if [[ "${NOOP_E2E_DISPOSABLE:-}" != 1 || "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'Run only on a disposable macOS runner.' >&2
  exit 1
fi

interface=$(/sbin/route -n get default | awk '/interface:/{print $2; exit}')
if [[ -z "$interface" ]]; then
  printf '%s\n' 'No default network interface found.' >&2
  exit 1
fi
sudo -n true
curl -fsS --max-time 10 https://github.com/ -o /dev/null
printf 'Online check passed on %s\n' "$interface"

(sleep 120; sudo -n pfctl -d >/dev/null 2>&1 || true) >/dev/null 2>&1 &
guard=$!
restore() { sudo -n pfctl -d >/dev/null 2>&1 || true; kill "$guard" 2>/dev/null || true; }
trap restore EXIT
printf 'block drop out quick on %s all\n' "$interface" | sudo -n pfctl -f - >/dev/null 2>&1
sudo -n pfctl -e >/dev/null 2>&1
if curl -fsS --max-time 5 https://github.com/ -o /dev/null 2>/dev/null; then
  printf '%s\n' 'Public network remained reachable.' >&2
  exit 1
fi
printf '%s\n' 'Public network is blocked; starting native service acceptance.'
bun test/self-hosted-service-e2e.ts
bun test/self-hosted-update-e2e.ts
if curl -fsS --max-time 5 https://github.com/ -o /dev/null 2>/dev/null; then
  printf '%s\n' 'Public network returned before acceptance finished.' >&2
  exit 1
fi
restore
trap - EXIT
curl -fsS --retry 3 --max-time 10 https://github.com/ -o /dev/null
printf '%s\n' 'Public network restored after offline acceptance.'
