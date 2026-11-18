// Build and run a coordinator archive using an isolated source checkout and Noop home.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-package-e2e-"));
const repo = join(out, "repo"), artifacts = join(out, "artifacts"), extracted = join(out, "extracted"), home = join(out, "home");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "";
const checks: string[] = [], token = "synthetic-package-token-0000000000";
let service: ChildProcess | undefined, error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function run(command: string, args: string[], cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  return { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
try {
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "Web fixture and pinned workerd are supplied");
  for (const name of ["src", "cloud", "app", "templates", "presets", "scripts"])
    cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
  for (const name of ["package.json", "bunfig.toml", "tsconfig.json", ".gitignore"]) cpSync(join(source, name), join(repo, name));
  check(run("git", ["init", "-q"]).status === 0 && run("git", ["add", "."]).status === 0 &&
    run("git", ["-c", "user.name=Noop E2E", "-c", "user.email=noop-e2e@example.test", "commit", "-qm", "fixture"]).status === 0,
    "the packaging source is an isolated committed checkout");
  const revision = run("git", ["rev-parse", "HEAD"]).out.trim();
  mkdirSync(join(repo, "app", "dist", "web"), { recursive: true });
  cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  mkdirSync(artifacts);
  const pack = (version: string, runtime = workerd) => run(process.execPath, [join(repo, "scripts", "package-local-coordinator.ts"),
    "--workerd", runtime, "--output", artifacts, "--web-commit", version]);
  const mismatch = pack("0000000000000000000000000000000000000000");
  check(mismatch.status !== 0 && mismatch.out.includes("Web source commit") && readdirSync(artifacts).length === 0, "a Web build from a different source commit cannot be published");
  const badRuntime = join(out, "bad-workerd"); writeFileSync(badRuntime, "not the pinned runtime");
  const invalidRuntime = pack(revision, badRuntime);
  check(invalidRuntime.status !== 0 && invalidRuntime.out.includes("workerd checksum") && readdirSync(artifacts).length === 0, "a runtime with the wrong checksum cannot be published");
  const result = pack(revision);
  check(result.status === 0, `Linux coordinator archive builds: ${result.out.slice(-1000)}`);
  const built = readdirSync(artifacts).find((name) => name.endsWith(".tar.gz")) || "";
  const archive = process.env.NOOP_E2E_ARCHIVE ? resolve(process.env.NOOP_E2E_ARCHIVE) : join(artifacts, built);
  const expectedRevision = process.env.NOOP_E2E_ARCHIVE ? run("git", ["rev-parse", "HEAD"], source).out.trim() : revision;
  check(!!built && existsSync(`${archive}.sha256`) && run("sha256sum", ["-c", `${basename(archive)}.sha256`], dirname(archive)).status === 0,
    "the archive checksum verifies");
  mkdirSync(extracted);
  check(run("tar", ["-xzf", archive, "-C", extracted]).status === 0, "the archive extracts");
  const manifest = JSON.parse(readFileSync(join(extracted, "manifest.json"), "utf8"));
  check(manifest.sourceCommit === expectedRevision && manifest.webSourceCommit === expectedRevision && manifest.platform === "linux" && manifest.arch === process.arch &&
    manifest.workerdSha256 === hash(workerd) && manifest.webIndexSha256 === hash(join(assets, "index.html")), "manifest identifies the source, Web build, runtime and architecture");
  check(!existsSync(join(extracted, "repo", ".git")) && !existsSync(join(extracted, ".noop")), "the archive excludes Git metadata and machine data");
  const socket = createServer(); await new Promise<void>((ok, fail) => socket.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = (socket.address() as { port: number }).port; await new Promise<void>((ok) => socket.close(() => ok()));
  mkdirSync(home); writeFileSync(join(home, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${join(extracted, "bin")}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  service = spawn(process.execPath, [join(extracted, "repo", "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${port}`],
    { cwd: join(extracted, "repo"), env, detached: true, stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 150 && service.exitCode === null; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) { ready = true; break; }
    } catch {}
    await Bun.sleep(100);
  }
  check(ready, "the extracted archive starts and authenticates without a cloud deployment");
  const web = await fetch(`http://127.0.0.1:${port}/`);
  check(web.ok && (await web.text()).includes("nsh"), "the extracted archive serves the supplied Web bundle");
  writeFileSync(join(repo, "src", "cli.ts"), "\n// dirty source fixture\n", { flag: "a" });
  const dirty = pack(revision);
  check(dirty.status !== 0 && dirty.out.includes("uncommitted"), "uncommitted source cannot be labeled as the committed revision");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (service?.pid) { try { process.kill(-service.pid, "SIGINT"); } catch {} await new Promise<void>((ok) => service!.once("exit", () => ok())); }
  const report = { status: error ? "failed" : "passed", source, revision: run("git", ["rev-parse", "HEAD"], source).out.trim(),
    changes: run("git", ["status", "--short"], source).out.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, workerdSha256: existsSync(workerd) ? hash(workerd) : null,
    webIndexSha256: existsSync(join(assets, "index.html")) ? hash(join(assets, "index.html")) : null, checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
