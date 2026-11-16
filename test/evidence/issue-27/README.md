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

The release gate is still open. A real macOS logout followed by login, native
desktop and mobile client use, actual device push delivery, and isolated
Cloudflare deployment and mail binding have not been validated. The SMTP test
uses a local Mailpit server, and the cloud checks use a local Wrangler emulator
and deployment stubs. No real VPS or Tailscale connection was used. These
results do not establish those external environments.

The Web bundle is the checksum-verified upstream `v0.3.18` release, not a build
of this source revision. The original workerd's local Durable Object storage is
experimental; the project has not formally selected it for production.
