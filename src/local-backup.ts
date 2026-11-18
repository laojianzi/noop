import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DATA, HOME_DIR } from "./core";
import { hubTomlPath } from "./sync";
import { coordinatorNamespace, lockCoordinator, WORKERD_DATE } from "./local-coordinator";

type Entry = { path: string; size: number; sha256: string };
type Manifest = { format: string; version: number; runtime: string; files: Entry[] };
const FIXED = new Set(["noop.toml", "vapid.json", "coordinator/namespace-key", "coordinator/workerd.capnp", "coordinator/runtime-version", "data/config.toml", "data/config.local.toml", "data/settings.json"]);
const REQUIRED = ["noop.toml", "vapid.json", "coordinator/namespace-key", "coordinator/workerd.capnp"];

async function digest(path: string) {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

export function syncPath(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectories(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) syncDirectories(join(path, entry.name));
  syncPath(path);
}

export async function backupCoordinator(destination: string) {
  const target = resolve(destination), root = join(HOME_DIR, "coordinator"), storage = join(root, "storage");
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error("Backup destination already exists");
  const insideStorage = relative(storage, target);
  if (!insideStorage || (!insideStorage.startsWith("..") && !isAbsolute(insideStorage))) throw new Error("Backup destination cannot be inside coordinator storage");
  if (!existsSync(root) || !existsSync(storage)) throw new Error("Local coordinator data does not exist");
  using lock = lockCoordinator(root);
  if (!existsSync(join(storage, coordinatorNamespace(root)))) throw new Error("Coordinator namespace storage is missing");
  const config = Bun.TOML.parse(readFileSync(hubTomlPath(), "utf8")) as any;
  if (config.cloud?.mode !== "local" || !config.server?.token) throw new Error("Local coordinator configuration or machine token is missing");
  if (!existsSync(dirname(target))) throw new Error("Backup parent directory does not exist");
  const stage = mkdtempSync(join(dirname(target), ".noop-backup-")), files: Entry[] = [];
  try {
    const copy = async (source: string, name: string): Promise<void> => {
      const st = lstatSync(source);
      if (st.isDirectory()) {
        mkdirSync(join(stage, name), { recursive: true, mode: 0o700 });
        for (const child of readdirSync(source).sort()) await copy(join(source, child), `${name}/${child}`);
      } else if (st.isFile()) {
        const file = join(stage, name);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        copyFileSync(source, file); chmodSync(file, 0o600); syncPath(file);
        files.push({ path: name, size: statSync(file).size, sha256: await digest(file) });
      } else throw new Error(`Unsupported backup source: ${name}`);
    };
    for (const [name, source] of [
      ["noop.toml", hubTomlPath()], ["vapid.json", join(HOME_DIR, "vapid.json")],
      ["coordinator/namespace-key", join(root, "namespace-key")], ["coordinator/workerd.capnp", join(root, "workerd.capnp")],
      ["coordinator/runtime-version", join(root, "runtime-version")],
      ["coordinator/storage", storage], ["data/config.toml", join(DATA, "config.toml")],
      ["data/config.local.toml", join(DATA, "config.local.toml")], ["data/settings.json", join(DATA, "settings.json")],
    ]) if (existsSync(source)) await copy(source, name);
    if (REQUIRED.some((name) => !files.some((file) => file.path === name)) || !files.some((file) => file.path.startsWith("coordinator/storage/")))
      throw new Error("Local coordinator backup is missing required data");
    const versionFile = join(root, "runtime-version");
    const manifest: Manifest = { format: "noop-coordinator-backup", version: 1, runtime: existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : WORKERD_DATE, files };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    syncPath(join(stage, "manifest.json")); syncDirectories(stage);
    renameSync(stage, target); syncPath(dirname(target));
    console.log(`Coordinator backup created: ${target}`);
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
}

export async function restoreCoordinator(backup: string, destination = HOME_DIR, candidate = false) {
  if (!candidate && (process.env.HUB_DATA || process.env.HUB_CONF)) throw new Error("Unset HUB_DATA and HUB_CONF when restoring into a new Noop home");
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error("Restore destination already exists; choose a new NOOP_HOME");
  const source = resolve(backup);
  if (!lstatSync(source).isDirectory()) throw new Error("Backup must be a directory");
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "noop-coordinator-backup" || manifest.version !== 1 || (!candidate && manifest.runtime !== WORKERD_DATE) || !Array.isArray(manifest.files))
    throw new Error("Unsupported coordinator backup format or runtime version");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const name = file?.path;
    if (typeof name !== "string" || (!FIXED.has(name) && !name.startsWith("coordinator/storage/")) ||
      name.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")) || seen.has(name) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid backup manifest entry");
    seen.add(name);
  }
  if (REQUIRED.some((name) => !seen.has(name)) || ![...seen].some((name) => name.startsWith("coordinator/storage/")))
    throw new Error("Coordinator backup is missing required data");
  if (!existsSync(dirname(destination))) throw new Error("Restore parent directory does not exist");
  const stage = mkdtempSync(join(dirname(destination), ".noop-restore-"));
  try {
    for (const file of manifest.files) {
      let input = source;
      const parts = file.path.split("/");
      for (const part of parts.slice(0, -1)) { input = join(input, part); if (!lstatSync(input).isDirectory()) throw new Error(`Invalid backup directory: ${file.path}`); }
      input = join(input, parts.at(-1)!);
      const st = lstatSync(input);
      if (!st.isFile() || st.size !== file.size) throw new Error(`Backup integrity check failed: ${file.path}`);
      const output = join(stage, file.path);
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); copyFileSync(input, output); chmodSync(output, 0o600);
      if (await digest(output) !== file.sha256) throw new Error(`Backup integrity check failed: ${file.path}`);
      syncPath(output);
    }
    const root = join(stage, "coordinator");
    if (!existsSync(join(root, "storage", coordinatorNamespace(root)))) throw new Error("Backup namespace storage is missing");
    const config = Bun.TOML.parse(readFileSync(join(stage, "noop.toml"), "utf8")) as any;
    if (config.cloud?.mode !== "local" || !config.server?.token) throw new Error("Backup is missing local coordinator configuration or machine token");
    syncDirectories(stage); renameSync(stage, destination); syncPath(dirname(destination));
    console.log(`Coordinator restored to: ${destination}`);
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); }
}
