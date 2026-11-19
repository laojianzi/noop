import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const [cli, ...args] = Bun.argv.slice(2);
const dir = process.env.NOOP_EXECUTOR_FIXTURE!;
const accountDir = cli === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
const account = accountDir ? basename(accountDir) : "default";
const modelIndex = args.findIndex(arg => arg === "--model" || arg === "-m");
const record = (stage: string, task?: string) => appendFileSync(join(dir, "calls.jsonl"),
  JSON.stringify({ cli, account, stage, task, model: modelIndex < 0 ? undefined : args[modelIndex + 1], pid: process.pid }) + "\n");
const fault = (stage: string) => {
  if (!existsSync(join(dir, cli + "-" + stage + ".fault"))) return;
  console.error("not logged in");
  process.exit(1);
};
const message = (turn: string) => turn.split("The owner's message:\n").at(-1) ?? "";
const answer = (input: string) => {
  if (message(input).includes("HOLD CONVERSATION")) record("held");
  if (input.startsWith("Tool results:")) return { calls: [], reply: "Fixture used task data" };
  if (message(input).includes("Read a task first")) return { calls: [{ tool: "list_tasks", args: {} }], reply: "" };
  if (message(input).includes("Create fixture task")) return { calls: [{ tool: "create_task", args: { title: "Created exactly once" } }], reply: "Creating one task" };
  return { calls: [], reply: cli + " fixture reply" };
};

if (cli === "codex" && process.env.NOOP_E2E_REAL_CODEX) {
  if (args[0] !== "exec") process.exit(2);
  const stage = args.includes("--ephemeral") ? "chat" : "exec";
  record(stage);
  const started = Date.now();
  const proc = Bun.spawn([process.env.NOOP_E2E_REAL_CODEX, "exec", "-c", 'model_reasoning_effort="low"', ...args.slice(1)],
    { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  process.stdout.write(out);
  const code = await proc.exited;
  const events = stage === "chat" ? out.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }) : [];
  const usage = events.find(e => e.type === "turn.completed")?.usage;
  const tools = events.filter(e => e.type === "item.completed" && /command_execution|mcp_tool_call|file_change|web_search|collab_tool_call/.test(e.item?.type ?? "")).map(e => e.item.type);
  appendFileSync(join(dir, "real-codex.jsonl"), JSON.stringify({ stage, code, elapsedMs: Date.now() - started, usage, tools }) + "\n");
  process.exit(code);
}
if (args.includes("setup-token") || args[0] === "login") {
  record("login");
  process.exit(1);
}
if (args.includes("--input-format")) {
  if (cli !== "claude") { record("wrong-protocol"); process.exit(1); }
  record("warm");
  for await (const line of createInterface({ input: process.stdin })) {
    const turn = JSON.parse(line).message.content;
    record("chat");
    fault("chat");
    const result = answer(turn);
    while (message(turn).includes("HOLD CONVERSATION") && !existsSync(join(dir, "release-chat"))) await Bun.sleep(100);
    console.log(JSON.stringify({ type: "result", result: JSON.stringify(result) }));
  }
  process.exit();
}
const input = await Bun.stdin.text();
if (args.includes("--ephemeral")) {
  record("chat");
  if (existsSync(join(dir, "codex-chat-tool.fault"))) {
    console.log('{"type":"item.started","item":{"type":"command_execution"}}');
    process.exit(1);
  }
  fault("chat");
  const data = input.split("Conversation turns (JSON):\n").at(-1)!.split("\nRespond to the last user turn.")[0]!;
  const turn = (JSON.parse(data).at(-1) as { content: string }).content;
  const result = answer(turn);
  while (message(turn).includes("HOLD CONVERSATION") && !existsSync(join(dir, "release-chat"))) await Bun.sleep(100);
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } }));
  process.exit();
}
if (input.includes("You place tasks for an AI agent fleet")) {
  record("plan");
  fault("plan");
  const tasks = Object.fromEntries(Array.from(input.matchAll(/^\- (T-\d+) \[agent /gm), ([, id]) => [id, { cli: "claude" }]));
  console.log(JSON.stringify(tasks));
  process.exit();
}
if (input.startsWith("You are the owner's JUDGE")) {
  record("judge");
  fault("judge");
  console.log('{"verdict":"hold","answer":"A","reason":"fixture hold"}');
  process.exit();
}
if (input.includes('{"fixed": true|false')) {
  record("medic");
  if (existsSync(join(dir, cli + "-medic-write.fault"))) {
    record("medic-write");
    if (args.includes("--json")) console.log('{"type":"item.started","item":{"type":"command_execution"}}');
    console.error("usage limit");
    process.exit(1);
  }
  fault("medic");
  const result = '```json\n{"fixed":true,"summary":"fixture repaired"}\n```';
  if (args.includes("stream-json")) console.log(JSON.stringify({ type: "result", result }));
  else if (args.includes("--json")) {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
    console.log('{"type":"turn.completed"}');
  } else console.log(result);
  process.exit();
}
const task = input.match(/^# Task (T-\d+):/m)?.[1];
if (!task) { record("other"); process.exit(1); }
record("task", task);
const taskFault = join(dir, account + ".fault");
const result = existsSync(taskFault) ? readFileSync(taskFault, "utf8")
  : input.includes("Ask fixture judgement") ? '{"status":"needs_decision","summary":"fixture question","question":"Can we continue?","options":["A: yes","B: no"]}'
  : '{"status":"done","summary":"fixture task completed"}';
console.log(args.includes("stream-json") ? JSON.stringify({ type: "result", result }) : result);
