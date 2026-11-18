#!/usr/bin/env bash
# Exercise installation with isolated homes and a simulated service manager.
set -euo pipefail
src=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d "${NOOP_E2E_OUT:-${TMPDIR:-/tmp}}/noop-install-home-XXXXXX")
repo="$out/repo"
mkdir -p "$repo" "$out/bin"
for path in src cloud app templates presets; do cp -R "$src/$path" "$repo/$path"; done
cp "$src/package.json" "$src/bunfig.toml" "$src/tsconfig.json" "$repo/"
mkdir -p "$repo/app/dist/web/noop"
printf '<html>fixture</html>\n' > "$repo/app/dist/web/noop/index.html"
cat > "$out/bin/systemctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$NOOP_SERVICE_CALLS"
mkdir -p "$HOME/.config/systemd/user/default.target.wants"
case "$*" in *daemon-reload*) [ "${NOOP_FAIL_RELOAD:-}" != 1 ] ;; esac
SH
cat > "$out/bin/loginctl" <<'SH'
#!/bin/sh
printf 'yes\n'
SH
cat > "$out/bin/workerd" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$out/bin/"*
bun=$(command -v bun)
trap '
  status=$?
  result=passed
  [ "$status" = 0 ] || result=failed
  printf "{\"status\":\"%s\",\"revision\":\"%s\",\"platform\":\"%s\",\"bun\":\"%s\"}\n" \
    "$result" "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" "$(uname -sm)" "$("$bun" --version)" > "$out/report.json"
  (cd "$out" && sha256sum ./*.log report.json > SHA256SUMS)
  printf "Evidence: %s\n" "$out"
  exit "$status"
' EXIT
for suffix in / /. ; do
  for service in primary coordinator; do
    name="${service}$( [ "$suffix" = / ] && printf trailing || printf dot )"
    home="$out/$name"
    mkdir -p "$home/.noop"
    printf '[cloud]\nmode = "local"\n' > "$home/.noop/noop.toml"
    calls="$out/$name.log"
    : > "$calls"
    args=(install)
    if [ "$service" = coordinator ]; then args=(cloud service install); fi
    rc=0
    timeout 12 env HOME="$home$suffix" NOOP_HOME="$home/.noop" HUB_NO_MEDIC=1 \
      NOOP_SERVICE_CALLS="$calls" NOOP_FAIL_RELOAD="$([ "$service" = coordinator ] && printf 1 || printf 0)" \
      PATH="$out/bin:$PATH" "$bun" "$repo/src/cli.ts" "${args[@]}" >> "$calls" 2>&1 || rc=$?
    if [ "$rc" = 124 ] || ! grep -q -- '--user daemon-reload' "$calls"; then
      printf 'FAIL %s: install did not reach the service manager (exit %s)\n' "$name" "$rc"
      exit 1
    fi
    if [ "$service" = primary ] && [ "$rc" != 0 ]; then
      printf 'FAIL %s: primary installation failed (exit %s)\n' "$name" "$rc"
      exit 1
    fi
    printf 'PASS %s reached the service manager\n' "$name"
  done
done
