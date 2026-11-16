# Linux native coordinator service

The service tests ran on disposable GitHub-hosted Linux x86_64 and ARM64
runners. Each test installed the actual user systemd service, confirmed linger,
bound TOTP, signed in without SMTP, synchronized a task to another Noop home,
and checked status, logs, stop, failed start and restart.

The reboot tests ran a separate Debian 12 guest with public network access
blocked. They installed the service, reset the whole VM, confirmed a new boot
ID, `Linger=yes` and no login sessions, then authenticated and synchronized a
file from a fresh host. The x86_64 guest used KVM. The ARM64 guest ran on an
ARM64 runner with QEMU TCG software emulation.

- Service run: https://github.com/laojianzi/noop/actions/runs/43874605126
- Reboot run: https://github.com/laojianzi/noop/actions/runs/43874630681
- Scripts: `test/self-hosted-service-e2e.ts` and
  `test/self-hosted-reboot-vm.ts`
- Source, runtime hashes, environment and individual checks: each `report.json`

Both Linux service jobs passed. The service workflow was later cancelled while
an unrelated macOS job was still queued.

The Web bundle is the checksum-verified upstream `v0.3.18` artifact. The reboot
guests and credentials are synthetic. These results do not assert physical
hardware or a deployed cloud service. The original GitHub artifact omitted
`meta-data` and `network-config`; these two files were reconstructed from the
test script and match the checksums produced by the run.

Verify each directory with `sha256sum -c SHA256SUMS`.

The `linux-x64-immediate-reset` run repeats the full reboot scenario after
removing a five-second diagnostic delay from the fixture. It passed with the
same unclean VM reset: https://github.com/laojianzi/noop/actions/runs/43878910898.
