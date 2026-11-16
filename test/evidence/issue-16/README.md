# macOS native coordinator service

The service test ran on disposable macOS Intel and Apple Silicon runners. It
used each runner's actual logged-in `launchd` GUI domain. With outbound traffic
blocked on the default interface, it installed the service, bound TOTP, signed
in without SMTP, synchronized a task, and checked stop, failed start, restart,
status and logs. The same offline session also passed service update and
rollback; the Apple Silicon run used two different workerd versions.

The service reports and manager logs are in the platform directories.
`network.log` contains the online, blocked and restored markers from the
corresponding Actions job. Verify the generated files with the top-level
`SHA256SUMS`, or the original service reports with each subdirectory's
`SHA256SUMS`.

- Intel run: https://github.com/laojianzi/noop/actions/runs/43877134011
- Apple Silicon run: https://github.com/laojianzi/noop/actions/runs/43879285512
- Scripts: `test/self-hosted-macos-offline.sh` and
  `test/self-hosted-service-e2e.ts`

The Intel job passed. Its workflow later ended as failed because an unrelated
Apple Silicon job was cancelled while queued; the separate Apple Silicon run
passed.

The `RunAtLoad` launch agent was loaded and tested in an existing login session.
An actual macOS user logout followed by a new login has not been tested. That
acceptance criterion remains open and requires a disposable Mac or VM with a
controllable graphical login session. These tests use synthetic credentials.
