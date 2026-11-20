# Executor selection acceptance

See [Review follow-up](REVIEW.md) for the fixes and repeat runs after review.

The implementation and deterministic E2E checkout is `82782ef6913714de04c4028cd4170fa90659a7f1`. The authorized Codex run uses `a49ec44b17ed3f6bc9f2a7471f90ce38acccdd4b`. The only product change between these commits is the chat error text. The browser fixture retests that text. All runs start a fresh workerd coordinator and primary on Linux x86_64. The browser uses the Web bundle built from the same application sources. The tested versions are Bun 1.4.4, workerd 2026-11-10, NSH nightly `4aeefa8`, Chromium 155.0.8059.84, Playwright Core 1.64.1 and Codex CLI 0.170.0.

| Check | Result |
| --- | --- |
| Member tasks | A Codex-only task originally started Claude after a quota failure. The fixed task stays queued. Explicit task selection, unavailable executors, exhausted accounts and both configured orders pass. |
| Internal AI | The old primary omitted the effective setting and planned with Claude. In a separate legacy Web run, Codex received the Claude streaming protocol. The candidate uses the shared selection for chat, planning, Judge and Medic. It preserves work in progress, stops idle legacy prewarming and avoids replay after a tool starts. |
| Browser | All four choices save and the client displays the primary's acknowledgement. A failed Codex-only message remains visible with a manual retry notice. |
| Authorized Codex | With `gpt-6-luna` and `low`, Codex replies after using the Noop `list_tasks` tool. Chat launches zero native tools and leaves the MCP probe marker absent. A normal task runs Codex on a broken TypeScript addition helper, and the test executes the corrected helper. |
| Budget | The existing fleet simulation reports 7,595 requests and about 15,427 rows written per day, under the existing target of 20,000 each. Settings confirmation uses the existing status stream. Added timed Worker requests and writes are both zero. |
| Upstream | Git merge preview with `huacnlee/noop` main `f940acf71df48bf7dd5c8b25108db8342910b95d` returns the candidate tree without conflicts. That upstream commit is already an ancestor of the candidate. |

`reports.json` contains the red and green results, ordered executor calls and measurements. Codex CLI reports token counts for the JSONL chat calls. The normal task and planner use plain output, so their measurements record elapsed time and exit status. The screenshots show the isolated Web session.

## Ablation

The team settings and member picker use one enum and one widget. The four internal entry points read one optional field. Codex and Claude use the same conversation interface and Noop tool loop. Chat and Medic share the CLI stream parser. The final E2Es pass with those shared paths. Removing just the idle prewarm cleanup from a detached candidate makes the isolation test fail because the excluded Claude process stays alive. That failure is in the report.

## Repeat

From the tested checkout, install dependencies with `bun install --frozen-lockfile` and build the Web bundle with `NSH=/path/to/nsh sh app/build-web.sh`. Supply the pinned workerd binary used by the coordinator workflow. For browser checks, supply Playwright Core and Chromium.

To reuse CI Web assets, download `coordinator-web` from the run for the tested checkout. Verify `coordinator-web.tar.gz` with `sha256sum -c coordinator-web.sha256` and match `web-source-commit` to `git rev-parse HEAD`. Extract the archive under `app/dist/web` or point `NOOP_E2E_WEB_ASSETS` to the extracted `noop` directory.

```sh
export NOOP_E2E_WORKERD=/path/to/workerd
export NOOP_E2E_WEB_ASSETS="$PWD/app/dist/web/noop"
export NOOP_E2E_PLAYWRIGHT=/path/to/playwright-core/index.mjs
export NOOP_E2E_BROWSER=/path/to/chromium

bun test/self-hosted-executor-e2e.ts --tasks
bun test/self-hosted-executor-e2e.ts --internal
bun test/self-hosted-executor-e2e.ts --web
bun test test/budget.test.ts
```

For the real run, use a private Codex home with an authorized login. Add this MCP server to its `config.toml` and use the absolute path of that test profile.

```toml
[mcp_servers.noop_probe]
command = "/bin/sh"
args = ["-c", "touch /path/to/test-profile/noop-mcp-probe-started"]
```

Start the real run with a fresh profile or remove the previous probe marker from that profile. The normal task can start the probe after the chat check. The runner sets the model and reasoning effort on each test invocation.

