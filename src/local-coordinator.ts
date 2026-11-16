import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { type Cfg, CODE, HOME_DIR } from "./core";
import { allowIps } from "./cloud";
import { readHubToml, writeHubToml } from "./sync";

const WORKERD_DATE = "2026-11-10";
// SHA-256 of the binary in the verified @cloudflare/workerd-linux-64 1.20261110.1 package.
const WORKERD_LINUX_X64_SHA256 = "620d9f7e5eb461067e08af17316aaa087445b4232e0e98e3dd146763bd9ab394";

export async function localCoordinator(cfg: Cfg, listen = "127.0.0.1:8790") {
  const match = listen.match(/^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("The local coordinator candidate only accepts a loopback address and port");
  if (allowIps(cfg)) throw new Error("IP allow-lists need a trusted local ingress; do not deploy this candidate yet");
  const prior = readHubToml();
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
  using lock = new Database(join(root, "active.sqlite"), { create: true });
  try { lock.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("A local coordinator is already running for this Noop home");
    throw error;
  }
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  const keyFile = join(root, "namespace-key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, crypto.randomUUID(), { mode: 0o600 });
  const namespace = readFileSync(keyFile, "utf8").trim();
  if (!namespace) throw new Error("The coordinator namespace key is empty");
  const built = await Bun.build({ entrypoints: [join(CODE, "cloud", "src", "index.ts"), join(CODE, "cloud", "src", "local-assets.ts")],
    outdir: bundle, target: "browser", external: ["cloudflare:*"] });
  if (!built.success) throw new Error(`Could not build the coordinator: ${built.logs.map(String).join("\n")}`);

  const q = (value: string) => JSON.stringify(value);
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "index.js", esModule = embed "bundle/index.js")],
      compatibilityDate = "2026-10-01",
      durableObjectNamespaces = [(className = "Hub", uniqueKey = ${q(namespace)}, enableSql = true)],
      durableObjectStorage = (localDisk = "storage"),
      bindings = [(name = "HUB", durableObjectNamespace = "Hub"),
        (name = "HUB_TOKEN", fromEnvironment = "NOOP_LOCAL_TOKEN"),
        (name = "HUB_OWNER_EMAIL", fromEnvironment = "NOOP_LOCAL_OWNER_EMAIL"),
        (name = "HUB_SMTP", fromEnvironment = "NOOP_LOCAL_SMTP"),
        (name = "HUB_LANG", fromEnvironment = "NOOP_LOCAL_LANG"),
        (name = "ASSETS", service = "assets")]
    )),
    (name = "storage", disk = (path = ${q(storage)}, writable = true)),
    (name = "assets", worker = (
      modules = [(name = "local-assets.js", esModule = embed "bundle/local-assets.js")],
      compatibilityDate = "2026-10-01", bindings = [(name = "FILES", service = "web")]
    )),
    (name = "web", disk = (path = ${q(assets)}))
  ],
  sockets = [(name = "http", address = ${q(listen)}, http = (), service = "main")]
);
`;
  const configFile = join(root, "workerd.capnp");
  writeFileSync(configFile, config, { mode: 0o600 });
  const token = String(prior.server?.token || cfg.server?.token || crypto.randomUUID().replace(/-/g, ""));
  const email = cfg.email ?? {};
  const smtp = email.to && email.host ? JSON.stringify({ host: email.host, port: email.port ?? 465,
    secure: email.secure ?? (email.port ?? 465) === 465, user: email.user, pass: email.pass, from: email.from ?? email.user }) : "";
  const child = Bun.spawn([workerd, "serve", configFile], { stdout: "inherit", stderr: "inherit", env: {
    ...process.env, NOOP_LOCAL_TOKEN: token, NOOP_LOCAL_OWNER_EMAIL: String(email.to ?? ""),
    NOOP_LOCAL_SMTP: smtp, NOOP_LOCAL_LANG: String(cfg.owner?.language ?? ""),
  } });
  let exited = false;
  void child.exited.then(() => { exited = true; });
  const stop = () => child.kill("SIGINT"); // workerd's SIGTERM waits for open WebSockets.
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const url = `http://${listen}`;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        const response = await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("The local coordinator did not start");
    writeHubToml({ cloud: { url, mode: "local" }, server: { token } });
    console.log(`Local coordinator candidate: ${url}`);
    const result = await child.exited;
    if (result !== 0 && result !== 130 && result !== 143) process.exitCode = result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (!exited) { child.kill("SIGINT"); await child.exited; }
  }
}
