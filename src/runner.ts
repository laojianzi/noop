// Builds the prompt for an agent, runs Claude Code / Codex headless, parses the structured result.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Cfg, HOME_DIR, L, P, ROOT, agentActivity, agentName, precedents, readAll, readIf, readTail, recentJournal, signature,
} from "./core";
import { claudeDisallowed } from "./gates";
import { channelPrompt } from "./channels";
import { claudeMcpConfig, codexMcpLaunch, mcpServers, usableMcp, withOAuth } from "../app/mcp-servers";
import { sharedSecrets } from "./secrets";
import { tryInternalExecutors } from "./accounts";
import type { Executor } from "../app/executor-choices";

export type Result = {
  status: "done" | "needs_decision" | "failed" | "delegated" | "waiting";
  wait_minutes?: number;
  waiting_on?: string;
  wait_check?: string;
  wait_kind?: "human" | "ci";
  summary: string;
  question?: string;
  options?: string[];
  recommendation?: string;
  lessons?: string[];
  attachments?: string[];
  channels?: unknown[];
  followups?: { title: string; body?: string; agent?: string; priority?: string; repo?: string; requires?: string; host?: string }[];
};

export type RunLimits = {
  totalMinutes: number;
  workMinutes: number;
  checkpointMinutes: number;
  checkpointAt: string;
  hardAt: string;
};

export function runLimits(cfg: Cfg, started = Date.now()): RunLimits {
  const totalMinutes = Math.max(1, Number(cfg.clis?.timeout_minutes) || 60);
  const configured = Number(cfg.clis?.checkpoint_minutes);
  const requested = Number.isFinite(configured) ? Math.max(0, configured) : (totalMinutes >= 30 ? 10 : 0);
  const checkpointMinutes = Math.min(Math.max(0, totalMinutes - 5), requested);
  const workMinutes = totalMinutes - checkpointMinutes;
  return {
    totalMinutes, workMinutes, checkpointMinutes,
    checkpointAt: new Date(started + workMinutes * 60_000).toISOString(),
    hardAt: new Date(started + totalMinutes * 60_000).toISOString(),
  };
}

export function deadlinePrompt(limits: RunLimits): string {
  const reserve = limits.checkpointMinutes
    ? `The final ${limits.checkpointMinutes} minutes are reserved for emergency checkpoint recovery; the process is stopped at ${limits.hardAt}.`
    : `The process is stopped at ${limits.hardAt}.`;
  return `The task has a ${limits.totalMinutes}-minute hard limit. Finish normally or return a structured result before ${limits.checkpointAt}.
If work may outlive that checkpoint deadline, save durable progress first, then return \`waiting\` with a quick read-only \`wait_check\` whose exit code changes when the wait is over. ${reserve}`;
}

const RESULT_SPEC = () => `Finish the work, then end your final reply with EXACTLY one fenced \`\`\`json block:
{
  "status": "done" | "needs_decision" | "failed" | "delegated" | "waiting",   // delegated = you split the work into followups and want to be woken up to consolidate when they finish; waiting = see below
  "waiting_on": "waiting only: what you wait for and how to check it, e.g. CI run https://github.com/o/r/actions/runs/123 (gh run view 123)",
  "wait_kind": "waiting only: human when it waits on a person (the owner merging, publishing, answering) — then it wakes only on an event, never on a timer; ci for machines (CI, deploys)",
  "wait_minutes": 15,   // waiting only: latest time to wake you to check again (5-120)
  "wait_check": "waiting only: a quick read-only shell command whose exit code changes when the wait is over, e.g. gh pr checks 123 -R o/r (exits 8 while pending); the daemon runs it every few minutes and wakes you as soon as it changes",
  "summary": "1-3 sentences: what you did / found (links to PRs, commits, files). For needs_decision this is all the owner reads before choosing: say what the PR / change does and what is at stake, the facts they need to choose (not why it needs them, they know)",
  "question": "needs_decision only: one short sentence (under 30 characters) naming what to decide, e.g. Merge gpui-fast #97 now?; name PRs/issues with their full URL in summary and options",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "lessons": ["durable lesson for your own memory (optional)"],
  "attachments": ["/abs/path/screenshot.png", "/abs/path/recording.mp4", "/abs/path/report.md"],   // optional: shown to the owner with the message; a long report goes as a .md file the owner opens in the chat, never as "see file"
  "channels": ["existing-slug", {"name": "New topic", "goal": "what it is for"}],   // see # Channels; [] when none fits
  "followups": [{"title": "...", "body": "...", "agent": "<agent id>", "priority": "normal", "difficulty": "hard if it needs deep engineering/design work", "requires": "os:macos when it needs macOS/iOS/Xcode (os:windows for Windows); omit otherwise"}]
}
Write summary, question and options in the owner's language (${L("English", "Simplified Chinese")} unless the owner writes otherwise), plain text, no emoji; keep identifiers, links and code as they are.
Only use needs_decision after doing all preparation that does not depend on the answer.
Never sit idle waiting on something slow (GitHub Actions/CI, a release, a review, a deploy): if the next step needs it, return "waiting" with waiting_on, wait_minutes and wait_check. If the PR's workflow runs are held for "Approve and run" (gh run list shows status waiting / action_required, gh pr checks shows nothing), CI will never start by itself: return wait_kind "human" and say in waiting_on that the owner must approve the run, with the PR link.
Before returning "waiting", do every part of the task that does not depend on the condition (other platforms, docs, tests, screenshots, the next PR): implement and let CI verify rather than wait for a host. Waiting on another PR to merge is not a reason to stop: build on its branch or merge it locally, and note the dependency.
The machine then runs other work and wakes you later with your notes; check the condition first, then continue from where you left off.`;