```sh
NOOP_E2E_REAL_CODEX=/path/to/codex \
NOOP_E2E_CODEX_HOME=/path/to/test-profile \
bun test/self-hosted-executor-e2e.ts --real
```

Each run prints its output directory. Run `sha256sum -c SHA256SUMS` there to verify its report and in this directory to verify the selected evidence. The real run covers locally configured MCP servers. System-managed Codex configuration layers and native phone clients were outside this run.

## Executor configuration review and handoff

- Follow `PUT /api/settings` through the coordinator inbox to the primary's `saveSettings` and `settingsView`. Check when each new internal request reads effective `clis.internal` and where an in-flight execution keeps its selection. In `--internal`, a held task fails after the setting changes from Claude only to Codex only. The resulting automatic Medic starts with Codex. The same suite checks that an open chat keeps its original executor through a settings change. [Primary settings](../../../src/server.ts) / [Internal acceptance](../../self-hosted-executor-e2e.ts)
- Follow the confirmed `effective.internalClis` to Web over `$settings` on `/api/stream?v=2`. Check that reconnect restores the stored view and that a normal status update recovers a missed confirmation on the same socket. Hold an older status write and confirm that the primary sends the newer acknowledgement after it. `--web` checks that the display ends on the newest value and exercises all four choices. [State publishing](../../../src/cloud.ts) / [Browser fault injection](../../fixtures/settings-state-network.ts)
- Inspect the effective configuration with the real Codex CLI and the overrides from Noop's read-only chat launch. Check the selected account configuration, the trusted parent project and the current directory. `--codex-mcp` reports the account probe as disabled and omits both project probes. Its two controls expose each project layer separately. [Launch arguments](../../../src/runner.ts) / [CLI probe](../../fixtures/codex-mcp-probe.ts)

### Reproduce the evidence

Use a clean worktree at the reviewed SHA. This reference run used the merged [PR #51 commit](https://github.com/laojianzi/noop/commit/2cb620318b138b916ebb9442988098f8c1d0529b).

```sh
git fetch origin main
git worktree add --detach ../noop-executor-review 2cb620318b138b916ebb9442988098f8c1d0529b
cd ../noop-executor-review
```

Run the `--web` command under [Repeat](#repeat). Use the pinned browser and CLI setup in the [Linux coordinator workflow](../../../.github/workflows/coordinator-linux.yml). Run the independent CLI probe with the real binary. The fixture creates its own credential-free account and projects.

```sh
NOOP_E2E_REAL_CODEX=/path/to/codex bun test/self-hosted-executor-e2e.ts --codex-mcp
```

The clean Linux x86_64 replay passed five Web checks and three CLI checks. It used Bun 1.4.4, workerd 1.20261110.1, Playwright Core 1.64.1, Chrome Headless Shell 156.0.8078.4 and Codex CLI 0.170.0. The workflow ran both checks on the same checkout with Bun 1.4.5. [Coordinator run 44685241549, attempt 1](https://github.com/laojianzi/noop/actions/runs/44685241549) / [x86_64 job](https://github.com/laojianzi/noop/actions/runs/44685241549/job/136118143864) / [Report ZIP 14606221991](https://github.com/laojianzi/noop/actions/runs/44685241549/artifacts/14606221991)

Download the ZIP by the upload ID. Compare its SHA-256 to the upload digest (`250ce941eff13580fec6c1831eb0814d50470ea784ad4a026d5c5ef81ab5593d` for this run). Extract the ZIP and run `bash test/verify-coordinator-evidence.sh /path/to/extracted-evidence`. Find the two `noop-executors-*/report.json` files with `playwright` or `codex` fields. In each file, check that `revision` matches the CI checkout SHA and `error` is empty.

Record the next candidate's HEAD and actual CI checkout SHA with its run, attempt, tool versions and download links. Record the merge SHA after merge and the live service revision in the local handoff. Use `unknown` if read-only service metadata cannot identify that revision. [Handoff issue](https://github.com/laojianzi/noop/issues/44)

The isolated Web run uses fixture executor responses. The CLI probe runs `codex mcp list` without a model request. Actions ties both reports to a checkout. Use the authorized `--real` command under [Repeat](#repeat) to verify model replies and Noop tool calls. Track managed Codex configuration, native clients, real VPS, multi-host and Cloudflare verification in the real-environment issue. [Real environments #28](https://github.com/laojianzi/noop/issues/28) / [Roadmap #1](https://github.com/laojianzi/noop/issues/1)
