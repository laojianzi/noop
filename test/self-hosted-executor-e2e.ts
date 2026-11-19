// The real local coordinator and primary run against executable test doubles.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { BUILTIN_ROUTINES } from "../src/builtin-routines";
import { b32decode, hotp, stepAt } from "../cloud/src/totp";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "..");
const out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-executors-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), noopHome = join(home, ".noop");
const mode = Bun.argv[2] ?? "--tasks";
const assets = process.env.NOOP_E2E_WEB_ASSETS, workerd = process.env.NOOP_E2E_WORKERD;
const token = "synthetic-executor-e2e-machine-token";
const children: ChildProcess[] = [], checks: string[] = [];
const env: Record<string, string> = { HOME: home, NOOP_HOME: noopHome, HUB_HOST: "executor-e2e", PATH: bin + ":/usr/bin:/bin",
  NOOP_EXECUTOR_FIXTURE: out, LANG: "C.UTF-8" };
if (mode === "--real") {
  assert(process.env.NOOP_E2E_REAL_CODEX && process.env.NOOP_E2E_CODEX_HOME, "Supply the authorized Codex binary and isolated login for real acceptance");
  env.NOOP_E2E_REAL_CODEX = process.env.NOOP_E2E_REAL_CODEX;
  env.CODEX_HOME = process.env.NOOP_E2E_CODEX_HOME;
}
type Call = { cli: string; account: string; stage: string; task?: string; model?: string; pid: number; mcpDisabled: boolean };

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
  return await r.json() as { effective: { agents: { id: string; clis: string[] }[]; internalClis?: string[] | null } };
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
cli = "${mode === "--tasks" ? "codex" : "claude"}"
model = "legacy-claude-model"
timeout_seconds = ${mode === "--real" ? 45 : 8}
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
[medic]
enabled = false
push = false
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
let error = "", browser: any;
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
  const seeded = Bun.TOML.parse(readFileSync(join(noopHome, "data/config.toml"), "utf8")) as { routine?: { name: string }[] };
  const routines = Object.fromEntries([...BUILTIN_ROUTINES, ...(seeded.routine ?? [])].map(r => [r.name, { enabled: false }]));
  writeFileSync(join(noopHome, "data/settings.json"), JSON.stringify({ routines }));
  if (mode === "--web" || mode === "--real") {
    accounts();
    if (mode === "--real") writeFileSync(configPath, fixtureConfig + '\n[clis.codex]\nmodel = "gpt-6-luna"\n');
    start("primary", "daemon");
    await until("primary did not start", () => ready(local));
    const setup = await (await request(hub, "/api/host/2fa/setup", "POST", {})).json() as { secret: string };
    const secret = b32decode(setup.secret);
    assert((await request(hub, "/api/host/2fa/confirm", "POST", { totp: await hotp(secret, stepAt() - 1) })).ok);
    const { chromium } = await import(process.env.NOOP_E2E_PLAYWRIGHT ?? "playwright-core");
    browser = await chromium.launch({ executablePath: process.env.NOOP_E2E_BROWSER || Bun.which("chromium") || undefined, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === hub ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(hub, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("you@example.com").fill("executor-owner@example.invalid");
    await page.getByTestId("send-code").click();
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll("input").length >= 2);
    const { code } = await (await request(hub, "/api/host/login-code")).json() as {code: string};
    await page.locator("input").nth(0).fill(code);
    await page.locator("input").nth(1).fill(await hotp(secret, stepAt()));
    const input = page.getByPlaceholder(/Tell the team what to do|给团队下指令/);
    await input.waitFor({ timeout: 30_000 });
    const settings = await context.newPage();
    await settings.goto(hub, { waitUntil: "domcontentloaded" });
    await settings.getByTestId("user-menu").click({ timeout: 30_000 });
    await settings.getByTestId("settings").click();
    await settings.getByTestId("settings-tab-members").click();
    const control = settings.getByTestId("internal-executor");
    const options = mode === "--real" ? [["codex"]] : [["claude"], ["claude", "codex"], ["codex", "claude"], ["codex"]];
    for (const list of options) {
      await control.click();
      const id = list.join(",");
      const patchApplied = settings.waitForResponse((r: any) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
      await settings.getByTestId("internal-executor-" + id).click();
      assert.equal((await patchApplied).status(), 200);
      const label = id === "codex" ? /Codex only|仅 Codex/ : id === "claude" ? /Claude only|仅 Claude/ : new RegExp(list[0] + ".*→.*" + list[1], "i");
      await control.getByText(label).waitFor();
      await until("primary did not acknowledge setting", async () => {
        const view = await (await request(hub, "/api/settings")).json() as { effective?: { internalClis?: string[] } };
        return view.effective?.internalClis?.join(",") === id;
      });
    }
    await settings.screenshot({ path: join(out, "settings.png") });
    check("Web settings display the primary's acknowledged executor selection");
    const invalid = await request(hub, "/api/settings", "PUT", { clis: { internal: [] } });
    assert.equal(invalid.status, 400);
    const say = async (text: string) => {
      await input.fill(text);
      await input.press("Enter");
    };
    if (mode === "--real") {
      await say('Call the Noop list_tasks read tool first. After receiving tool results, reply with exactly NOOP-REAL-CODEX-READ. Do not create a task.');
      await page.getByText("NOOP-REAL-CODEX-READ", { exact: true }).waitFor({ timeout: 60_000 });
      const brain = readFileSync(join(noopHome, "brain.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert(brain.some(row => row.executor === "codex" && row.rounds >= 2 && row.calls.some((c: any) => c.tool === "list_tasks" && c.ok)));
      assert(calls().filter(c => c.stage === "chat").every(c => c.mcpDisabled), "the profile must define the noop_probe MCP server");
      assert(!existsSync(join(env.CODEX_HOME!, "noop-mcp-probe-started")), "Codex did not launch an MCP server in the Web conversation");
      const project = join(out, "acceptance-project");
      mkdirSync(project);
      writeFileSync(join(project, "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
      const verifySum = () => spawnSync(process.execPath, ["-e",
        'import { sum } from "./sum.ts"; if (sum(2, 3) !== 5 || sum(-2, 1) !== -1) process.exit(1);',
      ], { cwd: project, encoding: "utf8" });
      assert.equal(verifySum().status, 1, "the fixture must fail before the repair");
      const id = add("Fix the addition helper", "--cli", "codex", "--repo", project, "--body",
        'In this directory, fix sum.ts so sum(a, b) adds the two numbers. Edit only that file and finish with a JSON result with status "done".');
      await until("real Codex task did not finish", async () => (await task(id)).state === "done", 120_000);
      assert.equal((await task(id)).cli, "codex");
      const verified = verifySum();
      assert.equal(verified.status, 0, verified.stderr);
      const measurements = readFileSync(join(out, "real-codex.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const turns = measurements.filter(m => m.stage === "chat");
      assert(turns.length >= 2 && turns.every(m => m.code === 0 && m.tools.length === 0 && m.usage));
      assert(calls().some(c => c.stage === "task" && c.cli === "codex" && c.model === "gpt-6-luna"));
      check("real Codex replied, used the Noop read tool and fixed the task's code");
    } else {
      await say("Read a task first");
      await page.getByText("Fixture used task data", { exact: true }).waitFor({ timeout: 20_000 });
      writeFileSync(join(out, "codex-chat.fault"), "");
      await say("Keep this failed message in the Web conversation");
      await page.getByText(/try again manually|请手动重试/).waitFor({ timeout: 20_000 });
      await page.getByText("Keep this failed message in the Web conversation", { exact: true }).waitFor();
      check("Web chat shows a multi-turn reply and a manual retry notice");
    }
    await page.screenshot({ path: join(out, "chat.png") });
  } else if (mode === "--internal") {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.noop_probe]\ncommand = "/usr/bin/false"\n');
    accounts();
    start("primary", "daemon");
    await until("primary did not start", () => ready(local));
    const legacy = add("Legacy planned task");
    await until("legacy task did not complete", async () => (await task(legacy)).state === "done");
    assert(calls().some(c => c.stage === "plan" && c.cli === "claude"));
    assert(calls().some(c => c.stage === "warm" && c.cli === "claude" && c.model === "legacy-claude-model"));
    check("legacy routing keeps the Claude planner and configured chat model");

    const setSelection = async (list: string[]) => {
      const view = await save({ clis: { internal: list } });
      assert.deepEqual(view.effective.internalClis, list, "the saved setting is returned as effective");
    };
    const feed = async () => await (await request(local, "/api/feed")).json() as {events: {text: string; kind: string}[]};
    const say = async (text: string) => {
      const r = await request(local, "/api/messages", "POST", { text });
      assert.equal(r.status, 200, await r.clone().text());
    };
    const stage = (name: string) => calls().filter(c => c.stage === name).map(c => c.cli);
    await setSelection(["codex"]);
    const invalid = await request(local, "/api/settings", "PUT", { clis: { internal: ["bogus"] } });
    assert.equal(invalid.status, 400);
    const legacyWarm = calls().find(c => c.stage === "warm")!;
    await until("legacy idle Claude process did not stop", () => {
      try { process.kill(legacyWarm.pid, 0); return false; } catch { return true; }
    });
    const count = stage("chat").length;
    await say("Read a task first");
    assert.deepEqual(stage("chat").slice(count), ["codex", "codex"]);
    assert(calls().filter(c => c.stage === "chat").every(c => c.mcpDisabled), "Noop chat disables locally configured Codex MCP servers");
    assert((await feed()).events.some(e => e.text === "Fixture used task data"));
    check("Codex handles a multi-turn Web chat and returns the tool-informed reply");

    await save({ clis: { agents: { lead: ["claude"] } } });
    writeFileSync(join(out, "codex-chat.fault"), "");
    const tasksBefore = await (await request(local, "/api/tasks")).json() as { total: number };
    const chatBefore = stage("chat").length;
    await say("Retain this message");
    const messages = (await feed()).events;
    assert(messages.some(e => e.kind === "owner" && e.text === "Retain this message"));
    assert(messages.some(e => /try again manually/i.test(e.text)));
    assert.deepEqual(stage("chat").slice(chatBefore), ["codex"]);
    const tasksAfter = await (await request(local, "/api/tasks")).json() as { total: number };
    assert.equal(tasksAfter.total, tasksBefore.total);
    unlinkSync(join(out, "codex-chat.fault"));
    check("an exhausted chat remains visible and does not route to a member");

    writeFileSync(configPath, fixtureConfig.replace("timeout_seconds = 8", "timeout_seconds = 0.35"));
    await say("HOLD CONVERSATION");
    const timedOut = calls().filter(c => c.stage === "held").at(-1)!;
    await until("timed-out CLI did not exit", () => {
      try { process.kill(timedOut.pid, 0); return false; } catch { return true; }
    });
    assert((await feed()).events.some(e => /timed out/.test(e.text) && /try again manually/.test(e.text)));
    writeFileSync(configPath, fixtureConfig);
    check("a timed-out model exits and leaves the request available for retry");
    await say("Create fixture task");
    await until("no single requested write", async () => {
      const tasks = await (await request(local, "/api/tasks?q=Created%20exactly%20once")).json() as { total: number };
      return tasks.total === 1;
    });

    for (const [first, second] of [["codex", "claude"], ["claude", "codex"]]) {
      await setSelection([first, second]);
      writeFileSync(join(out, first + "-chat.fault"), "");
      const before = stage("chat").length;
      await say("Try the next selected executor");
      assert.deepEqual(stage("chat").slice(before), [first, second]);
      assert((await feed()).events.some(e => e.text === second + " fixture reply"));
      unlinkSync(join(out, first + "-chat.fault"));
    }
    await setSelection(["codex", "claude"]);
    writeFileSync(join(out, "codex-chat-tool.fault"), "");
    const beforeUnexpectedTool = stage("chat").length;
    await say("Do not replay this conversation");
    assert.deepEqual(stage("chat").slice(beforeUnexpectedTool), ["codex"]);
    unlinkSync(join(out, "codex-chat-tool.fault"));
    check("a conversation is not replayed after the CLI starts a tool");
    await setSelection(["codex"]);
    const beforeHold = stage("chat").length;
    const ongoing = say("HOLD CONVERSATION");
    await until("chat did not hold", () => stage("held").length > 1);
    await setSelection(["claude"]);
    writeFileSync(join(out, "release-chat"), "");
    await ongoing;
    await say("Use the new selection");
    assert.deepEqual(stage("chat").slice(beforeHold), ["codex", "claude"]);
    await until("fixture task created by chat did not finish", async () => {
      const tasks = await (await request(local, "/api/tasks?q=Created%20exactly%20once")).json() as { tasks: {state: string}[] };
      return tasks.tasks.some(task => task.state === "done");
    });
    const planBefore = stage("plan").length;
    await setSelection(["codex"]);
    const planTask = add("Use Codex to plan", "--cli", "codex");
    await until("planned task did not finish", async () => (await task(planTask)).state === "done");
    assert.deepEqual(stage("plan").slice(planBefore), ["codex"]);
    check("settings apply to new work and spare the current conversation");

    writeFileSync(configPath, fixtureConfig.replace('[judge]\nenabled = false', '[judge]\nenabled = true')
      .replace('[medic]\nenabled = false', '[medic]\nenabled = true'));
    const judgeBefore = stage("judge").length;
    const judging = add("Ask fixture judgement", "--cli", "codex");
    await until("Judge did not apply the shared selection", async () => (await task(judging)).state === "blocked" && stage("judge").length > judgeBefore);
    assert.deepEqual(stage("judge").slice(judgeBefore), ["codex"]);
    cli("fix", "Run fixture Medic");
    assert.deepEqual(stage("medic"), ["codex"]);
    check("Judge and Medic use the same selection as planning and chat");

    await setSelection(["codex", "claude"]);
    for (const entry of ["judge", "medic", "plan"]) writeFileSync(join(out, "codex-" + entry + ".fault"), "");
    const before = Object.fromEntries(["judge", "medic", "plan"].map(entry => [entry, stage(entry).length]));
    const alternate = add("Ask fixture judgement with a backup", "--cli", "codex");
    await until("Judge did not try the backup", async () => (await task(alternate)).state === "blocked" && stage("judge").length > before.judge! + 1);
    cli("fix", "Run Medic with a backup");
    for (const entry of ["judge", "medic", "plan"]) assert.deepEqual(stage(entry).slice(before[entry]), ["codex", "claude"]);
    check("planning, Judge and Medic try the available backup in the selected order");

    unlinkSync(join(out, "codex-medic.fault"));
    writeFileSync(join(out, "codex-medic-write.fault"), "");
    const beforeWrite = stage("medic").length;
    const repair = spawnSync(process.execPath, argsFor(["fix", "Repair tool starts before a quota failure"]), { cwd: repo, env, encoding: "utf8", timeout: 15000 });
    assert.deepEqual(stage("medic").slice(beforeWrite), ["codex"], "a repair must not run a second executor after starting a tool");
    assert.equal(repair.status, 1);
    check("a partially executed repair is not replayed after a quota failure");
  } else {
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

    unlinkSync(join(bin, "codex"));
    await save({ clis: { agents: { lead: ["codex"] } } });
    const missing = add("Wait for missing Codex");
    await Bun.sleep(2300);
    assert.equal((await task(missing)).state, "inbox");
    assert.deepEqual(taskCalls(missing), []);
    check("a missing single executor leaves the task queued");
  }
} catch (err) {
  error = err instanceof Error ? err.stack || err.message : String(err);
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
  const report = JSON.stringify({ revision, checks, error, calls: readdirSync(out).includes("calls.jsonl") ? calls() : [] }, null, 2) + "\n";
  writeFileSync(join(out, "report.json"), report);
  writeFileSync(join(out, "SHA256SUMS"), createHash("sha256").update(report).digest("hex") + "  report.json\n");
  console.log("Evidence:", out);
}
