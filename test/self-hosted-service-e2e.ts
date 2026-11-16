// Run only on a disposable host or VM: this installs a user system service.
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-service-e2e-"));
const repo = join(out, "repo with spaces"), home = join(out, "coordinator home"), bin = join(out, "bin with spaces");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", token = "synthetic-service-machine-token-000";
const unit = process.platform === "linux" ? join(homedir(), ".config", "systemd", "user", "noop-coordinator.service") : join(homedir(), "Library", "LaunchAgents", "dev.noop.coordinator.plist");
const checks: string[] = [];
let error = "", installed = false;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) { value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
async function waitFor(fn: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 30_000; while (Date.now() < end) { if (await fn()) return; await Bun.sleep(200); } throw new Error(message);
}
try {
  check(process.env.NOOP_E2E_DISPOSABLE === "1" && !existsSync(unit), "test runs on a disposable host without an existing coordinator service");
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "real Web assets and native workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd")); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const cli = (args: string[], testHome = home) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env: { ...env, NOOP_HOME: testHome }, encoding: "utf8", timeout: 45_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const available = async () => { try { return (await fetch(base)).ok; } catch { return false; } };
  const result = cli(["cloud", "service", "install", "--listen", `127.0.0.1:${listenPort}`]);
  installed = existsSync(unit);
  const managerLog = process.platform === "linux" ? spawnSync("journalctl", ["--user", "-u", "noop-coordinator.service", "-n", "100", "--no-pager", "-o", "cat"], { env, encoding: "utf8" }).stdout || "" :
    existsSync(join(home, "coordinator", "service.log")) ? readFileSync(join(home, "coordinator", "service.log"), "utf8") : "";
  writeFileSync(join(out, "install.log"), result.out + managerLog);
  check(result.status === 0 && installed, `native service installs successfully: ${result.out.slice(-1500)} ${managerLog.slice(-1500)}`);
  await waitFor(available, "installed service did not serve the real Web client");
  const status = cli(["cloud", "service", "status"]);
  check(status.status === 0 && /running|active/i.test(status.out), "service status reports the actual running state");
  if (process.platform === "linux") {
    const user = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
    const linger = spawnSync("loginctl", ["show-user", user, "-p", "Linger", "--value"], { encoding: "utf8" });
    const enabled = spawnSync("systemctl", ["--user", "is-enabled", "noop-coordinator.service"], { env, encoding: "utf8" });
    check(linger.status === 0 && linger.stdout.trim() === "yes" && enabled.status === 0, "Linux service is enabled with linger active");
  } else {
    const info = spawnSync("launchctl", ["print", `gui/${process.getuid!()}/dev.noop.coordinator`], { env, encoding: "utf8" });
    check(info.status === 0, "macOS service is loaded in the logged-in user's launchd domain");
  }
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "owner binds TOTP through the installed service");
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  check((await post("/api/auth/start", { email: "owner@example.com" })).ok, "owner requests a CLI login code");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const auth = await post("/api/auth/verify", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) });
  const session = ((await auth.json()) as any).session; check(auth.ok && !!session, "owner signs in without SMTP");
  const primary = cli(["init", "--primary"]), added = cli(["add", "service acceptance task"]), task = added.out.match(/\bT-[A-Z0-9-]+\b/)?.[0] || "";
  check(primary.status === 0 && added.status === 0 && !!task, "primary creates a shared task through the installed service");
  const peer = join(out, "peer home"), joined = cli(["init", base, "--token", token], peer);
  check(joined.status === 0 && existsSync(join(peer, "data", "tasks", "inbox", `${task}.md`)), "an independent host synchronizes the task");
  check(cli(["cloud", "service", "stop"]).status === 0, "native service stops");
  await waitFor(async () => !(await available()), "service remained reachable after stop");
  const stopped = cli(["cloud", "service", "status"]);
  check(stopped.status !== 0 || /inactive|stopped|not running/i.test(stopped.out), "status reports that the service is stopped");
  const keyFile = join(home, "coordinator", "namespace-key"), namespace = readFileSync(keyFile, "utf8");
  writeFileSync(keyFile, "invalid namespace");
  check(cli(["cloud", "service", "start"]).status !== 0, "service start reports an invalid namespace");
  writeFileSync(keyFile, namespace);
  check(cli(["cloud", "service", "start"]).status === 0, "native service restarts after the namespace is repaired");
  await waitFor(available, "restarted service is not reachable");
  const feed = await fetch(base + "/api/feed", { headers: { authorization: `Bearer ${session}` } });
  check(feed.ok && existsSync(join(peer, "data", "tasks", "inbox", `${task}.md`)), "owner session and task survive a service restart");
  const logs = cli(["cloud", "service", "logs"]); writeFileSync(join(out, "service-manager.log"), logs.out);
  check(logs.status === 0 && /Local coordinator candidate|namespace key is invalid/i.test(logs.out), "service logs show startup and configuration errors");
  check(cli(["cloud", "service", "stop"]).status === 0, "service can be stopped after verification");
  await waitFor(async () => !(await available()), "service remained reachable after final stop");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (installed) {
    const env = { ...process.env, NOOP_HOME: home, PATH: `${bin}:${process.env.PATH || ""}` };
    if (process.platform === "linux") {
      spawnSync("systemctl", ["--user", "disable", "--now", "noop-coordinator.service"], { env });
      if (existsSync(unit)) unlinkSync(unit); spawnSync("systemctl", ["--user", "daemon-reload"], { env });
    } else {
      spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}`, unit], { env }); if (existsSync(unit)) unlinkSync(unit);
    }
  }
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, webVersion: process.env.NOOP_E2E_WEB_VERSION || "not specified", webIndexSha256: hash(join(assets, "index.html")),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) }, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
