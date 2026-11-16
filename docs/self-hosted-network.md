# Local coordinator network access

The local coordinator listens on `127.0.0.1:8790` by default. Use
`noop cloud deploy --local --listen <ip>:<port>` to choose another interface.
Use an existing HTTPS proxy or Tailscale Serve when clients need a TLS endpoint.

To limit source addresses, set these values in the coordinator machine's
`data/config.local.toml`. The proxy list is optional. Restart the coordinator
after changing either value.

```toml
[cloud]
allow_ips = "127.0.0.1, 192.0.2.0/24"
trusted_proxies = "127.0.0.3"
```

`allow_ips` and `trusted_proxies` accept IP addresses and CIDR ranges, separated
by spaces or commas. Invalid entries stop the local service from starting.
When the allow-list is empty, the source-IP restriction is disabled.

For a direct connection, Noop uses the source address reported by workerd. It
ignores client-supplied forwarding headers. For a connection from a configured
trusted proxy, Noop reads `X-Forwarded-For` from right to left and uses the first
address outside the trusted proxy ranges. It rejects a missing or invalid client
address. The proxy must replace that header or append the actual address of its
peer. Configure only addresses that identify proxies under your control.

An address is trusted for every process that can connect from it. For example,
trusting `127.0.0.1` also trusts other local processes using that address. Limit
access to the backend accordingly. The local startup check uses a private Unix
socket in the coordinator data directory. That socket accepts only an
authenticated `GET /api/status` request.

The proxy should preserve the external `Host` and set `X-Forwarded-Proto`.
HTTP, WebSocket and streaming responses work through the tested TLS proxy.
External HTTPS origin handling for MCP OAuth is tracked separately in #19.
