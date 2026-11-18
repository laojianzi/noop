// Boot an isolated Debian VM, install the user service, and reset the machine without logging in.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-reboot-vm-"));
const stage = join(out, "assets"), serial = join(out, "serial.log"), qmp = join(out, "qmp.sock"), disk = join(out, "disk.qcow2");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", image = process.env.NOOP_E2E_DEBIAN_IMAGE || "";
const token = "synthetic-reboot-vm-machine-token-000", checks: string[] = [];
let vm: ChildProcess | undefined, error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) { value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
function run(command: string, args: string[], cwd = source) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${command} failed: ${(r.stderr || r.stdout || r.error?.message || "unknown error").slice(-2000)}`);
  return r.stdout;
}
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
async function waitFor(fn: () => boolean | Promise<boolean>, message: string, timeout = process.arch === "arm64" ? 600_000 : 300_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (vm && (vm.exitCode !== null || vm.signalCode !== null)) throw new Error(`VM exited: ${existsSync(serial) ? readFileSync(serial, "utf8").slice(-3000) : "no serial log"}`);
    if (existsSync(serial) && /^NOOP_VM_PROVISION_FAILED /m.test(readFileSync(serial, "utf8"))) throw new Error(`VM provisioning failed: ${readFileSync(serial, "utf8").slice(-8000)}`);
    if (await fn()) return; await Bun.sleep(500);
  }
  throw new Error(`${message}: ${existsSync(serial) ? readFileSync(serial, "utf8").slice(-3000) : "no serial log"}`);
}
async function reset() {
  await new Promise<void>((ok, fail) => {
    const socket = createConnection(qmp); let buffer = "", phase = 0;
    const timer = setTimeout(() => { socket.destroy(); fail(new Error("QMP reset timed out")); }, 10_000);
    socket.on("error", (e) => { clearTimeout(timer); fail(e); });
    socket.on("data", (part) => {
      buffer += part.toString();
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n"), line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue; const message = JSON.parse(line);
        if (message.QMP && phase === 0) { phase = 1; socket.write('{"execute":"qmp_capabilities"}\n'); }
        else if (message.return && phase === 1) { phase = 2; socket.write('{"execute":"system_reset"}\n'); }
        else if (message.return && phase === 2) { clearTimeout(timer); socket.end(); ok(); }
        else if (message.error) { clearTimeout(timer); socket.destroy(); fail(new Error(JSON.stringify(message.error))); }
      }
    });
  });
}
try {
  check(process.platform === "linux" && ["x64", "arm64"].includes(process.arch), "the VM host is Linux x86_64 or ARM64");
  check(existsSync(image) && existsSync(workerd) && existsSync(join(assets, "index.html")), "Debian image, pinned workerd and real Web assets are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(stage, "repo", name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(stage, "repo", name));
  mkdirSync(join(stage, "repo", "app", "dist", "web"), { recursive: true }); cpSync(assets, join(stage, "repo", "app", "dist", "web", "noop"), { recursive: true });
  writeFileSync(join(stage, "repo", "app", "dist", "web", ".release"), "old-release\n");
  cpSync(assets, join(stage, "web-next"), { recursive: true });
  appendFileSync(join(stage, "web-next", "index.html"), "\n<!-- owner-update-web-v2 -->\n");
  mkdirSync(join(stage, "web-release"), { recursive: true });
  run("tar", ["-czf", join(stage, "web-release", "noop-web.tar.gz"), "-C", join(stage, "web-next"), "."]);
  writeFileSync(join(stage, "web-release", "sha256sums"), `${createHash("sha256").update(readFileSync(join(stage, "web-release", "noop-web.tar.gz"))).digest("hex")}  noop-web.tar.gz\n`);
  writeFileSync(join(stage, "web-server.py"), `from http.server import HTTPServer, SimpleHTTPRequestHandler\nfrom threading import Thread\nclass Handler(SimpleHTTPRequestHandler):\n    def __init__(self, *args, **kwargs):\n        super().__init__(*args, directory='/mnt/noop-assets/web-release', **kwargs)\n    def do_GET(self):\n        if self.path == '/stop':\n            self.send_response(200)\n            self.end_headers()\n            Thread(target=self.server.shutdown, daemon=True).start()\n        else:\n            super().do_GET()\nHTTPServer(('0.0.0.0', 18888), Handler).serve_forever()\n`);
  mkdirSync(join(stage, "bin"), { recursive: true }); copyFileSync(process.execPath, join(stage, "bin", "bun")); copyFileSync(workerd, join(stage, "bin", "workerd"));
  const proof = `#!/bin/bash\nTASK_TTY=/dev/ttyS0; if [ "$(uname -m)" = aarch64 ]; then TASK_TTY=/dev/ttyAMA0; fi\nfor n in $(seq 1 100); do loginctl show-user nooptest >/dev/null 2>&1 && break; sleep .2; done\nprintf 'NOOP_VM_BOOT %s\\n' "$(cat /proc/sys/kernel/random/boot_id)" > "$TASK_TTY"\nfor n in $(seq 1 120); do TASK_LOGIN_STATE=$(loginctl show-user nooptest -p Linger -p Sessions 2>&1); if printf '%s\\n' "$TASK_LOGIN_STATE" | grep -qx 'Linger=yes' && printf '%s\\n' "$TASK_LOGIN_STATE" | grep -qx 'Sessions='; then break; fi; sleep .5; done\nprintf '%s\\n' "$TASK_LOGIN_STATE" > "$TASK_TTY"\nTASK_UID=$(id -u nooptest)\nfor n in $(seq 1 100); do [ -S "/run/user/$TASK_UID/bus" ] && break; sleep .2; done\nrunuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user status noop-coordinator.service --no-pager > "$TASK_TTY" 2>&1 || true\nrunuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user show noop.service -p Environment --value > "$TASK_TTY" 2>&1 || true\nfor n in $(seq 1 100); do runuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user is-active --quiet noop.service && break; sleep .2; done\nrunuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user is-active --quiet noop.service && echo NOOP_VM_PRIMARY_ACTIVE > "$TASK_TTY" || true\njournalctl _UID=$TASK_UID -o cat --no-pager -n 100 > "$TASK_TTY" 2>&1 || true\nss -ltnp > "$TASK_TTY" 2>&1 || true\n`;
  const provision = `#!/bin/bash
TASK_TTY=/dev/ttyS0; if [ "$(uname -m)" = aarch64 ]; then TASK_TTY=/dev/ttyAMA0; fi
exec > /var/log/noop-provision.log 2>&1
set -euxo pipefail
trap 'TASK_RC=$?; echo "NOOP_VM_PROVISION_FAILED line=$LINENO status=$TASK_RC" > "$TASK_TTY"; tail -100 /var/log/noop-provision.log > "$TASK_TTY"; journalctl --no-pager -n 150 > "$TASK_TTY"; exit "$TASK_RC"' ERR
mkdir -p /mnt/noop-assets
mount -L NOOPASSETS /mnt/noop-assets
cp -a /mnt/noop-assets/repo /opt/noop
chown -R nooptest:nooptest /opt/noop
cp /mnt/noop-assets/bin/bun /mnt/noop-assets/bin/workerd /usr/local/bin/
chmod 755 /usr/local/bin/bun /usr/local/bin/workerd
install -d -o nooptest -g nooptest -m 700 /home/nooptest/.noop-test
printf '[server]\\ntoken = "${token}"\\n' > /home/nooptest/.noop-test/noop.toml
chown nooptest:nooptest /home/nooptest/.noop-test/noop.toml
chmod 600 /home/nooptest/.noop-test/noop.toml
loginctl enable-linger nooptest
TASK_UID=$(id -u nooptest)
for n in $(seq 1 100); do [ -S "/run/user/$TASK_UID/bus" ] && break; sleep .2; done
runuser -u nooptest -- env NOOP_HOME=/home/nooptest/.noop-test HUB_NO_MEDIC=1 PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus /usr/local/bin/bun /opt/noop/src/cli.ts cloud service install --listen 0.0.0.0:8790
runuser -u nooptest -- env NOOP_HOME=/home/nooptest/.noop-test HUB_NO_MEDIC=1 HUB_HOST=noop-vm PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/bun /opt/noop/src/cli.ts init --primary --local http://127.0.0.1:8790 --token ${token}
cat > /home/nooptest/.noop-test/data/config.local.toml <<'EOF'
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
EOF
chown nooptest:nooptest /home/nooptest/.noop-test/data/config.local.toml
python3 - /opt/noop/cloud/src/index.ts <<'PY'
from pathlib import Path
import os
import sys
path = Path(sys.argv[1])
source = path.read_text()
needle = 'statusView() { return { ...(this.get("status") ?? {}), hub:'
assert needle in source
path.write_text(source.replace(needle, 'statusView() { return { release_marker: "owner-update-v2", ...(this.get("status") ?? {}), hub:', 1))
for name in [path, Path('/home/nooptest/.noop-test/data/config.local.toml')]:
    fd = os.open(name, os.O_RDONLY)
    os.fsync(fd)
    os.close(fd)
fd = os.open('/home/nooptest/.noop-test/data', os.O_RDONLY)
os.fsync(fd)
os.close(fd)
PY
install -d -o nooptest -g nooptest -m 700 /home/nooptest/bootstrap
cp /home/nooptest/.noop-test/noop.toml /home/nooptest/bootstrap/custom.toml
chown nooptest:nooptest /home/nooptest/bootstrap/custom.toml
runuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user set-environment HUB_CONF=/home/nooptest/bootstrap/custom.toml
runuser -u nooptest -- env XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus systemctl --user set-environment NOOP_CLIENT_BASE_URL=http://127.0.0.1:18888
runuser -u nooptest -- env NOOP_HOME=/home/nooptest/.noop-test HUB_NO_MEDIC=1 PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$TASK_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TASK_UID/bus /usr/local/bin/bun /opt/noop/src/cli.ts install
for n in $(seq 1 150); do journalctl _UID=$TASK_UID -o cat --no-pager | grep -q 'web client not updated' && break; sleep .2; done
journalctl _UID=$TASK_UID -o cat --no-pager | grep -q 'web client not updated'
systemd-run --unit=noop-vm-web /usr/bin/python3 /mnt/noop-assets/web-server.py
systemd-run --unit=noop-vm-log /bin/sh -c "journalctl -f -o cat _UID=$TASK_UID > $TASK_TTY 2>&1"
systemctl enable --now noop-vm-proof.service
if timeout 3 bash -c 'echo >/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo NOOP_VM_PUBLIC_NETWORK_UNEXPECTED > "$TASK_TTY"; exit 1; else echo NOOP_VM_PUBLIC_NETWORK_BLOCKED > "$TASK_TTY"; fi
echo NOOP_VM_PROVISIONED > "$TASK_TTY"
`;
  const proofUnit = `[Unit]\nDescription=Record Noop VM login state\nAfter=systemd-logind.service\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/noop-vm-proof\n[Install]\nWantedBy=multi-user.target\n`;
  const indent = (s: string) => s.trimEnd().split("\n").map((line) => `      ${line}`).join("\n");
  writeFileSync(join(out, "user-data"), `#cloud-config\nusers:\n  - name: nooptest\n    shell: /bin/bash\n    lock_passwd: true\nwrite_files:\n  - path: /root/noop-provision\n    permissions: '0700'\n    content: |\n${indent(provision)}\n  - path: /usr/local/bin/noop-vm-proof\n    permissions: '0755'\n    content: |\n${indent(proof)}\n  - path: /etc/systemd/system/noop-vm-proof.service\n    permissions: '0644'\n    content: |\n${indent(proofUnit)}\nruncmd:\n  - [ /root/noop-provision ]\n`);
  writeFileSync(join(out, "meta-data"), "instance-id: noop-vm\nlocal-hostname: noop-vm\n");
  writeFileSync(join(out, "network-config"), 'version: 2\nethernets:\n  lan:\n    match:\n      macaddress: "52:54:00:12:34:56"\n    set-name: eth0\n    dhcp4: true\n');
  run("cloud-localds", [`--network-config=${join(out, "network-config")}`, join(out, "seed.iso"), join(out, "user-data"), join(out, "meta-data")]);
  run("genisoimage", ["-quiet", "-R", "-J", "-V", "NOOPASSETS", "-o", join(out, "assets.iso"), stage]);
  run("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", resolve(image), disk, "6G"]);
  const listenPort = await port(), fixturePort = await port(), base = `http://127.0.0.1:${listenPort}`, arm = process.arch === "arm64";
  const qemu = arm ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const args = ["-machine", arm ? "virt,accel=tcg" : "q35,accel=kvm", "-cpu", arm ? "max" : "host", "-m", "2048", "-smp", "2",
    ...(arm ? ["-bios", "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd"] : []), "-display", "none", "-serial", "stdio", "-monitor", "none",
    "-qmp", `unix:${qmp},server=on,wait=off`, "-drive", `file=${disk},if=virtio,format=qcow2`, "-device", "virtio-scsi-pci,id=scsi0",
    "-drive", `file=${join(out, "seed.iso")},if=none,id=seed,media=cdrom,readonly=on`, "-device", "scsi-cd,drive=seed",
    "-drive", `file=${join(out, "assets.iso")},if=none,id=assets,media=cdrom,readonly=on`, "-device", "scsi-cd,drive=assets",
    "-netdev", `user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:${listenPort}-:8790,hostfwd=tcp:127.0.0.1:${fixturePort}-:18888`, "-device", "virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56"];
  const fd = openSync(serial, "a"); vm = spawn(qemu, args, { detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
  const available = async () => { try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
  await waitFor(async () => (await available()) && existsSync(serial) && readFileSync(serial, "utf8").includes("NOOP_VM_PROVISIONED"), "VM did not install and start the coordinator");
  const initialLog = readFileSync(serial, "utf8"), bootLines = () => [...readFileSync(serial, "utf8").matchAll(/NOOP_VM_BOOT ([a-f0-9-]+)/g)].map((m) => m[1]);
  check(initialLog.includes("NOOP_VM_PUBLIC_NETWORK_BLOCKED") && initialLog.includes("Linger=yes"), "coordinator installs with linger while the guest has no public network");
  check(initialLog.includes("NOOP_HOME=/home/nooptest/.noop-test"), "the primary service keeps its configured Noop home");
  const request = (path: string, method = "GET", body?: unknown, credential = token) => fetch(base + path, { method,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setup = await (await request("/api/host/2fa/setup", "POST", {})).json() as any;
  check((await request("/api/host/2fa/confirm", "POST", { totp: totp(setup.secret, Math.floor(Date.now() / 30_000) - 1) })).ok, "owner binds TOTP on the offline VM");
  check((await request("/api/auth/start", "POST", { email: "first@example.com" }, "")).ok, "offline owner requests a login code");
  const code = ((await (await request("/api/host/login-code")).json()) as any).code;
  const firstStep = Math.floor(Date.now() / 30_000);
  const logged = await request("/api/auth/verify", "POST", { email: "first@example.com", code, totp: totp(setup.secret, firstStep) }, "");
  const ownerSession = ((await logged.json()) as any).session;
  check(logged.ok && !!ownerSession, "owner signs in to the offline VM");
  check((await request("/api/files/commit", "POST", { msg: "reboot", changes: [{ path: "reports/reboot.md", base_version: 0, content: Buffer.from("survives reboot").toString("base64") }] })).ok, "a host commits a file before reboot");
  await waitFor(async () => {
    try { const r = await request("/api/status"); return r.ok && Array.isArray(((await r.json()) as any).decisions); } catch { return false; }
  }, "the primary did not publish its status", 40_000);
  check(!((await (await request("/api/status")).json()) as any).release_marker, "the installed coordinator does not change before an explicit update");
  check((await request("/api/fleet/update", "POST", {}, ownerSession)).ok, "the owner requests an update through the real coordinator API");
  await waitFor(async () => {
    try { const r = await request("/api/status"); return r.ok && ((await r.json()) as any).release_marker === "owner-update-v2"; } catch { return false; }
  }, "the owner request did not update the co-located coordinator", process.arch === "arm64" ? 120_000 : 45_000);
  check(true, "the owner request updates the co-located coordinator");
  check((await (await fetch(base)).text()).includes("owner-update-web-v2"), "the first coordinator update serves the newly released Web client");
  let firstUpdate = "";
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; const u = s.hosts?.find((h: any) => h.host === "noop-vm")?.update; firstUpdate = u?.at || ""; return !!firstUpdate && u.state === "current"; } catch { return false; } }, "first update did not complete");
  check((await fetch(`http://127.0.0.1:${fixturePort}/stop`)).ok, "the isolated Web release source can be taken offline");
  check((await request("/api/fleet/update", "POST", {}, ownerSession)).ok, "owner requests another update with the Web release source offline");
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; const u = s.hosts?.find((h: any) => h.host === "noop-vm")?.update; return u?.at > firstUpdate && u.state === "current"; } catch { return false; } }, "offline coordinator update did not complete");
  check((await (await fetch(base)).text()).includes("owner-update-web-v2"), "offline update retains the last available Web client");
  const updatedFiles = ((await (await request("/api/files/changes?since=0")).json()) as any).files as any[];
  check(updatedFiles.some((file) => file.path === "reports/reboot.md"), "the owner-requested update preserves committed data");
  await waitFor(() => bootLines().length >= 1, "first boot marker is missing");
  const beforeBoot = bootLines().at(-1)!; await reset();
  await waitFor(async () => !(await available()), "coordinator did not stop during VM reset", 60_000);
  await waitFor(async () => (await available()) && bootLines().some((id) => id !== beforeBoot), "coordinator did not start after the VM reboot");
  await waitFor(() => {
    const log = readFileSync(serial, "utf8");
    return log.slice(log.lastIndexOf("NOOP_VM_BOOT ")).includes("NOOP_VM_PRIMARY_ACTIVE");
  }, "primary did not start after the VM reboot", process.arch === "arm64" ? 120_000 : 30_000);
  const rebootLog = readFileSync(serial, "utf8"), lastProof = rebootLog.slice(rebootLog.lastIndexOf("NOOP_VM_BOOT "));
  check(/Linger=yes/.test(lastProof) && /Sessions=\s*(?:\r?\n)/.test(lastProof), "after a new boot the service starts with linger and no user login session");
  check(lastProof.includes("NOOP_VM_PRIMARY_ACTIVE"), "the primary service also starts after the reboot");
  check((await request("/api/status")).ok, "machine credential still works after reboot");
  await waitFor(() => Math.floor(Date.now() / 30_000) > firstStep, "the next TOTP period did not arrive", 35_000);
  check((await request("/api/auth/start", "POST", { email: "second@example.com" }, "")).ok, "owner requests a login code after reboot");
  const next = ((await (await request("/api/host/login-code")).json()) as any).code;
  const after = await request("/api/auth/verify", "POST", { email: "second@example.com", code: next, totp: totp(setup.secret, Math.floor(Date.now() / 30_000)) }, "");
  check(after.ok, `owner signs in after reboot with the original TOTP secret${after.ok ? "" : `: ${await after.text()}`}`);
  const peer = join(out, "peer"), env = { ...process.env, NOOP_HOME: peer, HUB_NO_MEDIC: "1" };
  const joined = spawnSync(process.execPath, [join(source, "src", "cli.ts"), "init", "--local", base, "--token", token], { cwd: source, env, encoding: "utf8", timeout: 30_000 });
  check(joined.status === 0 && readFileSync(join(peer, "data", "reports", "reboot.md"), "utf8") === "survives reboot", "a fresh host synchronizes the persisted file after reboot");
  check(!/Bun has crashed|noop(?:-coordinator)?\.service: Failed with result/.test(readFileSync(serial, "utf8")), "neither service crashes or fails during the scenario");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (vm?.pid) { try { process.kill(-vm.pid, "SIGTERM"); } catch {} await Promise.race([new Promise<void>((done) => vm!.once("exit", () => done())), Bun.sleep(3000)]); }
  const hash = async (p: string) => { if (!existsSync(p)) return null; const h = new Bun.CryptoHasher("sha256"); for await (const chunk of Bun.file(p).stream()) h.update(chunk); return h.digest("hex"); };
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, vm: process.arch === "arm64" ? "QEMU ARM64 TCG" : "QEMU x86_64 KVM", debianImageSha256: await hash(image),
    workerdSha256: await hash(workerd), webIndexSha256: await hash(join(assets, "index.html")), checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && ["report.json", "serial.log", "user-data", "meta-data", "network-config"].includes(f.name)).map((f) => f.name);
  const sums: string[] = []; for (const file of files) sums.push(`${await hash(join(out, file))}  ${file}`);
  writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  if (!error) { rmSync(stage, { recursive: true, force: true }); for (const file of [disk, join(out, "seed.iso"), join(out, "assets.iso")]) if (existsSync(file)) rmSync(file); }
  console.log(`Evidence: ${out}`);
}
