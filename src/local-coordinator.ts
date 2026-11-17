import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { dirname, join } from "node:path";
import { dlopen } from "bun:ffi";
import { type Cfg, CODE, HOME_DIR } from "./core";
import { allowIps, vapidKeys } from "./cloud";
import { ipAllowed, parseAllowList } from "../cloud/src/ipallow";
import { hubTomlPath, writeHubToml } from "./sync";

export const WORKERD_DATE = "2026-11-10";
// SHA-256 of the binaries in the verified @cloudflare/workerd platform packages, version 1.20261110.1.
export const WORKERD_SHA256: Record<string, string> = {
  "linux-x64": "620d9f7e5eb461067e08af17316aaa087445b4232e0e98e3dd146763bd9ab394",
  "linux-arm64": "9d557f449060e57feb17541092929801dd7f8df79be9424fd8b61b772c7237c0",
  "darwin-x64": "790d752a3e30fa429950fb664111fa088b1b2c15732f9541e722fbf253ffff44",
  "darwin-arm64": "f08ed8b7be3588cc7393b274e7278bee3125a1015ed3e214293e5e75088dd5b1",
};

export function coordinatorNamespace(root: string) {
  const namespace = readFileSync(join(root, "namespace-key"), "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(namespace))
    throw new Error("The coordinator namespace key is invalid; restore it from backup");
  return namespace;
}

export function lockCoordinator(root: string) {
  const fd = openSync(join(root, "active.lock"), "a", 0o600);
  try {
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: ["int", "int"], returns: "int" } });
    if (libc.symbols.flock(fd, 2 | 4) !== 0) { libc.close(); throw new Error("Cannot lock coordinator data; another local coordinator may be running"); }
    return { fd, [Symbol.dispose]() { closeSync(fd); libc.close(); } };
  } catch (error) { closeSync(fd); throw error; }
}

