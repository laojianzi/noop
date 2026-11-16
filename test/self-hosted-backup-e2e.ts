// Offline backup and restore of a standalone coordinator in isolated Noop homes.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-backup-e2e-"));
const repo = join(out, "repo"), home = join(out, "source-home"), restored = join(out, "restored-home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const backup = join(out, "backup"), assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const token = "synthetic-backup-machine-token-0000", checks: string[] = [];
let service: ChildProcess | undefined, error = "";
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
  const end = Date.now() + 30_000; while (Date.now() < end) { if (await fn()) return; await Bun.sleep(200); } throw new Error(message);
}
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "Web assets and workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd")); mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  writeFileSync(join(home, "data", "config.local.toml"), '[owner]\nlanguage = "en"\n[email]\nto = "owner@example.com,second@example.com"\nfrom = "noop@example.com"\n');
  writeFileSync(join(home, "data", "config.toml"), '[backup_fixture]\nvalue = "shared-config"\n');
  writeFileSync(join(home, "data", "settings.json"), '{"backup_fixture":"settings"}');
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, XDG_CONFIG_HOME: join(out, "xdg"), HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const cli = (args: string[], testHome = home) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env: { ...env, NOOP_HOME: testHome }, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const start = async (testHome: string, listenPort: number) => {
    const fd = openSync(log, "a"); service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
      { cwd: repo, env: { ...env, NOOP_HOME: testHome }, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    const base = `http://127.0.0.1:${listenPort}`;
    await waitFor(async () => {
      if (service && (service.exitCode !== null || service.signalCode !== null)) throw new Error(`coordinator exited: ${readFileSync(log, "utf8").slice(-1500)}`);
      try { const cfg = Bun.TOML.parse(readFileSync(join(testHome, "noop.toml"), "utf8")) as any; return (await fetch(base)).ok && cfg.cloud?.url === base; } catch { return false; }
    }, "coordinator did not start");
    return base;
  };
  const stop = async (base: string) => {
    const child = service!; child.kill("SIGTERM");
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error("coordinator did not stop");
    await waitFor(async () => { try { await fetch(base); return false; } catch { return true; } }, "coordinator port remained open"); service = undefined;
  };
  const call = (base: string, path: string, method = "GET", body?: unknown, credential = token) => fetch(base + path, { method,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const sourceBase = await start(home, await port());
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "standalone coordinator binds TOTP without a primary");
  check((await call(sourceBase, "/api/auth/start", "POST", { email: "owner@example.com" }, "")).ok, "owner requests a CLI login code");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const verified = await call(sourceBase, "/api/auth/verify", "POST", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) }, "");
  const session = ((await verified.json()) as any).session; check(verified.ok && !!session, "owner signs in with CLI code and TOTP");
  for (let i = 0; i < 2; i++) check((await call(sourceBase, "/api/files/commit", "POST", { msg: "backup fixture", changes: [{ path: "reports/backup.md", base_version: i, content: Buffer.from(`saved version ${i + 1}`).toString("base64") }] })).ok, `version ${i + 1} is saved`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=", "base64"), form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "backup.png");
  const upload = await fetch(sourceBase + "/api/uploads", { method: "POST", headers: { authorization: `Bearer ${session}` }, body: form });
  const media = ((await upload.json()) as any).url;
  check(upload.ok && !!media && (await call(sourceBase, "/api/messages", "POST", { text: "saved backup message", attachments: [media] }, session)).ok, "message and attachment are saved");
  const keys = readFileSync(join(home, "vapid.json"), "utf8"), namespace = readFileSync(join(home, "coordinator", "namespace-key"), "utf8"),
    runtimeConfig = readFileSync(join(home, "coordinator", "workerd.capnp"), "utf8");
  const active = cli(["cloud", "backup", backup]);
  check(active.status !== 0 && !existsSync(backup), "backup rejects a running coordinator without creating a partial backup");
  await stop(sourceBase);
  const saved = cli(["cloud", "backup", backup]);
  check(saved.status === 0 && existsSync(join(backup, "manifest.json")) && !saved.out.includes(token), "stopped coordinator creates a backup without printing credentials");
  const inspect = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).every((entry) => {
    const p = join(dir, entry.name), mode = lstatSync(p).mode & 0o077; return mode === 0 && (entry.isDirectory() ? inspect(p) : entry.isFile());
  });
  check((statSync(backup).mode & 0o077) === 0 && inspect(backup), "backup directory and every contained file have restricted permissions");
  const existingBackup = join(out, "existing-backup"); mkdirSync(existingBackup); writeFileSync(join(existingBackup, "sentinel"), "keep");
  check(cli(["cloud", "backup", existingBackup]).status !== 0 && readFileSync(join(existingBackup, "sentinel"), "utf8") === "keep", "backup refuses to overwrite existing data");
  const backupLink = join(out, "backup-link"); symlinkSync("missing-backup", backupLink);
  check(cli(["cloud", "backup", backupLink]).status !== 0 && lstatSync(backupLink).isSymbolicLink(), "backup preserves an existing dangling destination link");
  check(cli(["cloud", "restore", backup], home).status !== 0 && readFileSync(join(home, "coordinator", "namespace-key"), "utf8") === namespace &&
    readFileSync(join(home, "vapid.json"), "utf8") === keys, "restore refuses to replace the original coordinator and its credentials");
  const existing = join(out, "existing-home"); mkdirSync(existing); writeFileSync(join(existing, "sentinel"), "keep");
  check(cli(["cloud", "restore", backup], existing).status !== 0 && readFileSync(join(existing, "sentinel"), "utf8") === "keep", "restore refuses to overwrite an existing home");
  const homeLink = join(out, "home-link"); symlinkSync("missing-home", homeLink);
  check(cli(["cloud", "restore", backup], homeLink).status !== 0 && lstatSync(homeLink).isSymbolicLink(), "restore preserves an existing dangling destination link");
  const corrupt = join(out, "corrupt-backup"), corruptTarget = join(out, "corrupt-target"); cpSync(backup, corrupt, { recursive: true });
  writeFileSync(join(corrupt, "coordinator", "namespace-key"), "corrupt");
  check(cli(["cloud", "restore", corrupt], corruptTarget).status !== 0 && !existsSync(corruptTarget), "corrupted backup is rejected without creating a restored home");
  const mismatch = join(out, "mismatched-backup"), mismatchTarget = join(out, "mismatched-target"); cpSync(backup, mismatch, { recursive: true });
  const wrongNamespace = "11111111-1111-4111-8111-111111111111", keyPath = join(mismatch, "coordinator", "namespace-key");
  writeFileSync(keyPath, wrongNamespace);
  const mismatchedManifest = JSON.parse(readFileSync(join(mismatch, "manifest.json"), "utf8"));
  const keyEntry = mismatchedManifest.files.find((entry: any) => entry.path === "coordinator/namespace-key");
  keyEntry.size = Buffer.byteLength(wrongNamespace); keyEntry.sha256 = createHash("sha256").update(wrongNamespace).digest("hex");
  writeFileSync(join(mismatch, "manifest.json"), JSON.stringify(mismatchedManifest));
  check(cli(["cloud", "restore", mismatch], mismatchTarget).status !== 0 && !existsSync(mismatchTarget), "restore rejects a namespace key that does not match the backed-up database");
  const unsupported = join(out, "unsupported-backup"), unsupportedTarget = join(out, "unsupported-target"); cpSync(backup, unsupported, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(unsupported, "manifest.json"), "utf8")); manifest.version = 999;
  writeFileSync(join(unsupported, "manifest.json"), JSON.stringify(manifest));
  check(cli(["cloud", "restore", unsupported], unsupportedTarget).status !== 0 && !existsSync(unsupportedTarget), "unsupported backup format is rejected before restoring");
  const result = cli(["cloud", "restore", backup], restored);
  check(result.status === 0 && !result.out.includes(token), "backup restores into a new home without printing credentials");
  check(readFileSync(join(restored, "coordinator", "namespace-key"), "utf8") === namespace && readFileSync(join(restored, "vapid.json"), "utf8") === keys &&
    ["config.toml", "config.local.toml", "settings.json"].every((name) => readFileSync(join(restored, "data", name), "utf8") === readFileSync(join(home, "data", name), "utf8")) &&
    readFileSync(join(restored, "coordinator", "workerd.capnp"), "utf8") === runtimeConfig, "namespace, VAPID and service configuration are preserved exactly");
  const restoredBase = await start(restored, await port());
  check((await call(restoredBase, "/api/status")).ok, "the original machine credential accesses the restored coordinator");
  check((await call(restoredBase, "/api/auth/start", "POST", { email: "second@example.com" }, "")).ok, "owner requests a new login code after restore");
  const again = cli(["login"], restored), nextCode = again.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const againVerified = await call(restoredBase, "/api/auth/verify", "POST", { email: "second@example.com", code: nextCode, totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) }, "");
  const restoredSession = ((await againVerified.json()) as any).session;
  check(againVerified.ok && !!restoredSession, "owner signs in after restore using the original TOTP secret");
  const history = ((await (await call(restoredBase, "/api/files/history?path=reports%2Fbackup.md&content=1", "GET", undefined, restoredSession)).json()) as any).history;
  check(history.length === 2 && Buffer.from(history[0].content, "base64").toString() === "saved version 2", "file content and history are restored");
  const feed = ((await (await call(restoredBase, "/api/feed", "GET", undefined, restoredSession)).json()) as any).events;
  const image = await fetch(restoredBase + media, { headers: { authorization: `Bearer ${restoredSession}` } });
  check(feed.some((event: any) => event.text === "saved backup message" && event.attachments?.includes(media)) && image.ok && Buffer.from(await image.arrayBuffer()).equals(png),
    "message and exact attachment bytes are restored");
  const peer = join(out, "new-peer"), joined = cli(["init", restoredBase, "--token", token], peer);
  check(joined.status === 0 && existsSync(join(peer, "data", "reports", "backup.md")) && readFileSync(join(peer, "data", "reports", "backup.md"), "utf8") === "saved version 2",
    "a fresh execution host synchronizes restored content");
  await stop(restoredBase);
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
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
