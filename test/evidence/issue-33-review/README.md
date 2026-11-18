# PR 33 review evidence

The reports record the original PR head `bd013ec` with the review fixes in the
working tree. The two `act` reports have empty Git revision fields because the
container ran as root over the host-owned checkout. The host and VM reports
record the revision and changed paths. All accounts, tokens, repositories and
agents used in these tests are synthetic.

## Regressions and checks

- `foreground-before`: a real local coordinator and real Git update reproduced
  the missing primary restart. `service-failure-before` removes only the
  primary restart after a failed coordinator update and reproduces the lost
  recovery. `waiting-before` reproduces a queued owner answer that is not
  processed while a task runs.
- `git-abbrev-before` sets Git `core.abbrev` to 12 and reproduces a false stale
  revision. `rejected-version-before` makes the candidate code test fail,
  rolls back real Git, and records the incorrect coordinator failure message.
- `stop-ablation` removes the pending-stop state and reproduces a lost SIGTERM
  during an update. `owner-after` passes these cases and proves that new work
  waits, resumes after failure, and a rejected version does not deploy.
- `status-write-before` makes the update status path unwritable after Git
  switches and reproduces a stuck primary. `owner-after` verifies the primary
  restarts in this case.
- The original installation test timed out after 12 seconds before it reached
  `systemctl` with a trailing slash in `HOME`. `install-after` passes both
  primary and coordinator installation for trailing slash and `/.` homes. It
  uses a simulated service manager.
- `web-vm-before` reaches the real systemd coordinator update, then finds the
  previous Web client. `vm-after` uses a Linux x86_64 KVM guest and passes 23
  checks, including the first Web update, offline fallback, forced reset,
  unattended startup, login and synchronization. The Web release source is
  served inside the isolated guest. The guest has no public network.
- `browser-after` passes 48 checks with a real local workerd and Chromium.
  `act-owner-after` and `act-install-after` ran the two added coordinator
  workflow steps through local `act` on Linux x86_64.

The Git regression test uses a real Git repository and a local bare origin.
It simulates dependency installation and the candidate's test command; it
runs the primary daemon and local coordinator as real processes. The managed
service failure uses an isolated service definition without an installed
release. The native service and snapshot path is exercised in the VM.

## Repeat

Set `NOOP_E2E_WEB_ASSETS` to the built Web client directory and
`NOOP_E2E_WORKERD` to the pinned workerd binary. Then run:

```sh
bash test/self-hosted-install-home-e2e.sh
bun test/self-hosted-owner-update-e2e.ts
bun test/self-hosted-e2e.ts
```

For the browser test also set `NOOP_E2E_BROWSER` and, if needed,
`NOOP_E2E_PLAYWRIGHT`. For the VM test set `NOOP_E2E_DEBIAN_IMAGE` and install
QEMU, cloud-localds and genisoimage. Run `bun test/self-hosted-reboot-vm.ts`.
The test generates its release fixture and writes checksummed evidence.

Run `sha256sum -c SHA256SUMS` from this directory to verify these copies.
