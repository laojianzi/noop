import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CODE, HOME_DIR } from "./core";
import { readHubToml } from "./sync";

const LABEL = "dev.noop.coordinator", UNIT = "noop-coordinator.service";
const serviceFile = () => process.platform === "linux" ? join(homedir(), ".config", "systemd", "user", UNIT)
  : process.platform === "darwin" ? join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`) : "";

export function localServiceInstalled(home = HOME_DIR) {
  const file = serviceFile();
  return !!file && existsSync(file) && readFileSync(file, "utf8").includes(`noop-home:${Buffer.from(home).toString("base64")}`);
}

export async function localService(action: string, listen = "127.0.0.1:8790", source?: string, runtime?: string) {
  const linux = process.platform === "linux", mac = process.platform === "darwin";
  if (!linux && !mac) throw new Error("The local coordinator service supports Linux and macOS");
  const file = serviceFile();
  const domain = `gui/${process.getuid!()}`, marker = `noop-home:${Buffer.from(HOME_DIR).toString("base64")}`;
  const exec = (command: string, args: string[], show = false) => {
    const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
    if (show && result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
    return result.stdout;
  };
  const installed = () => {
    if (!localServiceInstalled()) throw new Error("This Noop home has no installed coordinator service");
  };
  const stop = () => linux ? exec("systemctl", ["--user", "stop", UNIT]) : exec("launchctl", ["bootout", domain, file]);
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      const token = readHubToml().server?.token;
      if (token) try {
        const response = await fetch("http://localhost/api/status", { unix: join(HOME_DIR, "coordinator", "health.sock"),
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await Bun.sleep(200);
    }
    throw new Error("Coordinator service did not become ready; inspect its logs");
  };
  const start = async () => {
    if (linux) exec("systemctl", ["--user", "start", UNIT]);
    else exec("launchctl", ["bootstrap", domain, file]);
    try { await ready(); } catch (error) { try { stop(); } catch {} throw error; }
  };
  if (action === "install") {
    if (lstatSync(file, { throwIfNoEntry: false })) throw new Error("A coordinator service is already installed for this user");
    const workerd = Bun.which("workerd");
    if (!workerd) throw new Error("Install the pinned workerd runtime and put it on PATH");
    if (linux) {
      const user = userInfo().username;
      const linger = () => exec("loginctl", ["show-user", user, "-p", "Linger", "--value"]).trim();
      if (linger() !== "yes") { exec("loginctl", ["enable-linger", user]); if (linger() !== "yes") throw new Error("systemd linger is not enabled"); }
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const root = join(HOME_DIR, "coordinator"), current = join(root, "current");
    if (lstatSync(current, { throwIfNoEntry: false })) throw new Error("A coordinator release already exists in this Noop home");
    const { stageRelease, pointRelease } = await import("./local-release");
    const { syncPath } = await import("./local-backup");
    const release = stageRelease(CODE, workerd), repo = join(current, "repo");
    try {
      pointRelease("current", release);
      syncPath(root);
      const environment: Record<string, string> = { NOOP_HOME: HOME_DIR, PATH: `${join(current, "bin")}:${dirname(process.execPath)}:${process.env.PATH || ""}` };
      for (const name of ["HUB_DATA", "HUB_CONF", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[name]) environment[name] = process.env[name]!;
      if (linux) {
        const quote = (s: string) => JSON.stringify(s.replace(/%/g, "%%"));
        const command = [process.execPath, join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", listen].map((v) => quote(v.replace(/\$/g, "$$$$"))).join(" ");
        const env = Object.entries(environment).map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`).join("\n");
        writeFileSync(file, `# ${marker}\n[Unit]\nDescription=Noop coordination service\nAfter=network.target\n[Service]\nType=simple\nWorkingDirectory=${repo.replace(/%/g, "%%")}\n${env}\nExecStart=${command}\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=default.target\n`, { mode: 0o600, flag: "wx" });
      } else {
        const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
        const args = [process.execPath, join(repo, "src", "cli.ts"), "cloud", "deploy", "--local", "--listen", listen].map((s) => `<string>${xml(s)}</string>`).join("");
        const env = Object.entries(environment).map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`).join("");
        const log = xml(join(HOME_DIR, "coordinator", "service.log"));
        writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${marker} -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict>${env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string></dict></plist>\n`, { mode: 0o600, flag: "wx" });
      }
      syncPath(file);
      for (let dir = dirname(file); ; dir = dirname(dir)) { syncPath(dir); if (dir === resolve(homedir()) || dir === dirname(dir)) break; }
      if (linux) {
        exec("systemctl", ["--user", "daemon-reload"]); exec("systemctl", ["--user", "enable", "--now", UNIT]);
        syncPath(join(dirname(file), "default.target.wants")); syncPath(dirname(file)); await ready();
      }
      else await start();
    } catch (error) {
      try { if (linux) exec("systemctl", ["--user", "disable", "--now", UNIT]); else stop(); } catch {}
      if (existsSync(file)) unlinkSync(file); if (linux) try { exec("systemctl", ["--user", "daemon-reload"]); } catch {}
      if (lstatSync(current, { throwIfNoEntry: false })) unlinkSync(current);
      rmSync(release, { recursive: true, force: true });
      throw error;
    }
    console.log("Coordinator service installed and running"); return;
  }
  installed();
  if (action === "start") { await start(); console.log("Coordinator service started"); return; }
  if (action === "stop") { stop(); console.log("Coordinator service stopped"); return; }
  if (action === "status") { if (linux) exec("systemctl", ["--user", "status", UNIT, "--no-pager"], true); else exec("launchctl", ["print", `${domain}/${LABEL}`], true); return; }
  if (action === "logs") { if (linux) exec("journalctl", ["--user", "-u", UNIT, "-n", "100", "--no-pager", "-o", "cat"], true); else process.stdout.write(readFileSync(join(HOME_DIR, "coordinator", "service.log"), "utf8")); return; }
  if (action === "update" || action === "rollback") return (await import("./local-release")).updateRelease(action, start, stop, source, runtime);
  throw new Error("usage: noop cloud service install | start | stop | status | logs | update | rollback");
}
