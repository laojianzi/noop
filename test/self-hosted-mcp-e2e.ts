// Real OAuth and MCP session through an isolated TLS reverse proxy.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHttpsProxy } from "./fixtures/https-proxy";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-mcp-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const token = "synthetic-mcp-machine-token-00000", checks: string[] = [];
let service: ChildProcess | undefined, proxy: Awaited<ReturnType<typeof startHttpsProxy>> | undefined, error = "";

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const c of secret) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
function frames(stream: IncomingMessage, marker: string) {
  return new Promise<{ id: string; body: string }>((ok, fail) => {
    let body = ""; const timer = setTimeout(() => fail(new Error(`no SSE event for ${marker}`)), 8000);
    stream.on("data", (data) => {
      body += data.toString();
      const frame = body.split("\n\n").find((part) => part.includes(marker));
      if (frame) { clearTimeout(timer); ok({ id: frame.match(/(?:^|\n)id: ([^\n]+)/)?.[1] || "", body }); }
    });
    stream.on("error", (e) => { clearTimeout(timer); fail(e); });
  });
}

try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "real Web assets and workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd")); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[cloud]\nallow_ips = "127.0.0.1,127.0.0.4"\ntrusted_proxies = "127.0.0.3"\n[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), fd = openSync(log, "a");
  service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
    { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) throw new Error(`coordinator exited: ${readFileSync(log, "utf8")}`);
    try { if ((Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any).cloud?.mode === "local") break; } catch {}
    await Bun.sleep(100);
  }
  check((Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any).cloud?.mode === "local", "local coordinator starts");
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000))]).status === 0, "owner binds TOTP with the real CLI");

  const direct = await new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: listenPort, localAddress: "127.0.0.4", path: "/.well-known/oauth-protected-resource",
      headers: { host: `direct.example.test:${listenPort}`, "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" } }, (res) => {
      let body = ""; res.on("data", (v) => body += v); res.on("end", () => ok({ status: res.statusCode || 0, body }));
    }); req.on("error", fail); req.end();
  });
  check(direct.status === 200 && JSON.parse(direct.body).resource === `http://direct.example.test:${listenPort}/mcp`, "untrusted forwarding headers cannot change the OAuth origin");

  proxy = await startHttpsProxy(out, listenPort);
  const external = `https://noop.example.test:${proxy.port}`;
  const open = (target: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(target, external);
    if (u.origin !== external) throw new Error(`unexpected external origin: ${u.origin}`);
    const headers: Record<string, string | number> = { host: u.host, ...opts.headers };
    if (opts.body !== undefined) headers["content-length"] = Buffer.byteLength(opts.body);
    const req = httpsRequest({ hostname: "127.0.0.1", port: proxy!.port, servername: u.hostname, path: u.pathname + u.search,
      method: opts.method || "GET", headers, rejectUnauthorized: false });
    if (opts.body !== undefined) req.write(opts.body); req.end(); return req;
  };
  const call = (target: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((ok, fail) => {
    const req = open(target, opts); req.on("error", fail); req.setTimeout(8000, () => req.destroy(new Error("request timeout")));
    req.on("response", (res) => { let body = ""; res.on("data", (v) => body += v); res.on("end", () => ok({ status: res.statusCode || 0, headers: res.headers, body })); });
  });
  const metadataResponse = await call("/.well-known/oauth-protected-resource"), metadata = JSON.parse(metadataResponse.body);
  writeFileSync(join(out, "discovery.json"), `${JSON.stringify({ expectedOrigin: external, status: metadataResponse.status, metadata }, null, 2)}\n`);
  check(metadataResponse.status === 200 && metadata.resource === `${external}/mcp` && metadata.authorization_servers?.includes(external),
    "OAuth discovery advertises the actual external HTTPS origin");
  const forged = await call("/.well-known/oauth-protected-resource", { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" } });
  check(JSON.parse(forged.body).resource === `${external}/mcp`, "the proxy replaces client-supplied external-origin headers");
  check((await call("/.well-known/oauth-protected-resource", { headers: { "x-test-forwarded-host": "attacker.example/path" } })).status === 400,
    "a malformed trusted forwarded host is rejected");
  check((await call("/.well-known/oauth-protected-resource", { headers: { "x-test-forwarded-proto": "javascript" } })).status === 400,
    "an unsupported trusted forwarded protocol is rejected");
  const unauthorized = await call("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check(unauthorized.status === 401 && String(unauthorized.headers["www-authenticate"]).includes(`${external}/.well-known/oauth-protected-resource`),
    "unauthorized MCP discovery points to the external HTTPS origin");
  const authMeta = JSON.parse((await call(`${external}/.well-known/oauth-authorization-server`)).body);
  check(authMeta.issuer === external && authMeta.authorization_endpoint === `${external}/oauth/authorize` && authMeta.token_endpoint === `${external}/oauth/token`,
    "authorization server endpoints use the external HTTPS origin");
  const asJson = { "content-type": "application/json" }, asForm = { "content-type": "application/x-www-form-urlencoded" };
  const redirect = "http://localhost:6274/oauth/callback";
  const registration = await call(authMeta.registration_endpoint, { method: "POST", headers: asJson, body: JSON.stringify({ client_name: "local-e2e", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
  const client = JSON.parse(registration.body); check(registration.status === 201 && !!client.client_id, "MCP client registers through the proxy");
  const verifier = crypto.randomUUID() + crypto.randomUUID(), challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "synthetic-state",
    code_challenge: challenge, code_challenge_method: "S256", scope: "noop", resource: metadata.resource });
  const authorize = `${authMeta.authorization_endpoint}?${query}`;
  check((await call(authorize)).status === 200, "authorization page opens through the proxy");
  const send = await call(authorize, { method: "POST", headers: asForm, body: new URLSearchParams({ step: "send", email: "owner@example.com" }).toString() });
  check(send.status === 200 && send.body.includes("noop login"), "owner requests a CLI-delivered login code");
  const login = cli(["login"]), emailCode = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(login.status === 0 && !!emailCode, "owner obtains the one-time code from the real CLI");
  const verify = await call(authorize, { method: "POST", headers: asForm, body: new URLSearchParams({ step: "verify", email: "owner@example.com", code: emailCode,
    totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) }).toString() });
  const callback = new URL(String(verify.headers.location || "http://invalid/"));
  check(verify.status === 302 && callback.origin + callback.pathname === redirect && callback.searchParams.get("state") === "synthetic-state" && !!callback.searchParams.get("code"),
    "OAuth verifies the code and TOTP and returns to the registered callback");
  const tokenResponse = await call(authMeta.token_endpoint, { method: "POST", headers: asForm, body: new URLSearchParams({ grant_type: "authorization_code",
    code: callback.searchParams.get("code")!, client_id: client.client_id, code_verifier: verifier, redirect_uri: redirect }).toString() });
  const grant = JSON.parse(tokenResponse.body); check(tokenResponse.status === 200 && !!grant.access_token && !!grant.refresh_token, "PKCE exchange issues an MCP access token");
  const auth = { Authorization: `Bearer ${grant.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (body: unknown, sid = "") => call("/mcp", { method: "POST", headers: { ...auth, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
  const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-e2e", version: "1" } } });
  const sid = String(initialized.headers["mcp-session-id"] || "");
  check(initialized.status === 200 && !!sid, "authorized MCP session initializes");
  const tool = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_status", arguments: {} } }, sid);
  check(tool.status === 200 && !!JSON.parse(JSON.parse(tool.body).result.content[0].text).hub, "authorized MCP client calls get_status");
  const stream = async (last = "") => {
    const req = open("/mcp", { headers: { Authorization: `Bearer ${grant.access_token}`, accept: "text/event-stream", "mcp-session-id": sid, ...(last ? { "last-event-id": last } : {}) } });
    const res = await new Promise<IncomingMessage>((ok, fail) => { req.on("response", ok); req.on("error", fail); });
    if (res.statusCode !== 200 || res.headers["content-type"] !== "text/event-stream") throw new Error(`MCP stream rejected: ${res.statusCode}`);
    return { req, res };
  };
  const emit = (text: string) => call("/api/events", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "mcp-e2e", kind: "notice", text }) });
  const first = await stream(), firstFrame = frames(first.res, "mcp-event-before-reconnect");
  check((await emit("mcp-event-before-reconnect")).status === 200, "an event is sent while MCP is connected");
  const seen = await firstFrame; check(!!seen.id, "MCP receives a resumable streamed notification");
  first.res.destroy(); first.req.destroy();
  check((await emit("mcp-event-after-disconnect")).status === 200, "an event is sent while MCP is disconnected");
  const resumed = await stream(seen.id), replay = await frames(resumed.res, "mcp-event-after-disconnect");
  check(!!replay.id && !replay.body.includes("mcp-event-before-reconnect"), "MCP reconnects and resumes missed notifications");
  resumed.res.destroy(); resumed.req.destroy();
  check((await call("/api/host/revoke-sessions", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status === 200, "machine revokes owner sessions");
  check((await call("/mcp", { method: "POST", headers: auth, body: "{}" })).status === 401, "revoked MCP credentials are rejected");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (proxy) await proxy.close();
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, workerdVersion: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing",
    workerdSha256: existsSync(workerd) ? createHash("sha256").update(readFileSync(workerd)).digest("hex") : null,
    webIndexSha256: existsSync(join(assets, "index.html")) ? createHash("sha256").update(readFileSync(join(assets, "index.html"))).digest("hex") : null, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
