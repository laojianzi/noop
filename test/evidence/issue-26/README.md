# Protected local service update

The update acceptance uses an installed systemd or launchd service with a
separate Noop home, synthetic data, the real Web bundle and native workerd.
It checks that changing the source checkout does not change the installed
release on restart. It then tests invalid source, invalid Worker code, a live
startup failure, successful update, and rollback after a new write.

`before` records the acceptance failure before the update command existed.
Its earlier negative-case checks did not prove a live startup failure. The
current script requires evidence that the failed candidate reached the live
switch and its storage was preserved.

`long-socket-before` records the isolated verification failure caused by an
oversized Unix socket path. The implementation uses a short private alias to
the same data directory. The later runs complete the same update scenario.

The Linux x86_64, Linux ARM64 and macOS Intel reports test an actual workerd
change from `2026-11-10` to `2026-11-16`, then roll back with the newer
write intact. The candidate fixture pins the supplied second binary's hash.
`darwin-arm64-same-runtime` verifies the same code update and rollback on
native Apple Silicon with the original runtime. A different-runtime test on
that platform is still pending an available runner.

`linux-no-space` uses a 240 MiB tmpfs and produces an actual `ENOSPC` while
staging the release. The previous service and its data remain available.

- Original failure: https://github.com/laojianzi/noop/actions/runs/43872064364
- Unix socket failure: https://github.com/laojianzi/noop/actions/runs/43874057056
- Runtime upgrade: https://github.com/laojianzi/noop/actions/runs/43875210026
- Apple Silicon and full disk: https://github.com/laojianzi/noop/actions/runs/43874700734 and https://github.com/laojianzi/noop/actions/runs/43874605126
- Script: `test/self-hosted-update-e2e.ts`

The service workflow with the Linux no-space job was cancelled after that job
passed while an unrelated macOS job remained queued. The runtime-upgrade
workflow's Apple Silicon job was cancelled before a runner became available.
The reports record the exact environment, version hashes and checks.
