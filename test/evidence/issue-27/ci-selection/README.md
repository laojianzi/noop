# CI platform selection

The local `act` 0.2.98 dry run evaluated the CI event and matrix selection.
The push event selected Linux only. The manual event selected Linux and macOS.
`actionlint` 1.7.12 accepted the actual workflow. These are local simulations,
not completed GitHub-hosted jobs.

`selection.yml` retains the event, matrix and runner fields from the tested
workflow and replaces its steps with a single harmless echo. The source
`.github/workflows/ci.yml` SHA-256 was
`ceb2e1111e81a8ccae7063cb846af6ec20d778288c0139d811d507f29e2441e9`.

With `act` and Docker available, repeat from the repository root:

```sh
act --dryrun -P ubuntu-latest=-self-hosted -P macos-latest=-self-hosted \
  -W test/evidence/issue-27/ci-selection/selection.yml push
act --dryrun -P ubuntu-latest=-self-hosted -P macos-latest=-self-hosted \
  -W test/evidence/issue-27/ci-selection/selection.yml workflow_dispatch
```

GitHub can dispatch the manual event after the workflow's trigger is present
on the default branch. The separate tag release workflow still waits for every
platform package; issue #30 tracks the required release-path design.
