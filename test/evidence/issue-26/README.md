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

The Linux x86_64, Linux ARM64, macOS Intel and Apple Silicon reports test an
actual workerd change from `2026-11-10` to `2026-11-16`, then roll back with
the newer write intact. The candidate fixture pins the supplied second binary's hash. The Apple Silicon update and rollback ran with public traffic blocked.
`darwin-arm64-same-runtime` records the earlier code-only update test.

`linux-no-space` uses a 240 MiB tmpfs and produces an actual `ENOSPC` while
staging the release. The previous service and its data remain available.

- Original failure: https://github.com/laojianzi/noop/actions/runs/43872064364
- Unix socket failure: https://github.com/laojianzi/noop/actions/runs/43874057056
- Runtime upgrade: https://github.com/laojianzi/noop/actions/runs/43875210026
- Apple Silicon offline runtime upgrade: https://github.com/laojianzi/noop/actions/runs/43879285512
- Earlier Apple Silicon and full disk: https://github.com/laojianzi/noop/actions/runs/43874700734 and https://github.com/laojianzi/noop/actions/runs/43874605126
- Script: `test/self-hosted-update-e2e.ts`

The service workflow with the Linux no-space job was cancelled after that job
passed while an unrelated macOS job remained queued. The runtime-upgrade
workflow's Apple Silicon job was cancelled before a runner became available.
The later Apple Silicon run passed on an `xcode-27` runner. The reports
record the exact environment, version hashes and checks.

`cloud-routing` records a separate CLI run with synthetic Git and Wrangler.
The local update makes no cloud call. A cloud primary with Worker changes still
enters the existing Wrangler deployment path. This is a routing check; it is
not a deployed Cloudflare test. The unchanged fleet-day budget also passes.
