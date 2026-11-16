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
address outside the trusted proxy ranges. When the allow-list is enabled, it
rejects a missing or invalid client address. Login alerts use the same verified
address; if it is unavailable, they report an unknown address. The proxy must
replace that header or append the actual address of its peer. Configure only addresses that identify proxies under your control.

An address is trusted for every process that can connect from it. For example,
trusting `127.0.0.1` also trusts other local processes using that address. Limit
access to the backend accordingly. The local startup check uses a private Unix
socket in the coordinator data directory. That socket accepts only an
authenticated `GET /api/status` request.

The proxy must replace client-supplied `X-Forwarded-Proto` and
`X-Forwarded-Host` with the external protocol and host. For MCP and OAuth,
Noop uses those values only when the connection comes from a trusted proxy.
If the forwarded host is absent, it uses `Host`. A forwarded protocol must be
`http` or `https`; malformed forwarded origins are rejected. Untrusted forwarding
headers do not change the origin. HTTP, WebSocket and streaming responses work
through the tested TLS proxy.

The local coordinator permits outbound connections to public and private
addresses. This lets it reach a local or LAN SMTP server and push endpoints.
Use the host firewall to restrict outbound access when needed.

To send login codes and security alerts through SMTP, set `[email]` in the
coordinator's `data/config.local.toml` and restart it. Use the existing
`to`, `host`, `port`, `user`, `pass`, and `from` settings. Port 465 uses
implicit TLS; other ports use STARTTLS unless `secure = true`. The SMTP
certificate must be trusted by the coordinator host. Without an SMTP host,
owners can read login codes with `noop login`.

The coordinator generates its Web Push VAPID keypair once in
`<NOOP_HOME>/vapid.json`. Keep this file when backing up or moving the
coordinator. Replacing it invalidates existing push subscriptions.

Local mode records usage but does not apply Cloudflare free-plan shedding.
File history keeps the existing 90-day, 20,000-row and 30-version rules. It
keeps only the current version for `latestOnly` paths. A database over 500 MB
does not reduce other files to one version in local mode.
