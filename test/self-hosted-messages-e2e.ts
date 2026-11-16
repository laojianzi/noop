// Two real Web sessions against an isolated native coordinator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-messages-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const browserPath = process.env.NOOP_E2E_BROWSER || Bun.which("chromium") || "";
const playwrightModule = process.env.NOOP_E2E_PLAYWRIGHT || "playwright-core";
const checks: string[] = [];
let service: ChildProcess | undefined, browser: any, error = "", playwrightVersion = "not loaded";
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
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd) && existsSync(browserPath), "Web assets, workerd and Chromium are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd"));
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg"), HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NOOP_CLIENT_BASE_URL"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const start = async () => {
    const fd = openSync(log, "a");
    service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
      { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    for (let i = 0; i < 150; i++) {
      if (service.exitCode !== null) throw new Error(`coordinator exited: ${readFileSync(log, "utf8").slice(-1500)}`);
      try { const ok = (await fetch(base)).ok; const config = Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any; if (ok && config.cloud?.mode === "local" && config.cloud.url === base) return; } catch {} await Bun.sleep(200);
    }
    throw new Error("coordinator did not start");
  };
  const stop = async () => {
    const child = service!; child.kill("SIGTERM");
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error("coordinator did not stop");
    for (let i = 0; i < 50; i++) { try { await fetch(base); } catch { return; } await Bun.sleep(100); }
    throw new Error("coordinator port remained open");
  };
  await start(); check(true, "local coordinator starts");
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32, "owner starts authenticator setup");
  check(cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "owner binds the authenticator");
  const { chromium } = await import(playwrightModule);
  try { playwrightVersion = JSON.parse(readFileSync(join(dirname(require.resolve(playwrightModule)), "package.json"), "utf8")).version; } catch {}
  browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
  const frames: string[] = [];
  const login = async (email: string, offset: number, observe = false) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    if (observe) page.on("websocket", (socket: any) => socket.on("framereceived", (frame: any) => frames.push(String(frame.payload))));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("you@example.com").fill(email, { timeout: 30_000 });
    await page.getByText(/^(Send code|发送验证码)$/).click();
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll("input").length >= 2, { timeout: 15_000 });
    const result = cli(["login"]), code = result.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
    check(result.status === 0 && !!code, `${email} gets a login code from the CLI`);
    const verified = page.waitForResponse((r: any) => r.url().includes("/api/auth/verify") && r.status() === 200, { timeout: 30_000 });
    await page.locator("input").nth(0).fill(code); await page.locator("input").nth(1).fill(totp(secret, Math.floor(Date.now() / 30_000) + offset));
    const session = ((await (await verified).json()) as { session: string }).session;
    await page.getByPlaceholder(/Tell the team what to do|给团队下指令/).waitFor({ timeout: 30_000 });
    check(!!session, `${email} signs in through the real Web client`); return { context, page, session };
  };
  const a = await login("first@example.com", 0), b = await login("second@example.com", 1, true);
  check(a.session !== b.session, "two separately authenticated clients have different sessions");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=", "base64");
  const chooser = a.page.waitForEvent("filechooser", { timeout: 15_000 });
  await a.page.getByRole("button", { name: /Add image|添加图片/ }).click();
  await (await chooser).setFiles({ name: "fixture.png", mimeType: "image/png", buffer: png });
  await a.page.getByTestId("attachment").waitFor({ timeout: 15_000 });
  const message = "Self-hosted Web attachment acceptance";
  const upload = a.page.waitForResponse((r: any) => r.url().includes("/api/uploads") && r.request().method() === "POST", { timeout: 30_000 });
  const sent = a.page.waitForResponse((r: any) => r.url().includes("/api/messages") && r.request().method() === "POST", { timeout: 30_000 });
  const input = a.page.getByPlaceholder(/Tell the team what to do|给团队下指令/); await input.fill(message); await input.press("Enter");
  const uploaded = await upload, sentMessage = await sent;
  check(uploaded.status() === 200 && sentMessage.status() === 200, "owner uploads an image and sends a message from the Web UI");
  const media = ((await uploaded.json()) as { url: string }).url;
  await b.page.getByText(message, { exact: true }).waitFor({ timeout: 30_000 });
  check(frames.some((frame) => frame.includes(message)), "second Web client receives the message over its live WebSocket");
  const unauthorized = await fetch(base + media), authorized = await fetch(base + media, { headers: { Authorization: `Bearer ${b.session}` } });
  check(unauthorized.status === 401 && authorized.ok && Buffer.from(await authorized.arrayBuffer()).equals(png), "media rejects anonymous access and returns exact bytes to the second owner");
  const imageLoaded = await b.page.locator(`img[src*="${media}"]`).evaluate((img: { complete: boolean; naturalWidth: number }) => img.complete && img.naturalWidth > 0);
  check(imageLoaded, "second Web client renders the attached image");
  const rejected = async (body: Blob, name: string) => { const fd = new FormData(); fd.append("file", body, name); return fetch(base + "/api/uploads", { method: "POST", headers: { Authorization: `Bearer ${a.session}` }, body: fd }); };
  check((await rejected(new Blob(["not an image"], { type: "text/plain" }), "invalid.txt")).status === 415, "non-image upload is rejected");
  check((await rejected(new Blob([png, new Uint8Array(10 * 1024 * 1024)], { type: "image/png" }), "large.png")).status === 413, "uploads larger than 10 MiB are rejected");
  await stop(); await b.context.setOffline(true); await start();
  const missed = "Message while second client is offline";
  const posted = await fetch(base + "/api/messages", { method: "POST", headers: { Authorization: `Bearer ${a.session}`, "content-type": "application/json" }, body: JSON.stringify({ text: missed }) });
  check(posted.ok, "a message is created while the second Web client is offline");
  await b.context.setOffline(false);
  await b.page.getByText(missed, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "the second client automatically reconnects and synchronizes its missed message");
  const restored = await fetch(base + media, { headers: { Authorization: `Bearer ${b.session}` } });
  check(restored.ok && Buffer.from(await restored.arrayBuffer()).equals(png), "the exact attachment survives coordinator restart");
  const second = "Message after coordinator reconnect";
  await a.page.getByPlaceholder(/Tell the team what to do|给团队下指令/).fill(second);
  await a.page.getByPlaceholder(/Tell the team what to do|给团队下指令/).press("Enter");
  await b.page.getByText(second, { exact: true }).waitFor({ timeout: 30_000 });
  check(frames.some((frame) => frame.includes(second)), "reconnected Web client receives new messages over WebSocket");
  await b.page.reload({ waitUntil: "domcontentloaded" });
  await b.page.getByText(message, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "a fresh page reads the original message after restart");
  await b.page.screenshot({ path: join(out, "web-messages-after-restart.png") });
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, webVersion: process.env.NOOP_E2E_WEB_VERSION || "not specified", webIndexSha256: hash(join(assets, "index.html")),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) },
    chromium: existsSync(browserPath) ? spawnSync(browserPath, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", playwright: playwrightVersion, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
