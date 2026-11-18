import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  workerd: { type: "string" }, output: { type: "string" }, "web-commit": { type: "string" },
} });
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Linux x86_64 or ARM64 is required");
if (!values.workerd || !values.output || !values["web-commit"]) throw new Error("usage: bun scripts/package-local-coordinator.ts --workerd <file> --output <directory> --web-commit <commit>");
const source = resolve(import.meta.dir, ".."), runtime = resolve(values.workerd), output = resolve(values.output);
const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const revision = git(["rev-parse", "HEAD"]);
if (values["web-commit"] !== revision) throw new Error("Web source commit does not match the coordinator source commit");
const paths = ["src", "cloud", "app", "templates", "presets", "package.json", "bunfig.toml", "tsconfig.json"];
if (git(["status", "--porcelain", "--untracked-files=all", "--", ...paths])) throw new Error("Coordinator source has uncommitted changes");
const temporary = mkdtempSync(join(tmpdir(), "noop-package-"));
process.env.NOOP_HOME = join(temporary, "home");
try {
  const { WORKERD_DATE, WORKERD_SHA256 } = await import("../src/local-coordinator");
  const digest = async (path: string) => {
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    return hash.digest("hex");
  };
  const runtimeHash = await digest(runtime);
  if (runtimeHash !== WORKERD_SHA256[`linux-${process.arch}`]) throw new Error("workerd checksum does not match the pinned runtime for this architecture");
  const version = spawnSync(runtime, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== `workerd ${WORKERD_DATE}`) throw new Error("workerd version does not match the pinned runtime");
  const { stageRelease } = await import("../src/local-release");
  const release = stageRelease(source, runtime);
  const manifest = { sourceCommit: revision, webSourceCommit: values["web-commit"], platform: "linux", arch: process.arch,
    workerdVersion: WORKERD_DATE, workerdSha256: runtimeHash, bunVersion: Bun.version,
    webIndexSha256: await digest(join(release, "repo", "app", "dist", "web", "noop", "index.html")) };
  writeFileSync(join(release, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  mkdirSync(output, { recursive: true });
  const arch = process.arch === "x64" ? "x86_64" : "arm64";
  const name = `noop-coordinator-linux-${arch}-${revision.slice(0, 12)}.tar.gz`, archive = join(output, name);
  if (existsSync(archive) || existsSync(`${archive}.sha256`)) throw new Error(`The coordinator archive already exists: ${archive}`);
  const partial = join(output, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    const tar = spawnSync("tar", ["-czf", partial, "-C", release, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Could not create the coordinator archive: ${tar.stderr}`);
    const checksum = await digest(partial);
    renameSync(partial, archive);
    try { writeFileSync(`${archive}.sha256`, `${checksum}  ${name}\n`, { flag: "wx" }); }
    catch (error) { rmSync(archive, { force: true }); throw error; }
  } finally { rmSync(partial, { force: true }); }
  console.log(`Coordinator archive: ${archive}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
