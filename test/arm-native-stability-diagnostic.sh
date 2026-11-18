#!/usr/bin/env bash
set -Eeuo pipefail
out=/evidence/native-arm64
mkdir -p "$out" /opt/noop/app/dist/web
for name in src cloud app templates presets; do cp -a "/src/$name" /opt/noop/; done
cp /src/package.json /src/bunfig.toml /src/tsconfig.json /opt/noop/
mkdir -p /opt/noop/app/dist/web
cp -a /web /opt/noop/app/dist/web/noop
export NOOP_HOME="$out/home" HUB_NO_MEDIC=1 HUB_HOST=noop-vm
mkdir -p "$NOOP_HOME"
printf '[server]\ntoken = "synthetic-native-arm64-token-000"\n' > "$NOOP_HOME/noop.toml"
printf 'arch=%s\nbun=%s\n' "$(uname -m)" "$(bun --version)" > "$out/environment.log"
sha256sum /usr/local/bin/workerd >> "$out/environment.log"
bun /opt/noop/src/cli.ts cloud deploy --local --listen 127.0.0.1:8790 > "$out/coordinator.log" 2>&1 &
coordinator=$!
daemon=
cleanup() { [ -z "$daemon" ] || kill "$daemon" 2>/dev/null || true; kill "$coordinator" 2>/dev/null || true; wait || true; }
trap cleanup EXIT
for n in $(seq 1 60); do
  if bun -e 'fetch("http://127.0.0.1:8790/").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'; then break; fi
  kill -0 "$coordinator"
  sleep 1
done
bun /opt/noop/src/cli.ts init --primary --local http://127.0.0.1:8790 --token synthetic-native-arm64-token-000 > "$out/init.log" 2>&1
cat > "$NOOP_HOME/data/config.local.toml" <<'CONFIG'
[host]
tick_seconds = 1
[router]
cli = "not-installed"
[server]
enabled = false
[idle]
enabled = false
[supervisor]
enabled = false
[medic]
enabled = false
[tunnel]
mode = "off"
CONFIG
bun /opt/noop/src/cli.ts daemon > "$out/daemon.log" 2>&1 &
daemon=$!
for n in $(seq 1 30); do
  grep -q 'cloud bridge' "$out/daemon.log" && break
  kill -0 "$daemon"
  sleep 1
done
grep -q 'cloud bridge' "$out/daemon.log"
for n in $(seq 1 180); do
  if ! kill -0 "$daemon" 2>/dev/null; then echo "native primary exited after $n seconds" >&2; tail -100 "$out/daemon.log"; exit 1; fi
  if ! kill -0 "$coordinator" 2>/dev/null; then echo "native coordinator exited after $n seconds" >&2; tail -100 "$out/coordinator.log"; exit 1; fi
  sleep 1
done
bun -e 'fetch("http://127.0.0.1:8790/api/status", {headers:{authorization:"Bearer synthetic-native-arm64-token-000"}}).then(async r => process.exit(r.ok && Array.isArray((await r.json()).decisions) ? 0 : 1)).catch(() => process.exit(1))'
printf '{"status":"passed","platform":"linux-arm64-native-container","seconds":180,"network":"none"}\n' > "$out/report.json"
printf 'Native ARM64 primary and coordinator remained running for 180 seconds.\n'
