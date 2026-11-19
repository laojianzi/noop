# Executor selection acceptance

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
