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

With Tailscale Serve proxying from `127.0.0.1`, trusting that address and
enabling `allow_ips` currently blocks local CLI requests, even if the allow-list
includes loopback. The local CLI does not send a forwarding header, so the
coordinator cannot identify its source. Track the fix in issue #29.

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

For a private CA, set `SSL_CERT_FILE` to a PEM certificate bundle before
starting or installing the service. The coordinator adds those certificates to
the browser CA set. The background service keeps the supplied file path.

The coordinator generates its Web Push VAPID keypair once in
`<NOOP_HOME>/vapid.json`. Keep this file when backing up or moving the
coordinator. Replacing it invalidates existing push subscriptions.

Local mode records usage but does not apply Cloudflare free-plan shedding.
File history keeps the existing 90-day, 20,000-row and 30-version rules. It
keeps only the current version for `latestOnly` paths. A database over 500 MB
does not reduce other files to one version in local mode.

## Install and update the service

Prepare Bun, this Noop source tree, the genuine Web bundle, and the matching
workerd executable before installation. The candidate runtime is workerd
`2026-11-10` from package version `1.20261110.1`. The platform checksums are
in `src/local-coordinator.ts`. You can provide these files from local media or
an artifact source of your choice. For example:

The upstream workerd project marks its local Durable Object storage as
experimental. This deployment remains a candidate until the release gates in
issue #13 are complete.

```sh
cd /path/to/noop
mkdir -p app/dist/web/noop
cp -R /path/to/unpacked-web/. app/dist/web/noop/
export PATH="/path/to/workerd-directory:$PATH"
bun src/cli.ts cloud service install --listen 127.0.0.1:8790
```

If `noop` is already installed, use it in place of `bun src/cli.ts`. Linux
uses a user systemd service with linger; macOS uses a launch agent that starts
when the user logs in. The installed service starts without downloading files.

```sh
noop cloud service status
noop cloud service logs
noop cloud service stop
noop cloud service start
```

The installed service keeps its own copy of the code, Web client and runtime.
Changing the source checkout does not change the installed service. To update,
run the command on the coordinator host with the desired Noop source and its
built Web client. Use `--workerd` to select the matching pinned binary:

```sh
noop cloud service update --source /path/to/noop --workerd /path/to/workerd
noop cloud service rollback
```

The service must be running before an update or rollback. Each operation
stops it and creates a backup under `<NOOP_HOME>/coordinator/backups`. It
checks the selected release against an isolated copy before switching. A
rollback checks the current data with the previous release and retains writes
made after the update. If startup fails after the switch, Noop restores the
previous service and reports the path of the failed candidate's data. Keep
the printed backup path and remove old backups or releases when they are no
longer needed. They contain credentials and can use significant disk space.

After starting the coordinator, bind an authenticator with `noop 2fa setup`
and `noop 2fa confirm`. A primary on another machine joins with
`noop init --primary --local <coordinator-url> --token <machine-token>`.
Other hosts use `noop init --local <coordinator-url>` and the existing login
flow, or provide `--token`. The coordinator's machine token is stored in its
Noop home; share it only with trusted hosts.

## Back up and restore

Stop the coordinator before taking a backup. Choose a new backup directory
whose parent already exists:

```sh
noop cloud backup /secure/path/noop-backup
```

The command refuses to run while the coordinator holds its data lock. It writes
a checksum manifest and restricts the backup directory and files to the current
user. The backup contains the database files, namespace key, bootstrap and
machine token, VAPID keys, generated runtime configuration, and the three Noop
configuration files when present. It does not include remote host workspaces,
independent reverse proxy or Tailscale configuration, or executable and Web
artifacts. The backup contains credentials; store it accordingly.

To restore, choose a Noop home that does not already exist. Its parent must
exist. Unset `HUB_DATA` and `HUB_CONF` during the restore:

```sh
NOOP_HOME=/new/path/noop noop cloud restore /secure/path/noop-backup
NOOP_HOME=/new/path/noop noop cloud deploy --local --listen 127.0.0.1:8790
```

Restore checks every file, the backup format and its recorded runtime version
before it creates the new home. It refuses to replace an existing destination.
The generated runtime configuration is saved for reference and rebuilt at
startup; supply the desired `--listen` address when starting the restored
service. Use the same pinned runtime version recorded by the backup.
