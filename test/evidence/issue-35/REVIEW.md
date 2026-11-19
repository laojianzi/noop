# Executor selection review follow-up

PR #39 was reviewed from `4a0b792` to `5206ad9`. The repaired source and deterministic end-to-end checkout is `bffa7969c8cb97a128e12e389bca422ddafc232e`. Each test below uses a fresh local coordinator and primary.

| Condition | Before | After |
| --- | --- | --- |
| Save the Codex-only member setting while planning is paused, then add a task | The new task starts `claude/default`. | It starts `codex/default`. A running chat still completes with its original executor. |
| Give Codex a profile with a TOML syntax error | Planning stops before dispatch. Judge bypasses the available alternate too. | Both use the allowed alternate. With no alternate, planning returns no result and the task can still start. |
| Return a valid empty chat reply | One executor runs and the owner sees only the original message. | Chat tries the selected alternate or displays a manual retry notice. |
| Fail a chat write after it starts | The owner can receive neither an answer nor a useful recovery notice. | One executor runs. The feed asks the owner to check the result before retrying. |
| Return a provider error with a diagnostic ID | The ID appears in the feed. | The feed shows a safe reason. The original ID stays in the primary log. |
| Fail Medic before any tool starts | Only Codex runs. The command exits 1. | The command succeeds with the allowed alternate. A failure after a tool starts still stops with one invocation. |
| Use a file as an account directory or deny directory creation | Internal fallback stops or the task remains active without a runner. | The failed account is skipped. The next eligible account or executor runs. |
| Miss the settings acknowledgement while the Web socket is down | The open settings page keeps the old choice after reconnect. | The existing v2 socket delivers the confirmed choice when it reconnects. |
| Run the legacy planner with a custom executable name | The first repair dropped the read-only sandbox flag on this path. | The legacy planner still passes `--sandbox read-only`. |

Planning and Judge use one structured-call implementation. Their model, timeout and log rules remain distinct. The shared implementation keeps the existing entry points. The directory check rejects both an existing file and a directory that cannot be created before dispatch. The read-only-parent case demonstrated why a file-type check alone was insufficient.

## Verification

Run the commands in [Executor selection acceptance](README.md#repeat) on the repaired checkout. The green runs pass 17 internal checks, seven task checks and three browser checks. Each run produces a checksum manifest for its report. The project E2E and the local Bun suite passed during the repair. The Linux Bun suite reported 345 passes, one platform-specific skip and zero failures.

The live Codex run used `30ac806ac7fc02373a9192a9ca9b6fecdb1d52e6`. The later product change restores the read-only flag for legacy planner aliases. The live run used an explicit Codex selection. The existing Web bundle has the same application sources. With `gpt-6-luna` and `low`, Codex used the Noop read tool and completed the Web reply. Chat launched no native tool and left the MCP probe marker absent. The two chat calls took 34.054 seconds and reported 36,553 input tokens, including 16,384 cached tokens, and 72 output tokens. A normal task fixed the TypeScript addition helper in 32.013 seconds. Both arithmetic checks passed.

The fetch and storage budget stays at 7,595 requests and about 15,427 rows written per simulated day under the existing 20,000 targets. Reconnect uses the existing WebSocket upgrade and adds no requests or rows written. Each cache miss for the settings view can read one row. The merge preview against upstream `f940acf71df48bf7dd5c8b25108db8342910b95d` returned the candidate tree with no conflicts.

## Owner review of `7e49ae8`

The fixes and the final local E2E runs use `7071b4ca067c059ac3dc0d02bea99d9504683867`.

| Evidence before the fix | Verified behavior after the fix |
| --- | --- |
| Automatic Medic started Claude after a held task failed even though the owner had switched internal AI to Codex only. | Every Medic entry point loads the effective config at the start of the repair. The held-task E2E records only Codex for the new repair. |
| One settings acknowledgement failed before reaching the coordinator. The next status push stored the new choice, but the open browser kept the old choice. | The existing status frame carries changed confirmed settings. The open browser catches up without reconnecting. |
| A delayed status request arrived after the new confirmation and restored the old settings. | The primary sends status and confirmations in order. It reads the settings snapshot when the request starts. The browser E2E observes old status first and new confirmation second. |
| Real Codex CLI listed MCP servers from both a trusted parent project and the current working directory. Both were enabled. | The read-only command restricts project discovery and excludes the current directory's project config. The actual CLI lists only the disabled account probe. It produces no project probe marker or native chat tool event. |
| The first live run passed the config probe but answered that `list_tasks` was unavailable. It never sent a Noop tool request. | The Codex adapter states that Noop tools use the JSON reply protocol. The natural-language request reaches `list_tasks` in the live rerun. |

Removing only the discovery override enabled the parent probe. Removing only the current-directory trust override enabled the working-directory probe. Both checks used Codex CLI 0.170.0 with the exact production arguments and a credential-free temporary project. The live E2E also tests an account MCP probe. [Codex config precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)

Run the same commands in [Executor selection acceptance](README.md#repeat). The suite passes seven task checks, 18 internal checks and five browser checks. `--web` uses the test preload to drop one acknowledgement and hold one older status request. `--real` sets up both trusted project layers and runs the real CLI config probe before its first model request.

The live rerun used `gpt-6-luna` with `low` reasoning. Its two chat calls took 27.591 seconds and reported 36,643 input tokens, including 28,416 cached tokens, and 103 output tokens. A normal Codex task repaired the TypeScript addition helper in 28.743 seconds and passed both arithmetic checks. The project E2E, the Bun suite and the budget simulation passed during the repair. The status fix uses existing requests and writes no extra rows. The upstream merge preview against `f940acf7` returned the candidate tree without changes.

The final local Standards and Spec reviews found no outstanding findings. The runs cover account and project MCP configuration. Managed system configuration and native clients are outside this verification.
