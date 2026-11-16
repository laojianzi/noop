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

## Run the independent-host scenario

`test/self-hosted-network-e2e.ts` runs a coordinator, a primary and three
execution hosts on an isolated container network. It also checks cloud-mode
address adoption. It uses the real HTTP and WebSocket paths and synthetic data.
Install the `mcr.microsoft.com/playwright:v1.64.0-noble` image before the run;
the test does not download it. Set `NOOP_E2E_CONTAINER_IMAGE` to use another
installed image with Bun-compatible system libraries and curl.

```sh
NOOP_E2E_WEB_ASSETS=/path/to/web \
NOOP_E2E_WORKERD=/path/to/workerd \
bun test/self-hosted-network-e2e.ts
```

To run the coordinator in a separate Linux x86_64 KVM guest, first install the
`alpine/socat:1.8.0.3` and `dockurr/windows:latest` images. The latter supplies
QEMU only. The host needs `/dev/kvm`, a bootable kernel with built-in ext4 and
virtio block support, its matching e1000 module, `cpio`, `zstd`, `rg`,
`sha256sum`, `file`, `truncate` and `mkfs.ext4`. The default kernel and module come from
the running host. Override them with `NOOP_E2E_VM_KERNEL` and
`NOOP_E2E_E1000_MODULE` if needed.

```sh
TASK_VM_DIR=$(mktemp -d)
NOOP_E2E_WEB_ASSETS=/path/to/web NOOP_E2E_WORKERD=/path/to/workerd \
  test/prepare-self-hosted-vm.sh "$TASK_VM_DIR"
NOOP_E2E_VM_FIXTURE="$TASK_VM_DIR" NOOP_E2E_WEB_ASSETS=/path/to/web \
  NOOP_E2E_WORKERD=/path/to/workerd bun test/self-hosted-network-e2e.ts
```

The test verifies that the VM fixture matches the source, Web bundle and
runtime under test. It creates a new temporary VM disk. It powers off the VM,
restarts it, joins a fresh host, checks earlier committed files, and checks that
hosts synchronize work queued during the outage. The container and VM image
identities, logs and checksums are recorded in the output directory. These are
virtual-host results, not physical-machine or Tailscale acceptance.

## Run the trusted network scenario

Install OpenSSL and set the same Web and workerd paths as above. Run
`bun test/self-hosted-ingress-e2e.ts`. The test creates a temporary TLS proxy and
synthetic certificate. It checks direct and proxied IPv4 sources, IPv6,
forged and missing forwarding data, WebSocket, streaming HTTP, and the private
startup check. It prints a directory containing its logs, report and checksums.
See `docs/self-hosted-network.md` for the proxy trust and configuration rules.

## Run MCP and OAuth through HTTPS

With the same prerequisites, run `bun test/self-hosted-mcp-e2e.ts`. The test
starts a real TLS proxy and uses synthetic credentials. It binds TOTP, performs
OAuth with a CLI-delivered code and PKCE, calls a tool, and reconnects an MCP
notification stream. It also checks that untrusted or malformed forwarded
origins cannot alter discovery. Its report and checksums are written to a new
temporary directory.

For the Cloudflare-mode regression, start an isolated `wrangler dev --local`
instance with a synthetic `HUB_TOKEN` and a fresh `--persist-to` directory.
Set `BASE` and `TOKEN` to that instance and run
`bun test/cloud-auth/mcp-e2e.ts`. This is a local emulator check, not a deployed
Cloudflare test.

## Run the guest lifecycle

With the same Web and workerd paths, run `bun test/self-hosted-guest-e2e.ts`.
The test creates two isolated guest homes and uses a synthetic Codex executable
to return a fixed result. It checks one-time invitations, task isolation,
permissions, result recovery, acknowledgment and revocation. To test expiry
without waiting ten minutes, it stops the isolated service and expires one
synthetic invitation in its temporary database before restarting it.

## Run Web message and attachment acceptance

Set the Web, workerd and Playwright paths described above, then run
`bun test/self-hosted-messages-e2e.ts`. The test signs two independent Web
sessions in with CLI codes and TOTP. It selects a real PNG in the browser,
checks live delivery, access control, image limits, automatic reconnect, missed
message synchronization and persistence after restart. It saves a screenshot,
logs, versions, report and checksums in a new temporary directory. Browser
results do not establish native desktop or mobile device behavior.

## Run SMTP acceptance

Install Mailpit, OpenSSL, the Web bundle and the pinned workerd runtime. Set
`NOOP_E2E_MAILPIT` to the Mailpit executable, and set the Web and workerd paths
described above. Run `bun test/self-hosted-smtp-e2e.ts`. The test starts an
isolated Mailpit SMTP server that requires STARTTLS and authentication. It
creates a temporary CA, sends a login code and security alerts, checks direct
and proxied source addresses, and verifies SMTP failure and CLI fallback. It
writes logs, versions, report and checksums to a new temporary directory. The
Mailpit server receives real SMTP traffic but does not deliver to an external
mailbox.