export function buildPrompt(meta: Record<string, string>, body: string, cfg: Cfg, resourceNote = "", limits = runLimits(cfg)): string {
  const agent = meta.agent || "lead";
  const host = meta.claimed_by || "?";
  return `You are **${agentName(agent)}**, a permanent member of ${cfg.owner?.name ?? "the owner"}'s AI agent fleet, running headless on host \`${host}\`.
The fleet coordinates through the shared hub folder at ${ROOT} (tasks/, journal/, decisions/, agents/). Read it when you need context; you do not message other agents — you leave traces (commits in project repos, journal lines, follow-up tasks) that they pick up.
The hub folder is not a git repository: files you write there (reports/, memory) are synced to the cloud by the daemon after your run. Never git add/commit them, and never report a task as failed because the hub has no git metadata.

# Your profile
${readTail(P("agents", agent, "profile.md"))}

# Your memory
${readTail(P("agents", agent, "memory.md"), 8000) || "(empty)"}

# Fleet-wide policy
${readAll(P("policies"))}

# Owner profile & principles
${readAll(P("memory"))}

# Owner decision precedents (follow them; never re-ask a decided question)
${precedents(25) || "(none yet)"}

# Recent fleet journal
${recentJournal() || "(empty)"}

# Fleet roster (for follow-up routing)
${rosterLine()}

# External signature (MANDATORY)
Anything you post outside the hub — GitHub PR/issue/review comments, PR descriptions, Slack, Discord, email, OKR entries — must end with this exact line, after a blank line:
${signature(agent, host, cfg)}
Git commits you create must carry the trailer:  Agent: ${agent}
Outside the hub you are Noop: never use your agent name (${agentName(agent)}) or any other agent's name in GitHub text, commits or messages.

# Resource budget
${resourceNote}

# Run deadline
${deadlinePrompt(limits)}

${channelPrompt()}

# Task ${meta.id}: ${meta.title}
Working directory: ${meta.repo || ROOT}   Scratch space (checkouts, worktrees, build targets): ~/.agent-hub/work — never inside the hub folder ${ROOT}, which syncs to the cloud   Host capabilities: ${meta.host_caps ?? ""}
Priority: ${meta.priority}   Source: ${meta.source}

${body}

${RESULT_SPEC()}`;
}

function rosterLine(): string {
  return readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => {
      const prof = readIf(P("agents", d.name, "profile.md"), 100000);
      const first = prof.split("\n").find((l) => l.startsWith("# ")) ?? d.name;
      return `- \`${d.name}\` ${agentName(d.name)}: ${first.replace(/^# /, "")}`;
    }).join("\n");
}

/** workspace-write only covers the cwd and /tmp; agents also need project checkouts, scratch, the hub, its feed
 *  (where `noop notify` appends) and cargo's caches.
 *  `workDirs` is the owner's `[resources].work_dirs`: wherever they keep their repos, not only the default `~/work`. */
