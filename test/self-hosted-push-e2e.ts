// Web Push protocol against an isolated native coordinator and a controlled HTTP endpoint.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { b64u, unb64u } from "../cloud/src/push";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-push-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", token = "synthetic-push-machine-token-00000";
const checks: string[] = [], received: { payload: any; jwtValid: boolean; urgency: string | null }[] = [];
let service: ChildProcess | undefined, receiver: ReturnType<typeof Bun.serve> | undefined, error = "", publicKey = "";
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
async function waitFor(fn: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 20_000; while (Date.now() < end) { if (await fn()) return; await Bun.sleep(200); } throw new Error(message);
}
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "Web assets and workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd")); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[owner]\nlanguage = "en"\n[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg"), HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const start = async () => {
    const fd = openSync(log, "a"); service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
      { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    await waitFor(async () => { try { return (await fetch(base)).ok && (Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any).cloud?.mode === "local"; } catch { return false; } }, "coordinator did not start");
  };
  const stop = async () => {
    const child = service!; child.kill("SIGTERM");
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error("coordinator did not stop");
    await waitFor(async () => { try { await fetch(base); return false; } catch { return true; } }, "coordinator port remained open");
  };
  await start();
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "owner binds TOTP");
  const post = (path: string, body: unknown, credential = "") => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body) });
  check((await post("/api/auth/start", { email: "owner@example.com" })).ok, "owner requests a CLI login code");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const auth = await post("/api/auth/verify", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) });
  const session = ((await auth.json()) as any).session;
  check(auth.ok && !!session, "owner signs in with CLI code and TOTP");
  const vapid = await fetch(base + "/api/push/vapid", { headers: { authorization: `Bearer ${session}` } });
  check(vapid.ok, `local coordinator provides a VAPID key (HTTP ${vapid.status})`);
  publicKey = ((await vapid.json()) as any).publicKey;
  const keyFile = join(home, "vapid.json"), originalKeys = readFileSync(keyFile, "utf8");
  check(!!publicKey && (statSync(keyFile).mode & 0o077) === 0, "VAPID keys are persisted with restricted permissions");
  const te = new TextEncoder(), cat = (...parts: Uint8Array[]) => { const b = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let i = 0; for (const part of parts) { b.set(part, i); i += part.length; } return b; };
  const hmac = async (key: Uint8Array, data: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data as any));
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, n);
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)), authSecret = crypto.getRandomValues(new Uint8Array(16));
  receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/gone") return new Response("", { status: 410 });
    if (path === "/fail") return new Response("", { status: 503 });
    const match = req.headers.get("authorization")?.match(/^vapid t=([^,]+), k=(.+)$/);
    if (!match) return new Response("missing VAPID", { status: 400 });
    const [, jwt, key] = match, [h, p, signature] = jwt.split(".");
    const pub = await crypto.subtle.importKey("raw", unb64u(key) as any, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const jwtValid = key === publicKey && await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(signature) as any, te.encode(`${h}.${p}`)) &&
      JSON.parse(new TextDecoder().decode(unb64u(p))).aud === new URL(req.url).origin;
    const body = new Uint8Array(await req.arrayBuffer()), salt = body.slice(0, 16), length = body[20], asPub = body.slice(21, 21 + length), encrypted = body.slice(21 + length);
    const asKey = await crypto.subtle.importKey("raw", asPub as any, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const ikm = await hkdf(authSecret, shared, cat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
    const aes = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16) as any, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12) as any }, aes, encrypted));
    received.push({ payload: JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)))), jwtValid, urgency: req.headers.get("urgency") });
    return new Response("", { status: 201 });
  } });
  const endpoint = `http://127.0.0.1:${receiver.port}`, sub = { endpoint: endpoint + "/live", keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } };
  check((await post("/api/push/subscribe", { subscription: sub }, token)).status === 403 && (await post("/api/push/subscribe", { subscription: sub })).status === 401,
    "machine and anonymous clients cannot subscribe");
  check((await post("/api/push/subscribe", { subscription: sub, device_label: "synthetic browser" }, session)).ok, "owner subscribes a controlled push endpoint");
  check((await post("/api/push/subscribe", { subscription: { ...sub, endpoint: endpoint + "/gone" } }, session)).ok, "owner subscribes an expired endpoint");
  let tested: any = await (await post("/api/push/test", {}, session)).json();
  check(tested.sent === 1 && tested.removed === 1 && received.at(-1)?.jwtValid && received.at(-1)?.payload.tag === "test", "test notification has a valid VAPID signature and decryptable payload; HTTP 410 removes an expired subscription");
  await stop(); await start();
  const after = await (await fetch(base + "/api/push/vapid", { headers: { authorization: `Bearer ${session}` } })).json() as any;
  check(after.publicKey === publicKey && readFileSync(keyFile, "utf8") === originalKeys, "VAPID keypair survives restart without rotation");
  const before = received.length;
  check((await post("/api/events", { from: "lead@box", kind: "decision", text: "Ship this build?", ref: "D-1", options: ["A: ship", "B: wait"] }, token)).ok, "machine publishes a decision event after restart");
  await waitFor(() => received.length > before, "event notification was not delivered");
  check(received.at(-1)?.jwtValid && received.at(-1)?.urgency === "high" && received.at(-1)?.payload.ref === "D-1", "subscription survives restart and receives a signed, encrypted decision notification");
  check((await post("/api/push/subscribe", { subscription: { ...sub, endpoint: endpoint + "/fail" } }, session)).ok, "owner subscribes a failing endpoint");
  tested = await (await post("/api/push/test", {}, session)).json();
  await waitFor(() => readFileSync(log, "utf8").includes("HTTP 503"), "push failure was not logged");
  check(tested.total === 2 && tested.sent === 1 && (await fetch(base + "/api/status", { headers: { authorization: `Bearer ${token}` } })).ok,
    "failed push is logged while the other endpoint and core service remain available");
  const unreachable = `http://127.0.0.1:${await port()}/unreachable`;
  check((await post("/api/push/subscribe", { subscription: { ...sub, endpoint: unreachable } }, session)).ok, "owner subscribes an unreachable endpoint");
  tested = await (await post("/api/push/test", {}, session)).json();
  await waitFor(() => readFileSync(log, "utf8").includes("HTTP 0"), "unreachable push service was not logged");
  check(tested.total === 3 && tested.sent === 1, "unreachable push is logged without stopping other deliveries");
  check((await post("/api/push/unsubscribe", { endpoint: sub.endpoint }, session)).ok && (await post("/api/push/unsubscribe", { endpoint: endpoint + "/fail" }, session)).ok &&
    (await post("/api/push/unsubscribe", { endpoint: unreachable }, session)).ok, "owner unsubscribes all endpoints");
  tested = await (await post("/api/push/test", {}, session)).json();
  check(tested.total === 0, "no push subscriptions remain after unsubscribe");
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  receiver?.stop(true);
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, webVersion: process.env.NOOP_E2E_WEB_VERSION || "not specified", webIndexSha256: hash(join(assets, "index.html")),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) }, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
