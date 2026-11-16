# Self-hosted coordination service acceptance

These scenarios describe the complete feature in issue #13. They are written
before the implementation. A scenario is pending until its evidence is recorded.

Run tests with isolated Noop homes, data, ports and credentials. Never use a
production Worker or existing Noop data. Record the source revision, platform,
runtime version, commands, logs, result and checksums with each run.

## Deployment and local access

1. Given no Cloudflare credentials, when the owner deploys locally, the service
   starts on loopback and serves the installed Web client and its API.
2. Given an unknown deployment option, when the owner deploys, the command fails
   without invoking the Cloudflare deploy path. The default cloud command keeps
   its existing behavior.
3. Given a local deployment, when the machine key binds TOTP and the Web client
   requests a code without SMTP, `noop login` returns the code. The client signs
   in with that code and a valid authenticator code. Invalid or reused codes fail.
4. Given a primary host and an execution host connected over HTTP, when the
   primary changes a shared file, the execution host receives it. The service
   retains the file and TOTP binding after a clean restart.
5. Given installed runtime and Web assets, when public Internet access is
   unavailable, the service starts and the owner can sign in and synchronize.
   Installation and updates can use a local or user-selected artifact source.
6. On Linux x86_64 and ARM64, after a machine reboot with no user login, the
   installed service starts. A failed service installation or linger setup is
   reported as a failure.
7. On macOS x86_64 and ARM64, after the user logs in, the installed service
   starts. Status and logs describe a failed startup accurately.

## Network and shared work

8. Given a coordinator on a separate machine, a primary host and multiple
   execution hosts can join it. A host's local dial address is not overwritten
   by an unsuitable advertised address.
9. Given concurrent updates from two hosts, conflicting file writes return a
   conflict. Given three hosts claiming a task, only one claim succeeds.
   Hosts resume synchronization and status updates after reconnecting.
10. Given an IP allow-list, allowed sources connect and other sources are denied.
    A client cannot bypass the list using a forged forwarding header. A request
    with no trusted source is denied when the list is enabled.
11. Given a trusted HTTPS proxy or Tailscale ingress, external Host and protocol
    reach the coordinator correctly. HTTP, WebSocket and streaming connections
    work, and clients cannot bypass the trusted-proxy boundary.
12. Given an external HTTPS MCP client, OAuth discovery advertises its actual
    HTTPS origin. The client can authorize, call a tool and receive streamed
    notifications; invalid or revoked credentials fail.
13. Given a guest invite, the guest joins, receives only an assigned task and
    returns its result. A revoked guest cannot continue. It cannot read owner
    files, messages, memory or other guests' tasks.
14. Given authorized clients, the owner can send and receive a message with an
    attachment. An unauthorized client cannot read it. The attachment survives
    a coordinator restart.

## Delivery, retention and recovery

15. Given an actual SMTP service, a configured owner receives a login code and
    existing security alerts. An SMTP failure is reported and does not pretend
    delivery succeeded. Without SMTP, the CLI code path still works.
16. Given a supported device and configured push service, an owner can subscribe,
    receive a notification and unsubscribe. Record simulated endpoint evidence
    separately from evidence from an actual device and provider.
17. Given local usage over the Cloudflare free-plan thresholds, ordinary local
    work is not shed or rejected for that quota. Authentication rate limits
    remain active. Usage remains visible.
18. Given a local database over 500 MB, normal historical versions remain
    available under the existing age, count and per-file rules. Existing
    latest-only paths keep their current no-history behavior. Cloud policy and
    its unchanged budget simulation remain in force.
19. Given a stopped coordinator, a manual backup includes its database,
    namespace identifier, configuration, machine token, VAPID keys and required
    credentials. Restoring to another directory preserves login, files, history
    and media. A corrupt backup or failed restore does not overwrite the source.
20. Given an explicit update, the service is stopped and backed up before the
    new runtime is accepted. An invalid package, full disk or failed startup
    reports failure and restores the previous runtime and data.
21. Given a successful update followed by new writes, a later rollback cannot
    silently replace those writes with an older snapshot. A standalone server
    can be maintained locally without an active primary host.

## Cloud compatibility and release gate

22. Given the cloud deployment mode, existing initialization, deployment, email,
    client and update behavior stays compatible. The existing fleet-day budget
    test passes without increasing its target or weakening its simulation.
23. Given Linux x86_64, Linux ARM64, macOS x86_64 and macOS ARM64, run the
    applicable end-to-end scenarios on each native architecture using CI, a VM
    or a physical machine. Record real mobile, SMTP, push and Cloudflare evidence
    separately from test substitutes. Unavailable evidence remains pending.
24. Only select the candidate runtime for production after all platform,
    persistence, backup, upgrade, rollback, functionality and cloud gates pass.
    If a gate fails, retain the evidence and reassess the runtime choice.

## Run the local candidate scenario

Prepare the genuine Noop Web bundle and the pinned workerd binary separately.
Install Chromium and Playwright Core. The candidate currently supports Linux
x86_64 and requires the unmodified `@cloudflare/workerd-linux-64` binary from
version `1.20261110.1`. No Cloudflare account or agent CLI is needed for this
test.

Set `NOOP_E2E_WEB_ASSETS` to the unpacked Web bundle directory and
`NOOP_E2E_WORKERD` to the workerd executable. If Playwright Core is not a
project dependency, set `NOOP_E2E_PLAYWRIGHT` to its `index.js`. Set
`NOOP_E2E_BROWSER` if Chromium is not on PATH. Then run:

```sh
bun test/self-hosted-e2e.ts
```

The script prints its isolated evidence directory. `report.json` identifies the
runtime, Web bundle and checks. `SHA256SUMS` covers the generated report, logs
and screenshot. `NOOP_E2E_OUT` can select an existing parent directory for the
evidence. The test copies the project and never changes an existing Noop home.
Set `NOOP_E2E_WEB_VERSION` to record the Web bundle's release or build identity.
