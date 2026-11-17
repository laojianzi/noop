# Linux delivery acceptance

The service and update reports use clean source commit
`5baf2d58e71f8cacada0475bce4b7fd7845ea795`. They ran on native Linux x86_64
and ARM64 GitHub runners. With outbound traffic blocked except loopback, each
runner installed its coordinator archive as a systemd service, signed in,
synced a task, updated and rolled back. The rollback retained the new write. The archive
manifests identify the same source and Web commit for each architecture.

- Coordinator workflow and archives: https://github.com/laojianzi/noop/actions/runs/44045812078
- Linux and macOS CI on the same source: https://github.com/laojianzi/noop/actions/runs/44045812029
- The workflow artifacts contain the full reports, logs and per-test checksums.

## Delivery decision and ablation

Separate coordinator artifacts let Linux finish without changing the client
release or update protocol. A partial client release would need new rules for
missing platform assets and update manifests. The independent workflow needs
neither those rules nor a separate release publisher. Copy the artifacts to
durable storage before their GitHub retention period ends.

## Isolated release failure simulation

The probe commit `3bd3f00ba40bf37a6c9d4543434b832382c2a4f4` differs from the
tested source only by `probe.patch`. It deliberately fails the macOS and
Android package jobs and queues iOS on an unavailable runner label. It runs
the normal independent Linux coordinator workflow on the same probe commit.

At the same observation point, `release-probe.json` records those two failures
and queued iOS job. `linux-probe.json` records successful Linux x86_64 and
ARM64 jobs. `linux-artifacts.json` records both coordinator archives. The fork
had no releases and no latest release before or after this test. No tag or
formal release was created. After capturing the result, the test-only release
run was cancelled to release its intentionally queued job.

- Simulated client release: https://github.com/laojianzi/noop/actions/runs/44046847739
- Independent Linux delivery: https://github.com/laojianzi/noop/actions/runs/44046828395

To repeat the simulation, create a disposable branch from the source commit,
apply `probe.patch`, push the branch, and dispatch the `release` workflow for
that branch. Wait for the Linux coordinator workflow to finish. Record both
workflow states and the release list before cancelling the test-only run.

Run `sha256sum -c SHA256SUMS` in this directory to verify these records.
