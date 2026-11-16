// Exercise native client-IP metadata and a real TLS reverse proxy against workerd.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-ingress-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const token = "synthetic-ingress-token-000000000", allowed = "127.0.0.1,127.0.0.2", trusted = "127.0.0.3";
const checks: string[] = [];
let service: ChildProcess | undefined, raw: ChildProcess | undefined, proxy: ReturnType<typeof httpsServer> | undefined, error = "";
const proxySockets = new Set<any>();

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
  checks.push(message); console.log(`PASS ${message}`);
}
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
async function waitFor(fn: () => Promise<boolean>, message: string) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await fn()) return; await Bun.sleep(100); }
  throw new Error(message);
}
function request(opts: { port?: number; socketPath?: string; secure?: boolean; hostname?: string; path?: string; localAddress?: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const fn = opts.secure ? httpsRequest : httpRequest;
    const req = fn({ hostname: opts.hostname || "127.0.0.1", port: opts.port, socketPath: opts.socketPath, path: opts.path || "/api/status", localAddress: opts.localAddress,
      rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}`, ...opts.headers } } as any, (res) => {
      let body = ""; res.on("data", (part) => body += part); res.on("end", () => ok({ status: res.statusCode || 0, body }));
    });
    req.on("error", fail); req.setTimeout(3000, () => req.destroy(new Error("request timeout"))); req.end();
  });
}
async function ping(url: string, secure = false) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, ...(secure ? { tls: { rejectUnauthorized: false } } : {}) } as any);
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("WebSocket timeout")), 8000);
      ws.onopen = () => ws.send("ping");
      ws.onmessage = (e) => { if (e.data === "pong") { clearTimeout(timer); ok(); } };
      ws.onerror = () => { clearTimeout(timer); fail(new Error("WebSocket connection failed")); };
    });
  } finally { ws.close(); }
}

try {
  check(existsSync(join(assets, "index.html")), "real Web assets are supplied");
  check(existsSync(workerd), "workerd executable is supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[cloud]\nallow_ips = "${allowed}"\ntrusted_proxies = "${trusted}"\n[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), fd = openSync(log, "a");
  service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
    { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
  await waitFor(async () => {
    if (service?.exitCode !== null && service?.exitCode !== undefined) throw new Error(`coordinator exited: ${readFileSync(log, "utf8").slice(-2000)}`);
    if (!existsSync(join(home, "noop.toml"))) return false;
    try { return (await request({ port: listenPort })).status === 200 && (Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any).cloud.mode === "local"; } catch { return false; }
  }, "coordinator did not start with a local allow-list");
  check(true, "local coordinator starts with an IP allow-list");
  const healthPath = join(home, "coordinator", "health.sock");
  check((await request({ socketPath: healthPath })).status === 200 &&
    (await request({ socketPath: healthPath, headers: { Authorization: "Bearer invalid" } })).status === 401,
    "private health access still requires the machine credential");
  check((await request({ socketPath: healthPath, path: "/api/feed" })).status === 404, "private health access exposes no other API");
  check((await request({ port: listenPort, localAddress: "127.0.0.2" })).status === 200, "allowed direct source can connect");
  check((await request({ port: listenPort, localAddress: "127.0.0.2", headers: { "cf-connecting-ip": "127.0.0.4" } })).status === 200,
    "a forged header cannot block an allowed direct source");
  check((await request({ port: listenPort, localAddress: "127.0.0.4" })).status === 403, "unlisted direct source is rejected");
  check((await request({ port: listenPort, localAddress: "127.0.0.4", headers: { "cf-connecting-ip": "127.0.0.2", "x-forwarded-for": "127.0.0.2" } })).status === 403,
    "forged forwarding headers cannot make an unlisted direct source trusted");
  await ping(`ws://127.0.0.1:${listenPort}/api/host/stream`); check(true, "direct WebSocket remains usable");

  const key = join(out, "proxy.key"), cert = join(out, "proxy.crt");
  const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { encoding: "utf8" });
  if (openssl.status !== 0) throw new Error(`could not create the synthetic proxy certificate: ${openssl.stderr}`);
  const headersFor = (req: IncomingMessage) => {
    const h = { ...req.headers };
    if (h["x-test-drop-forwarded"]) { delete h["x-forwarded-for"]; delete h["x-test-drop-forwarded"]; }
    else h["x-forwarded-for"] = [h["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    h["x-forwarded-proto"] = "https"; h["x-forwarded-host"] = String(req.headers.host || ""); return h;
  };
  proxy = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: listenPort, localAddress: "127.0.0.3", method: req.method, path: req.url, headers: headersFor(req) }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  proxy.on("connection", (socket) => { proxySockets.add(socket); socket.on("close", () => proxySockets.delete(socket)); });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: listenPort, localAddress: "127.0.0.3", method: req.method, path: req.url, headers: headersFor(req) });
    upstream.on("upgrade", (response, other, first) => {
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((s, h, i, a) => i % 2 ? s : `${s}${h}: ${a[i + 1]}\r\n`, "")}\r\n`);
      if (first.length) socket.write(first); if (head.length) other.write(head);
      socket.on("error", () => other.destroy()); other.on("error", () => socket.destroy()); socket.pipe(other).pipe(socket);
    });
    upstream.on("response", (response) => { socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`); response.pipe(socket); });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  const proxyPort = await port(); await new Promise<void>((ok) => proxy!.listen(proxyPort, "127.0.0.1", ok));
  check((await request({ port: proxyPort, secure: true, localAddress: "127.0.0.2" })).status === 200, "actual HTTPS proxy forwards an allowed source");
  check((await request({ port: proxyPort, secure: true, localAddress: "127.0.0.4", headers: { "x-forwarded-for": "127.0.0.2", "cf-connecting-ip": "127.0.0.2" } })).status === 403,
    "a forged source in the proxy chain cannot bypass the allow-list");
  check((await request({ port: proxyPort, secure: true, localAddress: "127.0.0.2", headers: { "x-test-drop-forwarded": "1" } })).status === 403,
    "a trusted proxy without a client source is rejected");
  check((await request({ port: proxyPort, secure: true, localAddress: "127.0.0.3" })).status === 403,
    "a chain containing only trusted proxies has no verifiable client source");
  await ping(`wss://127.0.0.1:${proxyPort}/api/host/stream`, true); check(true, "WebSocket survives the actual HTTPS proxy");

  const post = (path: string, body: unknown) => new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((ok, fail) => {
    const text = JSON.stringify(body);
    const req = httpsRequest({ hostname: "127.0.0.1", port: proxyPort, path, method: "POST", rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
      let data = ""; res.on("data", (part) => data += part); res.on("end", () => ok({ status: res.statusCode || 0, headers: res.headers, body: data }));
    });
    req.on("error", fail); req.end(text);
  });
  const initialized = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ingress-e2e", version: "1" } } });
  const sid = String(initialized.headers["mcp-session-id"] || "");
  check(initialized.status === 200 && !!sid, "MCP session initializes through the HTTPS proxy");
  const streamRequest = httpsRequest({ hostname: "127.0.0.1", port: proxyPort, path: "/mcp", rejectUnauthorized: false,
    headers: { Authorization: `Bearer ${token}`, accept: "text/event-stream", "mcp-session-id": sid } });
  const stream = await new Promise<IncomingMessage>((ok, fail) => { streamRequest.on("response", ok); streamRequest.on("error", fail); streamRequest.end(); });
  check(stream.statusCode === 200 && stream.headers["content-type"] === "text/event-stream", "streaming HTTP opens through the HTTPS proxy");
  const streamed = new Promise<void>((ok, fail) => {
    let body = ""; const timer = setTimeout(() => fail(new Error("streamed event timeout")), 8000);
    stream.on("data", (part) => { body += part; if (body.includes("streaming-proxy-event")) { clearTimeout(timer); ok(); } });
    stream.on("error", (e) => { clearTimeout(timer); fail(e); });
  });
  check((await post("/api/events", { from: "ingress-e2e", kind: "notice", text: "streaming-proxy-event" })).status === 200, "an event is published through the HTTPS proxy");
  await streamed; stream.destroy(); streamRequest.destroy();
  check(true, "streaming HTTP delivers the event without closing the response");

  service.kill("SIGTERM");
  await new Promise<void>((ok) => service!.once("exit", () => ok())); service = undefined;
  const coordinator = join(home, "coordinator"), unixPath = join(coordinator, "test.sock"), unixConfig = join(coordinator, "unix-test.capnp");
  rmSync(healthPath, { force: true });
  const config = readFileSync(join(coordinator, "workerd.capnp"), "utf8").replace(`address = "127.0.0.1:${listenPort}"`, `address = ${JSON.stringify(`unix:${unixPath}`)}`);
  writeFileSync(unixConfig, config);
  const rawLog = openSync(join(out, "unix.log"), "a");
  raw = spawn(workerd, ["serve", unixConfig], { detached: true, stdio: ["ignore", rawLog, rawLog], env: { ...env,
    NOOP_LOCAL_TOKEN: token, NOOP_LOCAL_OWNER_EMAIL: "", NOOP_LOCAL_SMTP: "", NOOP_LOCAL_LANG: "",
    NOOP_LOCAL_ALLOW_IPS: allowed, NOOP_LOCAL_TRUSTED_PROXIES: trusted, NOOP_LOCAL_MODE: "1" } }); closeSync(rawLog);
  await waitFor(async () => existsSync(unixPath), "Unix socket did not start");
  check((await request({ socketPath: unixPath, headers: { "cf-connecting-ip": "127.0.0.2" } })).status === 403,
    "a request with no verifiable network source is rejected");
  raw.kill("SIGINT"); await new Promise<void>((ok) => raw!.once("exit", () => ok())); raw = undefined;

  const v6Home = join(out, "ipv6"), v6Port = await port(); mkdirSync(v6Home, { recursive: true });
  writeFileSync(join(v6Home, "noop.toml"), `[cloud]\nallow_ips = "::1"\n[server]\ntoken = "${token}"\n`);
  const v6Log = openSync(join(out, "ipv6.log"), "a");
  service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `[::1]:${v6Port}`],
    { cwd: repo, env: { ...env, NOOP_HOME: v6Home }, detached: true, stdio: ["ignore", v6Log, v6Log] }); closeSync(v6Log);
  await waitFor(async () => {
    if (service?.exitCode !== null && service?.exitCode !== undefined) throw new Error(`IPv6 coordinator exited: ${readFileSync(join(out, "ipv6.log"), "utf8")}`);
    try { return (await request({ hostname: "::1", port: v6Port })).status === 200; } catch { return false; }
  }, "IPv6 coordinator did not start");
  check(true, "allowed IPv6 loopback source can connect");
  service.kill("SIGTERM"); await new Promise<void>((ok) => service!.once("exit", () => ok())); service = undefined;

  for (const [name, entry, message] of [["invalid-allow", 'allow_ips = "not-a-cidr"', "invalid IP allow-list"],
    ["invalid-cidr-suffix", 'allow_ips = "127.0.0.1/0/garbage"', "invalid IP allow-list"],
    ["invalid-proxy", 'allow_ips = "127.0.0.1"\ntrusted_proxies = "not-a-cidr"', "invalid trusted proxy"]]) {
    const badHome = join(out, name); mkdirSync(badHome, { recursive: true });
    writeFileSync(join(badHome, "noop.toml"), `[cloud]\n${entry}\n[server]\ntoken = "${token}"\n`);
    const badLog = join(out, `${name}.log`), badFd = openSync(badLog, "a");
    const bad = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${await port()}`],
      { cwd: repo, env: { ...env, NOOP_HOME: badHome }, detached: true, stdio: ["ignore", badFd, badFd] }); closeSync(badFd);
    const deadline = Date.now() + 5000;
    while (bad.exitCode === null && bad.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
    const rejected = bad.exitCode !== null && bad.exitCode !== 0 && readFileSync(badLog, "utf8").includes(message);
    if (bad.pid) try { process.kill(-bad.pid, "SIGINT"); } catch {}
    check(rejected, `${name} is rejected before serving requests`);
  }
  for (const [name, entry] of [["remote-only", 'allow_ips = "198.51.100.7"'],
    ["trusted-loopback", 'allow_ips = "127.0.0.2"\ntrusted_proxies = "127.0.0.1"']]) {
    const restrictedHome = join(out, name), restrictedPort = await port(); mkdirSync(restrictedHome, { recursive: true });
    writeFileSync(join(restrictedHome, "noop.toml"), `[cloud]\n${entry}\n[server]\ntoken = "${token}"\n`);
    const restrictedLog = openSync(join(out, `${name}.log`), "a");
    const restricted = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${restrictedPort}`],
      { cwd: repo, env: { ...env, NOOP_HOME: restrictedHome }, detached: true, stdio: ["ignore", restrictedLog, restrictedLog] }); closeSync(restrictedLog);
    let ready = false; const deadline = Date.now() + 6000;
    while (restricted.exitCode === null && restricted.signalCode === null && Date.now() < deadline) {
      try { ready = (Bun.TOML.parse(readFileSync(join(restrictedHome, "noop.toml"), "utf8")) as any).cloud?.mode === "local"; } catch {}
      if (ready) break;
      await Bun.sleep(100);
    }
    const status = ready ? (await request({ port: restrictedPort })).status : 0;
    if (restricted.pid) try { process.kill(-restricted.pid, "SIGINT"); } catch {}
    check(ready && status === 403, `${name} starts while unverified local requests remain forbidden`);
  }
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise<void>((ok) => proxy!.close(() => ok()));
  for (const child of [service, raw]) if (child?.pid) try { process.kill(-child.pid, "SIGINT"); } catch {}
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    bun: Bun.version, workerdVersion: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
