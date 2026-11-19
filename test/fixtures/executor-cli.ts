import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const [cli, ...args] = Bun.argv.slice(2);
const dir = process.env.NOOP_EXECUTOR_FIXTURE!;
const accountDir = cli === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
const account = accountDir ? basename(accountDir) : "default";
const record = (stage: string, task?: string) =>
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ cli, account, stage, task }) + "\n");

if (args.includes("setup-token") || args[0] === "login") {
  record("login");
  process.exit(1);
}
if (args.includes("--input-format")) {
  record("warm");
  process.exit(1);
}
const input = await Bun.stdin.text();
if (input.includes("You place tasks for an AI agent fleet")) {
  record("plan");
  const tasks = Object.fromEntries(Array.from(input.matchAll(/^\- (T-\d+) \[agent /gm), ([, id]) => [id, { cli: "claude" }]));
  console.log(JSON.stringify(tasks));
  process.exit();
}
const task = input.match(/^# Task (T-\d+):/m)?.[1];
if (!task) { record("other"); process.exit(1); }
record("task", task);
const fault = join(dir, account + ".fault");
const result = existsSync(fault) ? readFileSync(fault, "utf8") : '{"status":"done","summary":"fixture task completed"}';
console.log(args.includes("stream-json") ? JSON.stringify({ type: "result", result }) : result);
