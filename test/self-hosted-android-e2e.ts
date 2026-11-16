// An Android emulator runs the packaged client against an isolated coordinator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-android-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", apk = process.env.NOOP_E2E_ANDROID_APK || "";
const serial = process.env.ANDROID_SERIAL || "", checks: string[] = [], requests: string[] = [], sockets: Socket[] = [];
let service: ChildProcess | undefined, proxy: HttpServer | undefined, error = "", incoming = "", proxyPort = 0;
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
async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await condition()) return; await Bun.sleep(300); }
  throw new Error(message);
}
const adb = (...args: string[]) => {
  const r = spawnSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`adb ${args.slice(0, 2).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const ui = () => { adb("shell", "uiautomator", "dump", "/sdcard/noop-e2e.xml"); return adb("exec-out", "cat", "/sdcard/noop-e2e.xml"); };
const tap = (id: string) => {
  const xml = ui(), match = xml.match(new RegExp(`<node\\b[^>]*resource-id="${id}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!match) throw new Error(`Android control ${id} was not visible`);
  adb("shell", "input", "tap", String(Math.round((+match[1] + +match[3]) / 2)), String(Math.round((+match[2] + +match[4]) / 2)));
};
const hideKeyboard = () => adb("shell", "input", "keyevent", "KEYCODE_BACK");
try {
  check(process.platform === "linux" && process.env.NOOP_E2E_DISPOSABLE_ANDROID === "1" && /^emulator-\d+$/.test(serial) && !!Bun.which("adb") &&
    existsSync(apk) && existsSync(workerd) && existsSync(join(assets, "index.html")), "disposable Android emulator, APK, workerd and Web bundle are supplied");
  check(adb("get-state").trim() === "device", "Android emulator is online");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd"));
  const env: NodeJS.ProcessEnv = { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg"), HUB_HOST: "noop-e2e-host", HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NOOP_CLIENT_BASE_URL"]) delete env[key];
  const listenPort = await port(); proxyPort = await port(); const base = `http://127.0.0.1:${listenPort}`, clientBase = `http://127.0.0.1:${proxyPort}`;
  const cli = (args: string[]) => { const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 20_000 }); return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` }; };
  const fd = openSync(join(out, "coordinator.log"), "a");
  service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`], { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
  await waitFor(async () => { try { const c = Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any; return (await fetch(base)).ok && c.cloud?.mode === "local" && c.cloud.url === base; } catch { return false; } }, "coordinator did not start");
  check(true, "local coordinator starts");
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "synthetic owner binds TOTP");
  const log = (method: string, path: string, status: number) => requests.push(`${method} ${path.split("?")[0]} ${status}`);
  const target = (method: string, path: string, headers: any) => ({ hostname: "127.0.0.1", port: listenPort, method, path, headers });
  proxy = createHttpServer((req, res) => { const upstream = httpRequest(target(req.method!, req.url!, req.headers), (reply) => { log(req.method!, req.url!, reply.statusCode!); res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res); }); upstream.on("error", () => res.destroy()); req.pipe(upstream); });
  proxy.on("connection", (socket) => sockets.push(socket));
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest(target(req.method!, req.url!, req.headers));
    upstream.on("upgrade", (reply, peer, first) => {
      sockets.push(peer); log(req.method!, req.url!, reply.statusCode!); peer.on("data", (part) => { incoming += part.toString(); });
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n` + reply.rawHeaders.reduce((s, h, i, a) => i % 2 ? s : s + `${h}: ${a[i + 1]}\r\n`, "") + "\r\n");
      if (head.length) peer.write(head); if (first.length) socket.write(first); socket.pipe(peer).pipe(socket);
    }); upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((ok) => proxy!.listen(proxyPort, "127.0.0.1", ok));
  adb("reverse", `tcp:${proxyPort}`, `tcp:${proxyPort}`); adb("install", "-r", resolve(apk));
  adb("shell", "am", "force-stop", "dev.noop.app"); adb("shell", "pm", "clear", "dev.noop.app");
  adb("shell", "monkey", "-p", "dev.noop.app", "1"); await Bun.sleep(5000); hideKeyboard();
  await waitFor(() => ui().includes('resource-id="email"'), "Android sign-in did not appear");
  tap("email"); adb("shell", "input", "text", "android@example.com"); hideKeyboard();
  tap("url"); adb("shell", "input", "text", clientBase); hideKeyboard(); tap("send-code");
  await waitFor(() => requests.includes("POST /api/auth/start 200"), "Android app could not request the login code");
  check(true, "Android app requests a login code through local HTTP");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(login.status === 0 && !!code, "owner retrieves the Android login code from the CLI");
  await waitFor(() => ui().includes('resource-id="code"'), "Android code entry did not appear");
  tap("code"); adb("shell", "input", "text", code); hideKeyboard(); tap("totp"); adb("shell", "input", "text", totp(secret, Math.floor(Date.now() / 30_000))); hideKeyboard();
  await waitFor(() => requests.includes("POST /api/auth/verify 200"), "Android app could not sign in"); check(true, "Android app signs in with the CLI code and TOTP");
  await waitFor(() => requests.includes("GET /api/stream 101"), "Android app did not connect its WebSocket"); check(true, "Android app opens the live WebSocket");
  await waitFor(() => ui().includes('resource-id="composer"'), "Android composer did not appear");
  tap("composer"); adb("shell", "input", "text", "Android%ssends%sa%smessage"); hideKeyboard(); tap("send");
  await waitFor(() => requests.includes("POST /api/messages 200"), "Android app did not send the message"); check(true, "Android app sends a message to the local coordinator");
  const post = (path: string, body: object, token = "") => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  check((await post("/api/auth/start", { email: "peer@example.com" })).ok, "independent peer starts sign-in");
  const peerLogin = cli(["login"]), peerCode = peerLogin.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const peerAuth = await post("/api/auth/verify", { email: "peer@example.com", code: peerCode, totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) });
  const peerSession = ((await peerAuth.json()) as { session?: string }).session;
  check(peerLogin.status === 0 && peerAuth.ok && !!peerSession, "independent peer signs in");
  const message = "Android receives live update";
  check((await post("/api/messages", { text: message }, peerSession)).ok, "independent peer sends a message");
  await waitFor(() => incoming.includes(message), "message did not arrive on the Android WebSocket"); check(true, "Android WebSocket receives the peer message");
  await waitFor(() => ui().includes(message), "Android app did not render the peer message"); check(true, "Android app renders the peer message");
  const screenshot = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], { timeout: 20_000 });
  check(screenshot.status === 0 && !!screenshot.stdout.length, "Android screenshot is saved"); writeFileSync(join(out, "android-message.png"), screenshot.stdout);
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (proxyPort) try { adb("reverse", "--remove", `tcp:${proxyPort}`); } catch {}
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  for (const socket of sockets) socket.destroy(); proxy?.close();
  writeFileSync(join(out, "requests.log"), requests.join("\n") + "\n");
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    platform: `${process.platform}-${process.arch}`, timestamp: new Date().toISOString(), bun: Bun.version, apkSha256: hash(apk),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) }, webIndexSha256: hash(join(assets, "index.html")), checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n"); console.log(`Evidence: ${out}`);
}
