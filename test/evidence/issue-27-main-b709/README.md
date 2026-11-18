# Fork main compatibility evidence

The product candidate is `e8cae1d032e9eee6ce2260205ab8f3daa739825b`, which merges fork main `b709bf52bd2e691d377c16789ba676cffc83f8f2`. The reports use Linux x86_64, Bun 1.4.4, workerd 2026-11-10 and isolated data. The passing coordinator tests use Web assets built from the candidate. They do not contact a real agent, GitHub account or hosted Worker.

The first shared MCP report uses a clean merge of the prior PR head and main, with the new E2E test and without the dialing fix. The owner stores a synthetic MCP secret and submits a task through the public CLI. The task returns to `inbox`: the direct local address was not used. With the fix, the same task reaches `done`, and the remaining OAuth and MCP checks pass. The fake Codex executable checks the received MCP arguments and synthetic secret.

`ingress.json` and `backup.json` report the local ingress and restore checks. `workflow.json` is a local simulation of the workflow graph; it is not a GitHub Actions run. The actual Linux and platform workflow results must be checked separately. The test suite passed 343 tests, with one existing skip.

The runtime logs show the Linux desktop check against a network-enabled runtime and a runtime without a network stack. The latter fails at the HTTP marker as intended. Their SHA-256 values are `7765a75474e1d5253ac5936f9777ce841e1afab9d4995df5cadaf4a58a21dfb2` and `6f9e4b45f0aca0019b8395817f421d1c984d0d2a51c3898dfa7d14340125e7af`. See the [desktop evidence](../issue-27/linux-x64/desktop/) for their provenance.

To repeat the coordinator checks, build the Web package from this checkout, then provide the pinned workerd binary:

```sh
NSH=/path/to/nsh ./app/build-web.sh
export NOOP_E2E_WORKERD=/path/to/workerd
export NOOP_E2E_WEB_ASSETS="$PWD/app/dist/web/noop"
NOOP_E2E_OVERLAP=1 bun test/self-hosted-mcp-e2e.ts
bun test/self-hosted-ingress-e2e.ts
bun test/self-hosted-backup-e2e.ts
bun test/local-workflow-e2e.ts
```

Each coordinator test writes an isolated report and checksum manifest. The `coordinator-linux` workflow runs these checks with freshly built Web assets on both Linux architectures.
