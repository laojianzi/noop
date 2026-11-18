import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { CODE, HOME_DIR } from "./core";
import { readHubToml } from "./sync";
import { backupCoordinator, restoreCoordinator, syncPath } from "./local-backup";

const root = join(HOME_DIR, "coordinator"), releases = join(root, "releases");

export function stageRelease(source = CODE, runtime = Bun.which("workerd")) {
  if (!runtime || !existsSync(runtime)) throw new Error("The selected workerd runtime does not exist");
  for (const path of ["src/cli.ts", "cloud/src/index.ts", "app/dist/web/noop/index.html", "package.json"])
    if (!existsSync(join(source, path))) throw new Error(`The selected release is missing ${path}`);
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const release = mkdtempSync(join(releases, "release-"));
  try {
    const repo = join(release, "repo");
    for (const name of ["src", "cloud", "app", "templates", "presets"])
      cpSync(join(source, name), join(repo, name), { recursive: true, filter: (path) => !relative(source, path).split(/[\\/]/).some((part) => part === "node_modules" || part === "dist" || part === ".git") });
    for (const name of ["package.json", "bunfig.toml", "tsconfig.json"]) copyFileSync(join(source, name), join(repo, name));
    mkdirSync(join(repo, "app", "dist", "web"), { recursive: true });
    cpSync(join(source, "app", "dist", "web", "noop"), join(repo, "app", "dist", "web", "noop"), { recursive: true });
    mkdirSync(join(release, "bin"), { mode: 0o700 });
    copyFileSync(runtime, join(release, "bin", "workerd")); chmodSync(join(release, "bin", "workerd"), 0o700);
    const sync = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) sync(child);
        else if (entry.isFile()) syncPath(child);
      }
      syncPath(path);
    };
    sync(release); syncPath(releases);
    return release;
  } catch (error) { rmSync(release, { recursive: true, force: true }); throw error; }
}

export function pointRelease(name: "current" | "previous", release: string) {
  const link = join(root, name), temp = join(root, `.${name}-${crypto.randomUUID()}`);
  symlinkSync(relative(root, release), temp); renameSync(temp, link);
}

export async function updateRelease(action: "update" | "rollback", start: () => Promise<void>, stop: () => void, source?: string, runtime?: string) {
  const current = join(root, "current"), previous = join(root, "previous");
  if (!lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("The installed service has no managed release");
  const oldRelease = resolve(root, readlinkSync(current));
  const oldPrevious = lstatSync(previous, { throwIfNoEntry: false }) ? resolve(root, readlinkSync(previous)) : "";
  if (action === "rollback" && (!oldPrevious || !existsSync(oldPrevious))) throw new Error("No previous coordinator release is available");
  const token = readHubToml().server?.token;
  if (!token) throw new Error("The coordinator machine token is missing");
  try {
    const response = await fetch("http://localhost/api/status", { unix: join(root, "health.sock"), headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error("not ready");
  } catch { throw new Error("Start the coordinator service before updating it"); }
  const selected = action === "update" ? stageRelease(source, runtime) : oldPrevious;
  const operation = crypto.randomUUID(), backup = join(root, "backups", operation), clone = join(root, `.verify-${operation}`);
  const storage = join(root, "storage"), saved = join(root, `.storage-${operation}`), quarantine = join(root, `failed-storage-${operation}`);
  let stopped = false, savedStorage = false, newStorage = false, changedCurrent = false, changedPrevious = false;
  let alias = "";
  try {
    stop(); stopped = true;
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    await backupCoordinator(backup);
    await restoreCoordinator(backup, clone, true);
    alias = mkdtempSync("/tmp/noop-check-");
    const testHome = join(alias, "home");
    symlinkSync(clone, testHome, "dir");
    const socket = createServer();
    await new Promise<void>((ok, fail) => socket.once("error", fail).listen(0, "127.0.0.1", ok));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((ok) => socket.close(() => ok()));
    const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: testHome, PATH: `${join(selected, "bin")}:${process.env.PATH || ""}` };
    delete env.HUB_DATA; delete env.HUB_CONF;
    const child = Bun.spawn([process.execPath, join(selected, "repo", "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", `127.0.0.1:${port}`],
      { cwd: join(selected, "repo"), env, stdout: "ignore", stderr: "pipe" });
    const errors = new Response(child.stderr).text();
    let exited = false;
    void child.exited.then(() => { exited = true; });
    try {
      let ready = false;
      for (let i = 0; i < 100 && !exited; i++) {
        try {
          const response = await fetch("http://localhost/api/status", { unix: join(testHome, "coordinator", "health.sock"), headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
          if (response.ok) { ready = true; break; }
        } catch {}
        await Bun.sleep(200);
      }
      if (!ready) throw new Error(`Candidate validation failed: ${(await Promise.race([errors, Bun.sleep(100).then(() => "")])).slice(-2000)}`);
    } finally { if (!exited) child.kill("SIGTERM"); await child.exited; }
    renameSync(storage, saved); savedStorage = true;
    renameSync(join(clone, "coordinator", "storage"), storage); newStorage = true;
    pointRelease("current", selected); changedCurrent = true;
    pointRelease("previous", oldRelease); changedPrevious = true;
    syncPath(root);
    await start(); stopped = false;
    try { rmSync(saved, { recursive: true, force: true }); } catch { console.error(`Old coordinator storage remains at ${saved}`); }
    console.log(`Coordinator ${action} complete. Backup: ${backup}`);
  } catch (error) {
    let preserved = "";
    if (stopped) {
      try {
        if (newStorage && existsSync(storage)) { renameSync(storage, quarantine); preserved = ` Candidate storage is preserved at ${quarantine}.`; }
        if (savedStorage) renameSync(saved, storage);
        if (changedCurrent) pointRelease("current", oldRelease);
        if (changedPrevious) { if (oldPrevious) pointRelease("previous", oldPrevious); else unlinkSync(previous); }
        syncPath(root);
        await start();
      } catch (recovery) { throw new Error(`Coordinator ${action} failed: ${error}. Recovery failed: ${recovery}.${preserved} Backup: ${backup}`); }
    }
    if (action === "update" && !preserved) rmSync(selected, { recursive: true, force: true });
    throw new Error(`Coordinator ${action} failed; the previous service was restored: ${error}.${preserved} Backup: ${backup}`);
  } finally {
    if (alias) rmSync(alias, { recursive: true, force: true });
    try { if (existsSync(clone)) rmSync(clone, { recursive: true, force: true }); }
    catch { console.error(`Verification data remains at ${clone}`); }
  }
}
