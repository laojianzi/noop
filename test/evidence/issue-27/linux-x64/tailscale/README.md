# Tailscale Serve on the Linux coordinator host

On 2026-11-17, the host's existing Tailscale Serve HTTPS route forwarded to an
isolated coordinator on `127.0.0.1:8787`. The test used synthetic credentials
and two authenticated Chromium sessions on the same host. The Web test passed
login, messages, image upload, WebSocket delivery, reconnect and restart.

The MCP test passed OAuth discovery, authorization, tool calls and resumable
streaming through the same HTTPS route with the IP allow-list disabled. The
HTTPS client verified the Serve certificate. A separate HTTP header probe showed
that Serve replaced supplied forwarding headers and supplied the host's
Tailscale address as the source. The scripts did not change Serve settings.

The allow-list test failed before TOTP setup. It trusted `127.0.0.1` and allowed
both that address and the host's Tailscale address. The follow-up probe returned
403 from the local endpoint and 200 from Serve using the same synthetic machine
credential. The local CLI reported an unknown source. See issue #29.

These tests do not establish communication between separate physical devices.
The reports identify the base revision and uncommitted test changes. The exact
SHA-256 of each tested script is:

- `test/self-hosted-messages-e2e.ts`: `cbb77d48be1926893e42afef923437f437a78f5e089e554f453349269ac4930a`
- `test/self-hosted-mcp-e2e.ts`: `ccfc87b0bf8e018934dba7e4daf59b24cefa12867550a9565b0d56d749739af1`

Run instructions are in `test/self-hosted-acceptance.md`. The files here omit
the private tailnet hostname. The test's temporary data and credentials are
not part of this evidence.
