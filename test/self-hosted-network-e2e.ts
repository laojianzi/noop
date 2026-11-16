// Run a coordinator and four independent Noop hosts on an isolated container network.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-network-e2e-"));
const repo = join(out, "repo"), network = `noop-e2e-${process.pid}`, image = process.env.NOOP_E2E_CONTAINER_IMAGE || "mcr.microsoft.com/playwright:v1.64.0-noble";
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const vm = process.env.NOOP_E2E_VM_FIXTURE || "", vmImage = process.env.NOOP_E2E_QEMU_IMAGE || "dockurr/windows:latest";
const names = ["coordinator", "primary", "worker1", "worker2", "worker3", "legacy"].map((n) => `${network}-${n}`);
const checks: string[] = [];
let createdNetwork = false, error = "";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
  checks.push(message);
  console.log(`PASS ${message}`);
}
function docker(args: string[], required = true) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  if (r.error) throw r.error;
  if (required && r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).slice(-2000)}`);
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const container = (n: string) => `${network}-${n}`;
const exec = (n: string, args: string[], required = true) => docker(["exec", container(n), ...args], required);
const cli = (n: string, args: string[], required = true) => exec(n, ["bun", "/repo/src/cli.ts", ...args], required);
async function waitFor(fn: () => boolean, message: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await Bun.sleep(250); }
  throw new Error(message);
}
async function parallel(n: string[], args: string[]) {
  return Promise.all(n.map((host) => new Promise<{ status: number | null; out: string }>((ok, fail) => {
    const p = spawn("docker", ["exec", container(host), ...args]);
    let out = "";
    p.stdout.on("data", (s) => out += s); p.stderr.on("data", (s) => out += s);
    p.on("error", fail); p.on("close", (status) => ok({ status, out }));
  })));
}

try {
  check(existsSync(join(assets, "index.html")), "real Web assets are supplied");
  check(existsSync(workerd), "workerd executable is supplied");
  check(docker(["image", "inspect", image], false).status === 0, "container image is already installed");
  if (vm) {
    check(existsSync(join(vm, "vmlinuz")) && existsSync(join(vm, "initramfs.cpio.zst")) && existsSync("/dev/kvm"), "native virtual machine fixture and KVM are available");
    const sourceCheck = spawnSync("sha256sum", ["-c", join(resolve(vm), "source.SHA256SUMS")], { cwd: source, encoding: "utf8" });
    check(sourceCheck.status === 0, "virtual machine fixture contains the source under test");
    check(createHash("sha256").update(readFileSync(join(assets, "index.html"))).digest("hex") === readFileSync(join(vm, "web.sha256"), "utf8").trim(), "virtual machine uses the supplied Web bundle");
    check(createHash("sha256").update(readFileSync(workerd)).digest("hex") === readFileSync(join(vm, "workerd.sha256"), "utf8").trim(), "virtual machine uses the supplied runtime");
    check(createHash("sha256").update(readFileSync(process.execPath)).digest("hex") === readFileSync(join(vm, "bun.sha256"), "utf8").trim(), "virtual machine uses the same Bun executable as the hosts");
    check(docker(["image", "inspect", vmImage], false).status === 0, "QEMU image is already installed");
    const disk = join(out, "state.img");
    for (const [cmd, args] of [["truncate", ["-s", "512M", disk]], ["mkfs.ext4", ["-q", "-F", disk]]] as const) {
      const result = spawnSync(cmd, args);
      if (result.status !== 0) throw new Error(`${cmd} could not prepare the isolated VM disk`);
    }
  }
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true });
  cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  writeFileSync(join(out, "action.ts"), `import { mkdirSync, writeFileSync } from "node:fs";
