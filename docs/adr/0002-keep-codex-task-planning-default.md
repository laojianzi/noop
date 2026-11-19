# Configure reasoning effort while keeping upstream defaults

Keep the upstream `low` fallback for Codex task planning. Only `[router].reasoning_effort` overrides it. An explicit `default` hands the choice back to Codex, even when `[clis.codex]` sets a level. This preserves existing behavior and reduces the changes we carry when we sync with upstream.

Resolve `model` and `reasoning_effort` separately. Task runs and Medic use the selected executor's `[clis.<executor>]` effort. Owner conversation, task planning, and Judge use `[chat]`, `[router]`, and `[judge]` respectively. A role with no effort inherits the selected executor's setting, subject to the Codex task planning rule above. Explicit `default` bypasses that inheritance. At the end of resolution, an unset effort or `default` leaves effort selection to the CLI.

Use `[chat]` so the owner can configure conversation and task planning independently. A `[chat].model` applies to the first configured internal executor, or the existing chat executor in legacy mode. When `[chat].model` is absent or applies to another executor, use the existing model lookup, including `[router].model`. Executor selection follows the existing rules.

Require a non-empty string for a configured effort. Pass an explicit level to Codex as `model_reasoning_effort`, or to Claude Code as `CLAUDE_CODE_EFFORT_LEVEL` in the child process. Each CLI and model defines its own supported levels. A full `command` override controls its own invocation.

Keep fixed-format queries on the existing read-only data paths. Natural-language questions use the owner conversation. Classification during task planning shares the planner's effort. A fleet member running a classification routine uses its normal task effort.

## Machine-local example

Merge these fields into `config.local.toml` on a Codex-only host.

```toml
[clis]
internal = ["codex"]

[clis.codex]
model = "gpt-6.2-sol"
reasoning_effort = "max"

[chat]
reasoning_effort = "medium"
```

Task runs, Judge, and enabled Medic use the executor's `max`. Task planning uses `low`. The owner conversation uses `medium`.