export function codexWritableDirs(home = homedir(), workDirs: string[] = [], root = ROOT): string[] {
  const configured = workDirs.map((d) => d.replace(/^~/, home));
  const dirs = [join(home, "work"), join(home, ".noop", "work"), join(home, ".agent-hub", "work"), root, join(root, "..", "feed"), join(home, ".cargo"), ...configured];
  const real = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  return [...new Set(real)];
}

/** The owner's shared MCP servers (Settings → MCP) this machine can run: enabled, with every variable they name set
 *  (by the team's shared keys or this machine's environment). */
export function sharedMcp(cfg: Cfg, env: Record<string, string | undefined> = process.env) {
  return usableMcp(withOAuth(mcpServers((cfg as { mcp_servers?: unknown }).mcp_servers), env), env).use;
}

export function reasoningEffortOptions(cli: Executor, effort?: string, claudeSettings?: Record<string, unknown>):
  { args: string[]; env: Record<string, string> } {
  const explicit = effort !== undefined && effort !== "default";
  if (cli === "codex") return { args: explicit ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : [], env: {} };
  const env: Record<string, string> = explicit ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {};
  // Claude loads account and project env settings after spawn.
  const settings = explicit ? { ...claudeSettings, env } : claudeSettings;
  return { args: settings ? ["--settings", JSON.stringify(settings)] : [], env };
}

/** `mcpArgs`: the MCP flags of this run (see `mcpLaunch`); none when left out (status views, model lookups). */
export function cliCommand(cli: string, cfg: Cfg, gateOverride = false, mcpArgs: string[] = []): string[] {
  const c = cfg.clis?.[cli] ?? {};
  if (Array.isArray(c.command)) return c.command;
  if (cli === "claude") {
    const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", c.permission_mode ?? "bypassPermissions"];
    cmd.push("--model", c.model ?? "claude-opus-5-5");
    // the agent signature is the only attribution; drop Claude Code's own "Generated with" / co-author lines
    cmd.push(...reasoningEffortOptions("claude", c.reasoning_effort, { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false }).args);
    const deny = claudeDisallowed(cfg, gateOverride);
    if (deny.length) cmd.push("--disallowedTools", ...deny);
    cmd.push(...mcpArgs);
    return cmd;
  }
  if (cli === "codex") {
    // non-interactive: workspace-write sandbox with network, never ask for approval
    const cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"];
    for (const dir of codexWritableDirs(homedir(), cfg.resources?.work_dirs)) cmd.push("--add-dir", dir);
    if (c.model) cmd.push("-m", c.model);
    cmd.push(...reasoningEffortOptions("codex", c.reasoning_effort).args, ...mcpArgs);
    return [...cmd, "-"];
  }
  throw new Error(`unknown cli ${cli}`);
}

/** The model a CLI is started with: an explicit `--model`/`-m`, else Codex's own config default. */
export function startModel(cli: string, cmd: string[], codexHome?: string): string | undefined {
  codexHome ??= process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const i = cmd.findIndex((c) => c === "--model" || c === "-m");
  if (i >= 0 && cmd[i + 1]) return cmd[i + 1];
  if (cli === "codex") return readIf(join(codexHome, "config.toml"), 100000).match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  return undefined;
}

/** Running agent processes by task id (so the owner can cancel one). */
export const agentProcs = new Map<string, { kill: (sig?: number | NodeJS.Signals) => void }>();

/** One line saying what a tool call does ("gh pr checks 814 -R longbridge/nsh", "读 src/cli.ts"), for "最近在做". */
function toolStep(name: string, input: any): string {
  const i = input ?? {};
  const v = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || "";
  return `${name}${v ? ` · ${String(v).split("\n")[0].slice(0, 120)}` : ""}`;
}

/** One stream-json line as it goes into the run log: base64 images (a Read of a screenshot carries each one twice,
 * in `source.data` and `tool_use_result.file.base64`) become a short placeholder. Any other line is returned as is. */
