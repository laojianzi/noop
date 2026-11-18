import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const stateFile = process.env.NOOP_E2E_RELOGIN_STATE || "";
const out = process.env.NOOP_E2E_VERIFY_OUT || "";
if (!stateFile || !out || process.platform !== "darwin") throw new Error("A disposable macOS relogin state and evidence directory are required");
mkdirSync(out, { recursive: true });
const checks: string[] = [];
let error = "";
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); checks.push(message); console.log(`PASS ${message}`); }
function totp(secret: string, counter: number) {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret) { value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const input = Buffer.alloc(8); input.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(input).digest(), offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
try {
  const { home, repo, bin, base, token, session, secret, peer, task } = JSON.parse(readFileSync(stateFile, "utf8"));
  const env: NodeJS.ProcessEnv = { ...process.env, NOOP_HOME: home, HUB_NO_MEDIC: "1", PATH: `${bin}:${process.env.PATH || ""}` };
  for (const key of ["HUB_CONF", "HUB_DATA", "HUB_SYNC", "HUB_SYNC_FAKE", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const cli = (args: string[], testHome = home) => {
    const r = spawnSync(process.execPath, [join(repo, "src", "cli.ts"), ...args], { cwd: repo, env: { ...env, NOOP_HOME: testHome }, encoding: "utf8", timeout: 45_000 });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  let available = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base)).ok) { available = true; break; } } catch {}
    await Bun.sleep(200);
  }
  check(available, "coordinator becomes available after the user logs in without a manual start");
  const status = cli(["cloud", "service", "status"]);
  check(status.status === 0 && /running|active/i.test(status.out), "launchd reports the coordinator is running");
  check((await fetch(base + "/api/feed", { headers: { authorization: `Bearer ${session}` } })).ok, "the owner session survives logout and relogin");
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  check((await post("/api/auth/start", { email: "owner@example.com" })).ok, "owner requests an offline login code after relogin");
  const login = cli(["login"]), code = login.out.match(/(?:验证码[：:]|Code for [^:]+:)\s*([A-HJ-NP-Z2-9]{8})/)?.[1] || "";
  const auth = await post("/api/auth/verify", { email: "owner@example.com", code, totp: totp(secret, Math.floor(Date.now() / 30_000)) });
  check(auth.ok && !!((await auth.json()) as any).session, "the existing TOTP configuration works after relogin");
  const peerAfter = join(dirname(peer), "peer after relogin");
  const joined = cli(["init", base, "--token", token], peerAfter);
  check(joined.status === 0 && existsSync(join(peerAfter, "data", "tasks", "inbox", `${task}.md`)), "a new isolated home synchronizes the existing task after relogin");
} catch (e) {
  error = e instanceof Error ? e.stack || e.message : String(e); console.error(`FAIL ${error}`); process.exitCode = 1;
} finally {
  const report = { status: error ? "failed" : "passed", scope: "coordinator verification after real macOS user relogin", productCommit: process.env.NOOP_E2E_PRODUCT_COMMIT || "", platform: `${process.platform}-${process.arch}`, timestamp: new Date().toISOString(), checks, error };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(out, "report.json"), text);
  writeFileSync(join(out, "SHA256SUMS"), `${createHash("sha256").update(text).digest("hex")}  report.json\n`);
  console.log(`Evidence: ${out}`);
}
