// Run against isolated Noop homes and a real local workerd process.
// Supply NOOP_E2E_WEB_ASSETS and NOOP_E2E_WORKERD with already installed artifacts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, "..");
const artifacts = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-self-hosted-"));
const repo = join(artifacts, "repo"), localHome = join(artifacts, "primary"), peerHome = join(artifacts, "peer");
const binaries = join(artifacts, "bin"), guard = join(artifacts, "cloud-guard.log"), serviceLog = join(artifacts, "service.log");
const webAssets = process.env.NOOP_E2E_WEB_ASSETS || "";
const workerd = process.env.NOOP_E2E_WORKERD || Bun.which("workerd") || "";
const browserExecutable = process.env.NOOP_E2E_BROWSER || Bun.which("chromium") || "";
const playwrightModule = process.env.NOOP_E2E_PLAYWRIGHT || "playwright-core";
const checks: string[] = [];
let service: ChildProcess | undefined;
let browser: any;
let playwrightVersion = "not loaded";
let error = "";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(message);
  console.log(`PASS ${message}`);
}

function code(secret: string, counter: number, digits = 6): string {
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/\s/g, "")) {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    if (n < 0) throw new Error("invalid authenticator secret");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

function cli(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], {
    cwd: repo, env, encoding: "utf8", timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((ok, fail) => server.close((err) => err ? fail(err) : ok()));
  return port;
}

async function start(env: NodeJS.ProcessEnv, address: string, base: string) {
  const fd = openSync(serviceLog, "a");
  const child = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", address], {
    cwd: repo, env, detached: true, stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  service = child;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`local deployment exited: ${readFileSync(serviceLog, "utf8").slice(-2000)}`);
    try {
      const response = await fetch(`${base}/`);
      const bootstrap = Bun.TOML.parse(readFileSync(join(String(env.NOOP_HOME), "noop.toml"), "utf8")) as any;
      if (response.ok && (await response.text()).includes("nsh") && bootstrap.cloud?.mode === "local" && bootstrap.cloud.url === base) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`local deployment did not serve the Web client: ${readFileSync(serviceLog, "utf8").slice(-2000)}`);
}

async function stop(base: string) {
  if (!service) return;
  const child = service;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
  if (child.exitCode === null && child.signalCode === null) throw new Error("local deployment did not stop");
  await waitForPortClosed(base);
}

async function waitForPortClosed(base: string) {
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${base}/`); } catch { return; }
    await Bun.sleep(100);
  }
  throw new Error("coordination service remained available after shutdown");
}

async function spoofedStatus(port: number, token: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/status", localAddress: "127.0.0.2",
      headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "127.0.0.1" } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode || 0));
    });
    req.on("error", fail);
    req.end();
  });
}

async function rejectedHome(home: string, name: string, env: NodeJS.ProcessEnv) {
  const log = join(artifacts, `${name}.log`), fd = openSync(log, "a");
  const child = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${await availablePort()}`],
    { cwd: repo, env: { ...env, NOOP_HOME: home }, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
  const exited = child.exitCode !== null && child.exitCode !== 0;
  if (child.pid) try { process.kill(-child.pid, "SIGINT"); } catch {}
  return { exited, output: readFileSync(log, "utf8") };
}

