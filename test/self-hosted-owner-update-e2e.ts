// Exercise owner updates with real Git, a primary daemon and a local coordinator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-owner-update-"));
const repo = join(out, "repo"), home = join(out, "home"), noopHome = join(home, ".noop"), bin = join(out, "bin");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const token = "synthetic-owner-update-machine-token-000", checks: string[] = [], children: ChildProcess[] = [];
let error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function run(cmd: string, args: string[], cwd = repo, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout.trim();
}
function start(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const fd = openSync(join(out, `${name}.log`), "a");
  const child = spawn(process.execPath, [join(repo, "src/cli.ts"), ...args], { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd); children.push(child); return child;
}
async function waitFor(fn: () => boolean | Promise<boolean>, message: string, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await Bun.sleep(100); }
  throw new Error(message);
}
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) { value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "real Web assets and workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"]) cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json", "bun.lock"]) if (existsSync(join(source, name))) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app/dist/web"), { recursive: true }); cpSync(assets, join(repo, "app/dist/web/noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); mkdirSync(noopHome, { recursive: true });
  symlinkSync(resolve(workerd), join(bin, "workerd"));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // Tests and dependency installation are controlled; Git fetch, merge and both Noop processes are real.
  writeFileSync(join(bin, "bun"), `#!/bin/sh\ncase "$1" in install) exit 0;; test) [ ! -f "$NOOP_TEST_DIR/fail-tests" ]; exit $?;; esac\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, NOOP_HOME: noopHome, HUB_HOST: "owner-test", HUB_NO_MEDIC: "1", NOOP_TEST_DIR: out, PATH: `${bin}:${process.env.PATH || ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const key of ["HUB_DATA", "HUB_CONF", "HUB_SYNC", "HUB_SYNC_FAKE", "NOOP_CLIENT_BASE_URL"]) delete (env as NodeJS.ProcessEnv)[key];
  run("git", ["init", "-q", "-b", "test"], repo, env); run("git", ["config", "user.email", "test@example.invalid"], repo, env);
  run("git", ["config", "user.name", "Noop test"], repo, env); run("git", ["add", "."], repo, env); run("git", ["commit", "-qm", "initial"], repo, env);
  const initial = run("git", ["rev-parse", "HEAD"], repo, env);
  run("git", ["clone", "-q", "--bare", repo, join(out, "origin.git")], out, env); run("git", ["remote", "add", "origin", join(out, "origin.git")], repo, env);
  run("git", ["fetch", "-q", "origin"], repo, env); run("git", ["branch", "--set-upstream-to=origin/test"], repo, env);
  writeFileSync(join(noopHome, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  const socket = createServer(); await new Promise<void>((ok, fail) => socket.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = (socket.address() as { port: number }).port; await new Promise<void>((ok) => socket.close(() => ok()));
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown, credential = token) => fetch(base + path, { method,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  start("coordinator", ["cloud", "deploy", "--local", "--listen", `127.0.0.1:${port}`], env);
  await waitFor(async () => { try { return (await request("/api/status")).ok; } catch { return false; } }, "foreground coordinator did not start");
  run(process.execPath, [join(repo, "src/cli.ts"), "init", "--primary", "--local", base, "--token", token], repo, env);
  writeFileSync(join(noopHome, "data/config.local.toml"), `[fleet]\nprimary = "owner-test"\n[host]\ntick_seconds = 1\n[server]\nenabled = false\n[router]\ncli = "not-installed"\n[idle]\nenabled = false\n[supervisor]\nenabled = false\n[medic]\nenabled = false\n[tunnel]\nmode = "off"\n`);
  const setup = await (await request("/api/host/2fa/setup", "POST", {})).json() as any;
  check((await request("/api/host/2fa/confirm", "POST", { totp: totp(setup.secret, Math.floor(Date.now() / 30_000) - 1) })).ok, "owner configures authentication");
  check((await request("/api/auth/start", "POST", { email: "owner@example.invalid" }, "")).ok, "owner requests a login code");
  const code = ((await (await request("/api/host/login-code")).json()) as any).code;
  const login = await request("/api/auth/verify", "POST", { email: "owner@example.invalid", code, totp: totp(setup.secret, Math.floor(Date.now() / 30_000)) }, "");
  const session = ((await login.json()) as any).session; check(login.ok && session, "owner signs in");
  const daemon = start("primary", ["daemon"], env);
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; return s.hosts?.some((h: any) => h.host === "owner-test"); } catch { return false; } }, "primary did not publish a heartbeat");
  writeFileSync(join(repo, "update-fixture.txt"), "new code\n"); run("git", ["add", "update-fixture.txt"], repo, env); run("git", ["commit", "-qm", "new version"], repo, env);
  const next = run("git", ["rev-parse", "HEAD"], repo, env); run("git", ["push", "-q", "origin", "test"], repo, env); run("git", ["reset", "--hard", "-q", initial], repo, env);
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner requests a real Git update");
  await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null || (existsSync(join(noopHome, "update-state.json")) && JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).state === "failed"), "primary did not complete its update");
  check(run("git", ["rev-parse", "HEAD"], repo, env) === next, "Git switched to the new revision");
  check(daemon.exitCode === 0, "a foreground coordinator does not prevent the updated primary from restarting");
  check((await request("/api/status")).ok, "foreground coordinator remains available");

  // A service definition with no release simulates an installed service that cannot update.
  const unit = join(home, ".config/systemd/user/noop-coordinator.service"); mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unit, `# noop-home:${Buffer.from(noopHome).toString("base64")}\n`);
  const failing = start("primary-failing-service", ["daemon"], env);
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; return s.hosts?.some((h: any) => h.host === "owner-test" && h.rev === next); } catch { return false; } }, "restarted primary did not publish the new revision");
  writeFileSync(join(repo, "update-fixture.txt"), "another version\n"); run("git", ["add", "update-fixture.txt"], repo, env); run("git", ["commit", "-qm", "another version"], repo, env);
  const third = run("git", ["rev-parse", "HEAD"], repo, env); run("git", ["push", "-q", "origin", "test"], repo, env); run("git", ["reset", "--hard", "-q", next], repo, env);
  const previousAt = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).at;
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner requests an update with a failing managed service");
  await waitFor(() => {
    try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== previousAt && s.state === "failed"; } catch { return false; }
  }, "coordinator update failure was not reported");
  await waitFor(() => failing.exitCode !== null, "primary did not restart after its code changed", 5000);
  check(failing.exitCode === 0 && run("git", ["rev-parse", "HEAD"], repo, env) === third, "a coordinator failure still restarts the primary on the switched revision");
  const retried = start("primary-retry", ["daemon"], env);
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; return s.hosts?.some((h: any) => h.host === "owner-test" && h.rev === third); } catch { return false; } }, "primary did not publish the switched revision after the failure");
  run("git", ["config", "core.abbrev", "12"], repo, env);
  const failedAt = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).at;
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner can request the coordinator update again");
  await waitFor(() => {
    try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== failedAt && s.state === "failed"; } catch { return false; }
  }, "coordinator retry was not reported");
  const retryState = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8"));
  check(/协调服务更新失败|Coordinator update failed/.test(retryState.detail) && retried.exitCode === null, "retry reaches the coordinator instead of rejecting the running revision");

  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprompt=$(cat)\nif printf '%s' "$prompt" | grep -q 'You place tasks'; then\n  printf '\`\`\`json\\n{}\\n\`\`\`\\n'\nelif printf '%s' "$prompt" | grep -q '^# Task T-[0-9]*: LONG work'; then\n  touch "$NOOP_TEST_DIR/agent-running"\n  while [ ! -f "$NOOP_TEST_DIR/agent-release" ]; do sleep .2; done\n  printf '\`\`\`json\\n{"status":"done","summary":"finished"}\\n\`\`\`\\n'\nelif printf '%s' "$prompt" | grep -q '^# Task T-[0-9]*: ASKME work'; then\n  printf '\`\`\`json\\n{"status":"needs_decision","summary":"ready","question":"Proceed?","options":["A: yes","B: no"]}\\n\`\`\`\\n'\nelse\n  printf '\`\`\`json\\n{"status":"done","summary":"finished"}\\n\`\`\`\\n'\nfi\n`, { mode: 0o755 });
  const config = join(noopHome, "data/config.local.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace('primary = "owner-test"', 'primary = "owner-test"\nplan_wait_minutes = 0').replace("tick_seconds = 1", "tick_seconds = 1\nmax_parallel = 3") + `\n[resources]\nwork_dirs = []\ndisk_min_gb = 0.01\ndisk_hard_min_gb = 0.001\ndisk_min_pct = 0.01\nmem_min_pct = 0.01\nload_mid = 100\nload_high = 101\n[clis.claude]\ncommand = [${JSON.stringify(join(bin, "claude"))}]\n[judge]\nenabled = false\n`);
  const longTask = run(process.execPath, [join(repo, "src/cli.ts"), "add", "LONG work", "--cli", "claude"], repo, env).match(/\bT-\d+\b/)?.[0] || "";
  check(!!longTask, "owner creates a long-running task");
  run(process.execPath, [join(repo, "src/cli.ts"), "add", "ASKME work", "--cli", "claude"], repo, env);
  await waitFor(() => existsSync(join(out, "agent-running")), "long-running task did not start");
  let decision = "";
  await waitFor(async () => { try { const s = await (await request("/api/status")).json() as any; decision = s.decisions?.find((d: any) => d.question === "Proceed?")?.id || ""; return !!decision; } catch { return false; } }, "decision was not published");
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner requests an update while work is running");
  await waitFor(() => { try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== retryState.at && s.state === "waiting"; } catch { return false; } }, "update did not wait for the running task");
  check((await request("/api/push/answer", "POST", { ref: decision, answer: "A" }, session)).ok, "owner answers a decision during the update wait");
  const queuedTask = run(process.execPath, [join(repo, "src/cli.ts"), "add", "new queued work", "--cli", "claude"], repo, env).match(/\bT-\d+\b/)?.[0] || "";
  check(!!queuedTask, "owner creates work while the primary drains");
  await waitFor(() => existsSync(join(noopHome, "data/decisions/closed", `${decision}.md`)), "primary did not process the answer while work was running", 8000);
  check(!existsSync(join(out, "agent-release")) && existsSync(join(noopHome, "data/tasks/active", `${longTask}.md`)), "primary processes the answer before the long-running task finishes");
  await Bun.sleep(2500);
  check(existsSync(join(noopHome, "data/tasks/inbox", `${queuedTask}.md`)), "the draining primary does not start new work");
  writeFileSync(join(out, "agent-release"), "done\n");
  await waitFor(() => { try { return JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).state === "failed"; } catch { return false; } }, "coordinator failure was not reported after work finished");
  check(retried.exitCode === null, "a failed coordinator update with unchanged primary code leaves the daemon running");
  await waitFor(() => existsSync(join(noopHome, "data/tasks/done", `${queuedTask}.md`)), "primary did not resume new work after the failed update");
  check(true, "primary resumes new work after the failed update");
  unlinkSync(join(out, "agent-running")); unlinkSync(join(out, "agent-release"));
  run(process.execPath, [join(repo, "src/cli.ts"), "add", "LONG work", "--cli", "claude"], repo, env);
  await waitFor(() => existsSync(join(out, "agent-running")), "second long-running task did not start");
  const lastAt = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).at;
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner requests an update before a service stop");
  await waitFor(() => { try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== lastAt && s.state === "waiting"; } catch { return false; } }, "second update did not wait for work");
  retried.kill("SIGTERM"); await Bun.sleep(500); writeFileSync(join(out, "agent-release"), "done\n");
  await waitFor(() => retried.exitCode !== null, "the service stop was lost during the update", 15_000);
  check(retried.exitCode === 0, "a stop requested during an update exits after running work finishes");
  const validating = start("primary-rejected-version", ["daemon"], env);
  await waitFor(() => readFileSync(join(out, "primary-rejected-version.log"), "utf8").includes("cloud bridge"), "primary did not restart for the rejected-version case");
  await Bun.sleep(1200);
  writeFileSync(join(repo, "update-fixture.txt"), "invalid version\n"); run("git", ["add", "update-fixture.txt"], repo, env); run("git", ["commit", "-qm", "invalid version"], repo, env);
  run("git", ["push", "-q", "origin", "test"], repo, env); run("git", ["reset", "--hard", "-q", third], repo, env);
  writeFileSync(join(out, "fail-tests"), "fail\n");
  const beforeRejected = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")).at;
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner requests an update whose code validation fails");
  await waitFor(() => { try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== beforeRejected && (s.state === "failed" || s.state === "current"); } catch { return false; } }, "rejected update was not reported");
  const rejected = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8"));
  check(rejected.state === "failed" && /测试没通过|failing tests/.test(rejected.detail) && validating.exitCode === null && run("git", ["rev-parse", "HEAD"], repo, env) === third,
    "a rejected code version is rolled back and reported without updating the coordinator");
  unlinkSync(join(out, "fail-tests")); unlinkSync(join(out, "agent-running")); unlinkSync(join(out, "agent-release"));
  run(process.execPath, [join(repo, "src/cli.ts"), "add", "LONG work", "--cli", "claude"], repo, env);
  await waitFor(() => existsSync(join(out, "agent-running")), "task for the status-write failure did not start");
  check((await request("/api/fleet/update", "POST", {}, session)).ok, "owner retries the fixed code while work runs");
  await waitFor(() => { try { const s = JSON.parse(readFileSync(join(noopHome, "update-state.json"), "utf8")); return s.at !== rejected.at && s.state === "waiting"; } catch { return false; } }, "retried update did not wait for work");
  const stateFile = join(noopHome, "update-state.json"); unlinkSync(stateFile); mkdirSync(stateFile);
  writeFileSync(join(out, "agent-release"), "done\n");
  await waitFor(() => validating.exitCode !== null, "primary remained stuck after an update status write failed", 15_000);
  check(validating.exitCode === 0, "primary restarts after switched code even if the update status cannot be written");
} catch (e) { error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1; }
finally {
  for (const child of children) if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Bun.sleep(300);
  for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch {}
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  const changes = spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim();
  const hash = async (file: string) => { if (!existsSync(file)) return null; const h = new Bun.CryptoHasher("sha256"); for await (const chunk of Bun.file(file).stream()) h.update(chunk); return h.digest("hex"); };
  writeFileSync(join(out, "report.json"), JSON.stringify({ status: error ? "failed" : "passed", source, revision, changes, platform: `${process.platform}-${process.arch}`, bun: Bun.version,
    workerdSha256: await hash(workerd), webIndexSha256: await hash(join(assets, "index.html")), checks, error }, null, 2) + "\n");
  const files = readdirSync(out).filter((f) => f.endsWith(".log") || f === "report.json");
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
