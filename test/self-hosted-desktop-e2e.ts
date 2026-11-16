// Real Linux desktop client against an isolated local coordinator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-desktop-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", desktop = process.env.NOOP_E2E_DESKTOP || "";
const checks: string[] = [], requests: string[] = [], sockets: Socket[] = [], sentMessages: string[] = [];
let incoming = "";
let service: ChildProcess | undefined, app: ChildProcess | undefined, proxy: HttpServer | undefined, error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) { value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function port() {
  const s = createNetServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await condition()) return; await Bun.sleep(200); }
  throw new Error(message);
}
try {
  check(process.platform === "linux" && existsSync(desktop) && existsSync(workerd) && existsSync(join(assets, "index.html")) &&
    ["xdotool", "xvfb-run", "dbus-run-session", "import", "tesseract"].every((name) => Bun.which(name)), "Linux desktop, workerd, Web bundle and display tools are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd"));
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg", "config"), XDG_DATA_HOME: join(out, "xdg", "data"),
    XDG_CACHE_HOME: join(out, "xdg", "cache"), HUB_HOST: "noop-e2e-host", HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NOOP_CLIENT_BASE_URL", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[key];
  const listenPort = await port(), proxyPort = await port(), base = `http://127.0.0.1:${listenPort}`, clientBase = `http://127.0.0.1:${proxyPort}`;
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const serviceFd = openSync(join(out, "coordinator.log"), "a");
  service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
    { cwd: repo, env, detached: true, stdio: ["ignore", serviceFd, serviceFd] }); closeSync(serviceFd);
  await waitFor(async () => {
    try {
      const config = Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any;
      return (await fetch(base)).ok && config.cloud?.mode === "local" && config.cloud.url === base;
    } catch { return false; }
  }, "coordinator did not start", 30_000);
  check(true, "local coordinator starts");
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "synthetic owner binds TOTP");
  const log = (method: string, path: string, status: number) => requests.push(`${method} ${path.split("?")[0]} ${status}`);
  const target = (method: string, path: string, headers: any) => ({ hostname: "127.0.0.1", port: listenPort, method, path, headers });
  proxy = createHttpServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/messages") {
      let body = ""; req.on("data", (part) => { body += part; }); req.on("end", () => sentMessages.push(JSON.parse(body).text));
    }
    const upstream = httpRequest(target(req.method!, req.url!, req.headers), (reply) => { log(req.method!, req.url!, reply.statusCode!); res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res); });
    upstream.on("error", () => res.destroy()); req.pipe(upstream);
  });
  proxy.on("connection", (socket) => sockets.push(socket));
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest(target(req.method!, req.url!, req.headers));
    upstream.on("upgrade", (reply, peer, first) => {
      sockets.push(peer); log(req.method!, req.url!, reply.statusCode!);
      peer.on("data", (part) => { incoming += part.toString(); });
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n` + reply.rawHeaders.reduce((s, h, i, a) => i % 2 ? s : s + `${h}: ${a[i + 1]}\r\n`, "") + "\r\n");
      if (head.length) peer.write(head); if (first.length) socket.write(first); socket.pipe(peer).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((ok) => proxy!.listen(proxyPort, "127.0.0.1", ok));
  const displayFile = join(out, "display"), appFd = openSync(join(out, "desktop.log"), "a");
  app = spawn("dbus-run-session", ["--", "xvfb-run", "-a", "-e", join(out, "xvfb.log"), "-s", "-screen 0 1280x800x24", "sh", "-c", 'printf "%s\\n" "$DISPLAY" > "$NOOP_E2E_DISPLAY"; exec "$NOOP_E2E_DESKTOP"'],
    { cwd: out, env: { ...env, GDK_BACKEND: "x11", NOOP_E2E_DISPLAY: displayFile, NOOP_E2E_DESKTOP: resolve(desktop) }, detached: true, stdio: ["ignore", appFd, appFd] }); closeSync(appFd);
  await waitFor(() => existsSync(displayFile) && !!readFileSync(displayFile, "utf8").trim(), "desktop display did not start");
  const display = readFileSync(displayFile, "utf8").trim(), guiEnv = { ...env, DISPLAY: display };
  let window = "";
  await waitFor(() => {
    if (app!.exitCode !== null || app!.signalCode !== null) throw new Error("desktop exited before opening a window; see desktop.log and xvfb.log");
    const r = spawnSync("xdotool", ["search", "--onlyvisible", "--name", "Noop"], { env: guiEnv, encoding: "utf8" }); window = r.stdout?.trim().split("\n")[0] || ""; return !!window;
  }, "desktop window did not open");
  const gui = (...args: string[]) => { const r = spawnSync("xdotool", args, { env: guiEnv, timeout: 10_000 }); if (r.status !== 0) throw new Error(`desktop input failed: ${args[0]}`); };
  const click = (x: number, y: number) => gui("mousemove", "--window", window, String(x), String(y), "click", "1");
  await Bun.sleep(1000); click(125, 410); gui("type", "--clearmodifiers", "desktop@example.com"); click(125, 495); gui("type", "--clearmodifiers", clientBase); click(180, 598);
  await waitFor(() => requests.includes("POST /api/auth/start 200"), "desktop could not request the login code");
  check(true, "desktop requests a login code through local HTTP");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(login.status === 0 && !!code, "owner retrieves the desktop login code from the CLI");
  await Bun.sleep(500); click(125, 410); gui("type", "--clearmodifiers", code); click(125, 495); gui("type", "--clearmodifiers", totp(secret, Math.floor(Date.now() / 30_000)));
  await waitFor(() => requests.includes("POST /api/auth/verify 200"), "desktop could not sign in");
  check(true, "desktop signs in with the CLI code and TOTP");
  await waitFor(() => requests.includes("GET /api/stream 101"), "desktop did not connect its WebSocket");
  check(true, "desktop opens the live WebSocket");
  await waitFor(() => {
    const image = spawnSync("import", ["-window", window, "png:-"], { env: guiEnv, timeout: 15_000 });
    const text = spawnSync("tesseract", ["stdin", "stdout"], { input: image.stdout, encoding: "utf8", timeout: 15_000 });
    return image.status === 0 && text.status === 0 && /tell the team/i.test(text.stdout);
  }, "desktop composer did not appear", 30_000);
  click(125, 765); gui("type", "--clearmodifiers", "Native desktop sends a message"); gui("key", "Return");
  await waitFor(() => requests.includes("POST /api/messages 200") && sentMessages.includes("Native desktop sends a message"), "desktop did not send the message");
  check(true, "desktop sends a message to the local coordinator");
  const post = (path: string, body: object, token = "") => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  check((await post("/api/auth/start", { email: "peer@example.com" })).ok, "independent peer starts sign-in");
  const peerLogin = cli(["login"]), peerCode = peerLogin.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const peerAuth = await post("/api/auth/verify", { email: "peer@example.com", code: peerCode, totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) });
  const peerSession = ((await peerAuth.json()) as { session?: string }).session;
  check(peerLogin.status === 0 && peerAuth.ok && !!peerSession, "independent peer signs in");
  const initialStatus = await (await fetch(base + "/api/status", { headers: { Authorization: `Bearer ${peerSession}` } })).json() as { decisions?: unknown };
  check(!Array.isArray(initialStatus.decisions), "desktop works before the primary publishes a status snapshot");
  const incomingText = "Desktop receives live update";
  check((await post("/api/messages", { text: incomingText }, peerSession)).ok, "independent peer sends a message");
  await waitFor(() => incoming.includes(incomingText), "message did not arrive on the desktop WebSocket");
  check(true, "desktop WebSocket receives the peer message");
  const screenshot = join(out, "desktop-message.png");
  await waitFor(() => {
    const image = spawnSync("import", ["-window", window, screenshot], { env: guiEnv, timeout: 15_000 });
    const text = spawnSync("tesseract", [screenshot, "stdout"], { encoding: "utf8", timeout: 15_000 });
    return image.status === 0 && text.status === 0 && /receives\s+live\s+update/i.test(text.stdout);
  }, "desktop did not render the peer message", 30_000);
  check(true, "desktop renders the peer message and saves a screenshot");
  const machineToken = (Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any).server.token as string;
  const snapshot = { tasks: { proposed: 0, inbox: 0, active: 0, blocked: 0, failed: 0, done: 0 }, active: [], recent: [], hosts: [],
    decisions: [{ id: "D-9001", kind: "decision", question: "Snapshot decision", held: true }] };
  const pushed = await fetch(base + "/api/host/state", { method: "PUT", headers: { Authorization: `Bearer ${machineToken}`, "content-type": "application/json" }, body: JSON.stringify({ status: snapshot }) });
  check(pushed.ok, "synthetic primary publishes a complete status snapshot");
  await waitFor(() => incoming.includes("Snapshot decision"), "desktop did not receive the status snapshot");
  click(22, 26);
  const snapshotScreenshot = join(out, "desktop-snapshot.png");
  await waitFor(() => {
    const image = spawnSync("import", ["-window", window, snapshotScreenshot], { env: guiEnv, timeout: 15_000 });
    const text = spawnSync("tesseract", [snapshotScreenshot, "stdout"], { encoding: "utf8", timeout: 15_000 });
    return image.status === 0 && text.status === 0 && /snapshot\s+decision/i.test(text.stdout);
  }, "desktop did not render the status snapshot", 30_000);
  check(true, "desktop renders the pushed status snapshot");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  for (const child of [app, service]) if (child?.pid) try { process.kill(-child.pid, "SIGINT"); } catch {}
  for (const socket of sockets) socket.destroy(); proxy?.close();
  writeFileSync(join(out, "requests.log"), requests.join("\n") + "\n");
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    platform: `${process.platform}-${process.arch}`, timestamp: new Date().toISOString(), bun: Bun.version,
    desktop: { executableSha256: hash(desktop), bundleSha256: hash(join(dirname(desktop), "nsh", "bundle.nshc")), archiveSha256: hash(process.env.NOOP_E2E_DESKTOP_ARCHIVE || "") },
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) },
    webIndexSha256: hash(join(assets, "index.html")), checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
