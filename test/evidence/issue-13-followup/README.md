# Local coordinator integration follow-up

This evidence uses synthetic credentials and disposable machines. The source
base is `98cf0a7d5fb387acb975137d81460eb2a3d08ea8`. The tested implementation
and test diff, excluding this evidence directory, has SHA-256
`306d79976a008ebb4c5341459a389f1309780a821875af4bf7c44355e89b4a06`.
The Linux report records the base commit because the changes were uncommitted
when the isolated VM ran.

## Before

- `cloud-before` used fake Wrangler in an isolated container. With a local
  coordinator configured, `cloud deploy` invoked the cloud path and rewrote
  the bootstrap URL. The recorded URL and token are synthetic.
- `vm-before/owner-update.json` records an owner request through the real API
  that did not update the co-located coordinator. `custom-config.json` records
  the same failure when `HUB_CONF` points outside `NOOP_HOME`.
- `runtime-durability`, `service-durability`, and `config-durability` record
  checksum, systemd unit, and TOML failures after a forced VM reset. Each test
  used its own data. The compressed serial logs retain the failure details.
- `totp-boundary.json` records a later failed re-login at a TOTP period boundary.
  That test used a future-period code; it did not retain the API error. The
  current test waits for a new period and records the response on failure.
- `arm64.json` and `arm64-serial.log.gz` record the first ARM64 TCG retry. The
  owner update succeeded, but the test did not obtain login state after reset.
  Bun also reported one trap before the reset; systemd restarted the primary.
  The logs do not establish whether the trap came from Bun or emulation.

## After

`linux-x64` contains the final QEMU/KVM report and serial log. The guest used
real systemd services, an independently configured `HUB_CONF`, real workerd,
a real Web bundle, synthetic credentials, and a network with no public access.
The test logged in, requested an update through the coordinator API, checked
data, forcibly reset the VM, and verified unattended service startup, login,
and synchronization by a new host. The test makes its own fixture writes
durable before the reset. Its Web bundle came from the base commit, not the
candidate. The PR's coordinator workflow builds Web from the PR checkout.

`linux-arm64` passed the same functional checks on a native ARM64 runner using
an emulated QEMU TCG guest. Before the reset, the primary daemon crashed twice
and systemd restarted it. The cause is not established. A native-container
comparison is tracked in https://github.com/laojianzi/noop/actions/runs/44263150284.
A QEMU CPU-feature comparison is tracked in
https://github.com/laojianzi/noop/actions/runs/44263482350. This result does
not prove crash-free use.

`cloud-after` contains the local Web/CLI E2E report. It verifies that the same
cloud command fails without invoking Wrangler or altering local configuration,
and checks the existing cloud routing with simulated Git and Wrangler. It is
not a live Cloudflare deployment.

`macos-x64` and `macos-arm64` contain native GitHub Actions service and update
reports. They cover launchd installation, startup, update, failed update, and
rollback. They do not claim a new physical-device or logout/login test.
Run: https://github.com/laojianzi/noop/actions/runs/44261407126

The Intel macOS packaging failure and its targeted fix are in these runs:
https://github.com/laojianzi/noop/actions/runs/44253921669 and
https://github.com/laojianzi/noop/actions/runs/44255266211. The complete
platform matrix remains in `.github/workflows/release.yml`.

The original Linux ARM64, Tailscale, backup, Cloudflare compatibility, and
budget evidence remains under `test/evidence/issue-27-linux-final` and the
other linked ticket evidence directories. No Cloudflare budget target changed.

## Repeat

Prepare the pinned native workerd, the real Web bundle, and a verified Debian
12 cloud image. Install QEMU, `cloud-localds`, `genisoimage`, and `qemu-img`.
The x86_64 test needs KVM. The ARM64 test uses QEMU TCG and the AArch64 UEFI
firmware at `/usr/share/qemu-efi-aarch64/QEMU_EFI.fd`.

```sh
mkdir -p /tmp/noop-acceptance
NOOP_E2E_OUT=/tmp/noop-acceptance \
NOOP_E2E_WEB_ASSETS=/path/to/web/noop \
NOOP_E2E_WORKERD=/path/to/pinned/workerd \
NOOP_E2E_DEBIAN_IMAGE=/path/to/debian-12-genericcloud.qcow2 \
  bun test/self-hosted-reboot-vm.ts
```

Each run writes a report, serial log, VM configuration, and `SHA256SUMS`.
Check the archived files with `sha256sum -c SHA256SUMS` in this directory.
