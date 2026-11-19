# Reasoning effort acceptance

The [report](report.json) records observed launches and the tested revisions for #47, #48, and #49. The runs used Linux x86_64, Bun 1.4.4, and workerd 1.20261110.1. The Web checks used Playwright 1.64.0 and Chromium 155.0.8059.84. The Web bundle came from the verified [fork main artifact](https://github.com/laojianzi/noop/actions/runs/44487485404). Its app tree matches the tested checkout.

| Ticket | Red | Green |
| --- | --- | --- |
| #47 | A Sol task omitted the configured `max` argument. | 11 task checks cover explicit levels, CLI defaults, local overrides, and a complete custom command. |
| #48 | Codex planning sent `low` after the owner set `medium`. | Planning keeps `low` by default and honors both kinds of override. Judge and Medic use the selected settings. |
| #49 | The legacy conversation omitted `medium` from the Claude environment. | Conversation checks cover both CLIs, legacy model lookup, multi-turn reads, and fallback. |

The combined internal run passed 21 checks. The Web run passed five checks. TypeScript and the project E2E passed. Bun reported 345 passes, one platform-specific skip, and zero failures. The existing fleet-day test measured 7,595 requests and about 15,427 row writes.

The real run completed a Noop task lookup in two Codex calls, with zero native tool events. Both calls used Luna with `low`. Planning and the task also used Luna with `low`. The task repaired the addition helper and passed both arithmetic checks. An earlier attempt timed out before the first reply. The same isolated configuration passed on retry.

Removing the conversation effort override from the tested code caused the Codex conversation to receive `max` in place of `medium`. The upstream merge preview against `6bcc190` found the same NSH setup action conflict in the fork base and in the feature branch.

The initial CI artifact manifest referenced a separate call ledger. The upload excludes it. The repaired manifest verifies the report, which includes the complete call ledger. A local replay of the CI file selection passed the checksum check.

## Repeat

Set up the Web assets, pinned workerd, and browser as in the [executor acceptance instructions](../issue-35/README.md#repeat). Run the fixture matrix from the checkout under test.

```sh
bun test/self-hosted-executor-e2e.ts --tasks
bun test/self-hosted-executor-e2e.ts --internal
bun test/self-hosted-executor-e2e.ts --web
bun test
bunx tsc --noEmit
bash test/e2e.sh
```

For the live smoke, use a separate authorized Codex home with the probe settings described in the same instructions. Run the existing `--real` mode. It sets Luna and `low` through Noop configuration.

Run `sha256sum -c SHA256SUMS` in each output directory to check its report. Run the same command in this directory to check the recorded evidence.