export function stripImages(line: string): string {
  if (!line.includes('"base64"')) return line;
  let e: any;
  try { e = JSON.parse(line); } catch { return line; }
  let hit = false;
  const note = (b64: string, type: unknown) => { hit = true; return `[${type ?? "image"}, ${Math.floor(b64.length * 3 / 4)} bytes omitted]`; };
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    if (o.type === "base64" && typeof o.data === "string") o.data = note(o.data, o.media_type);
    if (typeof o.base64 === "string") o.base64 = note(o.base64, o.type);
    for (const v of Object.values(o)) walk(v);
  };
  walk(e);
  return hit ? JSON.stringify(e) : line;
}

/** A run that died before reaching the provider — no tokens spent, no tool ran, so it is safe to spawn again. */
const UNREACHABLE = /Can't reach the API server|connection_failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo/i;

/** Marker for a quiet process that should use the bounded stall-retry path. */
export const STALLED = "\n[stalled]";
/** Marker for a process stopped at its work deadline so the caller can run checkpoint recovery. */
export const RUN_LIMIT = "\n[run-limit]";

/** The MCP flags and environment of one run. Keys (shared ones from the team, or this machine's own variables) never
 *  go on the command line: Claude reads a private 0600 file that is removed when the run ends, Codex gets them in its
 *  environment through its env indirections. */
