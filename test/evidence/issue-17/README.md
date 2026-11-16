# Independent coordinator acceptance evidence

The successful runs used source revision `237215cd3217dc8b21598b9fd721b037b0a50a03`.
`vm-report.json` records a Linux x86_64 KVM guest running the coordinator, with
the primary and execution hosts in separate network namespaces. The network
had no public Internet route. The test used real HTTP and WebSocket connections.
It checked concurrent commits and claims, distinct dial and advertised URLs,
reconnection, and recovery by a fresh host after the VM was powered off.

`local-report.json` records the real Web login and local process checks at the
same revision. It includes a forced launcher kill and verifies that an orphaned
runtime retains the single-instance lock. All data and credentials are synthetic.
See `test/self-hosted-acceptance.md` for the repeatable commands and prerequisites.

The failed development run in `power-loss-before-report.json` used an
uncommitted pre-fix tree. Its VM failed to start after a forced power-off;
`power-loss-before.log` records the runtime parse error. The initial test then
timed out while probing that failed guest. `storage-inspection.txt` records the
zero-filled namespace key and bootstrap file found in the stopped VM disk.
That isolated disk remains at `/var/tmp/noop-network-e2e-D721IV/state.img` on
the test machine, with SHA-256
`611e4906c52a14ae14828d1235440564ef15e12e74f4c6d0b4367c3c650b6986`.

`orphan-before.txt` records the pre-fix result where the orphan and a second
coordinator both served requests. `address-ablation.log` records a separate
run with the execution host's dial-address override removed; event forwarding
failed. These observations support the lock, durable-file and address changes.

The VM and containers do not establish physical-machine or Tailscale acceptance.
The four-platform, service-manager, backup and full release gates remain open.
From this directory, run `sha256sum -c SHA256SUMS` to verify these artifacts.
