// Real SMTP delivery and CLI fallback against isolated native coordinators.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHttpsProxy } from "./fixtures/https-proxy";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-smtp-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log"), mailLog = join(out, "mailpit.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", mailpit = process.env.NOOP_E2E_MAILPIT || "";
const checks: string[] = [];
let service: ChildProcess | undefined, mail: ChildProcess | undefined, proxy: Awaited<ReturnType<typeof startHttpsProxy>> | undefined, error = "";
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
async function waitFor(fn: () => Promise<boolean>, message: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await Bun.sleep(200); }
  throw new Error(message);
}
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd) && existsSync(mailpit), "Web assets, workerd and a real Mailpit SMTP server are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd")); mkdirSync(home, { recursive: true });
  const cert = join(out, "smtp-cert.pem"), key = join(out, "smtp-key.pem"), ca = join(out, "ca.pem"), caKey = join(out, "ca-key.pem"), csr = join(out, "smtp.csr"), ext = join(out, "smtp.ext");
  const wrongCa = join(out, "wrong-ca.pem"), wrongKey = join(out, "wrong-ca-key.pem");
  writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
  const openssl = (args: string[]) => spawnSync("openssl", args, { encoding: "utf8" }).status === 0;
  check(openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Noop test CA", "-keyout", caKey, "-out", ca]) &&
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Untrusted test CA", "-keyout", wrongKey, "-out", wrongCa]) &&
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", csr]) &&
    openssl(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", ext, "-out", cert]),
    "a temporary CA and SMTP TLS certificate are created");
  const smtpPort = await port(), mailPort = await port(), listenPort = await port(), base = `http://127.0.0.1:${listenPort}`, mailBase = `http://127.0.0.1:${mailPort}`;
  const mailFd = openSync(mailLog, "a");
  mail = spawn(mailpit, ["--listen", `127.0.0.1:${mailPort}`, "--smtp", `127.0.0.1:${smtpPort}`, "--smtp-tls-cert", cert, "--smtp-tls-key", key,
    "--smtp-require-starttls", "--smtp-auth-accept-any"], { stdio: ["ignore", mailFd, mailFd] }); closeSync(mailFd);
  await waitFor(async () => (await fetch(mailBase + "/api/v1/messages")).ok, "Mailpit did not start");
  check(true, "Mailpit starts a real SMTP server requiring STARTTLS and authentication");
  writeFileSync(join(home, "noop.toml"), `[cloud]\ntrusted_proxies = "127.0.0.3"\n[owner]\nlanguage = "en"\n[email]\nto = "owner@example.com,proxied@example.com,fail@example.com,untrusted@example.com"\nhost = "127.0.0.1"\nport = ${smtpPort}\nsecure = false\nuser = "synthetic-user"\npass = "synthetic-password"\nfrom = "noop@example.com"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg"), HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}`, SSL_CERT_FILE: ca };
  for (const name of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[name];
  const cli = (args: string[], testHome = home) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env: { ...env, NOOP_HOME: testHome }, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const start = async (testHome = home) => {
    const offset = existsSync(log) ? readFileSync(log, "utf8").length : 0;
    const fd = openSync(log, "a"); service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
      { cwd: repo, env: { ...env, NOOP_HOME: testHome }, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    await waitFor(async () => readFileSync(log, "utf8").slice(offset).includes("Local coordinator candidate:") && (await fetch(base)).ok &&
      (Bun.TOML.parse(readFileSync(join(testHome, "noop.toml"), "utf8")) as any).cloud?.mode === "local", "coordinator did not start");
  };
  const stop = async () => {
    const child = service!; child.kill("SIGTERM");
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error("coordinator did not stop");
    await waitFor(async () => { try { await fetch(base); return false; } catch { return true; } }, "coordinator port remained open");
  };
  const setup = (testHome = home) => {
    const r = cli(["2fa", "setup"], testHome), secret = r.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
    check(r.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)], testHome).status === 0, "authenticator is bound in isolated home"); return secret;
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  await start(); const secret = setup();
  const sent = await post("/api/auth/start", { email: "owner@example.com" });
  check(sent.status === 200, `SMTP login code is sent successfully (HTTP ${sent.status})`);
  let messages: any[] = [], code = "";
  await waitFor(async () => {
    messages = ((await (await fetch(mailBase + "/api/v1/messages")).json()) as any).messages || [];
    for (const item of messages) {
      const m = await (await fetch(mailBase + "/api/v1/message/" + item.ID)).json() as any;
      if (String(m.Subject).includes("login code") && m.To?.some((t: any) => t.Address === "owner@example.com")) {
        code = String(m.Text).match(/\b[A-HJ-NP-Z2-9]{8}\b/)?.[0] || ""; if (code) return true;
      }
    }
    return false;
  }, "SMTP server did not receive the owner login code");
  check(!!code, "real SMTP server receives the owner login code");
  const verified = await post("/api/auth/verify", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) }, { "cf-connecting-ip": "203.0.113.77" });
  check(verified.status === 200, "SMTP code and TOTP create an owner session");
  let alert: any;
  await waitFor(async () => {
    messages = ((await (await fetch(mailBase + "/api/v1/messages")).json()) as any).messages || [];
    for (const item of messages) { const m = await (await fetch(mailBase + "/api/v1/message/" + item.ID)).json() as any; if (String(m.Subject).includes("security alert") && String(m.Text).includes("Account: owner@example.com")) { alert = m; return true; } }
    return false;
  }, "SMTP server did not receive the security alert");
  const directOrigin = String(alert.Text).match(/^IP:.*$/m)?.[0] || "missing";
  check(directOrigin === "IP: 127.0.0.1", `security alert reports the actual peer and ignores a forged source header (observed ${directOrigin})`);
  proxy = await startHttpsProxy(out, listenPort);
  check((await post("/api/auth/start", { email: "proxied@example.com" })).ok, "second owner receives an SMTP login code");
  let proxyCode = "";
  await waitFor(async () => {
    messages = ((await (await fetch(mailBase + "/api/v1/messages")).json()) as any).messages || [];
    for (const item of messages) {
      const m = await (await fetch(mailBase + "/api/v1/message/" + item.ID)).json() as any;
      if (String(m.Subject).includes("login code") && m.To?.some((t: any) => t.Address === "proxied@example.com")) {
        proxyCode = String(m.Text).match(/\b[A-HJ-NP-Z2-9]{8}\b/)?.[0] || ""; if (proxyCode) return true;
      }
    }
    return false;
  }, "SMTP server did not receive the proxied owner's login code");
  const proxiedBody = JSON.stringify({ email: "proxied@example.com", code: proxyCode, totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) });
  const proxyStatus = await new Promise<number>((ok, fail) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port: proxy!.port, localAddress: "127.0.0.2", path: "/api/auth/verify", method: "POST", rejectUnauthorized: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(proxiedBody), "cf-connecting-ip": "203.0.113.77", "x-forwarded-for": "203.0.113.88" } }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode || 0)); });
    req.on("error", fail); req.end(proxiedBody);
  });
  check(proxyStatus === 200, "owner can sign in through the trusted HTTPS proxy");
  let proxyAlert: any;
  await waitFor(async () => {
    messages = ((await (await fetch(mailBase + "/api/v1/messages")).json()) as any).messages || [];
    for (const item of messages) { const m = await (await fetch(mailBase + "/api/v1/message/" + item.ID)).json() as any; if (String(m.Subject).includes("security alert") && String(m.Text).includes("Account: proxied@example.com")) { proxyAlert = m; return true; } }
    return false;
  }, "SMTP server did not receive the proxied security alert");
  const proxyOrigin = String(proxyAlert.Text).match(/^IP:.*$/m)?.[0] || "missing";
  check(proxyOrigin === "IP: 127.0.0.2", `security alert uses the verified proxy chain instead of forged source headers (observed ${proxyOrigin})`);
  await stop(); env.SSL_CERT_FILE = wrongCa; await start();
  check((await post("/api/auth/start", { email: "untrusted@example.com" })).status === 502, "SMTP rejects a certificate from an untrusted CA");
  await stop(); env.SSL_CERT_FILE = ca; await start();
  mail.kill("SIGTERM"); await new Promise<void>((done) => mail!.once("exit", () => done()));
  const failed = await post("/api/auth/start", { email: "fail@example.com" });
  check(failed.status === 502 && /failed|失败/i.test(await failed.text()), "SMTP connection failure is reported to the user");
  await stop();
  const cliHome = join(out, "without-smtp"); await start(cliHome); const cliSecret = setup(cliHome);
  const requested = await post("/api/auth/start", { email: "cli@example.com" });
  check(requested.ok && (await requested.json() as any).delivery === "cli", "without SMTP the login code is delivered to the CLI");
  const cliResult = cli(["login"], cliHome), cliCode = cliResult.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(cliResult.status === 0 && !!cliCode && (await post("/api/auth/verify", { email: "cli@example.com", code: cliCode, totp: totp(cliSecret, Math.floor(Date.now() / 30_000)) })).ok,
    "CLI code and TOTP log in without SMTP");
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (proxy) await proxy.close().catch(() => {});
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  if (mail && mail.exitCode === null && mail.signalCode === null) mail.kill("SIGTERM");
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, webVersion: process.env.NOOP_E2E_WEB_VERSION || "not specified", webIndexSha256: hash(join(assets, "index.html")),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) },
    mailpit: { version: existsSync(mailpit) ? spawnSync(mailpit, ["version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(mailpit) }, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && !["SHA256SUMS", "smtp-key.pem", "ca-key.pem", "wrong-ca-key.pem", "proxy.key"].includes(f.name)).map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
