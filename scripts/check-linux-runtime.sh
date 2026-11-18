#!/usr/bin/env bash
# Run the same executable `nsh package` ships, rather than an all-features test host.
set -euo pipefail
runtime="$(realpath "${1:?usage: check-linux-runtime.sh <Linux executable>}")"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:?set TMPDIR outside /tmp and any checkout}/noop-linux-runtime.XXXXXX")"
server_pid=''
runner_pid=''
trap 'if [[ -n "$runner_pid" ]]; then kill -TERM -- "-$runner_pid" 2>/dev/null || true; wait "$runner_pid" 2>/dev/null || true; fi; if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi; (cd "$work" && rm -rf -- ./*); rmdir "$work"' EXIT
mkdir -p "$work/nsh" "$work/source"
python3 - "$work/port" > "$work/server.log" 2>&1 <<'PY' &
import base64, hashlib, http.server, socketserver, sys
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'ok'); self.wfile.flush(); return
        if self.path != '/ws' or not self.headers.get('Sec-WebSocket-Key'):
            self.send_error(404); return
        accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101); self.send_header('Upgrade', 'websocket'); self.send_header('Connection', 'Upgrade'); self.send_header('Sec-WebSocket-Accept', accept); self.end_headers(); self.wfile.flush()
        first = self.rfile.read(2)
        if len(first) != 2 or first[1] & 127 != 4 or not first[1] & 128: return
        mask, payload = self.rfile.read(4), self.rfile.read(4)
        if bytes(value ^ mask[i % 4] for i, value in enumerate(payload)) == b'ping':
            self.wfile.write(b'\x81\x04pong'); self.wfile.flush()
with Server(('127.0.0.1', 0), Handler) as server:
    with open(sys.argv[1], 'w') as output: output.write(str(server.server_address[1]))
    server.serve_forever()
PY
server_pid=$!
for _ in {1..100}; do [[ -s "$work/port" ]] && break; sleep 0.05; done
[[ -s "$work/port" ]] || { cat "$work/server.log"; exit 1; }
port="$(cat "$work/port")"
sed "s/__NOOP_PORT__/$port/g" "$root/scripts/fixtures/linux-runtime/App.tsx" > "$work/source/App.tsx"
"${NSH:-nsh}" build "$work/source/App.tsx" -o "$work/nsh"
printf '%s\n' '{"name":"Noop runtime check","id":"dev.noop.runtime-check"}' > "$work/nsh/app.json"
cp "$runtime" "$work/runner"
export RUST_LOG=info
code=0
stopped=0
if [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
  setsid timeout --kill-after=5s 30s "$work/runner" > "$work/log" 2>&1 &
else
  setsid timeout --kill-after=5s 30s xvfb-run -a "$work/runner" > "$work/log" 2>&1 &
fi
runner_pid=$!
for _ in {1..300}; do
  if grep -qE 'NOOP_LINUX_RUNTIME_(WS_OK|WS_FAILED|NETWORK_FAILED)' "$work/log" || ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -TERM "$runner_pid" 2>/dev/null; then stopped=1; fi
wait "$runner_pid" 2>/dev/null || code=$?
runner_pid=''
cat "$work/log"
if [[ "$stopped" != 1 && "$code" != 0 && "$code" != 124 ]]; then exit "$code"; fi
for marker in OK HTTP_OK WS_OK; do
  if ! grep -q "INFO js: NOOP_LINUX_RUNTIME_$marker" "$work/log"; then
    echo "Linux runtime did not emit $marker (exit $code)" >&2
    exit 1
  fi
done
