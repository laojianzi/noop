// Run only on a disposable host or VM: this installs and updates a user system service.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const source = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-update-e2e-"));
const repo = join(out, "repo"), home = join(out, "long-home-" + "x".repeat(110)), bin = join(out, "bin"), log = join(out, "update.log");
const assets = process.env.NOOP_E2E_WEB_ASSETS || "", workerd = process.env.NOOP_E2E_WORKERD || "", archive = process.env.NOOP_E2E_ARCHIVE || "", nextWorkerd = process.env.NOOP_E2E_NEXT_WORKERD || "", token = "synthetic-update-machine-token-000";
const unit = process.platform === "linux" ? join(homedir(), ".config", "systemd", "user", "noop-coordinator.service") : join(homedir(), "Library", "LaunchAgents", "dev.noop.coordinator.plist");
const checks: string[] = [];
let error = "", installed = false;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
async function port() {
  const s = createServer(); await new Promise<void>((ok, fail) => s.once("error", fail).listen(0, "127.0.0.1", ok));
  const n = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return n;
}
async function waitFor(fn: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 30_000; while (Date.now() < end) { if (await fn()) return; await Bun.sleep(200); } throw new Error(message);
}
try {
  check(process.env.NOOP_E2E_DISPOSABLE === "1" && !existsSync(unit), "test runs on a disposable host without an existing coordinator service");
  check(existsSync(join(assets, "index.html")) && existsSync(workerd), "real Web assets and pinned workerd are supplied");
  let runtime = workerd;
  if (archive) {
    const file = resolve(archive), unpacked = join(out, "archive"), digest = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    check(spawnSync("sha256sum", ["-c", `${basename(file)}.sha256`], { cwd: dirname(file) }).status === 0, "the supplied archive checksum verifies");
    mkdirSync(unpacked);
    check(spawnSync("tar", ["-xzf", file, "-C", unpacked]).status === 0, "the supplied archive extracts");
    const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8"));
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
    runtime = join(unpacked, "bin", "workerd");
    check(manifest.sourceCommit === revision && manifest.webSourceCommit === revision && manifest.platform === process.platform && manifest.arch === process.arch &&
      manifest.workerdSha256 === digest(runtime) && manifest.workerdSha256 === digest(workerd) && manifest.webIndexSha256 === digest(join(assets, "index.html")),
      "the supplied archive matches this source, architecture, Web build and pinned runtime");
    cpSync(join(unpacked, "repo"), repo, { recursive: true });
  } else {
    for (const name of ["src", "cloud", "app", "templates", "presets"])
      cpSync(join(source, name), join(repo, name), { recursive: true, filter: (p) => !p.includes("/node_modules/") && !p.includes("/dist/") });
    for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) cpSync(join(source, name), join(repo, name));
    mkdirSync(join(repo, "app", "dist", "web"), { recursive: true }); cpSync(assets, join(repo, "app", "dist", "web", "noop"), { recursive: true });
  }
  mkdirSync(bin, { recursive: true }); symlinkSync(resolve(runtime), join(bin, "workerd")); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "noop.toml"), `[server]\ntoken = "${token}"\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const listenPort = await port(), base = `http://127.0.0.1:${listenPort}`;
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 90_000 });
    const output = `${r.stdout || ""}${r.stderr || ""}`; writeFileSync(log, `$ noop ${args[0]} ${args[1]}\n${output}\n`, { flag: "a" });
    return { status: r.status, out: output };
  };
  const status = async () => { try { const r = await fetch(base + "/api/status", { headers: { authorization: `Bearer ${token}` } }); return r.ok ? await r.json() as any : null; } catch { return null; } };
  const commit = (path: string, text: string) => fetch(base + "/api/files/commit", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ msg: "update acceptance", changes: [{ path, base_version: 0, content: Buffer.from(text).toString("base64") }] }) });
  const read = async () => ((await (await fetch(base + "/api/files/changes?since=0", { headers: { authorization: `Bearer ${token}` } })).json()) as any).files as any[];
  const update = (candidate: string, runtime = workerd) => cli(["cloud", "service", "update", "--source", candidate, "--workerd", runtime]);
  const first = cli(["cloud", "service", "install", "--listen", `127.0.0.1:${listenPort}`]); installed = existsSync(unit);
  check(first.status === 0 && installed, `the coordinator service installs: ${first.out.slice(-1000)}`);
  await waitFor(async () => !!await status(), "installed coordinator is not available");
  check((await commit("reports/before-update.md", "before update")).ok, "a host commits data before the update");
  const sourceWorker = join(repo, "cloud", "src", "index.ts"), sourceCode = readFileSync(sourceWorker, "utf8");
  const sourceNeedle = 'statusView() { return { ...(this.get("status") ?? {}), hub:';
  check(sourceCode.includes(sourceNeedle), "the source-change fixture matches the real status path");
  writeFileSync(sourceWorker, sourceCode.replace(sourceNeedle, 'statusView() { return { release_marker: "unapproved-source", ...(this.get("status") ?? {}), hub:'));
  const freezeStop = cli(["cloud", "service", "stop"]), freezeStart = cli(["cloud", "service", "start"]);
  writeFileSync(sourceWorker, sourceCode);
  const frozen = await status();
  check(freezeStop.status === 0 && freezeStart.status === 0 && !!frozen && !frozen.release_marker,
    "a restart keeps the installed release when the source checkout changes");
  const absent = update(join(out, "missing-release"));
  check(absent.status !== 0 && !!await status(), "an invalid release is rejected and the old service remains available");
  if (process.env.NOOP_E2E_EXPECT_NO_SPACE === "1") {
    const full = update(repo);
    check(full.status !== 0 && /ENOSPC|no space|disk full/i.test(full.out), `actual insufficient space is reported: ${full.out.slice(-500)}`);
    check(!!await status() && (await read()).some((item) => item.path === "reports/before-update.md"), "insufficient space preserves the running service and its data");
  } else {
    const invalid = join(out, "invalid-release"); cpSync(repo, invalid, { recursive: true });
    writeFileSync(join(invalid, "cloud", "src", "index.ts"), "\\n@@@ invalid TypeScript @@@\\n", { flag: "a" });
    const bad = update(invalid);
    check(bad.status !== 0 && !!await status() && (await read()).some((item) => item.path === "reports/before-update.md"), "a release that cannot build leaves the previous service and data intact");
    const failed = join(out, "startup-failure"); cpSync(repo, failed, { recursive: true });
    const failedLauncher = join(failed, "src", "local-coordinator.ts"), launcher = readFileSync(failedLauncher, "utf8");
    const launcherNeedle = 'export async function localCoordinator(cfg: Cfg, listen = "127.0.0.1:8790") {';
    check(launcher.includes(launcherNeedle), "the startup-failure fixture matches the real coordinator entry point");
    writeFileSync(failedLauncher, launcher.replace(launcherNeedle, `${launcherNeedle}\n  if (process.env.NOOP_HOME === ${JSON.stringify(home)}) throw new Error("synthetic live startup failure");`));
    const failedUpdate = update(failed);
    check(failedUpdate.status !== 0 && /Candidate storage is preserved/.test(failedUpdate.out) && !!await status() && (await read()).some((item) => item.path === "reports/before-update.md"),
      "a live startup failure restores the old service and original data");
    const candidate = join(out, "candidate-release"); cpSync(repo, candidate, { recursive: true });
    const worker = join(candidate, "cloud", "src", "index.ts"), original = readFileSync(worker, "utf8");
    const needle = 'statusView() { return { ...(this.get("status") ?? {}), hub:';
    check(original.includes(needle), "the candidate fixture matches the real status path");
    writeFileSync(worker, original.replace(needle, 'statusView() { return { release_marker: "candidate-v2", ...(this.get("status") ?? {}), hub:'));
    let nextVersion = "";
    const initialVersion = spawnSync(workerd, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^workerd /, "");
    if (nextWorkerd) {
      check(existsSync(nextWorkerd), "a second workerd release is supplied");
      nextVersion = spawnSync(nextWorkerd, ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^workerd /, "");
      const digest = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
      const launch = join(candidate, "src", "local-coordinator.ts"), code = readFileSync(launch, "utf8");
      check(!!nextVersion && nextVersion !== initialVersion && code.includes(initialVersion) && code.includes(digest(workerd)), "the candidate pins a different runtime and matching checksum");
      writeFileSync(launch, code.replace(initialVersion, nextVersion).replace(digest(workerd), digest(nextWorkerd)));
    }
    const applied = update(relative(repo, candidate), relative(repo, nextWorkerd || workerd));
    check(applied.status === 0, `explicit candidate update succeeds: ${applied.out.slice(-1000)}`);
    await waitFor(async () => (await status())?.release_marker === "candidate-v2", "new coordinator release did not become active");
    if (nextVersion) {
      const versionFile = join(home, "coordinator", "runtime-version");
      await waitFor(() => readFileSync(versionFile, "utf8").trim() === nextVersion, "new runtime version was not recorded");
      check(true, `the updated service runs workerd ${nextVersion}`);
    }
    check((await read()).some((item) => item.path === "reports/before-update.md"), "the candidate starts with the previous data");
    check(/backup/i.test(applied.out), "the update reports its pre-update backup");
    check((await commit("reports/after-update.md", "new write")).ok, "a host writes new data after the successful update");
    const rolledBack = cli(["cloud", "service", "rollback"]);
    check(rolledBack.status === 0, `explicit rollback completes: ${rolledBack.out.slice(-1000)}`);
    await waitFor(async () => { const s = await status(); return !!s && !s.release_marker; }, "the previous coordinator release did not return");
    if (nextVersion) {
      const versionFile = join(home, "coordinator", "runtime-version");
      await waitFor(() => readFileSync(versionFile, "utf8").trim() === initialVersion, "previous runtime version was not restored");
      check(true, `rollback returns to workerd ${initialVersion}`);
    }
    const files = await read();
    check(files.some((item) => item.path === "reports/before-update.md") && files.some((item) => item.path === "reports/after-update.md" && Buffer.from(item.content, "base64").toString() === "new write"),
      "rollback keeps the write made after the successful update");
  }
  check(cli(["cloud", "service", "stop"]).status === 0, "service stops after update verification");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  if (installed) {
    const env = { ...process.env, NOOP_HOME: home, PATH: `${bin}:${process.env.PATH || ""}` };
    if (process.platform === "linux") {
      spawnSync("systemctl", ["--user", "disable", "--now", "noop-coordinator.service"], { env });
      if (existsSync(unit)) unlinkSync(unit); spawnSync("systemctl", ["--user", "daemon-reload"], { env });
    } else {
      spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}`, unit], { env }); if (existsSync(unit)) unlinkSync(unit);
    }
  }
  const hash = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
  const report = { status: error ? "failed" : "passed", source, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim(),
    changes: spawnSync("git", ["status", "--short"], { cwd: source, encoding: "utf8" }).stdout.trim(), platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(), bun: Bun.version, noSpaceFixture: process.env.NOOP_E2E_EXPECT_NO_SPACE === "1", workerdSha256: hash(workerd), nextWorkerdSha256: nextWorkerd ? hash(nextWorkerd) : null, webIndexSha256: hash(join(assets, "index.html")), checks, error };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = readdirSync(out, { withFileTypes: true }).filter((f) => f.isFile() && f.name !== "SHA256SUMS").map((f) => f.name);
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${hash(join(out, f))}  ${f}`).join("\n") + "\n");
  console.log(`Evidence: ${out}`);
}
