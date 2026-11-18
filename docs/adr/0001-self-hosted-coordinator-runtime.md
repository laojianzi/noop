# ADR 0001: Run the self-hosted coordinator on workerd

## Status

Accepted for the Linux self-hosted coordinator on 2026-11-17.

## Context

Noop needs the same coordination features on a single Linux host and across
multiple hosts. The installed service must start without a Cloudflare account
or public network. The fork should stay close to the upstream Worker and its
protocol. Cloud deployments must keep their existing budget and behavior.

## Decision

Use the existing Worker with the native workerd runtime for a single active
self-hosted coordinator. Pin the workerd package and verify each platform
binary's SHA-256 before startup. The accepted initial candidate is
`@cloudflare/workerd` `1.20261110.1`. The service needs no Docker runtime.

Store the Durable Object data on local disk. Keep the namespace identifier,
machine token and push keys with the data. Make a consistent manual backup
while the service is stopped. Verify the installed release and keep the old
runtime and backup available for an explicit update or rollback.

Default to loopback. Use an existing HTTPS reverse proxy or Tailscale Serve
when other hosts need access. Use the existing Worker for local and Cloudflare
modes; keep their quota and retention policies distinct.

## Consequences

The upstream workerd schema marks local Durable Object storage as
[experimental](https://github.com/cloudflare/workerd/blob/v1.20261110.1/src/workerd/server/workerd.capnp#L916-L925).
The Linux acceptance evidence covers the pinned versions and tested workloads;
it does not promise compatibility with every future workerd version or storage
failure. Treat upgrades as explicit changes and re-run recovery checks.

Linux x86_64 and ARM64 are the initial release gate. macOS, a real VPS,
cross-device Tailscale, real mobile push and hosted Cloudflare remain separate
acceptance work. See [Linux acceptance evidence](../../test/evidence/issue-27-linux-final/README.md).

## Alternatives

- Wrangler and Miniflare are useful for development and compatibility tests.
  They also depend on workerd and add a development runtime to deployment.
- A separate Bun or SQLite coordinator would duplicate Durable Object, SQL,
  WebSocket and upstream protocol behavior. It would increase ongoing sync cost.