import { P, claim, commitPush } from "/repo/src/core";
const host = process.env.HUB_HOST!;
if (process.argv[2] === "conflict") {
  mkdirSync(P("reports"), { recursive: true });
  writeFileSync(P("reports", "network-conflict.md"), host);
  console.log("RESULT " + JSON.stringify({ ok: await commitPush(host + " conflict") }));
} else if (process.argv[2] === "claim") {
  console.log("RESULT " + JSON.stringify({ ok: !!(await claim(P("tasks", "inbox", process.argv[3]), host)) }));
} else if (process.argv[2] === "forward") {
  const { forwardEvent } = await import("/repo/src/server");
  const { loadConfig } = await import("/repo/src/core");
  console.log("RESULT " + JSON.stringify({ ok: await forwardEvent({ from: host, kind: "notice", text: "network event" }, loadConfig()) }));
} else {
  console.log("RESULT " + JSON.stringify({ ok: await commitPush(host + " config") }));
}
`);
  docker(["network", "create", "--internal", network]); createdNetwork = true;
  const common = ["--pull", "never", "--user", `${process.getuid!()}:${process.getgid!()}`, "--network", network,
    "-v", `${repo}:/repo:ro`, "-v", `${out}:/state`, "-v", `${process.execPath}:/usr/local/bin/bun:ro`,
    "-v", `${resolve(workerd)}:/usr/local/bin/workerd:ro`, "-e", "HUB_NO_MEDIC=1"];
  if (vm) docker(["run", "-d", "--pull", "never", "--network", network, "--network-alias", "coordinator", "--name", container("coordinator"),
    "--device", "/dev/kvm", "-v", `${resolve(vm)}/vmlinuz:/vm/vmlinuz:ro`, "-v", `${resolve(vm)}/initramfs.cpio.zst:/vm/initramfs.cpio.zst:ro`,
    "-v", `${out}/state.img:/vm/state.img`, "--entrypoint", "qemu-system-x86_64", vmImage, "-machine", "q35,accel=kvm", "-cpu", "host", "-m", "1024", "-smp", "2",
    "-nographic", "-no-reboot", "-kernel", "/vm/vmlinuz", "-initrd", "/vm/initramfs.cpio.zst", "-append", "console=ttyS0 loglevel=3",
    "-drive", "file=/vm/state.img,if=virtio,format=raw", "-netdev", "user,id=n0,hostfwd=tcp:0.0.0.0:8790-:8790", "-device", "e1000,netdev=n0"]);
  else docker(["run", "-d", ...common, "--hostname", "coordinator", "--network-alias", "coordinator", "--name", container("coordinator"),
    "-e", "NOOP_HOME=/state/coordinator", image, "bun", "/repo/src/cli.ts", "cloud", "deploy", "--local", "--listen", "0.0.0.0:8790"]);
  for (const n of ["primary", "worker1", "worker2", "worker3", "legacy"]) {
    docker(["run", "-d", ...common, "--hostname", n, "--name", container(n), "-e", `NOOP_HOME=/state/${n}`,
      "-e", `HUB_HOST=${n}`, "--entrypoint", "sh", image, "-c", "sleep 3600"]);
  }
  const coordinatorFile = join(out, "coordinator", "noop.toml"), base = "http://coordinator:8790";
  let token = vm ? "synthetic-vm-token-00000000000000" : "";
  await waitFor(() => {
    if (!vm && existsSync(coordinatorFile)) token = String((Bun.TOML.parse(readFileSync(coordinatorFile, "utf8")) as any).server?.token || "");
    if (token && exec("worker1", ["curl", "--max-time", "2", "-sf", "-H", `Authorization: Bearer ${token}`, `${base}/api/status`], false).status === 0) return true;
    const status = docker(["inspect", "--format", "{{.State.Running}}", container("coordinator")], false);
    if (!status.out.trim().endsWith("true")) throw new Error(`coordinator exited: ${docker(["logs", container("coordinator")], false).out}`);
    return false;
  }, "coordinator did not start");
  check(!!token && (vm || !existsSync(join(out, "coordinator", "data"))), "standalone coordinator starts without a primary or an agent");
  check(exec("worker1", ["sh", "-c", "! command -v claude && ! command -v codex"]).status === 0, "hosts do not need an agent CLI for setup");
  const denied = exec("worker1", ["env", "NOOP_HOME=/state/invalid-primary", "bun", "/repo/src/cli.ts", "init", "--primary", "--local", base, "--token", "invalid-token"], false);
  check(denied.status !== 0 && !existsSync(join(out, "invalid-primary", "data", "config.toml")), "a primary with an invalid machine credential is not initialized");
  const initialized = cli("primary", ["init", "--primary", "--local", base, "--token", token]);
  check(initialized.status === 0, "a separate primary initializes the existing local coordinator");
  const added = cli("primary", ["add", "network claim task"]), task = added.out.match(/\bT-[A-Z0-9-]+\b/)?.[0] || "";
  check(!!task, "the remote primary creates a task");
  for (const n of ["worker1", "worker2", "worker3"]) {
    cli(n, ["init", "--local", base, "--token", token]);
    check(existsSync(join(out, n, "data", "tasks", "inbox", `${task}.md`)), `${n} receives the task over the container network`);
  }
  const conflict = await parallel(["worker1", "worker2"], ["bun", "/state/action.ts", "conflict"]);
  check(conflict.every((r) => r.status === 0) && conflict.filter((r) => r.out.includes('"ok":true')).length === 1,
    "two hosts writing the same version produce one winner and one conflict");
  const claims = await parallel(["worker1", "worker2", "worker3"], ["bun", "/state/action.ts", "claim", `${task}.md`]);
  check(claims.every((r) => r.status === 0) && claims.filter((r) => r.out.includes('"ok":true')).length === 1,
    "three hosts claiming one task produce exactly one winner");

  const config = join(out, "primary", "data", "config.toml");
  writeFileSync(config, `${readFileSync(config, "utf8")}\n[cloud]\nurl = "https://advertised.invalid"\n`);
  check(exec("primary", ["bun", "/state/action.ts", "publish"]).out.includes('"ok":true'), "primary publishes a distinct advertised address");
  cli("worker1", ["init", "--local", base, "--token", token]);
  check(exec("worker1", ["bun", "/state/action.ts", "forward"]).out.includes('"ok":true'), "execution host forwards an event using its dial address");
  check(exec("worker2", ["curl", "-sf", "-H", `Authorization: Bearer ${token}`, `${base}/api/feed?since=0`]).out.includes("network event"),
    "the forwarded event is visible through the coordinator");
  const factor = cli("primary", ["2fa", "status"], false);
  check(factor.status === 0 && /2FA is not bound|还没有绑定两步验证/.test(factor.out), "authentication commands use the primary's dial address");
  const security = cli("primary", ["security", "--json"], false);
  check(!security.out.includes("Cannot reach") && !security.out.includes("连不上"), "security checks use the primary's dial address");
  const invite = cli("primary", ["guest", "invite", "synthetic guest"]);
  check(invite.out.includes("noop guest join https://advertised.invalid"), "guest administration dials locally and advertises the shared address");
  check(!cli("primary", ["status"]).out.includes("switching on the next tick"), "status does not report a local address switch");
  writeFileSync(join(out, "primary", "data", "config.local.toml"),
    '[host]\ntick_seconds = 1\n[server]\nenabled = false\n[idle]\nenabled = false\n[supervisor]\nenabled = false\n[medic]\nenabled = false\n[tunnel]\nmode = "off"\n');
  exec("primary", ["sh", "-c", "bun /repo/src/cli.ts daemon > /state/primary-daemon.log 2>&1 &"]);
  const primaryFile = join(out, "primary", "noop.toml");
  const apiStatus = () => {
    const r = exec("worker1", ["curl", "--max-time", "2", "-sf", "-H", `Authorization: Bearer ${token}`, `${base}/api/status`], false);
    try { return JSON.parse(r.out); } catch { return null; }
  };
  await waitFor(() => apiStatus()?.hub?.online === true, "primary did not connect using its machine-local address");
  check((Bun.TOML.parse(readFileSync(primaryFile, "utf8")) as any).cloud.url === base,
    "a shared advertised address does not replace the primary's dial address");
  check(apiStatus()?.hub?.online === true, "the primary bridge reaches the coordinator over its dial address");
  cli("legacy", ["init", base, "--token", token]);
  exec("legacy", ["sh", "-c", "bun /repo/src/cli.ts daemon > /state/legacy-daemon.log 2>&1 &"]);
  const legacyFile = join(out, "legacy", "noop.toml");
  await waitFor(() => (Bun.TOML.parse(readFileSync(legacyFile, "utf8")) as any).cloud.url === "https://advertised.invalid", "cloud mode did not retain automatic address adoption");
  check(true, "cloud mode retains automatic adoption of the shared address");

  docker(["stop", "-t", "5", container("coordinator")]);
  const offline = cli("primary", ["add", "queued while disconnected"]);
  const offlineTask = offline.out.match(/\bT-[A-Z0-9-]+\b/)?.[0] || "";
  check(!!offlineTask, "the primary retains a task created during disconnection");
  docker(["start", container("coordinator")]);
  await waitFor(() => apiStatus() !== null, "coordinator did not restart");
  const recovered = exec("worker2", ["env", "NOOP_HOME=/state/recovered", "bun", "/repo/src/cli.ts", "init", "--local", base, "--token", token], false);
  check(recovered.status === 0 && existsSync(join(out, "recovered", "data", "tasks", "active", `${task}.md`)) &&
    existsSync(join(out, "recovered", "data", "reports", "network-conflict.md")), "a fresh host recovers previously committed files and the claimed task");
  await waitFor(() => {
    const r = cli("worker3", ["init", "--local", base, "--token", token], false);
    return r.status === 0 && existsSync(join(out, "worker3", "data", "tasks", "inbox", `${offlineTask}.md`));
  }, "hosts did not resume synchronization", 45_000);
  check(true, "hosts resume synchronization after the coordinator reconnects");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e);
  console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  for (const name of names) {
    const r = docker(["logs", name], false);
    if (r.status === 0) writeFileSync(join(out, `${name.slice(network.length + 1)}.log`), r.out);
  }
  docker(["rm", "-f", ...names], false);
  if (createdNetwork) docker(["network", "rm", network], false);
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, image, imageId: docker(["image", "inspect", "--format", "{{.Id}}", image], false).out.trim(),
    coordinator: vm && existsSync(join(vm, "vmlinuz")) && existsSync(join(vm, "initramfs.cpio.zst")) ? { kind: "KVM virtual machine", image: vmImage, imageId: docker(["image", "inspect", "--format", "{{.Id}}", vmImage], false).out.trim(),
      qemuVersion: docker(["run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "qemu-system-x86_64", vmImage, "--version"], false).out.split("\n")[0],
      kernel: existsSync(join(vm, "kernel.txt")) ? readFileSync(join(vm, "kernel.txt"), "utf8").trim() : "unknown",
      kernelSha256: createHash("sha256").update(readFileSync(join(vm, "vmlinuz"))).digest("hex"),
      initramfsSha256: createHash("sha256").update(readFileSync(join(vm, "initramfs.cpio.zst"))).digest("hex") } : { kind: "container" },
    webIndexSha256: existsSync(join(assets, "index.html")) ? createHash("sha256").update(readFileSync(join(assets, "index.html"))).digest("hex") : null,
    workerdVersion: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing",
    workerdSha256: existsSync(workerd) ? createHash("sha256").update(readFileSync(workerd)).digest("hex") : null, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS" && f.name !== "state.img").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