try {
  check(!!webAssets && existsSync(join(webAssets, "index.html")), "real Web assets are supplied");
  check(!!workerd && existsSync(workerd), "workerd executable is supplied");
  check(!!browserExecutable && existsSync(browserExecutable), "Chromium executable is supplied");
  check(code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1, 8) === "94287082", "authenticator follows the RFC test vector");

  mkdirSync(binaries, { recursive: true });
  for (const name of ["src", "cloud", "app", "templates", "presets"]) {
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  }
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true });
  cpSync(webAssets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  symlinkSync(resolve(workerd), join(binaries, "workerd"));
  for (const name of ["bunx", "claude", "codex"]) {
    writeFileSync(join(binaries, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$NOOP_E2E_GUARD"\nexit 91\n`, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: localHome, XDG_CONFIG_HOME: join(artifacts, "xdg"),
    NOOP_E2E_GUARD: guard, PATH: `${binaries}:${process.env.PATH || ""}`, HUB_NO_MEDIC: "1" };
  for (const key of ["HUB_DATA", "HUB_CONF", "HUB_HOST", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NOOP_CLIENT_BASE_URL"]) delete env[key];

  const bad = cli(["cloud", "deploy", "--unsupported"], env);
  check(bad.status !== 0 && !existsSync(guard), "unknown deployment option fails without invoking Cloudflare");
  cli(["cloud", "deploy"], env);
  check(existsSync(guard) && readFileSync(guard, "utf8").includes("bunx wrangler whoami"), "default deployment retains the cloud path");
  writeFileSync(guard, "");

  const brokenHome = join(artifacts, "broken-bootstrap"), brokenPort = await availablePort();
  if (process.getuid?.() === 0) mkdirSync(join(brokenHome, "noop.toml"), { recursive: true });
  else {
    mkdirSync(brokenHome, { recursive: true });
    writeFileSync(join(brokenHome, "noop.toml"), '[server]\ntoken = "synthetic-readonly-token"\n');
    chmodSync(join(brokenHome, "noop.toml"), 0o400);
  }
  const brokenLog = openSync(join(artifacts, "broken-bootstrap.log"), "a");
  const broken = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${brokenPort}`],
    { cwd: repo, env: { ...env, NOOP_HOME: brokenHome }, detached: true, stdio: ["ignore", brokenLog, brokenLog] });
  closeSync(brokenLog);
  try {
    const deadline = Date.now() + 10_000;
    while (broken.exitCode === null && broken.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
    check(broken.exitCode !== null && broken.exitCode !== 0, "an unwritable bootstrap reports deployment failure");
    let stillRunning = false;
    try { await fetch(`http://127.0.0.1:${brokenPort}/`); stillRunning = true; } catch {}
    check(!stillRunning, "failed deployment does not leave a coordinator running");
  } finally {
    if (broken.pid) try { process.kill(-broken.pid, "SIGINT"); } catch {}
  }

  const restrictedHome = join(artifacts, "restricted"), restrictedToken = "synthetic-restricted-token";
  mkdirSync(restrictedHome, { recursive: true });
  writeFileSync(join(restrictedHome, "noop.toml"), `[cloud]\nallow_ips = "127.0.0.1"\n[server]\ntoken = "${restrictedToken}"\n`);
  const restrictedPort = await availablePort(), restrictedAddress = `127.0.0.1:${restrictedPort}`, restrictedBase = `http://${restrictedAddress}`;
  let restrictedStarted = false;
  try { await start({ ...env, NOOP_HOME: restrictedHome }, restrictedAddress, restrictedBase); restrictedStarted = true; }
  catch (e) { check(String(e).includes("IP allow-lists need a trusted local ingress"), "an unsupported IP allow-list is rejected"); }
  if (restrictedStarted) {
    check(await spoofedStatus(restrictedPort, restrictedToken) === 403, "a forged source header cannot bypass the IP allow-list");
    await stop(restrictedBase);
  }

  const existingHome = join(artifacts, "existing-cloud"), existingFile = join(existingHome, "noop.toml");
  const existingConfig = '[cloud]\nurl = "https://example.invalid"\n[server]\ntoken = "synthetic-existing-token"\n';
  mkdirSync(existingHome, { recursive: true });
  writeFileSync(existingFile, existingConfig);
  const existingPort = await availablePort(), existingAddress = `127.0.0.1:${existingPort}`, existingBase = `http://${existingAddress}`;
  let existingStarted = false;
  try { await start({ ...env, NOOP_HOME: existingHome }, existingAddress, existingBase); existingStarted = true; }
  catch (e) { check(String(e).includes("already uses another coordination service"), "existing cloud configuration is not silently replaced"); }
  check(readFileSync(existingFile, "utf8") === existingConfig, "existing cloud bootstrap remains unchanged");
  if (existingStarted) await stop(existingBase);

  const fakeBin = join(artifacts, "fake-runtime"), fakeMarker = join(artifacts, "fake-runtime-started");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "workerd"), '#!/bin/sh\nprintf started > "$NOOP_E2E_FAKE_RUNTIME"\nif [ "$1" = "--version" ]; then printf "workerd 2026-11-10\\n"; fi\n', { mode: 0o755 });
  const fakeEnv = { ...env, NOOP_HOME: join(artifacts, "invalid-runtime"), NOOP_E2E_FAKE_RUNTIME: fakeMarker, PATH: `${fakeBin}:${env.PATH}` };
  const fake = cli(["cloud", "deploy", "--local", "--listen", `127.0.0.1:${await availablePort()}`], fakeEnv);
  check(fake.status !== 0 && !existsSync(fakeMarker), "runtime integrity is checked before the candidate starts");

  const corruptHome = join(artifacts, "corrupt-namespace"), corruptKey = join(corruptHome, "coordinator", "namespace-key");
  mkdirSync(dirname(corruptKey), { recursive: true });
  writeFileSync(corruptKey, Buffer.alloc(36));
  const corrupt = cli(["cloud", "deploy", "--local", "--listen", `127.0.0.1:${await availablePort()}`], { ...env, NOOP_HOME: corruptHome });
  check(corrupt.status !== 0 && corrupt.output.includes("namespace key is invalid"), "a corrupt namespace reports a restore error");
  check(readFileSync(corruptKey).equals(Buffer.alloc(36)), "a corrupt namespace is not silently replaced");

  const corruptConfigHome = join(artifacts, "corrupt-bootstrap"), corruptConfig = join(corruptConfigHome, "noop.toml");
  mkdirSync(corruptConfigHome, { recursive: true }); writeFileSync(corruptConfig, Buffer.alloc(64));
  const badConfig = await rejectedHome(corruptConfigHome, "corrupt-bootstrap", env);
  check(badConfig.exited && badConfig.output.includes("bootstrap configuration is invalid"), "a corrupt bootstrap reports a restore error");
  check(readFileSync(corruptConfig).equals(Buffer.alloc(64)), "a corrupt bootstrap is not silently replaced");

  const missingTokenHome = join(artifacts, "missing-token"), existingKey = join(missingTokenHome, "coordinator", "namespace-key");
  mkdirSync(dirname(existingKey), { recursive: true }); writeFileSync(existingKey, "11111111-1111-4111-8111-111111111111");
  const missingToken = await rejectedHome(missingTokenHome, "missing-token", env);
  check(missingToken.exited && missingToken.output.includes("machine token is missing"), "existing coordinator data does not silently get a new machine token");

  const port = await availablePort(), address = `127.0.0.1:${port}`, base = `http://${address}`;
  await start(env, address, base);
  check(!readFileSync(guard, "utf8"), "local deployment does not invoke Cloudflare or an agent CLI");
  const bootstrap = Bun.TOML.parse(readFileSync(join(localHome, "noop.toml"), "utf8")) as any;
  const token = bootstrap.server?.token;
  check(typeof token === "string" && token.length >= 16, "local machine credential is persisted");

  const bootstrapBefore = readFileSync(join(localHome, "noop.toml"), "utf8"), duplicatePort = await availablePort();
  const duplicateLog = openSync(join(artifacts, "duplicate-deployment.log"), "a");
  const duplicate = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${duplicatePort}`],
    { cwd: repo, env, detached: true, stdio: ["ignore", duplicateLog, duplicateLog] });
  closeSync(duplicateLog);
  try {
    const deadline = Date.now() + 5000;
    while (duplicate.exitCode === null && duplicate.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
    check(duplicate.exitCode !== null && duplicate.exitCode !== 0, "a second coordinator using the same data is refused");
    check(readFileSync(join(localHome, "noop.toml"), "utf8") === bootstrapBefore, "a refused deployment preserves the active address");
  } finally {
    if (duplicate.pid) try { process.kill(-duplicate.pid, "SIGINT"); } catch {}
  }

  const original = service!;
  original.kill("SIGKILL");
  if (original.exitCode === null && original.signalCode === null) await new Promise<void>((done) => original.once("exit", () => done()));
  let orphanRunning = false;
  try { orphanRunning = (await fetch(`${base}/`)).ok; } catch {}
  if (orphanRunning) {
    const orphanLog = openSync(join(artifacts, "orphan-lock.log"), "a");
    const replacement = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${await availablePort()}`],
      { cwd: repo, env, detached: true, stdio: ["ignore", orphanLog, orphanLog] });
    closeSync(orphanLog);
    const deadline = Date.now() + 5000;
    while (replacement.exitCode === null && replacement.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
    const rejected = replacement.exitCode !== null && replacement.exitCode !== 0;
    if (replacement.pid) try { process.kill(-replacement.pid, "SIGINT"); } catch {}
    if (original.pid) try { process.kill(-original.pid, "SIGINT"); } catch {}
    check(rejected, "an orphaned runtime still excludes a second coordinator");
    check(readFileSync(join(localHome, "noop.toml"), "utf8") === bootstrapBefore, "orphan protection preserves the active address");
  } else check(true, "a killed launcher leaves no orphaned runtime");
  service = undefined;
  await waitForPortClosed(base);
  await start(env, address, base);

  const setup = cli(["2fa", "setup"], env);
  const secret = setup.output.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32, "owner can start TOTP setup from the CLI");
  const confirmed = cli(["2fa", "confirm", code(secret, Math.floor(Date.now() / 30_000))], env);
  check(confirmed.status === 0, "owner can confirm TOTP from the CLI");

  const { chromium } = await import(playwrightModule);
  try { playwrightVersion = JSON.parse(readFileSync(join(dirname(require.resolve(playwrightModule)), "package.json"), "utf8")).version; } catch {}
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.route("**/*", (route: any) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("you@example.com").fill("owner@example.com", { timeout: 30_000 });
  await page.getByText(/^(Send code|发送验证码)$/).click();
  await page.waitForFunction(() => (globalThis as any).document.querySelectorAll("input").length >= 2, { timeout: 15_000 });
  const login = cli(["login"], env);
  const emailCode = login.output.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(login.status === 0 && !!emailCode, "owner retrieves the one-time login code from the CLI");
  await page.locator("input").nth(0).fill(emailCode);
  await page.locator("input").nth(1).fill(code(secret, Math.floor(Date.now() / 30_000) + 1));
  const composer = page.getByPlaceholder(/Tell the team what to do|给团队下指令/);
  await composer.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(artifacts, "web-login.png") });
  check(true, "real Web client signs in using the CLI code and TOTP");

  const initialized = cli(["init", "--primary"], env);
  check(initialized.status === 0, "primary initializes against the local service");
  const title = "self-hosted end-to-end task";
  const added = cli(["add", title], env);
  const task = added.output.match(/\bT-[A-Z0-9-]+\b/)?.[0] || "";
  check(added.status === 0 && !!task, "primary creates a shared task");
  const peerEnv = { ...env, NOOP_HOME: peerHome };
  const joined = cli(["init", base, "--token", token], peerEnv);
  check(joined.status === 0 && existsSync(join(peerHome, "data", "tasks", "inbox", `${task}.md`)), "peer receives the task over HTTP");
  check(readFileSync(join(peerHome, "data", "tasks", "inbox", `${task}.md`), "utf8").includes(title), "peer mirror contains the task content");

  const updateBin = join(artifacts, "update-bin");
  mkdirSync(updateBin, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(updateBin, "git"), `#!/bin/sh\ncase "$1 $2" in\n  'rev-parse HEAD') printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;\n  'rev-parse @{u}') printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n' ;;\n  'diff --name-only') printf 'cloud/src/index.ts\\n' ;;\nesac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(updateBin, "bun"), '#!/bin/sh\ncase "$1" in install|test) exit 0 ;; *) exit 91 ;; esac\n', { mode: 0o755 });
  const update = cli(["update"], { ...env, PATH: `${updateBin}:${env.PATH}` });
  check(update.status === 0 && update.output.includes("self-updated"), "local update reaches the deployment decision with simulated Git");
  check(!readFileSync(guard, "utf8"), "local update does not invoke Cloudflare deployment");

  const cloudHome = join(artifacts, "cloud-update"), cloudMarker = join(artifacts, "cloud-update.log");
  mkdirSync(join(cloudHome, "data"), { recursive: true });
  writeFileSync(join(cloudHome, "noop.toml"), '[cloud]\nurl = "https://synthetic.invalid"\n[server]\ntoken = "synthetic-cloud-machine-token-000"\n');
  writeFileSync(join(cloudHome, "data", "config.toml"), '[fleet]\nprimary = "synthetic-primary"\n');
  writeFileSync(join(updateBin, "bunx"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NOOP_FAKE_CLOUD_MARKER"\nprintf "authentication missing\\n"\n', { mode: 0o755 });
  const cloudUpdate = cli(["update"], { ...env, NOOP_HOME: cloudHome, HUB_HOST: "synthetic-primary", NOOP_FAKE_CLOUD_MARKER: cloudMarker, PATH: `${updateBin}:${env.PATH}` });
  check(cloudUpdate.status === 0 && cloudUpdate.output.includes("self-updated") && readFileSync(cloudMarker, "utf8").includes("wrangler whoami"),
    "a cloud primary update still enters the existing cloud deployment path");

  await stop(base);
  await start(env, address, base);
  const after = cli(["2fa", "status"], env);
  check(after.status === 0 && /2FA is bound|两步验证已绑定/.test(after.output), "TOTP binding survives restart");
  await page.reload({ waitUntil: "domcontentloaded" });
  await composer.waitFor({ timeout: 30_000 });
  check(true, "owner session survives restart");
  const secondPeer = { ...env, NOOP_HOME: join(artifacts, "peer-after-restart") };
  const rejoined = cli(["init", base, "--token", token], secondPeer);
  check(rejoined.status === 0 && existsSync(join(secondPeer.NOOP_HOME, "data", "tasks", "inbox", `${task}.md`)), "shared task survives restart");
  check(!readFileSync(guard, "utf8"), "local flow never invokes Cloudflare or an agent CLI");
  await stop(base);
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e);
  console.error(`FAIL ${error}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (service?.pid) {
    try { process.kill(-service.pid, "SIGTERM"); } catch {}
  }
  const hash = (file: string) => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    platform: `${process.platform}-${process.arch}`, bun: Bun.version,
    webAssets: { directory: basename(webAssets), version: process.env.NOOP_E2E_WEB_VERSION || "not specified", indexSha256: hash(join(webAssets, "index.html")) },
    workerd: { name: basename(workerd), version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) },
    chromium: existsSync(browserExecutable) ? spawnSync(browserExecutable, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", playwright: playwrightVersion, checks, error };
  writeFileSync(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(artifacts, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS").map((entry) => entry.name);
  writeFileSync(join(artifacts, "SHA256SUMS"), files.map((name) => `${createHash("sha256").update(readFileSync(join(artifacts, name))).digest("hex")}  ${name}`).join("\n") + "\n");
  console.log(`Evidence: ${artifacts}`);
}
