import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { dlopen } from "bun:ffi";
import { type Cfg, CODE, HOME_DIR } from "./core";
import { allowIps, vapidKeys } from "./cloud";
import { parseAllowList } from "../cloud/src/ipallow";
import { hubTomlPath, writeHubToml } from "./sync";

const WORKERD_DATE = "2026-11-10";
// SHA-256 of the binary in the verified @cloudflare/workerd-linux-64 1.20261110.1 package.
const WORKERD_LINUX_X64_SHA256 = "620d9f7e5eb461067e08af17316aaa087445b4232e0e98e3dd146763bd9ab394";

export async function localCoordinator(cfg: Cfg, listen = "127.0.0.1:8790") {
  const match = listen.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
  const host = match?.[1]?.replace(/^\[|\]$/g, "") ?? "";
  const ip = isIP(host);
  if (!match || (host !== "localhost" && !ip) || (match[1].startsWith("[") && ip !== 6) || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Use an IP address or localhost and a valid port for the coordinator listener");
  const allowed = allowIps(cfg) ?? "";
  const configuredProxies = cfg.cloud?.trusted_proxies;
  const proxies = (Array.isArray(configuredProxies) ? configuredProxies.map(String) : String(configuredProxies ?? "").split(/[\s,]+/)).filter(Boolean).join(",");
  const badAllowed = parseAllowList(allowed).bad, badProxies = parseAllowList(proxies).bad;
  if (badAllowed.length) throw new Error(`invalid IP allow-list: ${badAllowed.join(", ")}`);
  if (badProxies.length) throw new Error(`invalid trusted proxy: ${badProxies.join(", ")}`);
  let prior: Record<string, any>;
  try { prior = existsSync(hubTomlPath()) ? Bun.TOML.parse(readFileSync(hubTomlPath(), "utf8")) : {}; }
  catch { throw new Error("The local bootstrap configuration is invalid or unreadable; restore it from backup"); }
  if (prior.cloud?.url && prior.cloud?.mode !== "local")
    throw new Error("This Noop home already uses another coordination service; use a separate Noop home");
  const workerd = Bun.which("workerd");
  if (!workerd) throw new Error(`Install workerd ${WORKERD_DATE} and put it on PATH`);
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The local coordinator candidate currently supports Linux x86_64");
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(workerd).stream()) hash.update(chunk);
  if (hash.digest("hex") !== WORKERD_LINUX_X64_SHA256) throw new Error(`The workerd ${WORKERD_DATE} binary checksum does not match`);
  const assets = join(CODE, "app", "dist", "web", "noop");
  if (!existsSync(join(assets, "index.html"))) throw new Error("Build or install the Noop Web client before local deployment");

  const root = join(HOME_DIR, "coordinator"), bundle = join(root, "bundle"), storage = join(root, "storage");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockFd = openSync(join(root, "active.lock"), "a", 0o600);
  const libc = dlopen("libc.so.6", { flock: { args: ["int", "int"], returns: "int" } });
  using lock = { [Symbol.dispose]() { closeSync(lockFd); libc.close(); } };
  if (libc.symbols.flock(lockFd, 2 | 4) !== 0) throw new Error("Cannot lock coordinator data; another local coordinator may be running"); // LOCK_EX | LOCK_NB
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  const keyFile = join(root, "namespace-key");
  const existingKey = existsSync(keyFile);
  if (!existingKey) writeFileSync(keyFile, crypto.randomUUID(), { mode: 0o600 });
  const namespace = readFileSync(keyFile, "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(namespace))
    throw new Error("The coordinator namespace key is invalid; restore it from backup");
  if (existingKey && !prior.server?.token && !cfg.server?.token)
    throw new Error("The coordinator machine token is missing; restore it from backup");
  const persist = (path: string) => {
    for (const p of [path, dirname(path)]) {
      const fd = openSync(p, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  };
  persist(keyFile);
  const built = await Bun.build({ entrypoints: [join(CODE, "cloud", "src", "index.ts"), join(CODE, "cloud", "src", "local-assets.ts"), join(CODE, "cloud", "src", "local-health.ts")],
    outdir: bundle, target: "browser", external: ["cloudflare:*"] });
  if (!built.success) throw new Error(`Could not build the coordinator: ${built.logs.map(String).join("\n")}`);

  const q = (value: string) => JSON.stringify(value);
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true))),
    (name = "main", worker = (
      modules = [(name = "index.js", esModule = embed "bundle/index.js")],
      compatibilityDate = "2026-10-01",
      durableObjectNamespaces = [(className = "Hub", uniqueKey = ${q(namespace)}, enableSql = true)],
      durableObjectStorage = (localDisk = "storage"),
      bindings = [(name = "HUB", durableObjectNamespace = "Hub"),
        (name = "HUB_TOKEN", fromEnvironment = "NOOP_LOCAL_TOKEN"),
        (name = "HUB_OWNER_EMAIL", fromEnvironment = "NOOP_LOCAL_OWNER_EMAIL"),
        (name = "HUB_SMTP", fromEnvironment = "NOOP_LOCAL_SMTP"),
        (name = "HUB_VAPID_PUBLIC", fromEnvironment = "NOOP_LOCAL_VAPID_PUBLIC"),
        (name = "HUB_VAPID_PRIVATE", fromEnvironment = "NOOP_LOCAL_VAPID_PRIVATE"),
        (name = "HUB_LANG", fromEnvironment = "NOOP_LOCAL_LANG"),
        (name = "HUB_LOCAL_MODE", fromEnvironment = "NOOP_LOCAL_MODE"),
        (name = "HUB_ALLOW_IPS", fromEnvironment = "NOOP_LOCAL_ALLOW_IPS"),
        (name = "HUB_TRUSTED_PROXIES", fromEnvironment = "NOOP_LOCAL_TRUSTED_PROXIES"),
        (name = "ASSETS", service = "assets")]
    )),
    (name = "storage", disk = (path = ${q(storage)}, writable = true)),
    (name = "assets", worker = (
      modules = [(name = "local-assets.js", esModule = embed "bundle/local-assets.js")],
      compatibilityDate = "2026-10-01", bindings = [(name = "FILES", service = "web")]
    )),
    (name = "health", worker = (
      modules = [(name = "local-health.js", esModule = embed "bundle/local-health.js")],
      compatibilityDate = "2026-10-01", bindings = [(name = "HUB", durableObjectNamespace = (className = "Hub", serviceName = "main"))]
    )),
    (name = "web", disk = (path = ${q(assets)}))
  ],
  sockets = [(name = "http", address = ${q(listen)}, http = (), service = "main"),
    (name = "health", address = ${q(`unix:${join(root, "health.sock")}`)}, http = (), service = "health")]
);
`;
  const configFile = join(root, "workerd.capnp");
  writeFileSync(configFile, config, { mode: 0o600 });
  const token = String(prior.server?.token || cfg.server?.token || crypto.randomUUID().replace(/-/g, ""));
  const email = cfg.email ?? {};
  const smtp = email.to && email.host ? JSON.stringify({ host: email.host, port: email.port ?? 465,
    secure: email.secure ?? (email.port ?? 465) === 465, user: email.user, pass: email.pass, from: email.from ?? email.user }) : "";
  const vapid = await vapidKeys();
  const healthSocket = join(root, "health.sock");
  if (existsSync(healthSocket)) unlinkSync(healthSocket);
  // The runtime keeps the lock if this launcher is killed.
  const child = Bun.spawn([workerd, "serve", configFile], { stdio: ["ignore", "inherit", "inherit", lockFd], env: {
    ...process.env, NOOP_LOCAL_TOKEN: token, NOOP_LOCAL_OWNER_EMAIL: String(email.to ?? ""),
    NOOP_LOCAL_SMTP: smtp, NOOP_LOCAL_VAPID_PUBLIC: vapid.publicKey, NOOP_LOCAL_VAPID_PRIVATE: JSON.stringify(vapid.privateJwk),
    NOOP_LOCAL_LANG: String(cfg.owner?.language ?? ""), NOOP_LOCAL_MODE: "1",
    NOOP_LOCAL_ALLOW_IPS: allowed, NOOP_LOCAL_TRUSTED_PROXIES: proxies,
  } });
  let exited = false;
  void child.exited.then(() => { exited = true; });
  const stop = () => child.kill("SIGINT"); // workerd's SIGTERM waits for open WebSockets.
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const dialHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : match[1];
  const url = `http://${dialHost}:${match[2]}`;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        const response = await fetch("http://localhost/api/status", { unix: healthSocket, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("The local coordinator did not start");
    writeHubToml({ cloud: { url, mode: "local" }, server: { token } });
    persist(hubTomlPath());
    console.log(`Local coordinator candidate: ${url}`);
    const result = await child.exited;
    if (result !== 0 && result !== 130 && result !== 143) process.exitCode = result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (!exited) { child.kill("SIGINT"); await child.exited; }
  }
}
