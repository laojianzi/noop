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
