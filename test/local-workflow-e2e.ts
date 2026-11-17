// Validate the delivery dependency graph without creating a GitHub release.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), out = mkdtempSync(join(process.env.NOOP_E2E_OUT || tmpdir(), "noop-workflow-e2e-"));
const checks: string[] = [];
let error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
try {
  const read = (name: string) => Bun.YAML.parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as any;
  const ci = read("ci.yml"), client = read("release.yml"), linux = read("coordinator-linux.yml");
  check(ci.on.includes("push") && ci.on.includes("pull_request") && ci.jobs.test.strategy.matrix.os.includes("ubuntu-latest") &&
    ci.jobs.test.strategy.matrix.os.includes("macos-latest"), "existing Linux and macOS CI retains its triggers and matrix");
  const targets = client.jobs.package.strategy.matrix.include.map((entry: any) => entry.target);
  check(["linux", "windows", "macos", "ios", "android", "web"].every((target) => targets.includes(target)) &&
    client.jobs.publish.needs === "package", "existing client release retains all six targets and waits for its complete matrix");
  const jobs = linux.jobs, packageJob = jobs.package;
  check(["workflow_dispatch", "pull_request", "push"].every((event) => Object.hasOwn(linux.on, event)) && packageJob.needs === "web",
    "the independent coordinator workflow has its own triggers and web dependency");
  const runners = packageJob.strategy.matrix.include.map((entry: any) => entry.os);
  check(runners.includes("ubuntu-24.04") && runners.includes("ubuntu-24.04-arm") && packageJob.strategy["fail-fast"] === false,
    "both native Linux architectures run without cancelling one another");
  const steps = packageJob.steps as any[];
  check(!packageJob["continue-on-error"] && steps.every((step) => !step["continue-on-error"]) &&
    steps.some((step) => String(step.run || "").includes("test/budget.test.ts")) &&
    steps.some((step) => String(step.run || "").includes("test/self-hosted-mcp-e2e.ts")) &&
    steps.some((step) => String(step.run || "").includes("test/local-package-e2e.ts")),
    "Linux delivery requires budget, coordinator and package checks without hidden failures");
  const upload = steps.find((step) => String(step.uses || "").startsWith("actions/upload-artifact@"));
  check(!!upload && !upload.if, "the artifact is uploaded only after earlier Linux steps succeed");
  const needs = Array.isArray(packageJob.needs) ? packageJob.needs : [packageJob.needs];
  const ready = (states: Record<string, string>) => needs.every((job: string) => states[job] === "success") && states.package === "success";
  check(ready({ web: "success", package: "success", macos: "failure", ios: "queued", android: "failure" }),
    "simulated macOS and Android failures and queued iOS do not gate a successful Linux delivery");
  check(!ready({ web: "success", package: "failure", macos: "success" }) && !ready({ web: "failure", package: "success", ios: "success" }),
    "simulated Linux or Web build failure prevents Linux delivery");
  const workflowText = readFileSync(join(root, ".github", "workflows", "coordinator-linux.yml"), "utf8");
  check(!/gh release|latest\.json|releases\/latest|--clobber/.test(workflowText), "coordinator delivery does not write the client release or latest manifest");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  const report = { status: error ? "failed" : "passed", scope: "local workflow graph simulation; not a GitHub Actions execution", checks, error };
  const text = `${JSON.stringify(report, null, 2)}\n`; writeFileSync(join(out, "report.json"), text);
  writeFileSync(join(out, "SHA256SUMS"), `${createHash("sha256").update(text).digest("hex")}  report.json\n`);
  console.log(`Evidence: ${out}`);
}
