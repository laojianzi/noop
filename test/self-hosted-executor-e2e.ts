// The real local coordinator and primary run against executable test doubles.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "..");
const out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-executors-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), noopHome = join(home, ".noop");
const assets = process.env.NOOP_E2E_WEB_ASSETS, workerd = process.env.NOOP_E2E_WORKERD;
const token = "synthetic-executor-e2e-machine-token";
const children: ChildProcess[] = [], checks: string[] = [];
const env = { HOME: home, NOOP_HOME: noopHome, HUB_HOST: "executor-e2e", PATH: bin + ":/usr/bin:/bin",
  NOOP_EXECUTOR_FIXTURE: out, HUB_NO_MEDIC: "1", LANG: "C.UTF-8" };
type Call = { cli: string; account: string; stage: string; task?: string };

const check = (message: string) => { checks.push(message); console.log("PASS", message); };
const calls = (): Call[] => readFileSync(join(out, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

async function freePort() {
  const socket = createServer();
  await new Promise<void>((ok, fail) => socket.once("error", fail).listen(0, "127.0.0.1", ok));
  const address = socket.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((ok) => socket.close(() => ok()));
  return address.port;
}

const coordinator = await freePort(), primary = await freePort();
const hub = "http://127.0.0.1:" + coordinator, local = "http://127.0.0.1:" + primary;
const request = (base: string, route: string, method = "GET", body?: unknown) => fetch(base + route, {
  method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
});
const argsFor = (args: string[]) => [join(repo, "src/cli.ts"), ...args];
function start(name: string, ...args: string[]) {
  const fd = openSync(join(out, name + ".log"), "a");
  children.push(spawn(process.execPath, argsFor(args), { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }));
  closeSync(fd);
}
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, argsFor(args), { cwd: repo, env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}
async function until<T>(why: string, fn: () => Promise<T | false> | T | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(120);
  }
  throw new Error(why);
}
const ready = async (base: string) => { try { return (await request(base, "/api/status")).ok; } catch { return false; } };
const save = async (change: Record<string, unknown>) => {
  const r = await request(local, "/api/settings", "PUT", change);
  assert.equal(r.status, 200, await r.clone().text());
  return await r.json() as { effective: { agents: { id: string; clis: string[] }[] } };
};
const add = (title: string, ...extra: string[]) => {
  const id = cli("add", title, ...extra).match(/\bT-\d+\b/)?.[0];
  assert(id);
  return id;
};
const task = async (id: string) => {
  const r = await request(local, "/api/tasks/get?id=" + id);
  return r.ok ? await r.json() as { state?: string; cli?: string } : {};
};
const taskCalls = (id: string) => calls().filter(call => call.stage === "task" && call.task === id).map(call => call.cli + "/" + call.account);
const configPath = join(noopHome, "data/config.local.toml");
const fixtureConfig = `[fleet]
primary = "executor-e2e"
plan_wait_minutes = 0
[host]
tick_seconds = 1
[server]
host = "127.0.0.1"
port = ${primary}
[router]
cli = "codex"
[owner]
language = "en"
[idle]
enabled = false
[supervisor]
enabled = false
[tunnel]
mode = "off"
[judge]
enabled = false
[resources]
work_dirs = []
disk_min_gb = 0.01
disk_hard_min_gb = 0.001
disk_min_pct = 0.01
mem_min_pct = 0.01
load_mid = 100
load_high = 101
`;
function accounts(...entries: [string, string, string?][]) {
  const list = entries.map(([executor, name, fault]) => {
    if (fault) writeFileSync(join(out, name + ".fault"), fault);
    return `[[accounts]]\ncli = "${executor}"\nname = "${name}"\ndir = ${JSON.stringify(join(out, name))}\n`;
  });
  writeFileSync(configPath, fixtureConfig + list.join(""));
}
const quota = '{"status":"failed","summary":"rate limit, try again in 1h"}';
const auth = '{"status":"failed","summary":"not logged in"}';
let error = "";
try {
  assert(assets && workerd, "Set NOOP_E2E_WEB_ASSETS and NOOP_E2E_WORKERD");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: p => !/\/(node_modules|dist)(\/|$)/.test(p) });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app/dist/web"), { recursive: true });
  cpSync(assets, join(repo, "app/dist/web/noop"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(noopHome, { recursive: true });
  symlinkSync(resolve(workerd), join(bin, "workerd"));
  writeFileSync(join(out, "calls.jsonl"), "");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  for (const executor of ["codex", "claude"])
    writeFileSync(join(bin, executor), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(source, "test/fixtures/executor-cli.ts"))} ${executor} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(noopHome, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  start("coordinator", "cloud", "deploy", "--local", "--listen", "127.0.0.1:" + coordinator);
  await until("coordinator did not start", () => ready(hub));
  cli("init", "--primary", "--local", hub, "--token", token);
  accounts(["codex", "codex-limited", quota], ["claude", "claude-available"]);
  start("primary", "daemon");
  await until("primary did not start", () => ready(local));
  const config = await save({ clis: { agents: { lead: ["codex"] } } });
  assert.deepEqual(config.effective.agents.find((a: {id: string}) => a.id === "lead")?.clis, ["codex"]);
  const onlyCodex = add("Codex only remains queued");
  await until("Codex did not try the task", () => taskCalls(onlyCodex).length > 0);
  await until("task neither completed nor returned to inbox", async () => ["done", "inbox"].includes((await task(onlyCodex)).state ?? ""));
  assert.deepEqual(taskCalls(onlyCodex), ["codex/codex-limited"], "the task must not escape its member selection");
  assert.equal((await task(onlyCodex)).state, "inbox");
  check("Codex-only member task queues when its account runs out");

  await request(local, "/api/tasks/cancel", "POST", { id: onlyCodex });
  accounts(["codex", "codex-available"], ["claude", "claude-expired", auth]);
  await save({ clis: { agents: { lead: ["codex", "claude"] } } });
  const pinned = add("Explicit Claude stays on Claude", "--cli", "claude");
  await until("Claude did not try the pinned task", () => taskCalls(pinned).length > 0);
  await until("pinned task did not finish or requeue", async () => ["done", "inbox"].includes((await task(pinned)).state ?? ""));
  assert.deepEqual(taskCalls(pinned), ["claude/claude-expired"]);
  assert.equal((await task(pinned)).state, "inbox");
  await request(local, "/api/tasks/cancel", "POST", { id: pinned });
  check("explicit task choice takes priority and stays on one executor");

  for (const [first, second] of [["codex", "claude"], ["claude", "codex"]]) {
    accounts([first, first + "-ordered", quota], [first, first + "-second", quota], [second, second + "-good"]);
    await save({ clis: { agents: { lead: [first, second] } } });
    const id = add(first + " then " + second);
    await until("ordered task did not finish", async () => (await task(id)).state === "done");
    assert.deepEqual(taskCalls(id), [first + "/" + first + "-ordered", first + "/" + first + "-second", second + "/" + second + "-good"]);
    assert.equal((await task(id)).cli, second);
    check(first + " preferred order includes accounts then the allowed alternate");
  }
} catch (err) {
  error = err instanceof Error ? err.stack || err.message : String(err);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  writeFileSync(join(out, "report.json"), JSON.stringify({ revision, checks, error, calls: readdirSync(out).includes("calls.jsonl") ? calls() : [] }, null, 2) + "\n");
  console.log("Evidence:", out);
}