export async function localCoordinator(cfg: Cfg, listen = "127.0.0.1:8790") {
  const match = listen.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
  const host = match?.[1]?.replace(/^\[|\]$/g, "") ?? "";
  const ip = isIP(host);
  if (!match || (host !== "localhost" && !ip) || (match[1].startsWith("[") && ip !== 6) || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Use an IP address or localhost and a valid port for the coordinator listener");
  const allowed = allowIps(cfg) ?? "";
  const configuredProxies = cfg.cloud?.trusted_proxies;
  const proxies = (Array.isArray(configuredProxies) ? configuredProxies.map(String) : String(configuredProxies ?? "").split(/[\s,]+/)).filter(Boolean).join(",");
  const { nets: allowedNets, bad: badAllowed } = parseAllowList(allowed), { nets: proxyNets, bad: badProxies } = parseAllowList(proxies);
  if (badAllowed.length) throw new Error(`invalid IP allow-list: ${badAllowed.join(", ")}`);
  if (badProxies.length) throw new Error(`invalid trusted proxy: ${badProxies.join(", ")}`);
  let prior: Record<string, any>;
  try { prior = existsSync(hubTomlPath()) ? Bun.TOML.parse(readFileSync(hubTomlPath(), "utf8")) : {}; }
  catch { throw new Error("The local bootstrap configuration is invalid or unreadable; restore it from backup"); }
  if (prior.cloud?.url && prior.cloud?.mode !== "local")
    throw new Error("This Noop home already uses another coordination service; use a separate Noop home");
  const proxyOnLoopback = ipAllowed("127.0.0.1", proxyNets) || ipAllowed("::1", proxyNets);
  const allowV4 = !allowed || ipAllowed("127.0.0.1", allowedNets), allowV6 = !allowed || ipAllowed("::1", allowedNets);
  const localHost = proxyOnLoopback ? (allowV4 || !allowV6 ? "127.0.0.1" : "::1") : "";
  let localUrl = "";
  if (localHost) {
    const saved = String(prior.cloud?.local_url || "");
    if (saved) {
      const address = new URL(saved);
      const savedHost = address.hostname.replace(/^\[|\]$/g, "");
      if (address.protocol !== "http:" || !["127.0.0.1", "::1"].includes(savedHost) || !address.port || address.pathname !== "/" || address.search || address.hash || address.username || address.password)
        throw new Error("The local coordinator dial address is invalid; correct [cloud] local_url in noop.toml");
      if ((savedHost === "127.0.0.1" ? allowV4 : allowV6) || (!allowV4 && !allowV6)) localUrl = address.origin;
    }
    if (!localUrl) {
      const socket = createServer();
      await new Promise<void>((ok, fail) => socket.once("error", fail).listen(0, localHost, ok));
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>((ok, fail) => socket.close((error) => error ? fail(error) : ok()));
      localUrl = `http://${localHost === "::1" ? "[::1]" : localHost}:${port}`;
    }
  }
  const workerd = Bun.which("workerd");
  if (!workerd) throw new Error(`Install workerd ${WORKERD_DATE} and put it on PATH`);
  const expected = WORKERD_SHA256[`${process.platform}-${process.arch}`];
  if (!expected) throw new Error("The local coordinator candidate supports Linux and macOS on x86_64 and ARM64");
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(workerd).stream()) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`The workerd ${WORKERD_DATE} binary checksum does not match`);
  const assets = join(CODE, "app", "dist", "web", "noop");
  if (!existsSync(join(assets, "index.html"))) throw new Error("Build or install the Noop Web client before local deployment");

  const root = join(HOME_DIR, "coordinator"), bundle = join(root, "bundle"), storage = join(root, "storage");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  using lock = lockCoordinator(root);
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  const keyFile = join(root, "namespace-key");
  const existingKey = existsSync(keyFile);
  if (!existingKey) writeFileSync(keyFile, crypto.randomUUID(), { mode: 0o600 });
  const namespace = coordinatorNamespace(root);
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
  const certFile = process.env.SSL_CERT_FILE;
  const certs = certFile ? readFileSync(certFile, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) : null;
  if (certFile && !certs?.length) throw new Error("SSL_CERT_FILE must contain at least one PEM certificate");
  const trustedCertificates = certs ? `, trustedCertificates = [${certs.map(q).join(", ")}]` : "";
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true${trustedCertificates}))),
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
    ${localUrl ? `(name = "local", address = ${q(localUrl.slice("http://".length))}, http = (), service = (name = "main", props = (json = ${q(JSON.stringify({ noopIngress: "local" }))}))),` : ""}
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
  persist(join(HOME_DIR, "vapid.json"));
  const healthSocket = join(root, "health.sock");
  if (existsSync(healthSocket)) unlinkSync(healthSocket);
  // The runtime keeps the lock if this launcher is killed.
  const child = Bun.spawn([workerd, "serve", configFile], { stdio: ["ignore", "inherit", "inherit", lock.fd], env: {
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
    if (!ready) throw new Error("The local coordinator did not start; check its listener addresses and logs");
    writeHubToml({ cloud: { url, mode: "local", ...(localUrl || prior.cloud?.local_url ? { local_url: localUrl } : {}) }, server: { token } });
    persist(hubTomlPath());
    const versionFile = join(root, "runtime-version");
    writeFileSync(versionFile, `${WORKERD_DATE}\n`, { mode: 0o600 });
    persist(versionFile);
    console.log(`Local coordinator candidate: ${url}`);
    if (localUrl) {
      console.log(`Local coordinator dial address: ${localUrl}`);
      if (prior.cloud?.url && prior.cloud?.local_url !== localUrl) console.log("Restart the Noop primary to use the new local dial address");
    }
    const result = await child.exited;
    if (result !== 0 && result !== 130 && result !== 143) process.exitCode = result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (!exited) { child.kill("SIGINT"); await child.exited; }
  }
}