export async function mcpLaunch(cli: string, cfg: Cfg, secrets?: Record<string, string>): Promise<{ args: string[]; env: Record<string, string>; file?: string }> {
  if (Array.isArray(cfg.clis?.[cli]?.command)) return { args: [], env: {} };
  const env = { ...process.env, ...(secrets ?? await sharedSecrets(cfg)) };
  const list = sharedMcp(cfg, env);
  if (!list.length) return { args: [], env: {} };
  if (cli === "codex") return codexMcpLaunch(list, env);
  const dir = join(HOME_DIR, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a file left by a daemon that died mid-run: older than any run can last
  for (const f of readdirSync(dir)) try { const p = join(dir, f); if (Date.now() - statSync(p).mtimeMs > 86_400_000) rmSync(p, { force: true }); } catch {}
  const file = join(dir, `mcp-${crypto.randomUUID()}.json`);
  writeFileSync(file, claudeMcpConfig(list, env), { mode: 0o600 });
  return { args: ["--mcp-config", file], env: {}, file };
}

/** `retryEmpty` is internal: an empty completion gets exactly one rerun (see the end of the function). */
export async function runAgent(cli: string, prompt: string, cwd: string, cfg: Cfg, logFile: string, gateOverride = false,
  extraEnv: Record<string, string> = {}, retryEmpty = true): Promise<string> {
  const mcp = await mcpLaunch(cli, cfg).catch(() => ({ args: [] as string[], env: {} as Record<string, string>, file: undefined }));
  const cmd = cliCommand(cli, cfg, gateOverride, mcp.args);
  const claude = cfg.clis?.claude;
  const effortEnv = cli === "claude" && !Array.isArray(claude?.command)
    ? reasoningEffortOptions("claude", claude?.reasoning_effort).env : {};
  const timeoutMs = (cfg.clis?.timeout_minutes ?? 60) * 60_000;
  const stallMs = (cfg.clis?.stall_minutes ?? 20) * 60_000;
  const dir = cwd.replace(/^~/, homedir());
  // before the spawn: a throw after it would leave the agent running with no timeout, stall watch or drained pipes
  mkdirSync(P("logs", "runs"), { recursive: true });
  const proc = Bun.spawn(cmd, {
    cwd: existsSync(dir) ? dir : ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe",
    // Claude -p stops background subagents 10 min after the last turn; our own run limit bounds the run instead
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...mcp.env, ...extraEnv, ...effortEnv, HUB_DATA: ROOT },
  });
  if (mcp.file) void proc.exited.finally(() => { try { rmSync(mcp.file!, { force: true }); } catch {} });
  const tid = logFile.split("/").pop()!.match(/^([A-Z]-[\w]*?\d{4})-\d{10,}/)?.[1];
  if (tid) agentProcs.set(tid, proc);
  void proc.exited.then(() => { if (tid && agentProcs.get(tid) === proc) agentProcs.delete(tid); });

  // what the agent is doing: every chunk of output is a sign of life; Claude's stream also names each step
  const json = cmd.includes("stream-json");
  const act = { at: Date.now(), step: undefined as string | undefined, steps: 0, model: startModel(cli, cmd, extraEnv.CODEX_HOME) };
  const inFlight = new Map<string, string>(); // tool_use id → tool name, until its result comes back
  let resultText: string | undefined, assistantText = "";
  const touch = () => {
    act.at = Date.now();
    if (tid) agentActivity.set(tid, { at: new Date(act.at).toISOString(), step: act.step, steps: act.steps, model: act.model });
  };
  touch();
  const onLine = (line: string) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "system" && e.subtype === "init" && e.model) act.model = String(e.model);
    if (e.type === "assistant") {
      if (e.message?.model && !e.parent_tool_use_id) act.model = String(e.message.model);
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") { inFlight.set(c.id, c.name); act.step = toolStep(c.name, c.input); act.steps++; }
        else if (c.type === "text" && !e.parent_tool_use_id) assistantText += c.text;
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) if (c.type === "tool_result") inFlight.delete(c.tool_use_id);
    } else if (e.type === "result") {
      // a background task finishing starts another turn with its own result, so keep every turn's text: the real report
      // may be followed by "that notification changes nothing"
      const text = typeof e.result === "string" ? e.result : "";
      resultText = resultText === undefined ? text : `${resultText}\n\n${text}`;
    }
  };
  // the log exists from the start and grows with stdout, so a long or killed run still leaves its transcript;
  // a failed write only loses that early copy, the full log is written again at exit
  const logPart = (s: string, append = true) => {
    try { (append ? appendFileSync : writeFileSync)(logFile, s); } catch {}
  };
  logPart(`$ ${cmd.join(" ")}\n\n`, false);
  const read = async (stream: ReadableStream<Uint8Array>, lines: boolean, log = false) => {
    const dec = new TextDecoder();
    let all = "", buf = "";
    for await (const chunk of stream) {
      const t = dec.decode(chunk, { stream: true });
      all += t;
      if (lines) {
        buf += t;
        const parts = buf.split("\n");
        buf = parts.pop()!;
        parts.forEach(onLine);
        if (log && parts.length) logPart(parts.map(stripImages).join("\n") + "\n");
      } else if (log) logPart(t);
      touch();
    }
    if (lines && buf) onLine(buf);
    return all;
  };

  let stalled = false, timedOut = false;
  // A work deadline is a checkpoint signal, not a quiet-process stall: the caller gets the reserved recovery window.
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  // a run that has gone quiet: no output at all, and nothing slow in flight (a sub-agent may work quietly for long)
  const watch = setInterval(() => {
    const slow = [...inFlight.values()].some((n) => /^(Task|Agent)$/.test(n));
    if (!slow && Date.now() - act.at > stallMs) { stalled = true; proc.kill(); }
  }, 30_000);
  const [raw, err] = await Promise.all([read(proc.stdout, json, true), read(proc.stderr, false)]);
  const code = await proc.exited;
  clearTimeout(timer);
  clearInterval(watch);
  if (tid) agentActivity.delete(tid);
  const logged = json ? raw.split("\n").map(stripImages).join("\n") : raw;
  writeFileSync(logFile, `$ ${cmd.join(" ")}\n(exit ${code})\n\n${logged}\n\n[stderr]\n${err}`);
  const out = json ? (resultText ?? assistantText) : raw;
  if (timedOut) return `${out}${RUN_LIMIT} hit the ${Math.round(timeoutMs / 60_000)}-minute work limit${act.step ? `; last step: ${act.step}` : ""}`;
  if (stalled) return `${out}${STALLED} no output for ${Math.round(stallMs / 60_000)} minutes${act.step ? `; last step: ${act.step}` : ""}`;
  // A provider occasionally answers with an empty completion (no text, no tool call, exit 0) and Claude Code's own
  // "no visible output" retry gets nothing either. That is a flake of the tool chain, not the task failing: rerun the
  // same prompt once, and never hand the empty run back to the caller as the task's result.
  // Do not retry when the run already used a tool or printed visible assistant text: an empty final result can still
  // sit on top of side effects (a posted comment, a commit), and replaying the prompt would repeat them. `out` is only
  // the final/assistant text, so also require act.steps === 0 and no accumulated assistantText.
  // The same holds for a run that never reached the provider: a DNS or connection failure kills every task running at
  // that moment, and the CLI exits non-zero having burnt no tokens and touched nothing, so replaying is free of side
  // effects. The second spawn re-resolves DNS and walks the CLI's own connect retries again.
  const nothingRan = !act.steps && !assistantText.trim();
  const unreachable = nothingRan && !!code && UNREACHABLE.test(`${out}\n${err}`);
  if (retryEmpty && nothingRan && (unreachable || (!out.trim() && !code))) {
    const first = readFileSync(logFile, "utf8");
    const again = await runAgent(cli, prompt, cwd, cfg, logFile, gateOverride, extraEnv, false);
    const why = unreachable ? "an unreachable API" : "an empty response";
    writeFileSync(logFile, `${first}\n\n[retried after ${why}]\n${readFileSync(logFile, "utf8")}`); // keep both attempts
    return again;
  }
  return out + (code ? `\n[exit ${code}] ${err.slice(-2000)}` : "");
}

