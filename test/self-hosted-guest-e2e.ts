// Guest CLI and API lifecycle against an isolated native coordinator.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-guest-e2e-"));
const repo = join(out, "repo"), home = join(out, "owner"), bin = join(out, "bin"), log = join(out, "coordinator.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const token = "synthetic-guest-machine-token-000", checks: string[] = [];
let service: ChildProcess | undefined, error = "";

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}

try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "real Web assets and workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(workerd), join(bin, "workerd"));
  writeFileSync(join(bin, "codex"), '#!/bin/sh\ncat >/dev/null\nprintf "synthetic guest result\\n"\n', { mode: 0o755 });
  mkdirSync(home, { recursive: true }); writeFileSync(join(home, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "NOOP_GUEST_HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const cli = (args: string[], guestHome?: string) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo,
      env: { ...env, ...(guestHome ? { NOOP_GUEST_HOME: guestHome } : {}) }, encoding: "utf8", timeout: 20_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  const start = async () => {
    const fd = openSync(log, "a");
    service = spawn(process.execPath, [join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${listenPort}`],
      { cwd: repo, env, detached: true, stdio: ["ignore", fd, fd] }); closeSync(fd);
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (service.exitCode !== null) throw new Error(`coordinator exited: ${readFileSync(log, "utf8")}`);
      try {
        const cfg = Bun.TOML.parse(readFileSync(join(home, "noop.toml"), "utf8")) as any;
        if (cfg.cloud?.mode === "local" && (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("coordinator did not start");
  };
  const stop = async () => {
    const child = service!; child.kill("SIGTERM"); await new Promise<void>((ok) => child.once("exit", () => ok())); service = undefined;
  };
  const api = (path: string, credential: string, method = "GET", body?: unknown) => fetch(base + path, { method,
    headers: { Authorization: `Bearer ${credential}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const invite = (label: string) => {
    const r = cli(["guest", "invite", label]);
    const code = r.out.match(/noop guest join \S+ ([0-9a-f]{32})/)?.[1] || "";
    check(r.status === 0 && !!code, `${label} invite is created by the owner CLI`); return code;
  };
  await start(); check(true, "local coordinator starts without Cloudflare");
  const aHome = join(out, "guest-a"), bHome = join(out, "guest-b"), aCode = invite("guest-a");
  check(cli(["guest", "join", base, aCode], aHome).out.includes("joined as guest"), "guest A joins with a one-time code");
  check(cli(["guest", "join", base, aCode], join(out, "guest-reuse")).out.includes("join failed") &&
    (await api("/api/guest/join", "", "POST", { code: aCode })).status === 401, "a used invitation is rejected");
  const bCode = invite("guest-b");
  check(cli(["guest", "join", base, bCode], bHome).out.includes("joined as guest"), "guest B joins independently");
  const a = JSON.parse(readFileSync(join(aHome, "guest.json"), "utf8")), b = JSON.parse(readFileSync(join(bHome, "guest.json"), "utf8"));
  check(a.id !== b.id && a.token !== b.token && (statSync(join(aHome, "guest.json")).mode & 0o077) === 0, "guest identities have separate protected credentials");
  check(cli(["guest", "assign", a.id, "T-1001", "Guest A task", "-b", "Only guest A may run this"]).out.includes("queued"), "owner assigns a task to guest A");
  check(cli(["guest", "assign", b.id, "T-1002", "Guest B task", "-b", "Only guest B may run this"]).out.includes("queued"), "owner assigns a different task to guest B");
  check((await api("/api/guest/result", b.token, "POST", { id: "T-1001", ok: true, text: "spoof" })).status === 403,
    "guest B cannot submit a result for guest A's task");
  for (const path of ["/api/feed", "/api/status", "/api/settings", "/api/files/changes?since=0", "/api/files/read?path=memory%2Flessons.md", "/api/guests"])
    check((await api(path, a.token)).status === 403, `guest cannot access ${path}`);
  const aRun = cli(["guest", "run", "--cli", "codex", "--once"], aHome);
  check(aRun.status === 0 && aRun.out.includes("T-1001") && aRun.out.includes("reported (200)"), "guest A claims and returns its task through the real CLI using a synthetic executor");
  check((await (await api("/api/guest/next", a.token)).json() as any).task === null, "guest A cannot claim guest B's queued task");
  const expiredCode = invite("expired-guest");
  await stop();
  const storage = join(home, "coordinator", "storage"), namespace = readdirSync(storage).find((n) => statSync(join(storage, n)).isDirectory())!;
  const dir = join(storage, namespace), database = readdirSync(dir).find((n) => /^[a-f0-9]{64}\.sqlite$/.test(n));
  if (!database) throw new Error("isolated Durable Object database not found");
  const db = new Database(join(dir, database));
  const expired = db.query("UPDATE guest_codes SET expires = 0 WHERE hash = ?").run(createHash("sha256").update(expiredCode).digest("hex")); db.close();
  check(expired.changes === 1, "the isolated fixture sets one invitation past its expiry");
  await start();
  check(cli(["guest", "join", base, expiredCode], join(out, "guest-expired")).out.includes("join failed") &&
    (await api("/api/guest/join", "", "POST", { code: expiredCode })).status === 401, "an expired invitation is rejected after restart");
  const results = cli(["guest", "results"]);
  check(results.status === 0 && results.out.includes("T-1001") && results.out.includes("synthetic guest result") && results.out.includes("UNTRUSTED"),
    "guest A's untrusted result survives coordinator restart");
  const bRun = cli(["guest", "run", "--cli", "codex", "--once"], bHome);
  check(bRun.status === 0 && bRun.out.includes("T-1002") && bRun.out.includes("reported (200)"), "guest B's assigned task survives restart");
  check(cli(["guest", "results", "--ack"]).out.includes("T-1002") && !cli(["guest", "results"]).out.includes("T-1002"), "the owner can acknowledge completed guest results");
  check(cli(["guest", "revoke", a.id]).out.includes("revoked"), "owner revokes guest A");
  check((await api("/api/guest/next", a.token)).status === 401, "revoked guest credentials are rejected immediately");
  check(cli(["guest", "run", "--cli", "codex", "--once"], aHome).out.includes("revoked") && existsSync(join(aHome, "guest.revoked.json")),
    "the guest CLI parks a revoked credential");
  await stop();
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
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
