# Local SMTP and security alert acceptance

`report.json` records the Linux x86_64 run at source revision `b6a261a`.
The coordinator connected to a separate Mailpit v1.33.1 SMTP server over
STARTTLS with authentication. A temporary CA signed the server certificate.
Mailpit received the synthetic login code and security alert. The test then
signed in with the received code and TOTP, checked direct and proxied alert
origins, stopped SMTP to check the error response, and checked CLI login in a
separate home with no SMTP configuration.

`network-before.log` records the original rejection of a loopback SMTP
connection. `origin-ablation.log` records a separate run with the trusted-origin
fix removed: the alert then contained the forged `203.0.113.77` header. Both
results support retaining the small runtime network configuration and the shared
verified-source handling. No second mail implementation was added.

The Mailpit server received real SMTP traffic but did not send to an external
mailbox. Native desktop and mobile clients and a deployed Cloudflare Worker were
not part of this test. See `test/self-hosted-acceptance.md` for the repeatable
scenario. Verify these artifacts with `sha256sum -c SHA256SUMS` in this directory.

The isolated Wrangler cloud-mode MCP and OAuth regression passed; see
`cloud-emulator-mcp.log`. The existing suite passed 290 tests with one
macOS-only skip. The fleet-day budget remained 7595 requests and about 15427
rows written against unchanged limits of 20000 each.
