// The real local coordinator and primary run against executable test doubles.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
type Call = { cli: string; account: string; stage: string; task?: string; model?: string; effortArgs: string[];
  effortEnv?: string; effortSettings?: string; attributionDisabled: boolean; sandbox?: string; pid: number; mcpDisabled: boolean };

const check = (message: string) => { checks.push(message); console.log("PASS", message); };
const calls = (): Call[] => readFileSync(join(out, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

function assertEffort(call: Call | undefined, executor: string, effort?: string, inlineEffort?: string) {
  assert(call, "expected an executor launch");
  assert.equal(call.cli, executor);
  assert.deepEqual(call.effortArgs,
    executor === "codex" && effort ? [`model_reasoning_effort=${JSON.stringify(effort)}`] : []);
  if (executor === "claude") {
    assert.equal(call.effortEnv, effort);
    assert.equal(call.effortSettings, inlineEffort, "Claude inline effort setting");
  }
}

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
  const preload = name === "primary" && mode === "--web"
    ? ["--preload", join(source, "test/fixtures/settings-state-network.ts")] : [];
  children.push(spawn(process.execPath, [...preload, ...argsFor(args)], { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }));
  closeSync(fd);
}
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, argsFor(args), { cwd: repo, env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim();
}
function assertInvalidSetting(section: string, key: string, value: string) {
  const probeHome = join(out, "invalid-setting");
  mkdirSync(join(probeHome, "data"), { recursive: true });
  writeFileSync(join(probeHome, "data/config.local.toml"), `[${section}]\n${key} = ${value}\n`);
  const result = spawnSync(process.execPath, argsFor(["status", "--brief"]),
    { cwd: repo, env: { ...env, NOOP_HOME: probeHome }, encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0, `expected invalid ${section}.${key} to fail`);
  assert(result.stderr.includes(`${section}.${key}`), result.stderr);
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
let error = "", browser: any, playwrightVersion: string | undefined, browserVersion: string | undefined;
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
    if (mode === "--real") {
      writeFileSync(configPath, fixtureConfig + '\n[clis.codex]\nmodel = "gpt-6-luna"\nreasoning_effort = "low"\n');
      const git = spawnSync("git", ["init", "-q", home], { encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
      const brain = join(noopHome, "brain");
      for (const [dir, name] of [[home, "parent_probe"], [brain, "cwd_probe"]]) {
        mkdirSync(join(dir, ".codex"), { recursive: true });
        writeFileSync(join(dir, ".codex/config.toml"),
          `[mcp_servers.${name}]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(join(out, name + "-started"))}]\n`);
      }
      const projectEntries = [home, brain].map(dir => `${JSON.stringify(dir)}={trust_level="trusted"}`).join(",");
      env.NOOP_E2E_CODEX_PROJECT_TRUST = `projects={${projectEntries}}`;
    }
    start("primary", "daemon");
    await until("primary did not start", () => ready(local));
    const setup = await (await request(hub, "/api/host/2fa/setup", "POST", {})).json() as { secret: string };
    const secret = b32decode(setup.secret);
    assert((await request(hub, "/api/host/2fa/confirm", "POST", { totp: await hotp(secret, stepAt() - 1) })).ok);
    const playwrightModule = process.env.NOOP_E2E_PLAYWRIGHT ?? "playwright-core";
    const { chromium } = await import(playwrightModule);
    const packageJson = new URL("./package.json", import.meta.resolve(playwrightModule));
    if (existsSync(packageJson)) playwrightVersion = JSON.parse(readFileSync(packageJson, "utf8")).version;
    browser = await chromium.launch({ executablePath: process.env.NOOP_E2E_BROWSER || Bun.which("chromium") || undefined, headless: true });
    browserVersion = browser.version();
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
    let settingsStream: any, suspendSettingsStream = false;
    if (mode === "--web") await settings.routeWebSocket((url: URL) => url.pathname === "/api/stream", (ws: any) => {
      if (suspendSettingsStream) { ws.close(); return; }
      settingsStream = ws;
      ws.connectToServer();
    });
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
    if (mode === "--web") {
      const previousStream = settingsStream;
      assert(previousStream);
      suspendSettingsStream = true;
      previousStream.close();
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["claude"] } })).ok);
      await until("settings did not reach the primary while the browser was offline", async () => {
        const view = await (await request(hub, "/api/settings")).json() as { effective?: { internalClis?: string[] } };
        return view.effective?.internalClis?.join(",") === "claude";
      });
      suspendSettingsStream = false;
      await until("settings page did not reconnect", () => settingsStream !== previousStream);
      await control.getByText(/Claude only|仅 Claude/).waitFor({ timeout: 8000 });
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["codex"] } })).ok);
      await control.getByText(/Codex only|仅 Codex/).waitFor();
      check("reconnecting recovers a settings confirmation that the browser missed offline");

      const stillOpen = settingsStream;
      writeFileSync(join(out, "drop-settings-ack"), "");
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["claude"] } })).ok);
      await until("settings-only acknowledgement was not dropped", () => existsSync(join(out, "drop-settings-ack-observed")));
      const active = add("Hold a task for the next status push", "--cli", "codex");
      await until("the status task did not start", () => taskCalls(active).length > 0);
      await until("a regular status push did not deliver confirmed settings", async () => {
        const view = await (await request(hub, "/api/settings")).json() as { effective?: { internalClis?: string[] } };
        return view.effective?.internalClis?.join(",") === "claude";
      });
      await control.getByText(/Claude only|仅 Claude/).waitFor({ timeout: 8000 });
      assert.equal(settingsStream, stillOpen);
      writeFileSync(join(out, "release-status-task"), "");
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["codex"] } })).ok);
      await control.getByText(/Codex only|仅 Codex/).waitFor();
      check("the normal status push restores a dropped settings acknowledgement without reconnecting");

      await until("the status task did not finish", async () => (await task(active)).state === "done");
      unlinkSync(join(out, "release-status-task"));
      const delivery = join(out, "settings-delivery-order");
      writeFileSync(join(out, "hold-old-status"), "");
      add("Hold a task for the next status push", "--cli", "codex");
      await until("the older status was not held", () => existsSync(join(out, "hold-old-status-observed")));
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["claude"] } })).ok);
      await until("the primary did not save the new selection", async () => {
        const view = await (await request(local, "/api/settings")).json() as { effective?: { internalClis?: string[] } };
        return view.effective?.internalClis?.join(",") === "claude";
      });
      // Give an unsequenced acknowledgement time to overtake the older status.
      await until("an acknowledgement went ahead of the old status", () => existsSync(delivery), 1600).catch(() => {});
      writeFileSync(join(out, "hold-old-status-release"), "");
      await until("both status and acknowledgement must arrive", () =>
        existsSync(delivery) && readFileSync(delivery, "utf8").trim().split("\n").length >= 2);
      assert.deepEqual(readFileSync(delivery, "utf8").trim().split("\n"), ["status", "ack"]);
      await control.getByText(/Claude only|仅 Claude/).waitFor();
      unlinkSync(join(out, "hold-old-status-observed"));
      writeFileSync(join(out, "release-status-task"), "");
      assert((await request(hub, "/api/settings", "PUT", { clis: { internal: ["codex"] } })).ok);
      await control.getByText(/Codex only|仅 Codex/).waitFor();
      check("an older status request cannot overwrite newly acknowledged settings");
    }
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
      assert.deepEqual(JSON.parse(readFileSync(join(out, "codex-mcp-probe.json"), "utf8")), [{ name: "noop_probe", enabled: false }]);
      assert(!existsSync(join(out, "parent_probe-started")) && !existsSync(join(out, "cwd_probe-started")));
      check("Codex ignores trusted project MCP layers and disables the account MCP probe");
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
      for (const stage of ["chat", "task"]) {
        const launches = calls().filter(c => c.stage === stage && c.cli === "codex");
        assert(launches.length);
        for (const launch of launches) {
          assert.equal(launch.model, "gpt-6-luna");
          assertEffort(launch, "codex", "low");
        }
      }
      check("real Codex replied, used the Noop read tool and fixed the task's code");
    } else {
      await say("Read a task first");
      await page.getByText("Fixture used task data", { exact: true }).waitFor({ timeout: 20_000 });
      writeFileSync(join(out, "codex-chat.fault"), "");
      await say("Keep this failed message in the Web conversation");
      await page.getByText("Chat could not finish (Codex needs login). Please try again manually.").waitFor({ timeout: 20_000 });
      await page.getByText("Keep this failed message in the Web conversation", { exact: true }).waitFor();
      check("Web chat shows a multi-turn reply and a manual retry notice");
    }
    await page.screenshot({ path: join(out, "chat.png") });
  } else if (mode === "--internal") {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.noop_probe]\ncommand = "/usr/bin/false"\n');
    writeFileSync(configPath, fixtureConfig + '\n[chat]\nreasoning_effort = "medium"\n');
    start("primary", "daemon");
    await until("primary did not start", () => ready(local));
    const legacy = add("Legacy planned task");
    await until("legacy task did not complete", async () => (await task(legacy)).state === "done");
    assert(calls().some(c => c.stage === "plan" && c.cli === "claude"));
    const warm = calls().find(c => c.stage === "warm");
    assertEffort(warm, "claude", "medium");
    assert.equal(warm?.model, "legacy-claude-model");
    check("legacy routing keeps the Claude planner and configured chat model");

    symlinkSync(join(bin, "codex"), join(bin, "codex-wrapper"));
    writeFileSync(configPath, fixtureConfig.replace('cli = "claude"', 'cli = "codex-wrapper"'));
    const legacyWrapper = add("Plan with a custom legacy executable name");
    await until("legacy planner wrapper did not run", async () => (await task(legacyWrapper)).state === "done");
    assert(calls().some(c => c.stage === "plan" && c.cli === "codex" && c.sandbox === "read-only"));
    writeFileSync(configPath, fixtureConfig);
    check("legacy planning keeps the read-only sandbox for a custom executable name");

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
    const lastLaunch = (name: string) => calls().findLast(c => c.stage === name);
    const effortConfig = fixtureConfig + '\n[clis.codex]\nmodel = "gpt-6.2-sol"\nreasoning_effort = "max"\n' +
      '\n[clis.claude]\nreasoning_effort = "high"\n';
    const observeChat = async (text: string, config: string) => {
      writeFileSync(configPath, effortConfig + "\n[chat]\n" + config + "\n");
      const before = stage("chat").length;
      await say(text);
      return calls().filter(c => c.stage === "chat").slice(before);
    };
    await save({ clis: { internal: ["codex"], agents: { lead: ["claude"] } } });
    add("Hold the planner during a settings change", "--cli", "codex");
    await until("planner did not pause", () => stage("planner-held").length > 0);
    const saved = await save({ clis: { agents: { lead: ["codex"] } } });
    assert.deepEqual(saved.effective.agents.find(member => member.id === "lead")?.clis, ["codex"]);
    const fresh = add("Run a new task after the member choice is confirmed");
    writeFileSync(join(out, "release-planner"), "");
    await until("the new task did not finish", async () => (await task(fresh)).state === "done");
    assert.deepEqual(taskCalls(fresh), ["codex/default"]);
    check("new tasks use the member choice confirmed while planning was in progress");

    await setSelection(["codex"]);
    const invalid = await request(local, "/api/settings", "PUT", { clis: { internal: ["bogus"] } });
    assert.equal(invalid.status, 400);
    const legacyWarm = calls().find(c => c.stage === "warm")!;
    await until("legacy idle Claude process did not stop", () => {
      try { process.kill(legacyWarm.pid, 0); return false; } catch { return true; }
    });
    const directBefore = calls().length;
    for (const route of ["/api/status", "/api/tasks", "/api/tasks/get?id=" + fresh]) {
      assert((await request(local, route)).ok);
    }
    assert.equal(calls().length, directBefore, "fixed-format queries do not start an executor");
    const reading = await observeChat("Read a task first", 'reasoning_effort = "medium"');
    assert.equal(reading.length, 2);
    for (const launch of reading) {
      assertEffort(launch, "codex", "medium");
      assert.equal(launch.model, "gpt-6.2-sol");
    }
    assert(calls().filter(c => c.stage === "chat").every(c => c.mcpDisabled), "Noop chat disables locally configured Codex MCP servers");
    assert((await feed()).events.some(e => e.text === "Fixture used task data"));
    check("Codex handles a multi-turn Web chat and returns the tool-informed reply");

    const modelOnly = 'model = "chat-model"';
    for (const [setting, level] of [["", "max"], ['\nreasoning_effort = "default"', undefined]] as const) {
      const [launch] = await observeChat("Use the configured chat model", modelOnly + setting);
      assertEffort(launch, "codex", level);
      assert.equal(launch?.model, "chat-model");
    }
    await setSelection(["codex", "claude"]);
    writeFileSync(join(out, "codex-chat.fault"), "");
    const backup = await observeChat("Use the next configured chat executor", modelOnly);
    assert.equal(backup.length, 2);
    assertEffort(backup[0], "codex", "max");
    assertEffort(backup[1], "claude", "high");
    assert.deepEqual(backup.map(c => c.model), ["chat-model", "legacy-claude-model"]);
    unlinkSync(join(out, "codex-chat.fault"));
    await setSelection(["codex"]);
    writeFileSync(configPath, fixtureConfig);
    assertInvalidSetting("chat", "reasoning_effort", '"  "');
    assertInvalidSetting("chat", "model", "7");
    assertInvalidSetting("chat", "model", '"  "');
    check("chat model and effort resolve separately and each fallback uses its own model settings");

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

    const beforeEmpty = (await feed()).events.length;
    await say("Return an empty result");
    assert((await feed()).events.slice(beforeEmpty).some(e => /did not answer.*try again manually/i.test(e.text)),
      "an empty reply without a write must show the retry notice");
    await setSelection(["codex", "claude"]);
    const beforeEmptyBackup = stage("chat").length;
    await say("Return an empty result with a backup available");
    assert.deepEqual(stage("chat").slice(beforeEmptyBackup), ["codex", "claude"]);
    check("empty results try the next allowed executor or display the retry notice");

    const unwritableMemory = join(noopHome, "data/memory/unwritable.md");
    mkdirSync(unwritableMemory);
    const beforeWriteFailure = stage("chat").length;
    await say("Run a write that cannot finish");
    rmdirSync(unwritableMemory);
    assert.deepEqual(stage("chat").slice(beforeWriteFailure), ["codex"]);
    assert((await feed()).events.some(e => /check the result before retrying/i.test(e.text)));
    check("a failed chat write shows a recovery notice without replaying the request");

    await setSelection(["claude"]);
    await say("Return an internal provider error");
    const errorFeed = (await feed()).events;
    assert(errorFeed.some(e => /Claude could not complete the request.*try again manually/i.test(e.text)));
    assert(!errorFeed.some(e => e.text.includes("review-123")));
    assert(readFileSync(join(out, "primary.log"), "utf8").includes("review-123"));
    check("the chat shows a safe reason and keeps the raw provider error in local diagnostics");

    await setSelection(["codex"]);
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

    for (const [executor, configured, expected] of [
      ["codex", "", "low"], ["codex", "medium", "medium"], ["codex", "default", undefined],
      ["claude", "", "high"], ["claude", "low", "low"], ["claude", "default", undefined],
    ] as const) {
      await setSelection([executor]);
      const planningConfig = configured
        ? effortConfig.replace("[router]\n", `[router]\nreasoning_effort = "${configured}"\n`) : effortConfig;
      writeFileSync(configPath, planningConfig);
      const before = stage("plan").length;
      const id = add(`Plan with ${executor} effort ${configured || "omitted"}`, "--cli", executor);
      await until("task planning did not complete", async () => (await task(id)).state === "done" && stage("plan").length > before);
      assert.deepEqual(stage("plan").slice(before), [executor]);
      const launch = lastLaunch("plan");
      assertEffort(launch, executor, expected, executor === "claude" ? expected : undefined);
      if (executor === "codex") assert.equal(launch?.model, "gpt-6.2-sol");
    }
    check("Codex planning keeps low beside a max task default and both planners accept overrides and CLI defaults");

    await setSelection(["codex"]);
    const enabledConfig = effortConfig.replace('[judge]\nenabled = false', '[judge]\nenabled = true')
      .replace('[medic]\nenabled = false', '[medic]\nenabled = true');
    writeFileSync(configPath, enabledConfig);
    const judgeBefore = stage("judge").length;
    const judging = add("Ask fixture judgement", "--cli", "codex");
    await until("Judge did not apply the shared selection", async () => (await task(judging)).state === "blocked" && stage("judge").length > judgeBefore);
    assert.deepEqual(stage("judge").slice(judgeBefore), ["codex"]);
    assertEffort(lastLaunch("judge"), "codex", "max");
    assert.equal(lastLaunch("judge")?.model, "gpt-6.2-sol");
    cli("fix", "Run fixture Medic");
    assert.deepEqual(stage("medic"), ["codex"]);
    assertEffort(lastLaunch("medic"), "codex", "max");
    assert.equal(lastLaunch("medic")?.model, "gpt-6.2-sol");
    check("Judge and Medic use the same selection as planning and chat");

    for (const [executor, configured, expected] of [["claude", "low", "low"], ["claude", "default", undefined]] as const) {
      await setSelection([executor]);
      writeFileSync(configPath, enabledConfig.replace("[judge]\n", `[judge]\nreasoning_effort = "${configured}"\n`));
      const before = stage("judge").length;
      const id = add(`Ask fixture judgement with ${configured} effort`, "--cli", executor);
      await until("Judge did not try the configured settings", async () =>
        (await task(id)).state === "blocked" && stage("judge").length > before);
      assertEffort(lastLaunch("judge"), executor, expected, expected);
    }
    cli("fix", "Run fixture Medic with Claude");
    assertEffort(lastLaunch("medic"), "claude", "high", "high");
    writeFileSync(configPath, enabledConfig);
    assertInvalidSetting("router", "reasoning_effort", "false");
    assertInvalidSetting("judge", "reasoning_effort", '""');
    check("Judge uses its override or CLI default and Medic uses its selected executor's effort");

    await setSelection(["codex", "claude"]);
    const codexConfig = join(home, ".codex/config.toml");
    const validCodexConfig = readFileSync(codexConfig, "utf8");
    writeFileSync(codexConfig, "[mcp_servers.\n");
    const planWithBadConfig = stage("plan").length, judgeWithBadConfig = stage("judge").length;
    const malformed = add("Ask fixture judgement with a malformed Codex profile", "--cli", "codex");
    await until("bad Codex config stopped planning or judging", async () =>
      (await task(malformed)).state === "blocked" && stage("judge").length > judgeWithBadConfig);
    assert.deepEqual(stage("plan").slice(planWithBadConfig), ["claude"]);
    assert.deepEqual(stage("judge").slice(judgeWithBadConfig), ["claude"]);
    await setSelection(["codex"]);
    const onlyBadConfig = stage("plan").length;
    const stillRuns = add("Dispatch even when the planner has no usable profile", "--cli", "codex");
    await until("bad Codex config blocked dispatch", () => taskCalls(stillRuns).length > 0);
    assert.deepEqual(stage("plan").slice(onlyBadConfig), []);
    writeFileSync(codexConfig, validCodexConfig);
    check("bad Codex config skips only that internal candidate and does not block dispatch");

    await setSelection(["codex", "claude"]);
    for (const entry of ["judge", "medic", "plan"]) writeFileSync(join(out, "codex-" + entry + ".fault"), "");
    const before = Object.fromEntries(["judge", "medic", "plan"].map(entry => [entry, stage(entry).length]));
    const alternate = add("Ask fixture judgement with a backup", "--cli", "codex");
    await until("Judge did not try the backup", async () => (await task(alternate)).state === "blocked" && stage("judge").length > before.judge! + 1);
    cli("fix", "Run Medic with a backup");
    for (const entry of ["judge", "medic", "plan"]) assert.deepEqual(stage(entry).slice(before[entry]), ["codex", "claude"]);
    check("planning, Judge and Medic try the available backup in the selected order");

    unlinkSync(join(out, "codex-medic.fault"));
    const beforePreflight = stage("medic").length;
    cli("fix", "Repair with an unavailable service");
    assert.deepEqual(stage("medic").slice(beforePreflight), ["codex", "claude"]);
    check("Medic can switch executors after a model failure before any tool starts");

    writeFileSync(join(out, "codex-medic-write.fault"), "");
    const beforeWrite = stage("medic").length;
    const repair = spawnSync(process.execPath, argsFor(["fix", "Repair tool starts before a quota failure"]), { cwd: repo, env, encoding: "utf8", timeout: 15000 });
    assert.deepEqual(stage("medic").slice(beforeWrite), ["codex"], "a repair must not run a second executor after starting a tool");
    assert.equal(repair.status, 1);
    check("a partially executed repair is not replayed after a quota failure");

    unlinkSync(join(out, "codex-medic-write.fault"));
    await setSelection(["claude"]);
    const beforeAutoMedic = stage("medic").length;
    const failingTask = add("Task fails after the Medic selection changes", "--cli", "codex");
    await until("the task did not start", () => taskCalls(failingTask).length > 0);
    await setSelection(["codex"]);
    writeFileSync(join(out, "release-failing-task"), "");
    await until("the failed task did not start automatic Medic", () => stage("medic").length > beforeAutoMedic);
    assert.deepEqual(stage("medic").slice(beforeAutoMedic), ["codex"]);
    check("automatic Medic uses the selection confirmed after the failed task started");
    await setSelection(["codex", "claude"]);

    accounts(["codex", "invalid-account-directory"]);
    writeFileSync(configPath, readFileSync(configPath, "utf8") + '\n[chat]\nmodel = "codex-only-chat-model"\n');
    writeFileSync(join(out, "invalid-account-directory"), "a file cannot be used as an account directory");
    const beforeAccount = stage("chat").length;
    await say("Use the backup if the first account directory cannot be opened");
    assert.deepEqual(stage("chat").slice(beforeAccount), ["claude"]);
    assert.equal(lastLaunch("chat")?.model, "legacy-claude-model");
    check("an unusable account directory does not stop the next selected executor");
  } else {
    env.CLAUDE_CODE_EFFORT_LEVEL = "high";
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

    accounts(["codex", "broken-task-account"], ["claude", "available-task-account"]);
    writeFileSync(join(out, "broken-task-account"), "a file cannot be used as an account directory");
    await save({ clis: { agents: { lead: ["codex", "claude"] } } });
    const recoverable = add("Skip an invalid preferred account directory");
    await until("invalid account directory blocked the task", async () => (await task(recoverable)).state === "done");
    assert.deepEqual(taskCalls(recoverable), ["claude/available-task-account"]);
    check("a task skips an unusable account directory and keeps the configured order");

    if (process.getuid?.() !== 0) {
      const readOnly = join(out, "read-only-accounts");
      mkdirSync(readOnly, { mode: 0o555 });
      try {
        accounts(["codex", "read-only-accounts/codex"], ["claude", "available-task-account"]);
        const needsDirectory = add("Skip a preferred account whose directory cannot be created");
        await until("failed account initialization blocked the task", async () => (await task(needsDirectory)).state === "done");
        assert.deepEqual(taskCalls(needsDirectory), ["claude/available-task-account"]);
        check("a task skips an account that cannot initialize its directory");
      } finally { chmodSync(readOnly, 0o755); }
    }

    accounts();
    const sharedPath = join(noopHome, "data/config.toml");
    const sharedConfig = readFileSync(sharedPath, "utf8");
    assert(sharedConfig.includes("[clis.codex]"));
    writeFileSync(sharedPath, sharedConfig.replace("[clis.codex]", '[clis.codex]\nreasoning_effort = "high"'));
    const observeTask = async (executor: string, model: string, localSettings: string, effort: string | undefined) => {
      writeFileSync(configPath, fixtureConfig + localSettings);
      const id = add(`Check ${executor} task settings ${model} ${effort}`, "--cli", executor);
      await until("task with effort settings did not finish", async () => (await task(id)).state === "done");
      const launches = calls().filter(call => call.stage === "task" && call.task === id);
      assert.equal(launches.length, 1);
      if (executor === "claude") {
        assertEffort(launches[0], executor, effort ?? "high", effort);
        assert(launches[0].attributionDisabled, "one inline settings document must preserve attribution options");
      } else assertEffort(launches[0], executor, effort);
      assert.equal(launches[0].model, model);
    };
    await observeTask("codex", "gpt-6.2-sol", '\n[clis.codex]\nmodel = "gpt-6.2-sol"\nreasoning_effort = "max"\n', "max");
    await observeTask("codex", "changed-model", '\n[clis.codex]\nmodel = "changed-model"\n', "high");
    await observeTask("codex", "gpt-6.2-sol", '\n[clis.codex]\nmodel = "gpt-6.2-sol"\nreasoning_effort = "default"\n', undefined);
    writeFileSync(sharedPath, sharedConfig);
    await observeTask("codex", "gpt-6.2-sol", '\n[clis.codex]\nmodel = "gpt-6.2-sol"\n', undefined);
    check("Codex tasks use shared and local effort independently of model and defer to the CLI when requested");

    for (const [setting, level] of [['reasoning_effort = "medium"', "medium"], ['reasoning_effort = "default"', undefined], ["", undefined]] as const)
      await observeTask("claude", "claude-fixture", `\n[clis.claude]\nmodel = "claude-fixture"\n${setting}\n`, level);
    check("Claude tasks set explicit effort and preserve the inherited CLI environment for default or omission");

    const custom = [join(bin, "codex"), "exec", "--sandbox", "workspace-write", "-m", "custom-model",
      "-c", 'model_reasoning_effort="medium"', "-"];
    await observeTask("codex", "custom-model", `\n[clis.codex]\ncommand = ${JSON.stringify(custom)}\nreasoning_effort = "max"\n`, "medium");
    check("a complete command keeps its own task effort");
    accounts();

    unlinkSync(join(bin, "codex"));
    await save({ clis: { agents: { lead: ["codex"] } } });
    const missing = add("Wait for missing Codex");
    await Bun.sleep(2300);
    assert.equal((await task(missing)).state, "inbox");
    assert.deepEqual(taskCalls(missing), []);
    check("a missing single executor leaves the task queued");

    assertInvalidSetting("clis.codex", "reasoning_effort", "7");
    check("invalid task effort identifies its configuration field");
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
  const diagnostics = mode === "--web"
    ? readdirSync(out).filter(name => name.endsWith(".log") || name === "settings.png" || name === "chat.png").sort()
    : [];
  const report = JSON.stringify({
    revision, checks, error, calls: readdirSync(out).includes("calls.jsonl") ? calls() : [],
    ...(mode === "--web" ? { playwright: playwrightVersion, chromium: browserVersion, diagnostics } : {}),
  }, null, 2) + "\n";
  writeFileSync(join(out, "report.json"), report);
  const evidence = ["report.json", ...diagnostics].map(name =>
    `${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}  ${name}`).join("\n");
  writeFileSync(join(out, "SHA256SUMS"), evidence + "\n");
  console.log("Evidence:", out);
}
