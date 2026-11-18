# Full-feature release evidence

Each platform directory contains reports from the actual local coordinator and
its native workerd executable. The reports cover the guest lifecycle, HTTPS MCP
and OAuth, STARTTLS SMTP, Web Push protocol, backup and restore, browser message
and attachment flows, network source policy, and a SQLite database over 500 MB.
The top-level checksums cover this curated set of reports, logs and screenshots.
The scripts produce additional disposable fixtures when repeated.

| Coordinator host | Core features | Browser | Network and retention |
| --- | --- | --- | --- |
| Linux x86_64 | passed | native Chromium | passed |
| Linux ARM64 | passed | native ARM64 Chromium in Debian container | passed |
| macOS Intel | passed | native Chrome | passed |
| macOS Apple Silicon | passed | native Chrome | passed |

The browser tests use two real, separately authenticated Web sessions. The
Linux ARM64 browser and coordinator processes ran inside a Debian container on
an ARM64 runner; they were not emulated. The Mailpit server receives real SMTP
traffic with STARTTLS and authentication. The push receiver is controlled test
software, not a production push service.

The Linux x86_64 native desktop acceptance is in `linux-x64/desktop`. It uses a
packaged application in an isolated Xvfb display and tests sign-in, messages,
WebSocket delivery and the first primary status snapshot.

`android-simulator` records a native Android app launch and an HTTP policy
comparison. A diagnostic build using the existing network policy rejected
cleartext HTTP. A test package that allowed cleartext completed sign-in and
WebSocket messaging. This does not establish HTTPS or physical-device acceptance.

The separate service, unattended Linux reboot, backup, protected update and
network-topology evidence is in `test/evidence/issue-15` through `issue-26`.
The Apple Silicon feature run also tested the service and a runtime update
while outbound public traffic was blocked. A real HTTPS proxy carries MCP and
WebSocket traffic. The separate-host topology used isolated VMs and containers.

- Linux and macOS Intel features: https://github.com/laojianzi/noop/actions/runs/43878457103
- Apple Silicon features and offline update: https://github.com/laojianzi/noop/actions/runs/43879285512
- Linux ARM64 browser: https://github.com/laojianzi/noop/actions/runs/43879562562
- Four-platform IP and retention tests: https://github.com/laojianzi/noop/actions/runs/43880545953
- Scripts and prerequisites: `test/self-hosted-acceptance.md`

The Linux and macOS Intel feature jobs passed. Their workflow was later
cancelled while its Apple Silicon job was queued; the separate Apple Silicon
run passed.

The release gate now targets Linux local deployments. Linux data recovery,
updates, offline operation, functionality and the unchanged Cloudflare budget
and local regression checks remain required. A real macOS logout and login,
other native desktops, mobile HTTPS and device push, VPS, and deployed
Cloudflare and mail binding remain follow-up acceptance work.
The current tag release workflow still waits for all platform packages. Its
independent Linux delivery path was completed in issue #30; see
[`issue-30-ci`](../issue-30-ci/README.md).

`linux-x64/tailscale` records two authenticated Web sessions through the
existing local Tailscale Serve HTTPS route. The test covered WebSocket delivery,
attachments and restart recovery. OAuth and MCP passed with the IP allow-list
disabled. With a trusted loopback proxy and an enabled allow-list, the initial
local CLI authentication failed with HTTP 403. The fix and retest are recorded
in `test/evidence/issue-29-30`. The client and
coordinator ran on the same host; this is not a cross-device Tailscale test. The SMTP test uses a local
Mailpit server, and cloud checks use a local Wrangler emulator and deployment
stubs. These results do not establish the deferred external environments.

The Web bundle is the checksum-verified upstream `v0.3.18` release, not a build
of this source revision. The original workerd's local Durable Object storage is
experimental. At the time of this report, the project had not selected it for
production. The later Linux decision and evidence are in
[`issue-27-linux-final`](../issue-27-linux-final/README.md).
