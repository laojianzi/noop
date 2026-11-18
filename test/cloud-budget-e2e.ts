// Cloud-mode policy regression under isolated wrangler dev, using a real >500 MB SQLite database.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-cloud-budget-e2e-"));
const repo = join(out, "repo"), state = join(out, "state"), log = join(out, "wrangler.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", wrangler = process.env.NOOP_E2E_WRANGLER || "", node = Bun.which("node") || "";
const token = "synthetic-cloud-budget-token-00000", checks: string[] = [];
let service: ChildProcess | undefined, error = "", databaseBytes = 0;
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
  check(existsSync(join(assets, "index.html")) && existsSync(wrangler) && !!node, "Web fixture, Wrangler and Node are supplied");
  for (const name of ["cloud", "app"]) cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  mkdirSync(join(repo, "app", "dist", "web", "noop"), { recursive: true }); cpSync(join(assets, "index.html"), join(repo, "app", "dist", "web", "noop", "index.html"));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(out, "xdg"), WRANGLER_SEND_METRICS: "false", CI: "1" };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "HUB_LOCAL_MODE"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const start = async () => {
    const fd = openSync(log, "a"); service = spawn(node, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(listenPort), "--inspector-port", "0", "--persist-to", state, "--var", `HUB_TOKEN:${token}`],
      { cwd: join(repo, "cloud"), env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    await waitFor(async () => { try { return (await fetch(base + "/api/status", { headers: { authorization: `Bearer ${token}` } })).ok; } catch { return false; } }, "Wrangler did not start");
  };
  const stop = async () => {
    const child = service!; if (child.pid) process.kill(-child.pid, "SIGINT");
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await Bun.sleep(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error("Wrangler did not stop");
    await waitFor(async () => { try { await fetch(base); return false; } catch { return true; } }, "Wrangler port remained open");
    service = undefined;
  };
  const request = (path: string, method = "GET", body?: unknown, credential = token) => fetch(base + path, { method,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const commit = (path: string, version: number) => request("/api/files/commit", "POST", { msg: "acceptance", changes: [{ path, base_version: version, content: Buffer.from(`version ${version + 1}`).toString("base64") }] });
  await start();
  const setup = await (await request("/api/host/2fa/setup", "POST", {})).json() as any;
  check((await request("/api/host/2fa/confirm", "POST", { totp: totp(setup.secret, Math.floor(Date.now() / 30_000) - 1) })).ok, "cloud-mode owner binds TOTP");
  check((await request("/api/auth/start", "POST", { email: "owner@example.com" }, "")).ok, "cloud-mode owner requests a CLI code");
  const code = ((await (await request("/api/host/login-code")).json()) as any).code;
  const login = await request("/api/auth/verify", "POST", { email: "owner@example.com", code, totp: totp(setup.secret, Math.floor(Date.now() / 30_000)) }, "");
  const session = ((await login.json()) as any).session; check(login.ok && !!session, "cloud-mode owner signs in");
  check((await commit("reports/cloud.md", 0)).ok && (await commit("reports/cloud.md", 1)).ok, "cloud-mode coordinator records two file versions");
  await stop();
  const dir = join(state, "v3", "do", "noop-Hub"), dbName = readdirSync(dir).find((n) => /^[a-f0-9]{64}\.sqlite$/.test(n));
  if (!dbName) throw new Error("isolated Wrangler Durable Object database not found");
  const path = join(dir, dbName), db = new Database(path);
  db.exec("CREATE TABLE e2e_padding (data BLOB)"); db.exec("INSERT INTO e2e_padding VALUES (zeroblob(501000000))");
  db.query("INSERT OR REPLACE INTO files_meta (k,v) VALUES ('pruned', 0)").run();
  db.query("INSERT OR REPLACE INTO kv (k,v) VALUES ('usage', ?)").run(JSON.stringify({ day: new Date().toISOString().slice(0, 10), requests: 75_000, rowsRead: 4_000_000, rowsWritten: 75_000, routes: {} }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); databaseBytes = statSync(path).size;
  check(databaseBytes > 500_000_000, `cloud-mode SQLite fixture exceeds 500 MB (${databaseBytes} bytes)`);
  await start();
  const usage = await (await request("/api/usage")).json() as any;
  check(usage.dbBytes > 500_000_000 && usage.level === "shed" && usage.requests >= 75_000, "cloud mode reports actual usage and retains shed level");
  check((await commit("reports/trigger.md", 0)).ok, "ordinary cloud-mode commit triggers history pruning");
  const history = ((await (await request("/api/files/history?path=reports%2Fcloud.md", "GET", undefined, session)).json()) as any).history;
  check(history.length === 1 && history[0].version === 2, "cloud mode retains only the newest file version above 500 MB");
  check((await commit("fleet/host.json", 0)).status === 429, "cloud mode still rate limits latest-only commits at the shed threshold");
  const event = await (await request("/api/events", "POST", { from: "worker@fixture", kind: "notice", text: "budgeted" })).json() as any;
  check(event.dropped === "write budget", "cloud mode still sheds routine events at the budget threshold");
  await request("/api/host/state", "PUT", { status: { marker: "first" } }); await request("/api/host/state", "PUT", { status: { marker: "second" } });
  check(((await (await request("/api/status")).json()) as any).marker === "first", "cloud mode still throttles repeated dashboard updates");
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (service?.pid) try { process.kill(-service.pid, "SIGINT"); } catch {}
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, node: spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(),
    wrangler: existsSync(wrangler) ? spawnSync(node, [wrangler, "--version"], { encoding: "utf8" }).stdout.trim() : "missing", databaseBytes, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  if (!error) rmSync(state, { recursive: true, force: true });
  console.log(`Evidence: ${out}`);
}
