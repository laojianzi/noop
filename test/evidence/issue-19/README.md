# MCP through an HTTPS proxy

`report.json` records the isolated run at source revision `973060f`. A real TLS
reverse proxy forwarded requests to native workerd. The synthetic external host
resolved to loopback for this test, and the proxy used a self-signed certificate.
No external MCP provider or Cloudflare account was used.

The test completed CLI TOTP setup, email-code authorization, PKCE token
exchange, MCP initialization and a `get_status` tool call. It received an SSE
notification, disconnected, and resumed a missed notification. It also checked
token revocation and rejected forged or malformed forwarded-origin headers.

`discovery-before.json` and `discovery.json` record the same behavior before
and after the origin change: the external HTTPS resource was previously reported
as HTTP. `invalid-origin-before-report.json` records the pre-fix rejection
test for malformed proxy data. The real proxy and replayable scenario are in
`test/fixtures/https-proxy.ts` and `test/self-hosted-mcp-e2e.ts`.

`cloud-emulator-mcp.log` records the existing cloud-mode scenario under an
isolated Wrangler development runtime. It covers OAuth, tools, streamed
notifications, replay and token refresh. It is not a deployed Cloudflare test.
The full local test suite reported 290 passed, one skipped and no failures;
the skipped test requires a macOS environment. See `full-suite.txt`.

Run `sha256sum -c SHA256SUMS` from this directory to verify these artifacts.
