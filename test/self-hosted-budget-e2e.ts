// Real local Worker policy with a >500 MB SQLite fixture and cloud-limit usage counters.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-budget-e2e-"));
const repo = join(out, "repo"), home = join(out, "home"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", token = "synthetic-budget-machine-token-000";
const checks: string[] = [];
let service: ChildProcess | undefined, error = "", databaseBytes = 0, historyRows = 0;
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
    service = undefined;
  };
  const request = (path: string, method = "GET", body?: unknown, credential = token) => fetch(base + path, { method,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const commit = (path: string, baseVersion: number, text: string) => request("/api/files/commit", "POST", { msg: "acceptance", changes: [{ path, base_version: baseVersion, content: Buffer.from(text).toString("base64") }] });
  await start();
  const setup = cli(["2fa", "setup"]), secret = setup.out.match(/(?:key by hand:|手动输入密钥：)\s*([A-Z2-7 ]+)/i)?.[1]?.replace(/\s/g, "") || "";
  check(setup.status === 0 && secret.length === 32 && cli(["2fa", "confirm", totp(secret, Math.floor(Date.now() / 30_000) - 1)]).status === 0, "owner binds TOTP");
  check((await request("/api/auth/start", "POST", { email: "owner@example.com" }, "")).ok, "owner requests a CLI login code");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const auth = await request("/api/auth/verify", "POST", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) }, "");
  const session = ((await auth.json()) as any).session;
  check(auth.ok && !!session, "owner signs in with CLI code and TOTP");
  await stop();
  const storage = join(home, "coordinator", "storage"), namespace = readdirSync(storage).find((n) => statSync(join(storage, n)).isDirectory())!;
  const dir = join(storage, namespace), dbName = readdirSync(dir).find((n) => /^[a-f0-9]{64}\.sqlite$/.test(n));
  if (!dbName) throw new Error("isolated coordinator database not found");
  const dbPath = join(dir, dbName), seed = new Database(dbPath);
  seed.exec("CREATE TABLE e2e_padding (data BLOB)");
  seed.exec("INSERT INTO e2e_padding VALUES (zeroblob(501000000))");
  const insert = seed.prepare("INSERT INTO history (path, version, hash, content, ts, by, msg) VALUES (?, ?, 'synthetic', x'78', ?, 'fixture', 'fixture')");
  const now = new Date().toISOString();
  seed.transaction(() => { for (let version = 1; version <= 21; version++) for (let i = 0; i < 1000; i++) insert.run(`reports/fixture-${i}.md`, version, now); })();
  seed.query("INSERT OR REPLACE INTO files_meta (k,v) VALUES ('pruned', ?)").run(Date.now());
  seed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seed.close();
  databaseBytes = statSync(dbPath).size;
  check(databaseBytes > 500_000_000, `isolated SQLite fixture exceeds 500 MB (${databaseBytes} bytes) and contains 21000 synthetic history rows`);
  await start();
  const usageBefore = await (await request("/api/usage")).json() as any;
  check(usageBefore.dbBytes > 500_000_000, "running coordinator reports a database above the cloud storage threshold");
  for (let i = 0; i < 35; i++) if (!(await commit("reports/versions.md", i, `version ${i + 1}`)).ok) throw new Error(`regular file version ${i + 1} failed`);
  for (let i = 0; i < 2; i++) if (!(await commit("reports/old.md", i, `old ${i + 1}`)).ok) throw new Error(`old file version ${i + 1} failed`);
  for (let i = 0; i < 3; i++) if (!(await commit("journal/example.log", i, `journal ${i + 1}`)).ok) throw new Error(`journal version ${i + 1} failed`);
  check(true, "real commits create 35 regular versions and old and latest-only fixtures");
  await stop();
  const edit = new Database(dbPath);
  edit.query("UPDATE history SET ts = ? WHERE path = ?").run(new Date(Date.now() - 100 * 86400_000).toISOString(), "reports/old.md");
  edit.query("INSERT OR REPLACE INTO files_meta (k,v) VALUES ('pruned', 0)").run();
  edit.exec("PRAGMA wal_checkpoint(TRUNCATE)"); edit.close();
  await start();
  check((await commit("reports/trigger.md", 0, "trigger prune")).ok, "a real file commit triggers the scheduled history prune");
  const history = async (path: string) => ((await (await request(`/api/files/history?path=${encodeURIComponent(path)}&limit=500`, "GET", undefined, session)).json()) as any).history as any[];
  const versions = await history("reports/versions.md");
  check(versions.length === 30 && versions[0].version === 35 && versions.at(-1).version === 6, `regular files retain 30 versions above 500 MB (observed ${versions.length})`);
  const old = await history("reports/old.md"), journal = await history("journal/example.log");
  check(old.length === 1 && old[0].version === 2, "90-day pruning keeps each old path's newest version");
  check(journal.length === 1 && journal[0].version === 3, "latest-only files expose only the current version");
  await stop();
  const prepareRevert = new Database(dbPath);
  prepareRevert.query("INSERT OR REPLACE INTO files_meta (k,v) VALUES ('pruned', 0)").run();
  prepareRevert.exec("PRAGMA wal_checkpoint(TRUNCATE)"); prepareRevert.close();
  await start();
  const reverted = await request("/api/files/revert", "POST", { path: "reports/versions.md", version: 10 }, session);
  const afterRevert = await history("reports/versions.md");
  check(reverted.ok && afterRevert.length === 30 && afterRevert[0].version === 36, "revert also preserves the normal 30-version policy above 500 MB");
  await stop();
  const meter = new Database(dbPath);
  historyRows = Number((meter.query("SELECT COUNT(*) AS n FROM history").get() as any).n);
  check(historyRows <= 20_000, `history total is pruned to the existing 20000-row bound (observed ${historyRows})`);
  const usage = { day: new Date().toISOString().slice(0, 10), requests: 75_000, rowsRead: 4_000_000, rowsWritten: 75_000, routes: {} };
  meter.query("INSERT OR REPLACE INTO kv (k,v) VALUES ('usage', ?)").run(JSON.stringify(usage));
  meter.exec("PRAGMA wal_checkpoint(TRUNCATE)"); meter.close();
  await start();
  const view = await (await request("/api/usage")).json() as any;
  check(view.requests >= 75_000 && view.rowsWritten >= 75_000 && view.dbBytes > 500_000_000, "actual usage remains visible beyond cloud budget thresholds");
  check((await commit("fleet/host.json", 0, "heartbeat")).ok, "local latest-only commit is not rate limited by cloud budget");
  const notice = await (await request("/api/events", "POST", { from: "worker@fixture", kind: "notice", text: "not dropped" })).json() as any;
  check(!notice.dropped && notice.text === "not dropped", "local routine event is not discarded by cloud budget");
  await request("/api/host/state", "PUT", { status: { marker: "first" } });
  await request("/api/host/state", "PUT", { status: { marker: "second" } });
  const status = await (await request("/api/status")).json() as any;
  check(status.marker === "second", "local status updates are not reduced by cloud budget");
  check((await request("/api/auth/start", "POST", { email: "locked@example.com" }, "")).ok, "security-limit fixture requests a new login code");
  const locked = cli(["login"]), goodCode = locked.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  check(!!goodCode, "security-limit fixture obtains its CLI code");
  const badCode = goodCode === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
  for (let i = 0; i < 5; i++) check((await request("/api/auth/verify", "POST", { email: "locked@example.com", code: badCode, totp: "000000" }, "")).status === 401, `wrong login code ${i + 1} is rejected`);
  check((await request("/api/auth/verify", "POST", { email: "locked@example.com", code: goodCode, totp: totp(secret, Math.floor(Date.now() / 30_000) + 1) }, "")).status === 401,
    "authentication attempt limit remains active in local mode");
  check((await request("/api/auth/start", "POST", { email: "locked@example.com" }, "")).status === 429, "authentication resend limit remains active in local mode");
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, webVersion: process.env.NOOP_E2E_WEB_VERSION || "not specified", webIndexSha256: hash(join(assets, "index.html")),
    workerd: { version: existsSync(workerd) ? spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing", sha256: hash(workerd) }, databaseBytes, historyRows, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  if (!error) rmSync(join(home, "coordinator", "storage"), { recursive: true, force: true });
  console.log(`Evidence: ${out}`);
}