export function parseResult(out: string): Result {
  const blocks = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    for (const text of [b, repairJson(b)]) {
      const r = parsed(text);
      if (r) return r;
    }
  }
  // codex (and others) sometimes end the reply with a bare JSON object instead of a fenced block
  const bare = out.match(/\{[\s\S]*\}/);
  if (bare) {
    const r = parsed(bare[0]) ?? parsed(repairJson(bare[0]));
    if (r) return r;
  }
  return { status: "failed", summary: `agent returned no result block. tail: ${out.slice(-300)}` };
}

function parsed(text: string): Result | null {
  try {
    const r = JSON.parse(text);
    return r?.status ? r : null;
  } catch { return null; }
}

/** Models occasionally put a literal line break, a bare `"` or a lone backslash inside a JSON string. Keep the text, make the block parseable.
 * A `"` inside a string is a stray quote unless the next non-space character can follow a value (`:`, `,`, `}`, `]`, end). */
function repairJson(json: string): string {
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (escaped) { out += c; escaped = false; continue; }
    if (c === "\\") {
      // a lone backslash, e.g. a Windows path like `D:\`, is not a JSON escape: keep it as a literal backslash
      if (inString && !/["\\/bfnrtu]/.test(json[i + 1] ?? "")) { out += "\\\\"; continue; }
      out += c; escaped = true; continue;
    }
    if (c === '"') {
      if (!inString) { inString = true; out += c; continue; }
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      const next = json[j] ?? "";
      if (next === "" || next === "," || next === ":" || next === "}" || next === "]") { inString = false; out += c; }
      else out += '\\"';
      continue;
    }
    if (inString && c === "\n") out += "\\n";
    else if (inString && c === "\r") out += "\\r";
    else if (inString && c === "\t") out += "\\t";
    else out += c;
  }
  return out;
}

/** The models that route each owner message, fastest first: a choice made within seconds, not a judgement.
 * `[router] cli/model` in config.toml puts one first; the others are fallbacks when its CLI is missing or fails. */
const ROUTERS = [{ cli: "claude", model: "claude-haiku-5-5" }, { cli: "codex", model: "gpt-6-luna" }];

export function codexReadOnlyArgs(cwd: string, env: Record<string, string> = {}): string[] {
  const home = env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const config = join(home, "config.toml");
  const parsed = Bun.TOML.parse(existsSync(config) ? readFileSync(config, "utf8") : "") as {
    profile?: string;
    mcp_servers?: Record<string, unknown>;
    profiles?: Record<string, { mcp_servers?: Record<string, unknown> }>;
  };
  const profile = parsed.profile ? parsed.profiles?.[parsed.profile] : undefined;
  // Codex merges the server table with lower layers. An empty override leaves their servers enabled.
  const servers = Object.keys({ ...parsed.mcp_servers, ...profile?.mcp_servers });
  const disabled = servers.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",");
  // Stop project discovery at this directory, and also exclude its own project configuration.
  const project = JSON.stringify(realpathSync(cwd));
  return ["--sandbox", "read-only",
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins", "--disable", "multi_agent_v2",
    "-c", "project_root_markers=[]", "-c", `projects={${project}={trust_level="untrusted"}}`,
    "-c", 'web_search="disabled"', "-c", `mcp_servers={${disabled}}`];
}

export function internalModel(cfg: Cfg, role: "router" | "judge", cli: Executor): string | undefined {
  const entry = cfg[role];
  return ((entry?.cli ?? "claude") === cli ? entry?.model : undefined) ?? cfg.clis?.[cli]?.model;
}

