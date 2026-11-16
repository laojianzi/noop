# Trusted network acceptance evidence

`report.json` records the Linux x86_64 run at source revision
`4e9db05`. The test used a real workerd process and an actual TLS reverse proxy
with a synthetic certificate. It checked direct and proxied IPv4, direct IPv6,
forged and missing source headers, WebSocket, MCP streaming, invalid rules and
private authenticated health checks. Run the same test as described in
`test/self-hosted-acceptance.md`.

The native metadata experiments show that workerd reported the actual socket
peer in `request.cf.clientIp` even when the client forged forwarding headers.
For a Unix socket it reported local process credentials and no network source.
The local allow-list therefore rejects that request instead of trusting its
header. The operating-system and runtime versions are identified in the reports.

The pre-fix CIDR run accepted a rule with an extra slash; the pre-fix readiness
run could not start a service restricted to a remote source. Their reports are
kept as `cidr-before-report.json` and `readiness-before-report.json`. A separate
health experiment returned 200 on the authenticated private socket and 403 on
the restricted public listener. The private health Worker has one purpose: it
keeps a real storage readiness check available when the public allow-list does
not include the coordinator itself.

`vm-regression-report.json` records a KVM power-off and recovery run at
`4f6396e`, whose product code is the same as the test revision. The existing
fleet-day budget simulation remained at 7,595 requests and approximately 15,427
written rows, each below the unchanged 20,000 target. The cloud build was a
Wrangler dry run, and its email binding was simulated.

The proxy was local test infrastructure. A real Tailscale Serve deployment,
physical devices, MCP external-origin handling and four-platform acceptance
remain separate checks. Verify these artifacts with `sha256sum -c SHA256SUMS`.
