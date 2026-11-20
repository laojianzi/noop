import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const codexMcpProofFile = "codex-mcp-probe.json";

export function configureCodexProbeProjects(parent: string, cwd: string, markerDir?: string) {
  const git = spawnSync("git", ["init", "-q", "--template=", parent], {
    env: { HOME: parent, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8",
  });
  assert.equal(git.status, 0, git.stderr || String(git.error ?? "git init failed"));
  for (const [dir, name] of [[parent, "parent_probe"], [cwd, "cwd_probe"]]) {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const command = markerDir
      ? `command = "/usr/bin/touch"\nargs = [${JSON.stringify(join(markerDir, name + "-started"))}]\n`
      : 'command = "/usr/bin/true"\n';
    writeFileSync(join(dir, ".codex/config.toml"), `[mcp_servers.${name}]\n${command}`);
  }
  return `projects={${[parent, cwd].map(dir => `${JSON.stringify(realpathSync(dir))}={trust_level="trusted"}`).join(",")}}`;
}

type Server = { name: string; enabled: boolean };
const probeNames = ["noop_probe", "parent_probe", "cwd_probe"];

export function checkCodexMcp(binary: string, launchArgs: string[], projectArgs: string[], proofPath: string, controls: boolean) {
  const overrides: [string, string][] = [];
  for (let i = 0; i < launchArgs.length; i++) {
    const flag = launchArgs[i]!;
    if (flag === "-c" || flag === "--disable") overrides.push([flag, launchArgs[++i]!]);
  }
  const proof: Record<string, Server[]> = {};
  const list = (name: string, omit?: string) => {
    const flags = overrides.filter(([flag, value]) => !omit || flag !== "-c" || !value.startsWith(omit + "="));
    const result = spawnSync(binary, ["mcp", "list", "--json", ...projectArgs, ...flags.flat()], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, `Codex MCP list failed for ${name} (${result.error?.message ?? result.signal ?? result.status})`);
    let servers: Server[];
    try { servers = JSON.parse(result.stdout); }
    catch { throw new Error(`Codex MCP list did not return JSON for ${name}`); }
    assert(Array.isArray(servers), `Codex MCP list did not return an array for ${name}`);
    const probes = servers.filter(s => probeNames.includes(s.name)).map(({ name, enabled }) => {
      assert(typeof enabled === "boolean", "Codex MCP probe must report a boolean enabled flag");
      return { name, enabled };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (controls) {
      proof[name] = probes;
      writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n");
    }
    return probes;
  };

  const parent = controls ? list("withoutProjectRootMarkers", "project_root_markers") : undefined;
  const cwd = controls ? list("withoutCwdTrustOverride", "projects") : undefined;
  const isolated = list("isolated");
  const account = { name: "noop_probe", enabled: false };
  assert.deepEqual(isolated, [account], "actual launch must disable account MCP and exclude both project layers");
  if (controls) {
    assert.deepEqual(parent, [account, { name: "parent_probe", enabled: true }], "removing the root marker override must expose only the parent probe");
    assert.deepEqual(cwd, [{ name: "cwd_probe", enabled: true }, account], "removing the trust override must expose only the cwd probe");
  } else {
    writeFileSync(proofPath, JSON.stringify(isolated) + "\n");
  }
}