export async function runInternalProcess(cmd: string[], prompt: string, cwd: string, timeout: number, env: Record<string, string> = {}) {
  let proc;
  try {
    proc = Bun.spawn(cmd, { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  } catch (error) {
    return { out: "", err: String(error), code: 127, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeout);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export function internalStream(out: string, cli: Executor) {
  let reply = "", completed = false, usedTools = false;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { usedTools = true; continue; }
    if (!event || typeof event !== "object") { usedTools = true; continue; }
    if (cli === "codex") {
      if (event.type === "turn.completed") completed = true;
      if (event.type !== "item.started" && event.type !== "item.completed") continue;
      const item = event.item;
      if (item?.type === "agent_message") {
        if (event.type === "item.completed" && typeof item.text === "string") reply = item.text;
      } else if (item?.type !== "reasoning" && item?.type !== "error") usedTools = true;
    } else {
      if (event.type === "result" && !event.is_error) { completed = true; reply = String(event.result ?? ""); }
      if ((event.type === "assistant" || event.type === "user") &&
        event.message?.content?.some((item: { type: string }) => item.type === "tool_use" || item.type === "tool_result")) usedTools = true;
    }
  }
  return { reply, completed, usedTools };
}

async function askStructured(role: "router" | "judge", prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const explicit = !!cfg.clis?.internal;
  const routing = role === "router";
  const timeout = routing ? (cfg.router?.timeout_seconds ?? 45) * 1000 : (cfg.judge?.timeout_minutes ?? 10) * 60_000;
  const attempt = async (cli: string, model?: string, env?: Record<string, string>) => {
    let codexArgs: string[] = [];
    if (explicit && cli === "codex") {
      try { codexArgs = codexReadOnlyArgs(ROOT, env); }
      catch (error) { console.error(`Codex ${role} configuration:`, error); return; }
    } else if (routing && cli !== "claude") {
      codexArgs = ["--sandbox", "read-only"];
    }
    const executor = cli === "claude" ? "claude" : "codex";
    const defaultEffort = routing && executor === "codex" ? "low" : cfg.clis?.[executor]?.reasoning_effort;
    const effort = reasoningEffortOptions(executor, cfg[role]?.reasoning_effort ?? defaultEffort);
    const cmd = cli === "claude"
      ? ["claude", "-p", "--output-format", "text", "--tools", "", ...(routing || explicit ? ["--strict-mcp-config"] : []),
        ...(routing ? (model ? ["--model", model] : []) : ["--model", model ?? "claude-opus-5-5"]), ...effort.args]
      : ["codex", "exec", "--skip-git-repo-check", ...codexArgs, ...(model ? ["-m", model] : []),
        ...effort.args, "-"];
    const { out, code } = await runInternalProcess(cmd, prompt, ROOT, timeout, { ...env, ...effort.env });
    mkdirSync(P("logs", "runs"), { recursive: true });
    if (explicit) appendFileSync(logFile, `${cli} ${model ?? ""} (exit ${code})\n${out}\n`);
    else writeFileSync(logFile, routing ? `${cli} ${model}\n${out}` : out);
    if (explicit && code) return;
    const payload = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
    if (payload) try { return JSON.parse(payload[1]); } catch {}
  };
  if (explicit) return await tryInternalExecutors(cfg, (cli, env) => attempt(cli, internalModel(cfg, role, cli), env)) ?? null;
  if (!routing) {
    const cli = cfg.judge?.cli ?? "claude";
    return await attempt(cli, cli === "claude" ? cfg.judge?.model : undefined) ?? null;
  }
  const own = cfg.router?.cli ? [{ cli: String(cfg.router.cli), model: String(cfg.router.model ?? "") }] : [];
  for (const r of [...own, ...ROUTERS.filter((x) => x.cli !== own[0]?.cli)]) {
    if (!Bun.which(r.cli)) continue;
    const answer = await attempt(r.cli, r.model);
    if (answer !== undefined) return answer;
  }
  return null;
}

export const quickAsk = (prompt: string, cfg: Cfg, logFile: string) => askStructured("router", prompt, cfg, logFile);
export const ask = (prompt: string, cfg: Cfg, logFile: string) => askStructured("judge", prompt, cfg, logFile);
